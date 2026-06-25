// ─── Playbook push backend (Cloudflare Worker) ──────────────────────────────
// A tiny always-on service that delivers price-alert notifications even when the
// PWA is fully closed — the one thing a static site cannot do on iOS/Android.
//
//   • fetch()     — the app registers its push subscription + alert list here.
//   • scheduled() — a cron trigger (every minute) fetches quotes for active
//                   alerts whose market is open, evaluates triggers, and pushes
//                   a notification for anything newly hit. The phone does no work
//                   beyond receiving the push, so battery cost is negligible.
//
// State lives in Workers KV (binding `PB`), one record per device. We only write
// when trigger state actually changes, keeping well inside the free-tier quota.
// ─────────────────────────────────────────────────────────────────────────────

import { sendPush } from './webpush.js';
import PBCore from '../pb-core.js';
// Market hours, alert evaluation, AND symbol/price-unit helpers are SHARED with
// the client (app.js) via pb-core.js, so the foreground app and this always-on
// server can never drift on "did this alert fire?" or "which instrument/units?".
// The cron path builds number-keyed prices, exactly what evaluateAlerts expects.
const { marketOpen, evaluateAlerts: evaluate, SESSIONS, yahooSymbol, centDivisor } = PBCore;

const MAX_TRIGGER_HISTORY = 100;
const ACTIVE_SUPPRESS_MS = 90 * 1000;        // skip push if app was foreground this recently
const CLIENT_TTL_MS = 120 * 24 * 3600 * 1000; // forget devices silent for 120 days

// ─── HTTP API ────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

async function handleFetch(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/' || path === '/health') return json({ ok: true, service: 'playbook-push' });

  if (path === '/vapid-public-key' && request.method === 'GET') {
    if (!env.VAPID_PUBLIC) return json({ error: 'VAPID not configured' }, 500);
    return json({ publicKey: env.VAPID_PUBLIC });
  }

  // ─── Encrypted data backup ──────────────────────────────────────────────────
  // The client stores a zero-knowledge snapshot keyed by SHA-256(recoveryCode).
  // We only ever see the hash (`key`) and opaque AES-GCM ciphertext (`blob`); the
  // recovery code never reaches the server, so we cannot read the portfolio. Kept
  // under the `backup:` prefix so the alert cron (which lists `client:`) ignores it.
  if (path === '/backup') {
    const validKey = k => typeof k === 'string' && /^[a-f0-9]{32,128}$/.test(k);
    if (request.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      if (!validKey(key)) return json({ error: 'bad key' }, 400);
      const rec = await kvGet(env, 'backup:' + key);
      if (!rec) return json({ error: 'not found' }, 404);
      return json(rec);
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_e) { return json({ error: 'bad json' }, 400); }
      if (!validKey(body.key)) return json({ error: 'bad key' }, 400);
      const b = body.blob;
      if (!b || typeof b !== 'object' || typeof b.ct !== 'string' || typeof b.iv !== 'string' || typeof b.salt !== 'string')
        return json({ error: 'bad blob' }, 400);
      if (b.ct.length > 6_000_000) return json({ error: 'too large' }, 413); // ~4.5MB plaintext cap
      const updatedAt = Date.now();
      await kvPut(env, 'backup:' + body.key, { blob: b, updatedAt });
      return json({ ok: true, updatedAt });
    }
    return json({ error: 'method not allowed' }, 405);
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (_e) { return json({ error: 'bad json' }, 400); }
    const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 64) : '';
    if (!clientId) return json({ error: 'clientId required' }, 400);
    const key = 'client:' + clientId;

    if (path === '/subscribe') {
      if (!body.subscription?.endpoint || !body.subscription?.keys?.p256dh) return json({ error: 'bad subscription' }, 400);
      const prev = (await kvGet(env, key)) || {};
      await kvPut(env, key, {
        ...prev,
        subscription: body.subscription,
        alerts: sanitizeAlerts(body.alerts ?? prev.alerts ?? []),
        seen: prev.seen || {},
        lastActiveAt: Date.now(),
        updatedAt: Date.now()
      });
      return json({ ok: true });
    }

    if (path === '/sync') {
      const prev = await kvGet(env, key);
      if (!prev) return json({ ok: false, reason: 'not-subscribed' }); // app will re-subscribe
      const next = { ...prev, lastActiveAt: Date.now(), updatedAt: Date.now() };
      if (Array.isArray(body.alerts)) next.alerts = sanitizeAlerts(body.alerts);
      if (body.subscription?.endpoint) next.subscription = body.subscription;
      await kvPut(env, key, next);
      return json({ ok: true });
    }

    if (path === '/unsubscribe') {
      await env.PB.delete(key);
      return json({ ok: true });
    }

    if (path === '/test') {
      const rec = await kvGet(env, key);
      if (!rec?.subscription) return json({ error: 'not-subscribed' }, 404);
      const status = await pushTo(env, rec.subscription, {
        title: 'Playbook', body: 'Background push is connected ✓', tag: 'pb-test', data: { url: '/' }
      }).catch(() => 0);
      return json({ ok: status >= 200 && status < 300, status });
    }
  }

  return json({ error: 'not found' }, 404);
}

