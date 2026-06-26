// ─── Playbook data layer ─────────────────────────────────────────────────────
// The client-only network layer carved out of app.js: the rotating CORS-proxy
// chain plus every quote/price/history provider (Yahoo, Stooq, Morningstar unit
// trusts, FRED/indicator) and the ticker→name cache. It is IMPURE (network,
// localStorage) and is loaded only in the browser — the Cloudflare worker
// (backend/worker.js) and the service worker (sw.js) keep their own inline fetch
// and must NOT import this. It depends only upward on pb-core.js (pure helpers).
//
// Dual-mode footer like pb-core.js: CommonJS module.exports (Node tests) +
// globalThis.PBData (browser <script> before app.js).
"use strict";
(function () {
  const PBCore = (typeof module !== 'undefined' && module.exports && typeof require !== 'undefined')
    ? require('./pb-core.js')
    : globalThis.PBCore;
  // These core helpers are used by the providers added in Task 3; pulled here so
  // the destructure is established once. (priceKey is the only one the proxy
  // ladder itself could need; the rest are forward-looking.)
  const { yahooSymbol, centDivisor, parseYahooQuote, buildDailyBars, derivePrevClose,
          deriveIntradayExt, MARKET_CURRENCY, priceKey } = PBCore;

  // App-injected config (set once from app.js via PBData.configure). Kept here so
  // pb-data never reaches into app.js globals (which would break the Node tests).
  const cfg = { indicatorCatalog: null };
  function configure(opts) { if (opts && typeof opts === 'object') Object.assign(cfg, opts); }

  // ─── Rotating CORS proxy chain ──────────────────────────────────────────────
  // CORS proxies for endpoints that don't allow direct browser fetches
  // (Yahoo Finance, Stooq). Tried in order; first valid response wins. Ordering
  // is by observed reliability when called from a deployed origin (not localhost).
  // Each entry has an `unwrap` so proxies that wrap the upstream body in JSON
  // (allorigins /get → {contents:"..."}) can still be parsed by callers that
  // expect raw upstream text.
  //
  // The list is intentionally diverse: corsmirror is fastest and most stable in
  // production; cors.lol is fast but rate-limits aggressively; allorigins is
  // reliable when its edge isn't 5xx-flapping; corsproxy.io blocks deployed
  // origins on its free tier (still useful for localhost dev). `lastGoodProxy`
  // floats the most-recently-successful proxy to the front of the next call so
  // we don't waste the user's latency budget on a known-failing edge.
  const CORS_PROXIES = [
    { name: 'corsmirror',     build: url => `https://corsmirror.com/v1?url=${encodeURIComponent(url)}`,     unwrap: t => t },
    { name: 'cors.lol',       build: url => `https://api.cors.lol/?url=${encodeURIComponent(url)}`,         unwrap: t => t },
    { name: 'allorigins-get', build: url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, unwrap: t => {
        try { const d = JSON.parse(t); return typeof d.contents === 'string' ? d.contents : t; } catch { return t; }
      } },
    { name: 'allorigins-raw', build: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, unwrap: t => t },
    { name: 'corsproxy.io',   build: url => `https://corsproxy.io/?${encodeURIComponent(url)}`,             unwrap: t => t },
    { name: 'codetabs',       build: url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, unwrap: t => t }
  ];
  let lastGoodProxy = null;
  function orderedProxies() {
    if (!lastGoodProxy) return CORS_PROXIES;
    const idx = CORS_PROXIES.findIndex(p => p.name === lastGoodProxy);
    return idx <= 0 ? CORS_PROXIES : [CORS_PROXIES[idx], ...CORS_PROXIES.slice(0, idx), ...CORS_PROXIES.slice(idx + 1)];
  }
  // Detect proxy responses that returned 200 but contain an upstream error or
  // rate-limit message. Treating these as success would silently propagate
  // stale/wrong data to the UI — better to fall through to the next proxy.
  function looksLikeProxyError(body) {
    if (!body || body.length < 20) return true;
    const head = body.slice(0, 200);
    if (head.startsWith('<!DOCTYPE') || head.startsWith('<html') || head.startsWith('<HTML')) return true;
    if (/Too Many Requests|Rate limit exceeded|Server-side requests are not allowed|Free usage is limited|domain_not_registered|"error"\s*:/i.test(head)) return true;
    return false;
  }
  // Fetch `url` through the proxy chain and return the upstream body as text.
  // Returns null if every proxy fails. Updates `lastGoodProxy` so subsequent
  // calls start with the working proxy.
  async function fetchViaProxies(url, { timeoutMs = 8000 } = {}) {
    for (const px of orderedProxies()) {
      try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
        const res = await fetch(px.build(url), { cache: 'no-store', signal: ctrl?.signal });
        if (t) clearTimeout(t);
        if (!res.ok) continue;
        const text = await res.text();
        const body = px.unwrap(text);
        if (looksLikeProxyError(body)) continue;
        lastGoodProxy = px.name;
        return body;
      } catch (e) {}
    }
    return null;
  }

  // Test seams (Node only; harmless in browser).
  function _setLastGoodProxy(v) { lastGoodProxy = v; }

  const PBData = {
    configure,
    fetchViaProxies,
    looksLikeProxyError,
    orderedProxies,
    _setLastGoodProxy,
    get _lastGoodProxy() { return lastGoodProxy; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PBData;
  if (typeof globalThis !== 'undefined') globalThis.PBData = PBData;
})();
