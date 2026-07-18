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
          deriveIntradayExt, plausiblePriceMove, MARKET_CURRENCY, priceKey, pLimit } = PBCore;

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
  // Collapse concurrent identical upstream requests, and cap total simultaneous
  // fetch() calls across every provider, so an auto-poll + a manual refresh + a
  // detail view don't stack into one proxy-tripping burst. cacheBust appends a
  // unique &_=<ts> so manual refreshes are distinct urls and bypass de-dupe.
  const _inflight = new Map();
  const _fetchLimit = pLimit(8);
  function fetchViaProxies(url, { timeoutMs = 8000 } = {}) {
    const existing = _inflight.get(url);
    if (existing) return existing;
    const run = (async () => {
      for (const px of orderedProxies()) {
        try {
          // The abort timeout starts when the limiter ADMITS the fetch (inside the
          // limited fn), not while the request is still queued for a slot — a request
          // shouldn't time out merely waiting its turn. Under heavy concurrency this
          // means wall-clock-to-failure can exceed timeoutMs by the queue wait.
          const res = await _fetchLimit(async () => {
            const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
            try { return await fetch(px.build(url), { cache: 'no-store', signal: ctrl?.signal }); }
            finally { if (t) clearTimeout(t); }
          });
          if (!res.ok) continue;
          const text = await res.text();
          const body = px.unwrap(text);
          if (looksLikeProxyError(body)) continue;
          lastGoodProxy = px.name;
          return body;
        } catch (e) {}
      }
      return null;
    })();
    _inflight.set(url, run);
    run.finally(() => _inflight.delete(url));
    return run;
  }

  // Test seams (Node only; harmless in browser).
  function _setLastGoodProxy(v) { lastGoodProxy = v; }

  // ─── Company-name cache ─────────────────────────────────────────────────────
  // Heatmap constituents (and many Yahoo-searched tickers) ship without a curated
  // name, so a bare ticker like AVGO would otherwise show with no company name.
  // We keep a persistent market:ticker → name map that fills from every live quote
  // we see (full + light), seeded with a curated map of the most-browsed names so
  // they read correctly on first paint before any network call lands.
  const CURATED_NAMES = {
    'US:AVGO': 'Broadcom', 'US:AAPL': 'Apple', 'US:MSFT': 'Microsoft', 'US:NVDA': 'NVIDIA',
    'US:GOOGL': 'Alphabet (Class A)', 'US:GOOG': 'Alphabet (Class C)', 'US:AMZN': 'Amazon',
    'US:META': 'Meta Platforms', 'US:TSLA': 'Tesla', 'US:ORCL': 'Oracle', 'US:CRM': 'Salesforce',
    'US:ADBE': 'Adobe', 'US:AMD': 'Advanced Micro Devices', 'US:CSCO': 'Cisco Systems',
    'US:ACN': 'Accenture', 'US:NOW': 'ServiceNow', 'US:IBM': 'IBM', 'US:INTU': 'Intuit',
    'US:QCOM': 'Qualcomm', 'US:TXN': 'Texas Instruments', 'US:AMAT': 'Applied Materials',
    'US:ANET': 'Arista Networks', 'US:PLTR': 'Palantir Technologies', 'US:ADI': 'Analog Devices',
    'US:MU': 'Micron Technology', 'US:APH': 'Amphenol', 'US:LRCX': 'Lam Research', 'US:INTC': 'Intel',
    'US:CRWD': 'CrowdStrike', 'US:KLAC': 'KLA Corp', 'US:SNPS': 'Synopsys', 'US:CDNS': 'Cadence Design',
    'US:DELL': 'Dell Technologies', 'US:APP': 'AppLovin', 'US:GLW': 'Corning', 'US:MPWR': 'Monolithic Power',
    'US:NFLX': 'Netflix', 'US:TMUS': 'T-Mobile US', 'US:DIS': 'Walt Disney', 'US:CMCSA': 'Comcast',
    'US:JPM': 'JPMorgan Chase', 'US:V': 'Visa', 'US:MA': 'Mastercard', 'US:BAC': 'Bank of America',
    'US:WFC': 'Wells Fargo', 'US:GS': 'Goldman Sachs', 'US:MS': 'Morgan Stanley', 'US:AXP': 'American Express',
    'US:BRK-B': 'Berkshire Hathaway', 'US:C': 'Citigroup', 'US:UNH': 'UnitedHealth', 'US:LLY': 'Eli Lilly',
    'US:JNJ': 'Johnson & Johnson', 'US:ABBV': 'AbbVie', 'US:MRK': 'Merck', 'US:PFE': 'Pfizer',
    'US:TMO': 'Thermo Fisher', 'US:ABT': 'Abbott Laboratories', 'US:VRTX': 'Vertex Pharmaceuticals',
    'US:XOM': 'Exxon Mobil', 'US:CVX': 'Chevron', 'US:OXY': 'Occidental Petroleum', 'US:COP': 'ConocoPhillips',
    'US:WMT': 'Walmart', 'US:COST': 'Costco', 'US:PG': 'Procter & Gamble', 'US:KO': 'Coca-Cola',
    'US:PEP': 'PepsiCo', 'US:HD': 'Home Depot', 'US:MCD': "McDonald's", 'US:NKE': 'Nike',
    'US:CAT': 'Caterpillar', 'US:GE': 'GE Aerospace', 'US:BA': 'Boeing', 'US:HON': 'Honeywell',
    'US:ETN': 'Eaton', 'US:GD': 'General Dynamics', 'US:GEV': 'GE Vernova', 'US:CEG': 'Constellation Energy',
    'US:TSM': 'Taiwan Semiconductor', 'US:ASML': 'ASML Holding', 'US:NBIS': 'Nebius Group',
    'US:MSTR': 'Strategy (MicroStrategy)', 'US:ASPI': 'ASP Isotopes',
  };
  const NAME_CACHE_KEY = 'pb.nameCache.v1';
  const NAME_CACHE = (() => {
    const seed = { ...CURATED_NAMES };
    try {
      const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(NAME_CACHE_KEY) : null;
      if (raw) Object.assign(seed, JSON.parse(raw) || {});
    } catch (_e) {}
    return seed;
  })();
  let _nameCacheDirty = false;
  function _flushNameCache() {
    if (!_nameCacheDirty) return;
    _nameCacheDirty = false;
    // Don't persist the curated seed — only learned names — to keep the blob small.
    const learned = {};
    for (const k in NAME_CACHE) { if (CURATED_NAMES[k] !== NAME_CACHE[k]) learned[k] = NAME_CACHE[k]; }
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(NAME_CACHE_KEY, JSON.stringify(learned)); } catch (_e) {}
  }
  function cacheName(market, ticker, name) {
    if (!market || !ticker || !name) return;
    const clean = String(name).trim();
    if (!clean || clean.toUpperCase() === String(ticker).toUpperCase()) return;
    const key = market + ':' + ticker;
    if (NAME_CACHE[key] === clean) return;
    NAME_CACHE[key] = clean;
    _nameCacheDirty = true;
    // Debounced persist so a batch of quotes writes once.
    if (typeof setTimeout === 'function') { clearTimeout(cacheName._t); cacheName._t = setTimeout(_flushNameCache, 1500); }
  }
  function cachedName(market, ticker) {
    return NAME_CACHE[market + ':' + ticker] || null;
  }

  // ─── Stooq fallback ─────────────────────────────────────────────────────────
  function stooqSymbol(ticker, market) {
    if (market === 'JSE' || market === 'TFSA') return ticker.toLowerCase() + '.jo';
    // Stooq quotes crypto as e.g. "btcusd" (no exchange suffix).
    if (market === 'CRYPTO') return ticker.toLowerCase().replace(/-usd$/, '') + 'usd';
    if (ticker === '^SPX' || ticker === '^GSPC') return '%5Espx';
    if (ticker === '^VIX') return '%5Evix';
    return ticker.toLowerCase().replace('-', '.') + '.us';
  }
  // Stooq returns CSV: header row, then one row per session. Last two rows are
  // today and the prior session; pull close[4] from each.
  function parseStooqCsv(text, market) {
    const lines = (text || '').trim().split('\n');
    if (lines.length < 3) return null;
    const last = lines[lines.length - 1].split(',');
    const prev = lines[lines.length - 2].split(',');
    let close = parseFloat(last[4]);
    let priorClose = parseFloat(prev[4]);
    if (!isFinite(close) || !isFinite(priorClose) || priorClose === 0) return null;
    if (market === 'JSE') { close = close / 100; priorClose = priorClose / 100; }
    return {
      price: close,
      prevClose: priorClose,
      change: close - priorClose,
      changePct: (close - priorClose) / priorClose * 100,
      currency: market === 'JSE' ? 'ZAR' : 'USD',
      marketState: 'UNKNOWN',
      fetchedAt: Date.now(),
      source: 'stooq'
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // South African unit trusts (collective investment schemes). These aren't
  // exchange-listed, so Yahoo and Stooq carry no data for them — every SA fund
  // (Coronation, Allan Gray, Ninety One, …) used to fail import matching with "no
  // live match". We price them off Morningstar's public fund feed (the same data
  // behind SA fund fact sheets) using a fund's Morningstar SecId as its ticker.
  // The SecId shape (F + 9 alphanumerics, e.g. F000002CRJ) is unmistakable, so
  // fetchQuote / fetchHistory route these to Morningstar instead of Yahoo and the
  // rest of the app treats a unit trust like any other JSE/TFSA (ZAR) holding —
  // quoted in rand, no cents divisor (Morningstar NAVs are already in rand).
  // ─────────────────────────────────────────────────────────────────────────
  const MORNINGSTAR_KEY = 'klr5zyak8x';                 // public Morningstar tools API key
  const MORNINGSTAR_UNIVERSE = 'FOZAF$$ALL';            // open-ended funds domiciled in South Africa
  function isUnitTrustId(t) { return /^F[0-9A-Z]{9}$/.test(String(t || '').toUpperCase()); }
  // Morningstar's term search returns nothing for "… Unit Trust" and mis-ranks
  // "… Fund", so strip the generic words SA investors append and let the import's
  // companyNameScore re-rank the share classes it returns.
  function unitTrustSearchTerm(q) {
    return String(q || '')
      .replace(/\(.*?\)/g, ' ')
      .replace(/\b(unit\s+trusts?|collective\s+investment(\s+schemes?)?|fund\s+of\s+funds|feeder\s+funds?|funds?)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  async function fetchMorningstarRows(term, pageSize) {
    const t = String(term || '').trim();
    if (!t) return [];
    const dp = 'SecId|Name|ClosePrice|PriceCurrency|ReturnD1|ClosePriceDate';
    const url = `https://lt.morningstar.com/api/rest.svc/${MORNINGSTAR_KEY}/security/screener`
      + `?page=1&pageSize=${pageSize || 12}&outputType=json&version=1&languageId=en&currencyId=ZAR`
      + `&universeIds=${encodeURIComponent(MORNINGSTAR_UNIVERSE)}`
      + `&securityDataPoints=${encodeURIComponent(dp)}`
      + `&term=${encodeURIComponent(t)}`;
    const text = await fetchViaProxies(url, { timeoutMs: 9000 });
    if (!text) return [];
    try { const d = JSON.parse(text); return Array.isArray(d.rows) ? d.rows : []; } catch (_e) { return []; }
  }
  // Name-search SA unit trusts for the import matcher. Returns candidate listings
  // in the same shape Yahoo search yields, tagged to the chosen ZAR account so the
  // ranker keeps them on-market.
  async function searchUnitTrusts(query, market) {
    const rows = await fetchMorningstarRows(unitTrustSearchTerm(query), 12);
    const mkt = (market === 'TFSA') ? 'TFSA' : 'JSE';
    return rows
      .filter(r => r && r.SecId && r.Name && Number(r.ClosePrice) > 0)
      .map(r => { cacheName(mkt, r.SecId, r.Name); return { ticker: r.SecId, market: mkt, name: r.Name, exchange: 'Unit trust' }; });
  }
  function morningstarRowToQuote(r) {
    const price = Number(r.ClosePrice);
    if (!isFinite(price) || price <= 0) return null;
    // ReturnD1 is the 1-day NAV move (%) — back out yesterday's NAV for change.
    const ret = Number(r.ReturnD1);
    const prevClose = (isFinite(ret) && ret > -100) ? price / (1 + ret / 100) : price;
    const change = price - prevClose;
    return {
      price, prevClose, change,
      changePct: prevClose > 0 ? (change / prevClose) * 100 : 0,
      yearHigh: null, yearLow: null, dayHigh: null, dayLow: null, volume: null,
      extPrice: null, extChange: null, extChangePct: null, extKind: null, extLive: null, extAsOf: null,
      currency: 'ZAR',
      marketState: 'CLOSED',     // a unit trust strikes one NAV per day, not live
      shortName: r.Name, longName: r.Name,
      regularMarketTime: r.ClosePriceDate ? Date.parse(r.ClosePriceDate) : Date.now(),
      fetchedAt: Date.now(),
      source: 'morningstar'
    };
  }
  async function fetchUnitTrustQuote(secId) {
    const id = String(secId || '').toUpperCase();
    const rows = await fetchMorningstarRows(id, 3);
    const row = rows.find(r => String(r.SecId).toUpperCase() === id) || (rows.length === 1 ? rows[0] : null);
    if (!row) return null;
    cacheName('JSE', id, row.Name); cacheName('TFSA', id, row.Name);
    return morningstarRowToQuote(row);
  }
  function unitTrustRangeStart(range) {
    const d = new Date();
    switch (range) {
      case '1d': case '5d': d.setDate(d.getDate() - 12); break;
      case '1mo': d.setMonth(d.getMonth() - 1); break;
      case '3mo': d.setMonth(d.getMonth() - 3); break;
      case '6mo': d.setMonth(d.getMonth() - 6); break;
      case 'ytd': d.setMonth(0, 1); break;
      case '1y': d.setFullYear(d.getFullYear() - 1); break;
      case '5y': d.setFullYear(d.getFullYear() - 5); break;
      case 'max': d.setFullYear(d.getFullYear() - 25); break;
      default: d.setFullYear(d.getFullYear() - 1);
    }
    return d;
  }
  async function fetchUnitTrustHistory(secId, range) {
    const id = String(secId || '').toUpperCase();
    const r = range || '1y';
    const isoDay = (dt) => dt.toISOString().slice(0, 10);
    const url = `https://lt.morningstar.com/api/rest.svc/timeseries_price/${MORNINGSTAR_KEY}`
      + `?currencyId=ZAR&idtype=Morningstar&frequency=daily&outputType=COMPACTJSON&applyTrackRecordExtension=true`
      + `&startDate=${isoDay(unitTrustRangeStart(r))}&endDate=${isoDay(new Date())}`
      + `&id=${encodeURIComponent(id + ']2]1]')}`;
    const text = await fetchViaProxies(url, { timeoutMs: 9000 });
    if (!text) return null;
    let arr;
    try { arr = JSON.parse(text); } catch (_e) { return null; }
    if (!Array.isArray(arr)) return null;
    const points = [];
    for (const row of arr) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const t = Number(row[0]), p = Number(row[1]);
      if (!isFinite(t) || !isFinite(p) || p <= 0) continue;
      points.push({ t, p, session: 'regular' });
    }
    if (points.length < 2) return null;
    return { points, range: r, fetchedAt: Date.now(), regularStart: null, regularEnd: null };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Macro / market indicators (the ribbon "stock cards"). These aren't ordinary
  // Yahoo tickers — they're sourced from FRED (the public fredgraph.csv endpoint,
  // no API key), a transparent central-bank balance-sheet proxy for global
  // liquidity, and a VIX-derived market-mood gauge. Each produces the SAME quote
  // and history shapes the rest of the app consumes, so charts, price triggers
  // and the ribbon all work unchanged. fetchQuote / fetchHistory route to these
  // based on the catalog descriptor's `source`.
  // ─────────────────────────────────────────────────────────────────────────
  const FRED_TTL_MS = 6 * 60 * 60 * 1000; // FRED series update daily at most
  const _fredCache = {}; // id -> { ts, data: [{date, value}] }
  function parseFredCsv(text) {
    const lines = String(text || '').trim().split('\n');
    const out = [];
    for (let i = 1; i < lines.length; i++) { // row 0 is the header
      const row = lines[i].split(',');
      const date = row[0];
      const value = parseFloat(row[1]);
      if (!date || !isFinite(value)) continue; // FRED writes '.' for missing days
      out.push({ date, value });
    }
    return out;
  }
  async function fetchFredSeries(id) {
    const cached = _fredCache[id];
    if (cached && Date.now() - cached.ts < FRED_TTL_MS) return cached.data;
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
    const text = await fetchViaProxies(url, { timeoutMs: 10000 });
    if (text) {
      const data = parseFredCsv(text);
      if (data.length) { _fredCache[id] = { ts: Date.now(), data }; return data; }
    }
    return cached ? cached.data : null; // fall back to any stale copy on failure
  }
  // Most-recent value at or before a YYYY-MM-DD date (series is chronological;
  // lexical string compare is valid for zero-padded ISO dates).
  function fredAsOf(series, dateStr) {
    if (!series) return null;
    let v = null;
    for (let i = 0; i < series.length; i++) {
      if (series[i].date <= dateStr) v = series[i].value; else break;
    }
    return v;
  }
  // Re-express a raw FRED series in the indicator's display unit: as-is (level),
  // year-over-year % (CPI inflation), or month-over-month change (payrolls).
  function fredTransformSeries(series, transform) {
    if (!Array.isArray(series) || !series.length) return [];
    if (transform === 'yoy') {
      const out = [];
      for (let i = 12; i < series.length; i++) {
        const base = series[i - 12].value;
        if (base) out.push({ date: series[i].date, value: (series[i].value / base - 1) * 100 });
      }
      return out;
    }
    if (transform === 'mom_change') {
      const out = [];
      for (let i = 1; i < series.length; i++) {
        out.push({ date: series[i].date, value: series[i].value - series[i - 1].value });
      }
      return out;
    }
    return series.map(p => ({ date: p.date, value: p.value }));
  }
  function rangeCutoffMs(range) {
    const day = 86400000;
    switch (range) {
      case '1d': return day;          case '5d': return 5 * day;
      case '1mo': return 31 * day;    case '3mo': return 92 * day;
      case '6mo': return 184 * day;   case '1y': return 366 * day;
      case '2y': return 731 * day;    case '5y': return 1827 * day;
      case 'ytd': {
        const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
        return Math.max(day, Date.now() - jan1);   // ≥1 day so early-January still charts
      }
      default: return Infinity;       // max / all
    }
  }
  // Build a quote ({price, prevClose, change, changePct, asOf}) from the last two
  // points of a transformed [{date, value}] series.
  function indicatorQuoteFromSeries(series, source) {
    if (!series || series.length < 2) return null;
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    const price = last.value, prevClose = prev.value;
    return {
      price, prevClose,
      change: price - prevClose,
      changePct: prevClose !== 0 ? (price - prevClose) / prevClose * 100 : 0,
      currency: 'USD', marketState: 'UNKNOWN',
      asOf: last.date,            // the data's own timestamp (release date)
      fetchedAt: Date.now(), source
    };
  }
  // Build a chart history ({points:[{t,p,session}]}) from a transformed series,
  // clipped to the requested range.
  function indicatorHistoryFromSeries(series, range) {
    if (!series || series.length < 2) return null;
    const cutoff = Date.now() - rangeCutoffMs(range);
    const points = [];
    for (const p of series) {
      const t = new Date(p.date + 'T00:00:00Z').getTime();
      if (!isFinite(t) || t < cutoff) continue;
      points.push({ t, p: p.value, session: 'regular' });
    }
    if (points.length < 2) return null;
    return { points, range, fetchedAt: Date.now(), regularStart: null, regularEnd: null };
  }
  async function fetchFredIndicatorQuote(cat) {
    const series = await fetchFredSeries(cat.fredSeries);
    return series ? indicatorQuoteFromSeries(fredTransformSeries(series, cat.fredTransform), 'fred:' + cat.fredSeries) : null;
  }
  async function fetchFredIndicatorHistory(cat, range) {
    const series = await fetchFredSeries(cat.fredSeries);
    return series ? indicatorHistoryFromSeries(fredTransformSeries(series, cat.fredTransform), range) : null;
  }
  // Combined major-central-bank balance sheets (Fed + ECB + BoJ) in USD trillions
  // — a transparent "global liquidity" proxy. ECB (EUR millions) and BoJ
  // (100-million-yen units) are converted with contemporaneous FRED FX so the
  // historical line reflects real USD scale, not just today's exchange rate.
  async function buildGliSeries() {
    const [fed, ecb, boj, eur, jpy] = await Promise.all([
      fetchFredSeries('WALCL'),      // $ millions, weekly
      fetchFredSeries('ECBASSETSW'), // EUR millions, weekly
      fetchFredSeries('JPNASSETS'),  // 100-million-yen, monthly
      fetchFredSeries('DEXUSEU'),    // USD per 1 EUR, daily
      fetchFredSeries('DEXJPUS')     // JPY per 1 USD, daily
    ]);
    if (!fed || !ecb || !boj) return null;
    const out = [];
    for (const row of fed) {
      const d = row.date;
      const eurusd = fredAsOf(eur, d), jpyusd = fredAsOf(jpy, d);
      const ecbV = fredAsOf(ecb, d), bojV = fredAsOf(boj, d);
      if (ecbV == null || bojV == null || !eurusd || !jpyusd) continue;
      const fedT = row.value / 1e6;          // $M → $T
      const ecbT = ecbV * eurusd / 1e6;      // €M → $M → $T
      const bojT = bojV / jpyusd / 1e4;      // 100M-yen → yen → $ → $T
      out.push({ date: d, value: fedT + ecbT + bojT });
    }
    return out.length ? out : null;
  }
  async function fetchGliQuote() {
    return indicatorQuoteFromSeries(await buildGliSeries(), 'gli');
  }
  async function fetchGliHistory(range) {
    return indicatorHistoryFromSeries(await buildGliSeries(), range);
  }
  // 0–100 market-mood gauge from the VIX: low volatility → greed, high → fear.
  // Anchored so VIX ~13 ≈ 72 (greed), ~20 ≈ neutral, ~35 ≈ deep fear. A
  // transparent proxy for the popular Fear & Greed gauge using data we already
  // fetch reliably.
  function vixToMood(vix) {
    if (vix == null || !isFinite(vix)) return null;
    return Math.max(2, Math.min(98, Math.round(72 - 2.76 * (vix - 13))));
  }
  async function fetchVixMoodQuote() {
    const q = await fetchQuote('^VIX', 'US');
    if (!q) return null;
    const price = vixToMood(q.price);
    if (price == null) return null;
    const prevClose = vixToMood(q.prevClose);
    const pc = prevClose != null ? prevClose : price;
    return {
      price, prevClose: pc,
      change: price - pc,
      changePct: pc !== 0 ? (price - pc) / pc * 100 : 0,
      currency: 'USD', marketState: q.marketState || 'UNKNOWN',
      vix: q.price, fetchedAt: Date.now(), source: 'vixmood'
    };
  }
  async function fetchVixMoodHistory(range) {
    const h = await fetchHistory('^VIX', 'US', range);
    if (!h || !Array.isArray(h.points)) return null;
    const points = h.points.map(p => ({ t: p.t, p: vixToMood(p.p), session: p.session }))
                           .filter(p => p.p != null);
    return points.length >= 2 ? { ...h, points } : null;
  }
  // Dispatch a non-Yahoo indicator quote based on its catalog `source`.
  async function fetchIndicatorQuote(cat) {
    if (cat.source === 'fred') return fetchFredIndicatorQuote(cat);
    if (cat.source === 'gli') return fetchGliQuote();
    if (cat.source === 'vixmood') return fetchVixMoodQuote();
    return null;
  }
  async function fetchIndicatorHistory(cat, range) {
    if (cat.source === 'fred') return fetchFredIndicatorHistory(cat, range);
    if (cat.source === 'gli') return fetchGliHistory(range);
    if (cat.source === 'vixmood') return fetchVixMoodHistory(range);
    return null;
  }

  // ─── Yahoo quote / history providers ────────────────────────────────────────
  async function fetchQuote(ticker, market, opts = {}) {
    // Macro indicators sourced outside Yahoo (FRED / liquidity proxy / VIX mood)
    // route here before the Yahoo path. Yahoo-native indicators (^TNX, DXY, ^DJT)
    // carry no `source` and fall through to the normal fetch below.
    const _indCat = cfg.indicatorCatalog && cfg.indicatorCatalog[priceKey(market, ticker)];
    if (_indCat && _indCat.source) return fetchIndicatorQuote(_indCat);
    // SA unit trusts are priced off Morningstar's NAV feed, not Yahoo.
    if (isUnitTrustId(ticker)) return fetchUnitTrustQuote(ticker);
    // Two ranges in parallel-of-attempts: 5d for daily prevClose context, 1d/1m
    // for intraday freshness on actively-traded sessions. We try 5d first because
    // its daily bars feed derivePrevClose; if Yahoo's regularMarketTime on that
    // response is suspiciously old, we re-shoot with the 1m chart which carries
    // a fresher tick on extended-hours sessions.
    const sym = yahooSymbol(ticker, market);
    // A manual refresh passes cacheBust so a unique query param sidesteps any
    // response the shared CORS proxies have cached — that stale-proxy cache is a
    // big reason tapping "refresh" could return the same numbers. Yahoo ignores
    // the extra param, so it's harmless on the auto-poll path (left off there to
    // keep benefiting from proxy caching).
    const cb = opts.cacheBust ? `&_=${Date.now()}` : '';
    const dailyUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d&includePrePost=true${cb}`;
    const dailyText = await fetchViaProxies(dailyUrl);
    let quote = null;
    if (dailyText) {
      try {
        const data = JSON.parse(dailyText);
        const result = data?.chart?.result?.[0];
        if (result) quote = parseYahooQuote(result, market);
      } catch (_e) {}
    }
    // If the regular-session price is older than ~30 minutes, ask Yahoo for the
    // 1-minute intraday chart and prefer its most recent bar — futures and
    // crypto trade nearly 24h, and the 5d-daily endpoint sometimes lags by an
    // hour or more after a session boundary. We keep the prevClose / 52w / etc.
    // from the daily quote since the intraday endpoint doesn't carry those.
    const PRICE_FRESH_MS = 30 * 60 * 1000;
    const ageMs = quote && quote.fetchedAt ? Date.now() - (quote.regularMarketTime || quote.fetchedAt) : Infinity;
    const looksStale = !quote || ageMs > PRICE_FRESH_MS;
    if (looksStale) {
      const intraUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d&includePrePost=true${cb}`;
      const intraText = await fetchViaProxies(intraUrl);
      if (intraText) {
        try {
          const data = JSON.parse(intraText);
          const result = data?.chart?.result?.[0];
          const fresh = result ? parseYahooQuote(result, market) : null;
          // The extended-hours quote can only be derived from the intraday bars
          // (the daily endpoint has no pre/post data); null outside ext hours.
          const ext = result ? deriveIntradayExt(result, market) : null;
          if (fresh && fresh.price > 0) {
            // Unit-mismatch guard for the splice: parseYahooQuote normalises
            // `currency` to the filed market, so a divisor disagreement between
            // the daily and intraday responses is only visible as an
            // implausible gap between the two prices. Skip the splice rather
            // than mix pence onto a pounds quote (a ~100x day move).
            if (quote) {
              if (plausiblePriceMove(quote.price, fresh.price)) {
                // Splice fresher price/change/extended-hours onto the daily quote.
                quote = {
                  ...quote,
                  price: fresh.price,
                  change: fresh.price - quote.prevClose,
                  changePct: quote.prevClose > 0 ? (fresh.price - quote.prevClose) / quote.prevClose * 100 : 0,
                  dayHigh: fresh.dayHigh || quote.dayHigh,
                  dayLow: fresh.dayLow || quote.dayLow,
                  extPrice: ext ? ext.extPrice : null,
                  extChange: ext ? ext.extChange : null,
                  extChangePct: ext ? ext.extChangePct : null,
                  extKind: ext ? ext.extKind : null,
                  extLive: ext ? ext.extLive : null,
                  extAsOf: ext ? ext.extAsOf : null,
                  regularMarketTime: fresh.regularMarketTime || quote.regularMarketTime,
                  // A FINAL (session-over) ext reading carries no marketState — only
                  // a live pre/post session may override the daily quote's state.
                  marketState: (ext && ext.marketState) ? ext.marketState : (fresh.marketState || quote.marketState),
                  fetchedAt: Date.now(),
                  source: 'yahoo+intraday'
                };
              } // implausible gap: keep the daily quote untouched
            } else {
              quote = ext ? { ...fresh, ...ext } : fresh;
            }
          }
        } catch (_e) {}
      }
    }
    if (quote) {
      cacheName(market, ticker, quote.shortName || quote.longName);
      return quote;
    }
    // Stooq fallback only covers US and JSE; other markets just fail here.
    if (market !== 'US' && market !== 'JSE') {
      console.warn(`Price fetch failed for ${ticker} (${market})`);
      return null;
    }
    const stooqUrl = `https://stooq.com/q/d/l/?s=${stooqSymbol(ticker, market)}&i=d`;
    const stooqText = await fetchViaProxies(stooqUrl);
    if (stooqText) {
      const stooqQuote = parseStooqCsv(stooqText, market);
      if (stooqQuote) return stooqQuote;
    }
    console.warn(`Price fetch failed for ${ticker} (${market})`);
    return null;
  }
  // Batches are awaited sequentially (not parallel across all items) so we don't
  // hammer shared CORS proxies with a burst that trips their rate limits — each
  // batch of 4 lets 4 fetchQuote calls race in parallel, then we pause for the
  // next batch. Per-symbol failures are kept out of `results` so callers can
  // treat absence as "no data"; the rejection reason is logged for diagnostics.
  async function fetchQuoteBatch(items, opts = {}) {
    const { onBatch, cacheBust } = opts;
    const results = {};
    const batchSize = 8;
    const runPass = async (list) => {
      for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize);
        const settled = await Promise.allSettled(batch.map(it => fetchQuote(it.ticker, it.market, { cacheBust })));
        // Collect just this batch's fresh quotes so the caller can paint them
        // immediately — the portfolio's "today" move then updates as the first
        // holdings land instead of waiting for the whole sweep (watchlist, ribbon,
        // recommended lists) to finish.
        const fresh = {};
        settled.forEach((r, idx) => {
          const { market, ticker } = batch[idx];
          const key = priceKey(market, ticker);
          if (r.status === 'fulfilled' && r.value) {
            results[key] = r.value;
            fresh[key] = r.value;
          } else if (r.status === 'rejected') {
            console.warn(`fetchQuoteBatch: ${key} rejected`, r.reason);
          }
        });
        if (onBatch && Object.keys(fresh).length) onBatch(fresh);
      }
    };
    await runPass(items);
    // Second pass for any symbols that came back empty. Non-US markets (JSE/LSE/
    // ASX/EU) are queried after the US names and trade outside US hours, so they
    // disproportionately hit shared-proxy rate limits on the first sweep and come
    // back null — a single retry recovers most of them so the watchlist isn't
    // left showing prices for US tickers only.
    const missing = items.filter(it => !results[priceKey(it.market, it.ticker)]);
    if (missing.length) await runPass(missing);
    return results;
  }
  async function fetchQuoteLight(ticker, market) {
    if (isUnitTrustId(ticker)) {
      const q = await fetchUnitTrustQuote(ticker);
      return q ? { price: q.price, changePct: q.changePct, fetchedAt: q.fetchedAt } : null;
    }
    const sym = yahooSymbol(ticker, market);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d&includePrePost=true`;
    const text = await fetchViaProxies(url, { timeoutMs: 6000 });
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      const result = data?.chart?.result?.[0];
      if (!result) return null;
      const meta = result?.meta;
      if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
      cacheName(market, ticker, meta.shortName || meta.longName);
      const currency = meta.currency || (MARKET_CURRENCY[market]?.code || 'USD');
      const divisor = centDivisor(market, currency);
      const price = meta.regularMarketPrice / divisor;
      const bars = buildDailyBars(result, divisor);
      const prevClose = derivePrevClose(bars, price, meta.chartPreviousClose / divisor, market);
      const changePct = prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0;
      return { price, changePct, fetchedAt: Date.now() };
    } catch (_e) { return null; }
  }
  async function fetchQuoteBatchLight(items, onProgress) {
    const results = {};
    // Larger batches finish the whole grid sooner; the light endpoint is a single
    // request per symbol so this stays well within proxy limits. Partial results
    // are streamed back via onProgress so callers can paint as data lands.
    const batchSize = 16;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const settled = await Promise.allSettled(batch.map(it => fetchQuoteLight(it.ticker, it.market)));
      settled.forEach((r, idx) => {
        const { market, ticker } = batch[idx];
        const key = priceKey(market, ticker);
        if (r.status === 'fulfilled' && r.value) results[key] = r.value;
      });
      if (onProgress) onProgress(Math.min(i + batchSize, items.length), items.length, results);
    }
    // Second pass: retry any symbols that failed (proxy hiccups / rate limits) so
    // the heatmap shows daily movement for *all* constituents, not a partial grid.
    const missing = items.filter(it => !results[priceKey(it.market, it.ticker)]);
    if (missing.length) {
      const retrySize = 8;
      for (let i = 0; i < missing.length; i += retrySize) {
        const batch = missing.slice(i, i + retrySize);
        const settled = await Promise.allSettled(batch.map(it => fetchQuoteLight(it.ticker, it.market)));
        settled.forEach((r, idx) => {
          const { market, ticker } = batch[idx];
          if (r.status === 'fulfilled' && r.value) results[priceKey(market, ticker)] = r.value;
        });
        if (onProgress) onProgress(items.length, items.length, results);
      }
    }
    return results;
  }
  function parseHistoryResult(result, ticker, market, r) {
    if (!result) return null;
    const ts = result.timestamp;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(ts) || !Array.isArray(closes)) return null;
    const meta = result.meta || {};
    const currency = meta.currency || (MARKET_CURRENCY[market]?.code || 'USD');
    const divisor = centDivisor(market, currency);
    // Cache the company name off the chart meta while we have it — chart history
    // is often the first call to land for a stock opened from the heatmap.
    cacheName(market, ticker, meta.shortName || meta.longName);
    // Regular-session window (epoch ms). Only meaningful on the intraday (1d)
    // chart, where we classify each bar as pre-market / regular / after-hours so
    // the UI can shade the extended-hours portion distinctly.
    const ctp = meta.currentTradingPeriod || {};
    const regularStart = r === '1d' && ctp.regular?.start ? ctp.regular.start * 1000 : null;
    const regularEnd = r === '1d' && ctp.regular?.end ? ctp.regular.end * 1000 : null;
    const points = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      // Same bar-validity rule as buildDailyBars (pb-core): a zero/negative
      // close is a data hole, not a price — it would spike any chart it lands in.
      if (c == null || !isFinite(c) || c <= 0) continue;
      const tms = ts[i] * 1000;
      let session = 'regular';
      if (r === '1d' && regularStart != null && regularEnd != null) {
        if (tms < regularStart) session = 'pre';
        else if (tms > regularEnd) session = 'post';
      }
      points.push({ t: tms, p: c / divisor, session });
    }
    if (points.length < 2) return null;
    return { points, range: r, fetchedAt: Date.now(), regularStart, regularEnd };
  }
  // Resolve to the first promise that yields a non-null value; null if all do.
  // Lets the two Yahoo hosts race so a dead host/proxy edge costs nothing instead
  // of an 8s timeout before we even try the fallback.
  function firstNonNull(promises) {
    return new Promise((resolve) => {
      let remaining = promises.length;
      if (!remaining) { resolve(null); return; }
      let done = false;
      const settle = (v) => {
        if (done) return;
        if (v != null) { done = true; resolve(v); return; }
        if (--remaining === 0) resolve(null);
      };
      promises.forEach(p => p.then(settle, () => settle(null)));
    });
  }
  async function fetchHistory(ticker, market, range) {
    const _indCat = cfg.indicatorCatalog && cfg.indicatorCatalog[priceKey(market, ticker)];
    if (_indCat && _indCat.source) return fetchIndicatorHistory(_indCat, range || '1y');
    if (isUnitTrustId(ticker)) return fetchUnitTrustHistory(ticker, range);
    const sym = yahooSymbol(ticker, market);
    const r = range || '1y';
    const interval = r === '1d' ? '5m' : (r === '5d' ? '15m' : (r === '1mo' || r === '3mo' || r === '6mo' || r === 'ytd' || r === '1y') ? '1d' : '1wk');
    // Pre/post-market bars belong ONLY on the 1-day chart. Every other range
    // shows actual regular-session trading only.
    const includePrePost = r === '1d' ? '&includePrePost=true' : '';
    // Hit both Yahoo hosts. Proxy edges fail intermittently and one host often
    // works when the other 5xx's.
    const urls = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${r}${includePrePost}`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${r}${includePrePost}`,
    ];
    // One sweep = race both hosts in parallel, first that parses wins.
    const sweep = () => firstNonNull(urls.map(async (u) => {
      const text = await fetchViaProxies(u);
      if (!text) return null;
      try {
        const result = JSON.parse(text)?.chart?.result?.[0];
        return result ? parseHistoryResult(result, ticker, market, r) : null;
      } catch (_e) { return null; }
    }));
    // Second-pass retry when a whole sweep comes back empty — proxy edges fail
    // intermittently, exactly like the quote batchers' missing-symbol retry. The
    // chart used to fetch once and give up, so a transient miss left the card blank
    // until the user toggled ranges; now it self-heals like the live prices do.
    return (await sweep()) || (await sweep());
  }
  // Like parseHistoryResult's 1d branch (same cent-divisor + pre/regular/post
  // classification) but KEEPS per-bar volume, for the Rotation tab's intraday
  // sector lines and its dollar-volume activity proxy. parseHistoryResult stays
  // untouched (its callers don't want the extra field). Volume is a share count,
  // so it is NOT divided by the pence/cents divisor (only prices are). Cumulative
  // % is computed downstream from ratios, so the divisor cancels there anyway —
  // dividing here just keeps prevClose in the same unit as the bars.
  function parseIntradayResult(result, ticker, market) {
    if (!result) return null;
    const ts = result.timestamp;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(ts) || !Array.isArray(closes)) return null;
    const vols = result?.indicators?.quote?.[0]?.volume;
    const meta = result.meta || {};
    const currency = meta.currency || (MARKET_CURRENCY[market]?.code || 'USD');
    const divisor = centDivisor(market, currency);
    cacheName(market, ticker, meta.shortName || meta.longName);
    const ctp = meta.currentTradingPeriod || {};
    const regularStart = ctp.regular?.start ? ctp.regular.start * 1000 : null;
    const regularEnd = ctp.regular?.end ? ctp.regular.end * 1000 : null;
    const points = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      // Same bar-validity rule as buildDailyBars (pb-core): a zero/negative
      // close is a data hole, not a price — it would spike any chart it lands in.
      if (c == null || !isFinite(c) || c <= 0) continue;
      const tms = ts[i] * 1000;
      let session = 'regular';
      if (regularStart != null && regularEnd != null) {
        if (tms < regularStart) session = 'pre';
        else if (tms > regularEnd) session = 'post';
      }
      const v = (Array.isArray(vols) && vols[i] != null && isFinite(vols[i])) ? vols[i] : null;
      points.push({ t: tms, p: c / divisor, v, session });
    }
    if (points.length < 2) return null;
    const prevClose = isFinite(meta.chartPreviousClose) ? meta.chartPreviousClose / divisor : null;
    return { points, prevClose, regularStart, regularEnd, fetchedAt: Date.now() };
  }
  // 5-minute intraday bars for one symbol, for the Rotation tab. Deliberately
  // hits ONE host per sweep (query1, then query2 only if it comes back empty)
  // rather than fetchHistory's race-both-hosts pattern: a non-US index fires
  // ~20-27 of these at once, and racing both hosts would double the burst
  // through the shared CORS-proxy pool. fetchViaProxies still applies the global
  // pLimit(8) + in-flight de-dupe.
  async function fetchIntradayBars(ticker, market) {
    const sym = yahooSymbol(ticker, market);
    const path = `/v8/finance/chart/${sym}?interval=5m&range=1d&includePrePost=true`;
    const sweep = async (host) => {
      const text = await fetchViaProxies(`https://${host}.finance.yahoo.com${path}`);
      if (!text) return null;
      try {
        const result = JSON.parse(text)?.chart?.result?.[0];
        return result ? parseIntradayResult(result, ticker, market) : null;
      } catch (_e) { return null; }
    };
    return (await sweep('query1')) || (await sweep('query2'));
  }

  // ─── Hot stocks (watchlist suggestions) ─────────────────────────────────────
  // "What's moving right now" for the watchlist's suggestion strip: Yahoo's
  // trending-tickers feed plus two predefined screeners (day gainers / most
  // actives), merged and rank-weighted. Every source is best-effort — the proxy
  // chain flakes and Yahoo occasionally auth-walls the screener endpoint — so
  // each returns [] on any failure and the merge works with whatever landed.
  // Symbols are normalised to the app's {ticker, market} shape: trending is the
  // US region feed, so plain symbols book as US; crypto pairs (BTC-USD) book on
  // CRYPTO under the bare base symbol (same rule as the ticker search); indices,
  // futures/FX and exchange-suffixed listings are dropped.
  function hotSymbolToItem(symbol, name) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym || /[\^=\/]/.test(sym)) return null;                 // ^GSPC, ES=F, EURUSD=X
    const cm = sym.match(/^([A-Z0-9]{2,10})-USD$/);
    if (cm) return { ticker: cm[1], market: 'CRYPTO', name: name || null };
    if (sym.includes('.')) return null;                           // ABC.JO / XYZ.L etc.
    if (!/^[A-Z0-9]{1,7}(-[A-Z])?$/.test(sym)) return null;       // allow BRK-B class shares
    return { ticker: sym, market: 'US', name: name || null };
  }
  async function fetchJsonViaProxies(url, timeoutMs) {
    const text = await fetchViaProxies(url, { timeoutMs: timeoutMs || 9000 });
    if (!text) return null;
    try { return JSON.parse(text); } catch (_e) { return null; }
  }
  async function fetchTrendingSymbols(count) {
    const n = count || 20;
    for (const host of ['query1', 'query2']) {
      const data = await fetchJsonViaProxies(`https://${host}.finance.yahoo.com/v1/finance/trending/US?count=${n}`);
      const quotes = data?.finance?.result?.[0]?.quotes;
      if (Array.isArray(quotes) && quotes.length) return quotes.map(q => q && q.symbol).filter(Boolean);
    }
    return [];
  }
  // Predefined-screener rows -> { symbol, name, changePct }. changePct tolerates
  // both formatted:false (plain number) and the {raw} wrapper Yahoo sometimes
  // returns anyway.
  async function fetchScreenerSymbols(scrId, count) {
    const n = count || 15;
    for (const host of ['query1', 'query2']) {
      const url = `https://${host}.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${encodeURIComponent(scrId)}&count=${n}&formatted=false`;
      const data = await fetchJsonViaProxies(url);
      const quotes = data?.finance?.result?.[0]?.quotes;
      if (Array.isArray(quotes) && quotes.length) {
        return quotes.map(q => {
          if (!q || !q.symbol) return null;
          const rc = q.regularMarketChangePercent;
          const pct = typeof rc === 'number' ? rc : (rc && typeof rc.raw === 'number' ? rc.raw : null);
          return { symbol: q.symbol, name: q.shortName || q.longName || null, changePct: pct };
        }).filter(Boolean);
      }
    }
    return [];
  }
  async function fetchHotStocks() {
    const [trend, gainers, actives] = await Promise.all([
      fetchTrendingSymbols(20).catch(() => []),
      fetchScreenerSymbols('day_gainers', 15).catch(() => []),
      fetchScreenerSymbols('most_actives', 15).catch(() => []),
    ]);
    const byKey = new Map();
    // Weight per source, decayed by list rank; a symbol on several lists sums
    // its weights, so "trending AND a top gainer" floats to the front.
    const fold = (list, weight, decay) => {
      (list || []).forEach((entry, i) => {
        const isObj = entry != null && typeof entry === 'object';
        const item = hotSymbolToItem(isObj ? entry.symbol : entry, isObj ? entry.name : null);
        if (!item) return;
        const key = priceKey(item.market, item.ticker);
        const rankBoost = weight * Math.max(0.4, 1 - i * decay);
        const pct = isObj && typeof entry.changePct === 'number' && isFinite(entry.changePct) ? entry.changePct : null;
        const ex = byKey.get(key);
        if (ex) {
          ex.hotScore += rankBoost;
          if (ex.name == null && item.name) ex.name = item.name;
          if (ex.changePct == null && pct != null) ex.changePct = pct;
        } else {
          byKey.set(key, { ...item, changePct: pct, hotScore: rankBoost });
        }
      });
    };
    fold(trend, 3, 0.04);
    fold(gainers, 2.5, 0.05);
    fold(actives, 1.5, 0.05);
    const all = Array.from(byKey.values()).sort((a, b) => b.hotScore - a.hotScore);
    // Cap crypto so a meme-coin day doesn't crowd out the equity suggestions.
    let cryptoSeen = 0;
    const out = all.filter(o => o.market !== 'CRYPTO' || ++cryptoSeen <= 2).slice(0, 24);
    out.forEach(o => { if (o.name) cacheName(o.market, o.ticker, o.name); });
    return out;
  }

  const PBData = {
    configure,
    fetchViaProxies, looksLikeProxyError, orderedProxies,
    fetchQuote, fetchQuoteBatch, fetchQuoteLight, fetchQuoteBatchLight, fetchHistory,
    parseIntradayResult, fetchIntradayBars,
    fetchTrendingSymbols, fetchScreenerSymbols, fetchHotStocks,
    parseStooqCsv, stooqSymbol,
    isUnitTrustId, searchUnitTrusts, fetchUnitTrustQuote, fetchUnitTrustHistory,
    fetchIndicatorQuote, fetchIndicatorHistory,
    cacheName, cachedName,
    _setLastGoodProxy,
    get _lastGoodProxy() { return lastGoodProxy; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PBData;
  if (typeof globalThis !== 'undefined') globalThis.PBData = PBData;
})();
