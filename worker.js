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

const TRIGGER_COOLDOWN_MS = 5 * 60 * 1000;   // re-arm window after a hit clears
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
function yahooSymbol(ticker, market) {
  if (market === 'JSE' || market === 'TFSA') return ticker + '.JO';
  if (market === 'LSE') return ticker + '.L';
  if (market === 'ASX') return ticker + '.AX';
  if (market === 'FRA') return ticker + '.F';
  if (market === 'PAR') return ticker + '.PA';
  if (market === 'AMS') return ticker + '.AS';
  // Crypto is held as a bare symbol (BTC, ETH); Yahoo prices it as a USD pair.
  // Without this we fetch the wrong instrument (e.g. an equity also tickered
  // "BTC") and fire triggers off a price that isn't the live crypto market —
  // mirror app.js's yahooSymbol exactly.
  if (market === 'CRYPTO') return /-USD$/i.test(ticker) ? encodeURIComponent(ticker) : encodeURIComponent(ticker + '-USD');
  return encodeURIComponent(ticker);
}
function centDivisor(market, currency) {
  const c = (currency || '').toUpperCase();
  if ((market === 'JSE' || market === 'TFSA') && (c === 'ZAC' || c === 'ZAR')) return 100;
  if (market === 'LSE' && (c === 'GBX' || c === 'GBP')) return 100; // Yahoo reports LSE in pence
  return 1;
}
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

// ─── Market hours (DST-correct via Intl time zones, supported on Workers) ────
const SESSIONS = {
  US:   { tz: 'America/New_York',      open: 4 * 60,  close: 20 * 60 },  // incl. pre/post-market
  JSE:  { tz: 'Africa/Johannesburg',   open: 9 * 60,  close: 17 * 60 + 5 },
  TFSA: { tz: 'Africa/Johannesburg',   open: 9 * 60,  close: 17 * 60 + 5 },
  LSE:  { tz: 'Europe/London',         open: 8 * 60,  close: 16 * 60 + 35 },
  ASX:  { tz: 'Australia/Sydney',      open: 10 * 60, close: 16 * 60 + 10 },
  FRA:  { tz: 'Europe/Berlin',         open: 9 * 60,  close: 17 * 60 + 35 },
  PAR:  { tz: 'Europe/Paris',          open: 9 * 60,  close: 17 * 60 + 35 },
  AMS:  { tz: 'Europe/Amsterdam',      open: 9 * 60,  close: 17 * 60 + 35 },
  CRYPTO: { tz: 'UTC',                 open: 0,       close: 24 * 60 }  // 24/7
};
function marketOpen(market, now = new Date()) {
  if (market === 'CRYPTO') return true; // crypto trades 24/7, incl. weekends
  const s = SESSIONS[market] || SESSIONS.US;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: s.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now);
  const get = t => parts.find(p => p.type === t)?.value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0; // some ICU builds emit 24 for midnight
  const mins = hh * 60 + parseInt(get('minute'), 10);
  return mins >= s.open && mins <= s.close;
}

// ─── Trigger evaluation (mirrors the app + service worker engine) ────────────
function evaluate(alerts, prices, seen) {
  const now = Date.now();
  const nextSeen = {};
  const newTriggers = [];
  let changed = false;
  for (const a of alerts) {
    if (!a.active) { if (seen[a.id] !== undefined) nextSeen[a.id] = seen[a.id]; continue; }
    const p = prices[a.market + ':' + a.ticker];
    if (p == null || !isFinite(p)) { if (seen[a.id] !== undefined) nextSeen[a.id] = seen[a.id]; continue; }
    const hit = a.direction === 'above' ? p >= a.targetPrice : p <= a.targetPrice;
    const prior = seen[a.id] !== undefined ? seen[a.id] : 'waiting';
    if (hit) {
      if (prior === 'waiting') {
        nextSeen[a.id] = { status: 'hit', at: now };
        newTriggers.push({ ...a, triggerPrice: p, triggeredAt: new Date().toISOString() });
        changed = true;
      } else {
        nextSeen[a.id] = prior;
      }
    } else {
      if (typeof prior === 'object' && prior !== null && (now - prior.at) < TRIGGER_COOLDOWN_MS) nextSeen[a.id] = prior;
      else { nextSeen[a.id] = 'waiting'; if (prior !== 'waiting') changed = true; }
    }
  }
  // Detect dropped keys (alerts removed) as a change so we persist the cleanup.
  if (!changed) for (const k in seen) if (!(k in nextSeen)) { changed = true; break; }
  return { nextSeen, newTriggers, changed };
}

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