function sanitizeAlerts(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200).map(a => ({
    id: String(a.id),
    ticker: String(a.ticker || '').toUpperCase().slice(0, 20),
    market: String(a.market || 'US').slice(0, 6),
    direction: a.direction === 'below' ? 'below' : 'above',
    targetPrice: Number(a.targetPrice),
    active: a.active !== false,
    note: a.note ? String(a.note).slice(0, 120) : ''
  })).filter(a => a.id && a.ticker && isFinite(a.targetPrice));
}

// ─── KV helpers ──────────────────────────────────────────────────────────────
async function kvGet(env, key) {
  try { return await env.PB.get(key, 'json'); } catch (_e) { return null; }
}
async function kvPut(env, key, val) {
  try { await env.PB.put(key, JSON.stringify(val)); } catch (_e) {}
}

// ─── Quote fetching (server-side: direct, with proxy fallback) ───────────────
// yahooSymbol + centDivisor are imported from pb-core.js (destructured above) —
// the worker no longer keeps its own drifted copies.
const PROXIES = [
  u => u,
  u => `https://corsmirror.com/v1?url=${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`
];
async function fetchQuote(ticker, market) {
  const sym = yahooSymbol(ticker, market);
  for (const host of ['query1', 'query2']) {
    const base = `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d&includePrePost=true`;
    for (const build of PROXIES) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(build(base), { cache: 'no-store', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        clearTimeout(t);
        if (!res.ok) continue;
        const meta = (await res.json())?.chart?.result?.[0]?.meta;
        const px = meta?.regularMarketPrice;
        if (typeof px === 'number' && isFinite(px)) return px / centDivisor(market, meta.currency);
      } catch (_e) {}
    }
  }
  return null;
}

// Market hours + trigger evaluation now live in pb-core.js (imported above) so
// the client and this Worker share one implementation. `fetchQuote` returns
// prices already keyed/divided, which evaluate() reads as plain numbers.

function pushTo(env, subscription, payload) {
  return sendPush(subscription, payload, {
    publicKey: env.VAPID_PUBLIC,
    privateKey: env.VAPID_PRIVATE,
    subject: env.VAPID_SUBJECT || 'mailto:alerts@playbook.app'
  });
}

// ─── Cron: the heartbeat that makes alerts "always on" ───────────────────────
async function runChecks(env) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return;
  const now = Date.now();
  let cursor;
  do {
    const page = await env.PB.list({ prefix: 'client:', cursor });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const { name } of page.keys) {
      try { await checkClient(env, name, now); } catch (_e) {}
    }
  } while (cursor);
}

async function checkClient(env, key, now) {
  const rec = await kvGet(env, key);
  if (!rec || !rec.subscription) return;

  // Garbage-collect long-silent devices.
  if (rec.updatedAt && now - rec.updatedAt > CLIENT_TTL_MS) { await env.PB.delete(key); return; }

  const active = (rec.alerts || []).filter(a => a.active && marketOpen(a.market));
  if (active.length === 0) return; // nothing to check while every relevant market is closed

  // Unique symbols (several alerts can share a ticker).
  const want = new Map();
  for (const a of active) want.set(a.market + ':' + a.ticker, a);
  const prices = {};
  await Promise.all([...want.values()].map(async a => {
    const px = await fetchQuote(a.ticker, a.market);
    if (px != null) prices[a.market + ':' + a.ticker] = px;
  }));

  const { nextSeen, newTriggers, changed } = evaluate(rec.alerts || [], prices, rec.seen || {});
  if (!changed) return; // no state change → no KV write, no push

  // If the app was foregrounded very recently, its own engine already notified —
  // skip the server push to avoid a duplicate, but still persist the seen-state.
  const appActive = rec.lastActiveAt && (now - rec.lastActiveAt) < ACTIVE_SUPPRESS_MS;

  const history = [...newTriggers, ...(rec.bgTriggered || [])].slice(0, MAX_TRIGGER_HISTORY);
  await kvPut(env, key, { ...rec, seen: nextSeen, bgTriggered: history, lastCheck: now });

  if (appActive) return;

  let gone = false;
  for (const t of newTriggers) {
    const sym = (t.market === 'JSE' || t.market === 'TFSA') ? 'R' : '$';
    const status = await pushTo(env, rec.subscription, {
      title: `${t.ticker} ${t.direction} ${sym}${t.targetPrice.toFixed(2)}`,
      body: `Now at ${sym}${t.triggerPrice.toFixed(2)}${t.note ? ` — ${t.note}` : ''}`,
      tag: 'alert-' + t.id,
      data: { url: '/', ticker: t.ticker, market: t.market }
    }).catch(() => 0);
    if (status === 404 || status === 410) gone = true;
  }
  if (gone) await env.PB.delete(key); // subscription expired/unsubscribed at the push service
}

export default {
  async fetch(request, env) { return handleFetch(request, env); },
  async scheduled(event, env, ctx) { ctx.waitUntil(runChecks(env)); }
};

// Exported for unit tests (Cloudflare only invokes the default export).
export { evaluate, marketOpen, yahooSymbol, centDivisor, sanitizeAlerts, SESSIONS };
