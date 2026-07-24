// ─── Playbook Service Worker ─────────────────────────────────────────────────
const CACHE_NAME   = 'playbook-shell-v83';
const CDN_CACHE    = 'playbook-cdn-v1';

// pb-core.js is the single source of truth for Yahoo symbols, the cent/pence
// divisor, and alert evaluation (CLAUDE.md rule #6). importScripts populates
// self.PBCore so the background alert check uses the SAME logic as the app +
// the Worker — never a hand-ported copy that can drift. (pb-data.js is
// browser-only and must NOT be imported here.)
importScripts('./pb-core.js');

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './pb-core.js',
  './pb-data.js',
  './pb-store.js',
  './pb-content.js',
  './pb-import.js',
  './pb-views.js',
  './pb-modals.js',
  './app.js',
  './data.js',
  './demo-data.js',
  './manifest.json',
  './manifest-light.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  // Brand icons — dark (default) + light home-screen variants, favicon.
  './brand/favicon.svg',
  './brand/favicon-32.png',
  './brand/apple-touch-icon.png',
  './brand/apple-touch-icon-light.png',
  './brand/icon-192.png',
  './brand/icon-512.png',
  './brand/icon-light-192.png',
  './brand/icon-light-512.png',
];

// ─── Install: pre-cache the entire app shell ──────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: purge every cache that isn't ours ─────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CDN_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // Same-origin assets → Network-First
  // Always try the network so deploys take effect immediately.
  // Fall back to cache only when offline.
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(request, CACHE_NAME));
    return;
  }

  // CDN scripts (React/unpkg) and Google Fonts → Stale-While-Revalidate
  if (
    url.hostname === 'unpkg.com' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    e.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  // Everything else (API calls) → network-only
});

// ─── Cache strategies ─────────────────────────────────────────────────────────

function networkFirst(request, cacheName) {
  return fetch(request)
    .then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(cacheName).then(cache => cache.put(request, clone));
      }
      return response;
    })
    .catch(() => caches.open(cacheName).then(cache => cache.match(request)));
}

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => {
      const revalidate = fetch(request)
        .then(response => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || revalidate;
    })
  );
}

// ─── Update messaging ─────────────────────────────────────────────────────────
// When the app calls postMessage({ type: 'SKIP_WAITING' }), activate immediately.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (e.data && e.data.type === 'check-alerts') {
    e.waitUntil(swRunAlertCheck());
    return;
  }
  if (e.data && e.data.type === 'notify') {
    self.registration.showNotification(e.data.title || 'Playbook', {
      body: e.data.body || '',
      tag: e.data.tag || 'playbook',
      icon: e.data.icon,
      badge: e.data.badge,
      data: e.data.data || { url: '/' },
      vibrate: [100, 50, 100],
      requireInteraction: false
    });
  }
});

// ─── Notifications ────────────────────────────────────────────────────────────

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title || 'Playbook alert', {
      body: data.body || '',
      tag: data.tag || 'playbook-push',
      icon: data.icon || './icon-192.png',
      badge: data.badge || './icon-192.png',
      data: data.data || { url: '/' },
      vibrate: [100, 50, 100],
      renotify: !!data.tag
    })
  );
});

// ─── Background price-alert checks ──────────────────────────────────────────
// When the app is installed but closed, Periodic Background Sync wakes the SW
// roughly every `minInterval`. We read the alert config the app mirrored into
// IndexedDB, fetch fresh quotes through the same CORS-proxy chain the app uses,
// evaluate the triggers, and fire notifications — so price alerts arrive even
// with no tab open. State (seen map + fired history) is written back to IDB so
// the app can reconcile it on next focus without double-firing.
// Note: requires an installed PWA on a browser that supports periodicSync
// (Chrome/Edge on Android/desktop). iOS Safari has no background sync; alerts
// there only fire while the app is open.

const BG_DB = 'playbook-bg', BG_STORE = 'kv', BG_KEY = 'alertState';
const SW_TRIGGER_COOLDOWN_MS = 5 * 60 * 1000;
const SW_MAX_TRIGGER_HISTORY = 100;

function swIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BG_DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(BG_STORE)) req.result.createObjectStore(BG_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function swIdbGet(key) {
  return swIdbOpen().then(db => new Promise((resolve, reject) => {
    const r = db.transaction(BG_STORE, 'readonly').objectStore(BG_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
function swIdbSet(key, val) {
  return swIdbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(BG_STORE, 'readwrite');
    tx.objectStore(BG_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// Same rotating CORS-proxy chain as the app (app.js · fetchViaProxies).
const SW_PROXIES = [
  url => `https://corsmirror.com/v1?url=${encodeURIComponent(url)}`,
  url => `https://api.cors.lol/?url=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];
function swLooksLikeError(body) {
  if (!body || body.length < 20) return true;
  const head = body.slice(0, 200);
  if (head.startsWith('<!DOCTYPE') || head.startsWith('<html') || head.startsWith('<HTML')) return true;
  return /Too Many Requests|Rate limit exceeded|Server-side requests are not allowed|Free usage is limited|domain_not_registered|"error"\s*:/i.test(head);
}
async function swFetchVia(url) {
  for (const build of SW_PROXIES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 7000);
      const res = await fetch(build(url), { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const body = await res.text();
      if (swLooksLikeError(body)) continue;
      return body;
    } catch (_e) {}
  }
  return null;
}
// Symbol building + the cent/pence divisor come from PBCore (via importScripts
// above) — the same canonical logic the app and the Worker use. The old
// hand-ported swYahooSymbol/swCentDivisor drifted (wrong ^SPX instrument, missing
// ZAX code) and were removed here (GAPS.md #2).
async function swFetchPrice(ticker, market) {
  const sym = PBCore.yahooSymbol(ticker, market);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d&includePrePost=true`;
  const text = await swFetchVia(url);
  if (!text) return null;
  try {
    const meta = JSON.parse(text)?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
    return meta.regularMarketPrice / PBCore.centDivisor(market, meta.currency);
  } catch (_e) { return null; }
}

// Alert evaluation now delegates to PBCore.evaluateAlerts (called in
// swRunAlertCheck) — the drifted swEvaluate copy was removed (GAPS.md #2). The
// SW cooldown is passed explicitly so behavior stays pinned to 5 minutes.

async function swRunAlertCheck() {
  const st = await swIdbGet(BG_KEY).catch(() => null);
  if (!st || !Array.isArray(st.alerts) || st.alerts.length === 0) return;
  const active = st.alerts.filter(a => a.active);
  if (active.length === 0) return;
  // Unique symbols to fetch (multiple alerts can share one ticker).
  const seenSym = new Set();
  const symbols = [];
  for (const a of active) {
    const k = a.market + ':' + a.ticker;
    if (!seenSym.has(k)) { seenSym.add(k); symbols.push({ ticker: a.ticker, market: a.market, key: k }); }
  }
  const prices = {};
  await Promise.all(symbols.map(async s => {
    const price = await swFetchPrice(s.ticker, s.market).catch(() => null);
    // PBCore.evaluateAlerts reads each price as a bare NUMBER (fetchedAt was
    // never used by the evaluator), so store the number directly.
    if (price != null) prices[s.key] = price;
  }));
  const { nextSeen, newTriggers } = PBCore.evaluateAlerts(active, prices, st.seen || {}, { cooldownMs: SW_TRIGGER_COOLDOWN_MS });
  // Persist updated seen + appended fired history regardless, so the app reconciles.
  const bgTriggered = [...newTriggers, ...(st.bgTriggered || [])].slice(0, SW_MAX_TRIGGER_HISTORY);
  await swIdbSet(BG_KEY, { ...st, seen: { ...(st.seen || {}), ...nextSeen }, bgTriggered, lastCheck: Date.now() }).catch(() => {});
  for (const t of newTriggers) {
    const sym = (t.market === 'JSE' || t.market === 'TFSA') ? 'R' : '$';
    await self.registration.showNotification(`${t.ticker} ${t.direction} ${sym}${t.targetPrice.toFixed(2)}`, {
      body: `Now at ${sym}${t.triggerPrice.toFixed(2)}${t.note ? ` — ${t.note}` : ''}`,
      tag: 'alert-' + t.id,
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: '/' },
      vibrate: [100, 50, 100],
    });
  }
}

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'check-alerts') e.waitUntil(swRunAlertCheck());
});
self.addEventListener('sync', (e) => {
  if (e.tag === 'check-alerts') e.waitUntil(swRunAlertCheck());
});
