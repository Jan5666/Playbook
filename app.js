"use strict";

const {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback
} = React;
const DATA = window.PB_DATA;
const LS = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  },
  set(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      console.warn('LS.set failed:', e);
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  }
};
function usePersistedState(key, defaultValue) {
  const [value, setValue] = useState(() => LS.get(key, defaultValue));
  useEffect(() => {
    LS.set(key, value);
  }, [key, value]);
  return [value, setValue];
}
// ─────────────────────────────────────────────────────────────────────────
// Body scroll lock. When a modal/overlay opens we pin the page with
// position:fixed (the only reliable lock on iOS) and restore the exact scroll
// offset on close. This is what kills the "whole app jumps" glitch when a
// stock card closes: the background never scrolls behind the sheet, and we
// scroll back to the precise pixel afterwards. Reference-counted so stacked
// overlays (sector popup over fullscreen heatmap) don't fight each other, and
// scrollbar-width is compensated so desktop doesn't shift horizontally.
let _scrollLockCount = 0;
let _savedScrollY = 0;
function lockBodyScroll() {
  if (_scrollLockCount === 0 && typeof document !== 'undefined') {
    _savedScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    const b = document.body;
    b.style.position = 'fixed';
    b.style.top = `-${_savedScrollY}px`;
    b.style.left = '0';
    b.style.right = '0';
    b.style.width = '100%';
    if (sbw > 0) b.style.paddingRight = `calc(var(--safe-right) + ${sbw}px)`;
    b.classList.add('pb-scroll-locked');
  }
  _scrollLockCount++;
}
function unlockBodyScroll() {
  _scrollLockCount = Math.max(0, _scrollLockCount - 1);
  if (_scrollLockCount === 0 && typeof document !== 'undefined') {
    const b = document.body;
    b.style.position = '';
    b.style.top = '';
    b.style.left = '';
    b.style.right = '';
    b.style.width = '';
    b.style.paddingRight = '';
    b.classList.remove('pb-scroll-locked');
    // Restore scroll without smooth behaviour so it's a single instant frame.
    window.scrollTo(0, _savedScrollY);
  }
}
function useBodyScrollLock(active = true) {
  useEffect(() => {
    if (active === false) return undefined;
    lockBodyScroll();
    return unlockBodyScroll;
  }, [active]);
}
// Calls `refresh` immediately, then on an interval, and on tab-visible if
// the cached data is older than `staleMs`. The callback is held in a ref so
// effect deps don't churn when refresh closes over fresh state — this avoids
// the stale-closure trap where the interval keeps calling an old refresh fn.
// `resetKey` lets callers force a re-mount (e.g. when the watched symbol set
// changes) so a fresh immediate fetch happens.
function usePolledRefresh(refresh, intervalMs, staleMs, resetKey) {
  const refreshRef = useRef(refresh);
  const lastRunRef = useRef(0);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => {
    const run = () => { lastRunRef.current = Date.now(); refreshRef.current(); };
    run();
    const interval = setInterval(() => { if (!document.hidden) run(); }, intervalMs);
    const onVisible = () => {
      if (document.hidden) return;
      const age = Date.now() - lastRunRef.current;
      if (age > staleMs) run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, staleMs, resetKey]);
}
// Per-key TTL cache: stores {data, loading, fetchedAt} per key. `load(key, fetcher)`
// returns the cached value when fresh (Date.now() - fetchedAt < ttlMs), de-dupes
// concurrent calls for the same key via an in-flight map, and otherwise marks
// the entry as loading (preserving any stale data so UI can show a soft
// refresh) before awaiting the fetcher. The cacheRef mirror lets `load`
// keep a stable identity across cache updates so children memoizing on it
// don't re-render on every fetch.
function useTtlCache(ttlMs) {
  const [cache, setCache] = useState({});
  const cacheRef = useRef(cache);
  const inFlight = useRef({});
  useEffect(() => { cacheRef.current = cache; }, [cache]);
  const load = useCallback(async (key, fetcher) => {
    const existing = cacheRef.current[key];
    if (existing && existing.data && Date.now() - existing.fetchedAt < ttlMs) return existing.data;
    if (inFlight.current[key]) return inFlight.current[key];
    setCache(prev => ({
      ...prev,
      [key]: { data: existing?.data || null, loading: true, fetchedAt: existing?.fetchedAt || 0 }
    }));
    const promise = (async () => {
      try {
        const data = await fetcher();
        setCache(prev => ({
          ...prev,
          [key]: { data, loading: false, fetchedAt: Date.now() }
        }));
        return data;
      } finally {
        delete inFlight.current[key];
      }
    })();
    inFlight.current[key] = promise;
    return promise;
  }, [ttlMs]);
  return [cache, load];
}
function useSwipeDownToClose(panelRef, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const isMobileLayout = () => window.matchMedia('(max-width: 639px)').matches;
    const getBackdrop = () => panel.parentElement && panel.parentElement.querySelector('.modal-backdrop');
    // iOS-sheet easing — quick, decelerating, no overshoot.
    const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
    let startY = 0;       // y where the actual drag began (transform anchor)
    let originY = 0;      // y where the finger first touched
    let prevY = 0;
    let dragging = false;
    let velocity = 0;
    let lastT = 0;
    let panelH = 0;
    const DRAG_THRESHOLD = 6;
    const onTouchStart = (e) => {
      if (!isMobileLayout() || e.touches.length !== 1) return;
      originY = prevY = e.touches[0].clientY;
      dragging = false;
      velocity = 0;
      lastT = Date.now();
      panelH = panel.offsetHeight || window.innerHeight;
    };
    const onTouchMove = (e) => {
      if (!isMobileLayout()) return;
      const y = e.touches[0].clientY;
      if (!dragging) {
        // Only start a close-drag from the top of the panel pulling down.
        if (panel.scrollTop > 0 || y - originY <= 0) { originY = y; prevY = y; return; }
        if (y - originY < DRAG_THRESHOLD) return;
        dragging = true;
        // Anchor the drag here so the panel tracks the finger 1:1 with no jump.
        startY = y;
        // Kill the entrance animation permanently. Otherwise, when we later
        // remove `.swiping` (which set `animation:none`), the base panel's
        // `slide-up` keyframes re-run and the sheet jumps back up before
        // closing — the glitch the user reported.
        panel.style.animation = 'none';
        panel.classList.add('swiping');
      }
      const now = Date.now();
      const dt = now - lastT;
      if (dt > 0) velocity = (y - prevY) / dt;
      prevY = y;
      lastT = now;
      const drag = Math.max(0, y - startY);
      panel.style.transform = `translateY(${drag}px)`;
      const bd = getBackdrop();
      if (bd) bd.style.opacity = String(1 - Math.min(1, drag / panelH) * 0.7);
      if (e.cancelable) e.preventDefault();
    };
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      const drag = Math.max(0, prevY - startY);
      panel.classList.remove('swiping');
      const bd = getBackdrop();
      const shouldClose = drag > panelH * 0.28 || (drag > 48 && velocity > 0.45);
      if (shouldClose) {
        panel.style.transition = `transform 0.26s ${EASE}`;
        panel.style.transform = 'translateY(100%)';
        if (bd) { bd.style.transition = 'opacity 0.26s ease'; bd.style.opacity = '0'; }
        let done = false;
        const cb = () => {
          if (done) return;
          done = true;
          // Trigger the close (which unmounts the modal) while the panel is
          // still translated off-screen. We must NOT reset the transform until
          // we KNOW the close failed to unmount the panel. The old code did this
          // on a fixed 80ms timer, which races React's commit: when the stock
          // card is heavy (charts/fundamentals) or the scroll-restore stalls the
          // frame, the unmount lands later than 80ms, so the panel first slides
          // back into view and only then disappears — the "closes, flickers on,
          // closes again" glitch. Instead, watch the DOM: the instant React
          // removes the panel we stand down and leave it off-screen (no flicker).
          // Only a genuinely guarded onClose (e.g. import review ignores swipe)
          // leaves the node attached, and a long fallback glides it home.
          closeRef.current();
          let settled = false;
          let guard = 0;
          const standDown = () => {
            if (settled) return; settled = true;
            try { obs.disconnect(); } catch (_e) {}
            clearTimeout(guard);
          };
          const obs = typeof MutationObserver !== 'undefined'
            ? new MutationObserver(() => { if (!panel.isConnected) standDown(); })
            : null;
          if (obs) { try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (_e) {} }
          // Fallback: if the panel is still mounted well after the close (guarded
          // onClose, or no MutationObserver support), glide it back into place.
          guard = setTimeout(() => {
            if (settled) return; settled = true;
            try { obs && obs.disconnect(); } catch (_e) {}
            if (!panel.isConnected) return;
            panel.style.transition = `transform 0.3s ${EASE}`;
            panel.style.transform = '';
            if (bd && bd.isConnected) { bd.style.transition = 'opacity 0.3s ease'; bd.style.opacity = ''; }
          }, 600);
        };
        panel.addEventListener('transitionend', cb, { once: true });
        setTimeout(cb, 320);
      } else {
        panel.style.transition = `transform 0.4s ${EASE}`;
        panel.style.transform = '';
        if (bd) { bd.style.transition = 'opacity 0.3s ease'; bd.style.opacity = ''; }
        const clear = () => { panel.style.transition = ''; if (bd) bd.style.transition = ''; };
        panel.addEventListener('transitionend', clear, { once: true });
        setTimeout(clear, 440);
      }
    };
    panel.addEventListener('touchstart', onTouchStart, { passive: true });
    panel.addEventListener('touchmove', onTouchMove, { passive: false });
    panel.addEventListener('touchend', finish);
    panel.addEventListener('touchcancel', finish);
    return () => {
      panel.removeEventListener('touchstart', onTouchStart);
      panel.removeEventListener('touchmove', onTouchMove);
      panel.removeEventListener('touchend', finish);
      panel.removeEventListener('touchcancel', finish);
    };
  }, [panelRef]);
}
const MARKET_CURRENCY = {
  US:   { sym: '$',   code: 'USD', label: 'USD' },
  JSE:  { sym: 'R',   code: 'ZAR', label: 'ZAR' },
  TFSA: { sym: 'R',   code: 'ZAR', label: 'ZAR' },
  LSE:  { sym: '\u00a3',  code: 'GBP', label: 'GBP' },
  ASX:  { sym: 'A$',  code: 'AUD', label: 'AUD' },
  FRA:  { sym: '\u20ac',  code: 'EUR', label: 'EUR' },
  PAR:  { sym: '\u20ac',  code: 'EUR', label: 'EUR' },
  AMS:  { sym: '\u20ac',  code: 'EUR', label: 'EUR' },
};
const MARKETS = [
  { value: 'US',   label: 'US',   country: 'USA',          exchange: 'NYSE / NASDAQ' },
  { value: 'JSE',  label: 'JSE',  country: 'South Africa',  exchange: 'JSE' },
  { value: 'TFSA', label: 'TFSA', country: 'South Africa',  exchange: 'JSE (Tax-Free)' },
  { value: 'LSE', label: 'LSE', country: 'UK',          exchange: 'London (LSE)' },
  { value: 'ASX', label: 'ASX', country: 'Australia',   exchange: 'ASX' },
  { value: 'FRA', label: 'FRA', country: 'Germany',     exchange: 'XETRA Frankfurt' },
  { value: 'PAR', label: 'PAR', country: 'France',      exchange: 'Euronext Paris' },
  { value: 'AMS', label: 'AMS', country: 'Netherlands', exchange: 'Euronext Amsterdam' },
];
// JSE and TFSA are the same underlying exchange — a TFSA account just tracks
// JSE-listed shares (.JO) tax-free — so a JSE-listed search result is valid for
// either account. Used so picking a listing never silently flips the account
// the user explicitly chose (e.g. TFSA → JSE) when both map to the same listing.
function sameUnderlyingExchange(a, b) {
  if (a === b) return true;
  const norm = m => (m === 'TFSA' ? 'JSE' : m);
  return norm(a) === norm(b);
}
const DISPLAY_CURRENCIES = [
  { code: 'USD', sym: '$',  label: 'US Dollar' },
  { code: 'ZAR', sym: 'R',  label: 'South African Rand' },
  { code: 'GBP', sym: '\u00a3', label: 'British Pound' },
  { code: 'AUD', sym: 'A$', label: 'Australian Dollar' },
  { code: 'EUR', sym: '\u20ac', label: 'Euro' },
];
const CURRENCY_SYMBOLS = { USD: '$', ZAR: 'R', GBP: '\u00a3', AUD: 'A$', EUR: '\u20ac' };
const RIBBON_CATALOG = [
  { key: 'US:^SPX',    ticker: '^SPX',    market: 'US', label: 'S&P 500',         short: 'S&P',  decimals: 0, invertColor: false },
  { key: 'US:^VIX',    ticker: '^VIX',    market: 'US', label: 'VIX',             short: 'VIX',  decimals: 2, invertColor: true  },
  { key: 'US:^DJI',    ticker: '^DJI',    market: 'US', label: 'Dow Jones',       short: 'DOW',  decimals: 0, invertColor: false },
  { key: 'US:^IXIC',   ticker: '^IXIC',   market: 'US', label: 'Nasdaq',          short: 'NDQ',  decimals: 0, invertColor: false },
  { key: 'US:^FTSE',   ticker: '^FTSE',   market: 'US', label: 'FTSE 100',        short: 'FTSE', decimals: 0, invertColor: false },
  { key: 'US:^N225',   ticker: '^N225',   market: 'US', label: 'Nikkei 225',      short: 'N225', decimals: 0, invertColor: false },
  { key: 'US:^GDAXI',  ticker: '^GDAXI',  market: 'US', label: 'DAX',             short: 'DAX',  decimals: 0, invertColor: false },
  { key: 'US:GC=F',    ticker: 'GC=F',    market: 'US', label: 'Gold',            short: 'GOLD', decimals: 2, invertColor: false },
  { key: 'US:SI=F',    ticker: 'SI=F',    market: 'US', label: 'Silver',          short: 'SLVR', decimals: 2, invertColor: false },
  { key: 'US:CL=F',    ticker: 'CL=F',    market: 'US', label: 'Crude Oil (WTI)', short: 'OIL',  decimals: 2, invertColor: false },
  { key: 'US:BZ=F',    ticker: 'BZ=F',    market: 'US', label: 'Brent Crude',     short: 'BRNT', decimals: 2, invertColor: false },
  { key: 'US:NG=F',    ticker: 'NG=F',    market: 'US', label: 'Natural Gas',     short: 'NGAS', decimals: 3, invertColor: false },
  { key: 'US:HG=F',    ticker: 'HG=F',    market: 'US', label: 'Copper',          short: 'CPPR', decimals: 3, invertColor: false },
  { key: 'US:PL=F',    ticker: 'PL=F',    market: 'US', label: 'Platinum',        short: 'PLAT', decimals: 2, invertColor: false },
  { key: 'US:BTC-USD', ticker: 'BTC-USD', market: 'US', label: 'Bitcoin',         short: 'BTC',  decimals: 0, invertColor: false },
  { key: 'US:ETH-USD', ticker: 'ETH-USD', market: 'US', label: 'Ethereum',        short: 'ETH',  decimals: 0, invertColor: false },
];
const RIBBON_CATALOG_MAP = Object.fromEntries(RIBBON_CATALOG.map(r => [r.key, r]));
const DEFAULT_RIBBON_ITEMS = ['US:^SPX', 'US:^VIX'];
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
// FX endpoints often allow direct CORS; fall back to proxies only on failure.
const FX_PROXIES = [
  url => url,
  url => `https://corsmirror.com/v1?url=${encodeURIComponent(url)}`,
  url => `https://api.cors.lol/?url=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
];
// Yahoo reports JSE in cents (ZAc) and LSE in pence (GBp / GBX) for some
// instruments. Values reported in those units must be divided by 100 to get
// the natural unit (rand, pound). Matching is case-insensitive and accepts
// the pence-suffix forms because Yahoo isn't perfectly consistent.
function priceKey(market, ticker) {
  return market + ':' + ticker;
}
// ─────────────────────────────────────────────────────────────────────────
// Company-name resolution. Heatmap constituents (and many Yahoo-searched
// tickers) ship without a curated name, so a bare ticker like AVGO would
// otherwise show with no company name. We keep a persistent market:ticker →
// name map that fills from every live quote we see (full + light), seeded with
// a curated map of the most-browsed names so they read correctly on first
// paint before any network call lands.
// ─────────────────────────────────────────────────────────────────────────
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
  try { Object.assign(seed, LS.get(NAME_CACHE_KEY, {}) || {}); } catch (_e) {}
  return seed;
})();
let _nameCacheDirty = false;
function _flushNameCache() {
  if (!_nameCacheDirty) return;
  _nameCacheDirty = false;
  // Don't persist the curated seed — only learned names — to keep the blob small.
  const learned = {};
  for (const k in NAME_CACHE) { if (CURATED_NAMES[k] !== NAME_CACHE[k]) learned[k] = NAME_CACHE[k]; }
  LS.set(NAME_CACHE_KEY, learned);
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
function centDivisor(market, currency) {
  const raw = currency || '';
  const c = raw.toUpperCase();
  const isJseCent = (market === 'JSE' || market === 'TFSA') && (c === 'ZAC' || c === 'ZAR' && /[cC]$/.test(raw));
  const isLseGBX = market === 'LSE' && c === 'GBX';
  // Yahoo sometimes returns "GBp" (mixed case) for pence-denominated LSE
  // instruments, but also plain "GBP" for pound-denominated ones. Treat any
  // lowercase-p suffix as pence, and conservatively treat bare "GBP" on LSE
  // tickers that report via the .L suffix as pence too — the chart endpoint
  // almost always returns values in pence for LSE.
  const isLseGBp = market === 'LSE' && (c === 'GBP' && /[pP]$/.test(raw));
  const isLseBareGBP = market === 'LSE' && raw === 'GBP';
  return (isJseCent || isLseGBX || isLseGBp || isLseBareGBP) ? 100 : 1;
}
function yahooSymbol(ticker, market) {
  if (market === 'JSE' || market === 'TFSA') return ticker + '.JO';
  if (market === 'LSE') return ticker + '.L';
  if (market === 'ASX') return ticker + '.AX';
  if (market === 'FRA') return ticker + '.F';
  if (market === 'PAR') return ticker + '.PA';
  if (market === 'AMS') return ticker + '.AS';
  if (ticker === '^SPX') return '%5EGSPC';
  if (ticker === '^VIX') return '%5EVIX';
  if (ticker === '^GSPC') return '%5EGSPC';
  return encodeURIComponent(ticker);
}
function stooqSymbol(ticker, market) {
  if (market === 'JSE' || market === 'TFSA') return ticker.toLowerCase() + '.jo';
  if (ticker === '^SPX' || ticker === '^GSPC') return '%5Espx';
  if (ticker === '^VIX') return '%5Evix';
  return ticker.toLowerCase().replace('-', '.') + '.us';
}
// Build a [{t, p}] daily-bar series from a Yahoo chart result, applying the
// cent-unit divisor so callers can reason in natural units (rand, pound).
function buildDailyBars(result, divisor) {
  const ts = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const bars = [];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    if (typeof c !== 'number' || !isFinite(c) || c <= 0) continue;
    const tsec = ts[i];
    bars.push({ t: typeof tsec === 'number' ? tsec * 1000 : null, p: c / divisor });
  }
  return bars;
}
// Yahoo's regularMarketPreviousClose is often stale, in the wrong unit, or
// missing — which produces an inflated %-change. Walk the daily bars
// backwards to find the most recent bar that isn't today and isn't ~equal to
// the live price; prefer that bar whenever its ratio to live looks sane.
// The sanity window is intentionally wide (0.01x–100x) to accept genuine
// extreme moves like flash crashes or halts — the only purpose is to reject
// obviously wrong data (e.g. cents-vs-dollars unit mismatch), not real moves.
function derivePrevClose(bars, livePrice, fallback) {
  if (!Array.isArray(bars) || bars.length < 2 || !(livePrice > 0)) return fallback;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  let candidate = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    const isToday = b.t != null && b.t >= todayMs;
    const equalsLive = Math.abs(b.p - livePrice) / livePrice < 0.01;
    if (isToday || equalsLive) continue;
    candidate = b.p;
    break;
  }
  if (candidate == null) candidate = bars[bars.length - 1].p;
  if (!(candidate > 0) || !isFinite(candidate)) return fallback;
  const ratio = candidate / livePrice;
  if (ratio > 0.01 && ratio < 100) return candidate;
  return fallback;
}
// Decide which extended-hours quote (pre or post) to surface based on Yahoo's
// market-state hint and which of pre/post differ meaningfully from the
// regular price. All inputs must already be in natural units.
function pickExtendedHours(meta, regularPrice, preMarketPrice, postMarketPrice) {
  const hasPre = preMarketPrice && regularPrice > 0 && Math.abs(preMarketPrice - regularPrice) > 0.001;
  const hasPost = postMarketPrice && regularPrice > 0 && Math.abs(postMarketPrice - regularPrice) > 0.001;
  const state = meta.marketState || 'UNKNOWN';
  const isPreState = state === 'PRE' || state === 'PREPRE';
  const isPostState = state === 'POST' || state === 'POSTPOST' || state === 'CLOSED';
  let extPrice = null, extKind = null;
  if (isPreState && hasPre) { extPrice = preMarketPrice; extKind = 'pre'; }
  else if (isPostState && hasPost) { extPrice = postMarketPrice; extKind = 'post'; }
  else if (hasPre && !hasPost) { extPrice = preMarketPrice; extKind = 'pre'; }
  else if (hasPost && !hasPre) { extPrice = postMarketPrice; extKind = 'post'; }
  else if (hasPre && hasPost) { extPrice = preMarketPrice; extKind = 'pre'; }
  if (extPrice == null) return { extPrice: null, extChange: null, extChangePct: null, extKind: null };
  return {
    extPrice,
    extChange: extPrice - regularPrice,
    extChangePct: (extPrice - regularPrice) / regularPrice * 100,
    extKind
  };
}
// Convert one Yahoo chart result into the app's normalized quote shape.
// Returns null if the response shape is unusable so the caller can fall
// through to the next proxy or data source.
function parseYahooQuote(result, market) {
  const meta = result?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
  let currency = meta.currency || (MARKET_CURRENCY[market]?.code || 'USD');
  const divisor = centDivisor(market, currency);
  let price = meta.regularMarketPrice;
  let prevClose = meta.regularMarketPreviousClose != null ? meta.regularMarketPreviousClose
    : (meta.previousClose != null ? meta.previousClose
    : (meta.chartPreviousClose != null ? meta.chartPreviousClose : price));
  let yearHigh = meta.fiftyTwoWeekHigh || null;
  let yearLow = meta.fiftyTwoWeekLow || null;
  let dayHigh = meta.regularMarketDayHigh || null;
  let dayLow = meta.regularMarketDayLow || null;
  const volume = meta.regularMarketVolume || null;
  let preMarketPrice = meta.preMarketPrice || null;
  let postMarketPrice = meta.postMarketPrice || null;
  if (divisor !== 1) {
    price = price / divisor;
    prevClose = prevClose / divisor;
    if (yearHigh) yearHigh = yearHigh / divisor;
    if (yearLow) yearLow = yearLow / divisor;
    if (dayHigh) dayHigh = dayHigh / divisor;
    if (dayLow) dayLow = dayLow / divisor;
    if (preMarketPrice) preMarketPrice = preMarketPrice / divisor;
    if (postMarketPrice) postMarketPrice = postMarketPrice / divisor;
    currency = market === 'JSE' ? 'ZAR' : 'GBP';
  }
  try {
    prevClose = derivePrevClose(buildDailyBars(result, divisor), price, prevClose);
  } catch (_e) {}
  const ext = pickExtendedHours(meta, price, preMarketPrice, postMarketPrice);
  return {
    price,
    prevClose,
    change: price - prevClose,
    changePct: prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0,
    yearHigh,
    yearLow,
    dayHigh,
    dayLow,
    volume,
    preMarketPrice,
    postMarketPrice,
    extPrice: ext.extPrice,
    extChange: ext.extChange,
    extChangePct: ext.extChangePct,
    extKind: ext.extKind,
    currency,
    marketState: meta.marketState || 'UNKNOWN',
    shortName: meta.shortName || meta.longName || null,
    longName: meta.longName || meta.shortName || null,
    // Upstream timestamp (in ms) of the most recent price tick. Callers use
    // this to detect stale data — fetchedAt only tracks when WE saw it, which
    // can drift far from the actual market clock when an upstream feed lags.
    regularMarketTime: typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : null,
    fetchedAt: Date.now(),
    source: 'yahoo'
  };
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
async function fetchQuote(ticker, market) {
  // Two ranges in parallel-of-attempts: 5d for daily prevClose context, 1d/1m
  // for intraday freshness on actively-traded sessions. We try 5d first because
  // its daily bars feed derivePrevClose; if Yahoo's regularMarketTime on that
  // response is suspiciously old, we re-shoot with the 1m chart which carries
  // a fresher tick on extended-hours sessions.
  const sym = yahooSymbol(ticker, market);
  const dailyUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d&includePrePost=true`;
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
    const intraUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d&includePrePost=true`;
    const intraText = await fetchViaProxies(intraUrl);
    if (intraText) {
      try {
        const data = JSON.parse(intraText);
        const result = data?.chart?.result?.[0];
        const fresh = result ? parseYahooQuote(result, market) : null;
        if (fresh && fresh.price > 0) {
          if (quote) {
            // Splice fresher price/change/extended-hours onto the daily quote.
            quote = {
              ...quote,
              price: fresh.price,
              change: fresh.price - quote.prevClose,
              changePct: quote.prevClose > 0 ? (fresh.price - quote.prevClose) / quote.prevClose * 100 : 0,
              dayHigh: fresh.dayHigh || quote.dayHigh,
              dayLow: fresh.dayLow || quote.dayLow,
              preMarketPrice: fresh.preMarketPrice || quote.preMarketPrice,
              postMarketPrice: fresh.postMarketPrice || quote.postMarketPrice,
              extPrice: fresh.extPrice || quote.extPrice,
              extChange: fresh.extChange != null ? fresh.extChange : quote.extChange,
              extChangePct: fresh.extChangePct != null ? fresh.extChangePct : quote.extChangePct,
              extKind: fresh.extKind || quote.extKind,
              regularMarketTime: fresh.regularMarketTime || quote.regularMarketTime,
              marketState: fresh.marketState || quote.marketState,
              fetchedAt: Date.now(),
              source: 'yahoo+intraday'
            };
          } else {
            quote = fresh;
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
async function fetchQuoteBatch(items) {
  const results = {};
  const batchSize = 8;
  const runPass = async (list) => {
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      const settled = await Promise.allSettled(batch.map(it => fetchQuote(it.ticker, it.market)));
      settled.forEach((r, idx) => {
        const { market, ticker } = batch[idx];
        const key = priceKey(market, ticker);
        if (r.status === 'fulfilled' && r.value) {
          results[key] = r.value;
        } else if (r.status === 'rejected') {
          console.warn(`fetchQuoteBatch: ${key} rejected`, r.reason);
        }
      });
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
    const prevClose = derivePrevClose(bars, price, meta.chartPreviousClose / divisor);
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
    if (c == null || !isFinite(c)) continue;
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
async function fetchHistory(ticker, market, range) {
  const sym = yahooSymbol(ticker, market);
  const r = range || '1y';
  const interval = r === '1d' ? '5m' : (r === '5d' ? '15m' : (r === '1mo' || r === '3mo' || r === '6mo' || r === '1y') ? '1d' : '1wk');
  // Pre/post-market bars belong ONLY on the 1-day chart. Every other range
  // shows actual regular-session trading only.
  const includePrePost = r === '1d' ? '&includePrePost=true' : '';
  // Try both Yahoo hosts; proxy edges fail intermittently and one host often
  // works when the other 5xx's, so a single attempt left charts blank too often.
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${r}${includePrePost}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${r}${includePrePost}`,
  ];
  for (let attempt = 0; attempt < urls.length; attempt++) {
    const text = await fetchViaProxies(urls[attempt]);
    if (!text) continue;
    try {
      const data = JSON.parse(text);
      const result = data?.chart?.result?.[0];
      const parsed = result ? parseHistoryResult(result, ticker, market, r) : null;
      if (parsed) return parsed;
    } catch (_e) {}
  }
  return null;
}
async function fetchNewsForTicker(ticker, market) {
  const yahooSym = yahooSymbol(ticker, market);
  const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${yahooSym}&region=US&lang=en-US`;
  const proxied = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;
  try {
    const res = await fetch(proxied);
    const data = await res.json();
    if (data.status === 'ok' && Array.isArray(data.items)) {
      return data.items.slice(0, 12).map(it => ({
        title: it.title,
        link: it.link,
        source: it.author || 'Yahoo Finance',
        pubDate: it.pubDate
      }));
    }
  } catch (e) {}
  return [];
}
async function fetchFundamentalsYahoo(ticker, market) {
  const sym = yahooSymbol(ticker, market);
  const modules = 'summaryDetail,defaultKeyStatistics,financialData,calendarEvents,price,assetProfile';
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const yahooUrls = hosts.map(h => `https://${h}/v10/finance/quoteSummary/${sym}?modules=${modules}`);
  let divisor = 1;
  for (const yahooUrl of yahooUrls) {
    const text = await fetchViaProxies(yahooUrl);
    if (!text) continue;
    let r;
    try {
      const data = JSON.parse(text);
      r = data?.quoteSummary?.result?.[0];
    } catch (_e) { continue; }
    if (!r) continue;
    try {
      const sd = r.summaryDetail || {};
      const ks = r.defaultKeyStatistics || {};
      const fd = r.financialData || {};
      const ce = r.calendarEvents || {};
      const pr = r.price || {};
      const ap = r.assetProfile || {};
      const curr = pr.currency || sd.currency || '';
      divisor = centDivisor(market, curr);
      const v = x => (x && typeof x.raw === 'number') ? x.raw : null;
      const pct = x => (x && typeof x.raw === 'number') ? x.raw * 100 : null;
      let earningsDate = null;
      let earningsDateEnd = null;
      const ed = ce?.earnings?.earningsDate;
      if (Array.isArray(ed) && ed.length > 0) {
        const first = v(ed[0]);
        if (first) earningsDate = first * 1000;
        if (ed.length > 1) {
          const second = v(ed[1]);
          if (second) earningsDateEnd = second * 1000;
        }
      }
      const epsEst = v(ce?.earnings?.earningsAverage);
      const revEst = v(ce?.earnings?.revenueAverage);
      const dvFwd = v(ce?.dividendDate);
      return {
        marketCap: v(sd.marketCap) || v(pr.marketCap),
        peTrailing: v(sd.trailingPE) || v(ks.trailingPE),
        peForward: v(sd.forwardPE) || v(ks.forwardPE),
        pegRatio: v(ks.pegRatio),
        priceToBook: v(ks.priceToBook) || v(sd.priceToBook),
        bookValue: v(ks.bookValue) != null ? v(ks.bookValue) / divisor : null,
        priceToSales: v(ks.priceToSalesTrailing12Months) || v(sd.priceToSalesTrailing12Months),
        eps: v(ks.trailingEps),
        epsForward: v(ks.forwardEps),
        beta: v(sd.beta) || v(ks.beta),
        dividendYield: pct(sd.dividendYield) || pct(sd.trailingAnnualDividendYield),
        payoutRatio: pct(sd.payoutRatio),
        profitMargin: pct(fd.profitMargins) || pct(ks.profitMargins),
        operatingMargin: pct(fd.operatingMargins),
        revenueGrowth: pct(fd.revenueGrowth),
        earningsGrowth: pct(fd.earningsGrowth),
        roe: pct(fd.returnOnEquity),
        roa: pct(fd.returnOnAssets),
        debtToEquity: v(fd.debtToEquity),
        currentRatio: v(fd.currentRatio),
        totalCash: v(fd.totalCash),
        totalDebt: v(fd.totalDebt),
        freeCashflow: v(fd.freeCashflow),
        operatingCashflow: v(fd.operatingCashflow),
        revenue: v(fd.totalRevenue),
        ebitda: v(fd.ebitda),
        mostRecentQuarter: v(ks.mostRecentQuarter) ? v(ks.mostRecentQuarter) * 1000 : null,
        lastFiscalYearEnd: v(ks.lastFiscalYearEnd) ? v(ks.lastFiscalYearEnd) * 1000 : null,
        targetMean: v(fd.targetMeanPrice),
        targetHigh: v(fd.targetHighPrice),
        targetLow: v(fd.targetLowPrice),
        recommendation: fd.recommendationKey || null,
        analystCount: v(fd.numberOfAnalystOpinions),
        volume: v(sd.volume) || v(sd.regularMarketVolume),
        avgVolume: v(sd.averageVolume) || v(sd.averageVolume10days),
        yearHigh: v(sd.fiftyTwoWeekHigh),
        yearLow: v(sd.fiftyTwoWeekLow),
        fiftyDayAvg: v(sd.fiftyDayAverage),
        twoHundredDayAvg: v(sd.twoHundredDayAverage),
        earningsDate,
        earningsDateEnd,
        epsEst,
        revEst,
        dividendDate: dvFwd ? dvFwd * 1000 : null,
        sector: ap.sector || null,
        industry: ap.industry || null,
        employees: v(ap.fullTimeEmployees),
        currency: curr,
        divisor,
        fetchedAt: Date.now(),
        source: 'yahoo'
      };
    } catch (e) {
      continue;
    }
  }
  return null;
}
async function fetchFundamentalsPerplexity(ticker, market, companyName, apiKey) {
  if (!apiKey) return null;
  const name = companyName || ticker;
  const exchangeLabel = {
    JSE: 'Johannesburg Stock Exchange', LSE: 'London Stock Exchange',
    ASX: 'Australian Securities Exchange', FRA: 'Frankfurt (XETRA)',
    PAR: 'Euronext Paris', AMS: 'Euronext Amsterdam', US: 'US markets'
  }[market] || market;
  const prompt = `Return current fundamentals for ${name} (ticker ${ticker}, ${exchangeLabel}) as compact JSON only, no prose, no markdown.

Shape (null for unknown values):
{
  "marketCap": number (absolute, e.g. 2500000000000),
  "peTrailing": number, "peForward": number, "pegRatio": number,
  "priceToBook": number, "priceToSales": number,
  "bookValue": number (book value / NAV per share, in reporting currency per share),
  "eps": number, "epsForward": number,
  "beta": number,
  "dividendYield": number (percent, e.g. 1.25),
  "profitMargin": number (percent), "operatingMargin": number (percent),
  "revenueGrowth": number (percent yoy), "earningsGrowth": number (percent yoy),
  "roe": number (percent), "roa": number (percent),
  "debtToEquity": number (ratio, e.g. 1.87 not 187),
  "currentRatio": number,
  "revenue": number (absolute TTM), "ebitda": number (absolute TTM),
  "freeCashflow": number (absolute TTM free cash flow),
  "mostRecentQuarter": "YYYY-MM-DD" (end date of most recently reported quarter),
  "avgVolume": number,
  "yearHigh": number, "yearLow": number,
  "targetMean": number, "targetHigh": number, "targetLow": number,
  "recommendation": "strong_buy"|"buy"|"hold"|"sell"|"strong_sell",
  "analystCount": number,
  "earningsDate": "YYYY-MM-DD" (next upcoming, null if none scheduled),
  "epsEst": number,
  "sector": string, "industry": string
}`;
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'You return only valid JSON objects. No prose, no markdown fences. Use null for unknown fields.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0,
        max_tokens: 900
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    let p = null;
    try { p = JSON.parse(cleaned); } catch (e) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { p = JSON.parse(m[0]); } catch (e2) { return null; } }
    }
    if (!p || typeof p !== 'object') return null;
    let earningsDateMs = null;
    if (p.earningsDate) {
      const d = new Date(p.earningsDate);
      if (!isNaN(d.getTime())) earningsDateMs = d.getTime();
    }
    const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;
    return {
      marketCap: num(p.marketCap),
      peTrailing: num(p.peTrailing),
      peForward: num(p.peForward),
      pegRatio: num(p.pegRatio),
      priceToBook: num(p.priceToBook),
      bookValue: num(p.bookValue),
      priceToSales: num(p.priceToSales),
      eps: num(p.eps),
      epsForward: num(p.epsForward),
      beta: num(p.beta),
      dividendYield: num(p.dividendYield),
      profitMargin: num(p.profitMargin),
      operatingMargin: num(p.operatingMargin),
      revenueGrowth: num(p.revenueGrowth),
      earningsGrowth: num(p.earningsGrowth),
      roe: num(p.roe),
      roa: num(p.roa),
      debtToEquity: num(p.debtToEquity) != null ? num(p.debtToEquity) * 100 : null,
      currentRatio: num(p.currentRatio),
      revenue: num(p.revenue),
      ebitda: num(p.ebitda),
      freeCashflow: num(p.freeCashflow),
      mostRecentQuarter: (() => { if (!p.mostRecentQuarter) return null; const d = new Date(p.mostRecentQuarter); return isNaN(d.getTime()) ? null : d.getTime(); })(),
      avgVolume: num(p.avgVolume),
      yearHigh: num(p.yearHigh),
      yearLow: num(p.yearLow),
      targetMean: num(p.targetMean),
      targetHigh: num(p.targetHigh),
      targetLow: num(p.targetLow),
      recommendation: typeof p.recommendation === 'string' ? p.recommendation : null,
      analystCount: num(p.analystCount),
      earningsDate: earningsDateMs,
      earningsDateEnd: null,
      epsEst: num(p.epsEst),
      sector: typeof p.sector === 'string' ? p.sector : null,
      industry: typeof p.industry === 'string' ? p.industry : null,
      currency: '', divisor: 1,
      fetchedAt: Date.now(),
      source: 'perplexity'
    };
  } catch (e) {
    return null;
  }
}
// Parse stockanalysis.com's human-formatted figures: "4.28T", "451.44B",
// "27.15%", "$1.04", "1,234" → numbers. Returns null for "n/a"/blank.
function saNum(s) {
  if (s == null) return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  let t = String(s).trim().replace(/[$%\s]/g, '');
  if (t === '' || /^n\/?a$/i.test(t) || t === '-') return null;
  t = t.replace(/,/g, '');
  const m = t.match(/^(-?\d+(?:\.\d+)?)([TBMK])?$/i);
  if (m) {
    let n = parseFloat(m[1]);
    const u = (m[2] || '').toUpperCase();
    if (u === 'T') n *= 1e12; else if (u === 'B') n *= 1e9; else if (u === 'M') n *= 1e6; else if (u === 'K') n *= 1e3;
    return isFinite(n) ? n : null;
  }
  const f = parseFloat(t);
  return isFinite(f) ? f : null;
}
// stockanalysis.com is CORS-open and (unlike Yahoo's now crumb-gated
// quoteSummary) returns full fundamentals for US listings without auth.
async function fetchFundamentalsStockAnalysis(ticker) {
  const base = `https://stockanalysis.com/api/symbol/s/${encodeURIComponent(ticker.toUpperCase())}`;
  let ov = null, st = null;
  try {
    const [ovr, str] = await Promise.all([
      fetch(`${base}/overview`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${base}/statistics`).then(r => r.ok ? r.json() : null).catch(() => null)
    ]);
    ov = ovr && ovr.data ? ovr.data : null;
    st = str && str.data ? str.data : null;
  } catch (e) { return null; }
  if (!ov && !st) return null;
  // Flatten every statistics section into a title→value map (prefer the
  // full-precision `hover` over the abbreviated `value` when present).
  const S = {};
  if (st) for (const sec of Object.keys(st)) {
    const blk = st[sec];
    if (blk && Array.isArray(blk.data)) for (const it of blk.data) {
      if (it && it.title) S[it.title] = (it.hover != null && /[\d]/.test(String(it.hover))) ? it.hover : it.value;
    }
  }
  const g = (title) => saNum(S[title]);
  const o = ov || {};
  // Latest fiscal-year revenue / earnings growth from the mini financial chart.
  let revenueGrowth = null, earningsGrowth = null, lastFyEnd = null;
  if (Array.isArray(o.financialChart) && o.financialChart.length) {
    const last = o.financialChart[o.financialChart.length - 1];
    revenueGrowth = (typeof last.revenueGrowth === 'number') ? last.revenueGrowth : null;
    earningsGrowth = (typeof last.earningsGrowth === 'number') ? last.earningsGrowth : null;
    const yr = parseInt(last.year, 10);
    if (isFinite(yr)) lastFyEnd = new Date(yr, 11, 31).getTime();
  }
  let dividendYield = null;
  if (o.dividend) { const m = String(o.dividend).match(/\(([-\d.]+)%\)/); if (m) dividendYield = parseFloat(m[1]); }
  let targetMean = null;
  if (o.target) { const m = String(o.target).match(/^[^\d-]*(-?[\d.,]+)/); if (m) targetMean = saNum(m[1]); }
  const recMap = { 'strong buy': 'strong_buy', 'buy': 'buy', 'hold': 'hold', 'sell': 'sell', 'strong sell': 'strong_sell' };
  const recommendation = o.analysts ? (recMap[String(o.analysts).toLowerCase()] || null) : null;
  const de = g('Debt / Equity');
  const result = {
    marketCap: g('Market Cap'),
    peTrailing: g('PE Ratio') != null ? g('PE Ratio') : saNum(o.peRatio),
    peForward: g('Forward PE') != null ? g('Forward PE') : saNum(o.forwardPE),
    pegRatio: g('PEG Ratio'),
    priceToBook: g('PB Ratio'),
    priceToSales: g('PS Ratio'),
    eps: saNum(o.eps) != null ? saNum(o.eps) : g('Earnings Per Share (EPS)'),
    epsForward: null,
    beta: g('Beta (5Y)') != null ? g('Beta (5Y)') : saNum(o.beta),
    dividendYield,
    profitMargin: g('Profit Margin'),
    operatingMargin: g('Operating Margin'),
    revenueGrowth,
    earningsGrowth,
    roe: g('Return on Equity (ROE)'),
    roa: g('Return on Assets (ROA)'),
    // Match Yahoo's convention (it reports D/E as a percent, e.g. 80 for 0.80).
    debtToEquity: de != null ? de * 100 : null,
    currentRatio: g('Current Ratio'),
    totalCash: null, totalDebt: null,
    freeCashflow: g('Free Cash Flow'),
    revenue: g('Revenue'),
    ebitda: g('EBITDA'),
    mostRecentQuarter: null,
    lastFiscalYearEnd: lastFyEnd,
    targetMean,
    targetHigh: null, targetLow: null,
    recommendation,
    analystCount: null,
    avgVolume: g('Average Volume (20 Days)'),
    yearHigh: null, yearLow: null,
    earningsDate: o.earningsDate && !isNaN(Date.parse(o.earningsDate)) ? Date.parse(o.earningsDate) : null,
    epsEst: null, revEst: null,
    sector: (o.infoTable || []).find(r => r.t === 'Sector')?.v || null,
    industry: (o.infoTable || []).find(r => r.t === 'Industry')?.v || null,
    currency: 'USD', divisor: 1,
    fetchedAt: Date.now(),
    source: 'stockanalysis'
  };
  // Require at least a couple of real values to count as a hit.
  const filled = Object.values(result).filter(v => typeof v === 'number' && isFinite(v)).length;
  return filled >= 3 ? result : null;
}
async function fetchFundamentals(ticker, market, companyName, perplexityKey) {
  // US listings: stockanalysis.com is the most reliable free source.
  if (market === 'US') {
    const sa = await fetchFundamentalsStockAnalysis(ticker);
    if (sa) return sa;
  }
  const yahoo = await fetchFundamentalsYahoo(ticker, market);
  if (yahoo) return yahoo;
  if (perplexityKey) return await fetchFundamentalsPerplexity(ticker, market, companyName, perplexityKey);
  return null;
}
// Lightweight sector/industry lookup for the background allocator fill — one
// CORS-open request to stockanalysis.com (US listings). Used to self-heal any
// holding the static map can't classify, so the dashboard stops dumping odd
// tickers into "Other". Returns raw labels; the caller normalises them.
async function fetchSectorStockAnalysis(ticker) {
  try {
    const r = await fetch(`https://stockanalysis.com/api/symbol/s/${encodeURIComponent(String(ticker).toUpperCase())}/overview`);
    if (!r.ok) return null;
    const j = await r.json();
    const o = j && j.data ? j.data : null;
    if (!o || !Array.isArray(o.infoTable)) return null;
    const sector = o.infoTable.find(x => x.t === 'Sector')?.v || null;
    const industry = o.infoTable.find(x => x.t === 'Industry')?.v || null;
    return sector ? { sector, industry } : null;
  } catch (_e) {
    return null;
  }
}
async function fetchPerplexityNews(ticker, market, companyName, apiKey) {
  if (!apiKey) return [];
  const name = companyName || ticker;
  const exchangeLabel = {
    JSE: 'Johannesburg Stock Exchange', LSE: 'London Stock Exchange',
    ASX: 'Australian Securities Exchange', FRA: 'Frankfurt (XETRA)',
    PAR: 'Euronext Paris', AMS: 'Euronext Amsterdam', US: 'US markets'
  }[market] || market;
  const prompt = `Find the 6 most recent and relevant news items from the past 14 days about ${name} (ticker ${ticker}, listed on ${exchangeLabel}). Prioritise earnings, guidance, analyst actions, M&A, regulatory, product launches, and share-price moving events.

Respond ONLY with a compact JSON array (no markdown, no prose) of objects with this shape:
[{"title": string, "url": string, "source": string, "date": "YYYY-MM-DD", "summary": string (max 160 chars)}]

If no meaningful news exists, respond with [].`;
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'You return only valid JSON arrays. No prose, no markdown fences.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 1200
      })
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const citations = Array.isArray(data?.citations) ? data.citations : [];
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    let parsed = [];
    try { parsed = JSON.parse(cleaned); } catch (e) {
      const m = cleaned.match(/\[[\s\S]*\]/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { return []; } }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(it => it && it.title).slice(0, 8).map((it, i) => ({
      title: String(it.title).slice(0, 200),
      link: it.url || citations[i] || '#',
      source: it.source || 'Perplexity',
      pubDate: it.date || null,
      summary: it.summary ? String(it.summary).slice(0, 240) : '',
      ai: true
    }));
  } catch (e) {
    return [];
  }
}
const HISTORICAL_FX_CACHE = {};
async function fetchHistoricalFx(dateISO, code) {
  if (!dateISO || !code || code === 'USD') return code === 'USD' ? 1 : null;
  const cacheKey = dateISO + ':' + code;
  if (HISTORICAL_FX_CACHE[cacheKey] != null) return HISTORICAL_FX_CACHE[cacheKey];
  const endpoints = [
    `https://api.frankfurter.app/${dateISO}?from=USD&to=${code}`,
    `https://api.exchangerate.host/${dateISO}?base=USD&symbols=${code}`
  ];
  for (const url of endpoints) {
    for (const build of FX_PROXIES) {
      try {
        const res = await fetch(build(url), { cache: 'force-cache' });
        if (!res.ok) continue;
        const d = await res.json();
        const rate = d?.rates?.[code];
        if (typeof rate === 'number' && isFinite(rate) && rate > 0) {
          HISTORICAL_FX_CACHE[cacheKey] = rate;
          return rate;
        }
      } catch (e) {}
    }
  }
  return null;
}
async function fetchFxRates() {
  const url = 'https://open.er-api.com/v6/latest/USD';
  for (const build of FX_PROXIES) {
    try {
      const res = await fetch(build(url), { cache: 'no-store' });
      if (!res.ok) continue;
      const d = await res.json();
      if (d && (d.result === 'success' || d.rates)) {
        const pick = {};
        DISPLAY_CURRENCIES.forEach(c => {
          if (d.rates && typeof d.rates[c.code] === 'number') pick[c.code] = d.rates[c.code];
        });
        if (!pick.USD) pick.USD = 1;
        if (Object.keys(pick).length >= 2) {
          return { base: 'USD', rates: pick, fetchedAt: Date.now(), source: 'open.er-api.com' };
        }
      }
    } catch (e) {}
  }
  return null;
}
function convertCcy(amount, from, to, rates) {
  if (amount == null || !isFinite(amount)) return null;
  if (!from || !to || from === to) return amount;
  if (!rates) return null;
  const fr = rates[from];
  const tr = rates[to];
  if (!fr || !tr) return null;
  return amount / fr * tr;
}
function marketCurrency(market) {
  return (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).code;
}
function resolvePositionUpdates(existing, updates, ctx) {
  const next = { ...updates };
  if (!existing || !updates.purchaseDate || updates.purchaseDate === existing.purchaseDate) return next;
  const nativeCode = marketCurrency(existing.market);
  if (updates.purchaseDate !== ctx.today && ctx.historicalFx != null) {
    next.fxRateAtCost = ctx.historicalFx;
  } else if (updates.purchaseDate === ctx.today && ctx.fxRates?.rates?.[nativeCode]) {
    next.fxRateAtCost = ctx.fxRates.rates[nativeCode];
  }
  return next;
}
function fmtCcy(n, code) {
  const sym = CURRENCY_SYMBOLS[code] || '$';
  if (n == null || !isFinite(n)) return sym + '—';
  return sym + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}
function fmtCcySigned(n, code) {
  if (n == null || !isFinite(n)) return '—';
  return (n >= 0 ? '+' : '−') + fmtCcy(n, code);
}
function fmt(n, market) {
  const sym = (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).sym;
  if (n == null || !isFinite(n)) return sym + '—';
  return sym + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}
function fmtSigned(n, market) {
  if (n == null || !isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '−';
  return sign + fmt(n, market);
}
function timeAgo(dateStr) {
  try {
    const d = new Date(dateStr);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  } catch (e) {
    return '';
  }
}
function uid() {
  const ts = Date.now().toString(36);
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return ts + '-' + rand;
}
// Decimal input handling. `type="number"` inputs silently reject a typed
// decimal point in locales whose number keypad emits a comma (common on
// South-African / European devices), and the spinner/scroll-wheel can mutate
// the value unexpectedly. We use `type="text" inputMode="decimal"` everywhere
// numbers are entered and sanitize the raw string ourselves so a "." always
// works regardless of locale, and a stray "," is treated as a decimal point.
function sanitizeDecimalInput(raw) {
  if (raw == null) return '';
  // Normalise comma to dot, drop everything that isn't a digit or dot.
  let s = String(raw).replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const firstDot = s.indexOf('.');
  if (firstDot !== -1) {
    // Collapse any additional dots after the first.
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
  }
  return s;
}
// Parse a possibly comma-decimalled / thousands-separated string to a number.
// Returns NaN when there's no usable numeric content.
function parseDecimal(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  // Strip currency symbols / spaces / letters but keep separators and sign.
  s = s.replace(/[^0-9.,\-]/g, '');
  if (!s) return NaN;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // Whichever separator appears last is the decimal separator.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    // A lone comma: decimal if it looks like one (e.g. 12,50), else thousands.
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length !== 3) s = parts[0] + '.' + parts[1];
    else s = s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : NaN;
}
const MAX_TRIGGER_HISTORY = 100;
const TRIGGER_COOLDOWN_MS = 5 * 60 * 1000; // 5-minute cooldown per alert
// Pure: given the current alerts, the latest prices, and the previously-seen
// status map, return the next status map plus any newly-fired triggers.
// "Fires" only on waiting -> hit transitions, never on a fresh hit with no
// prior state (prevents notification spam on first-load when an alert is
// already over its target). Once fired, a cooldown window prevents re-firing
// if price oscillates at the boundary. Stale ids (alerts that were removed)
// are dropped from the returned map. seenChanged lets the caller skip a
// redundant setState when nothing moved.
function evaluateTriggers(alerts, prices, seen) {
  const now = Date.now();
  const presentIds = new Set();
  const nextSeen = {};
  const newTriggers = [];
  for (const a of alerts) {
    presentIds.add(a.id);
    if (!a.active) {
      if (seen[a.id] !== undefined) nextSeen[a.id] = seen[a.id];
      continue;
    }
    const p = prices[priceKey(a.market, a.ticker)];
    if (!p || typeof p.price !== 'number' || !isFinite(p.price)) {
      if (seen[a.id] !== undefined) nextSeen[a.id] = seen[a.id];
      continue;
    }
    // Skip stale prices (>5 min old) — triggers should not fire on outdated
    // data that may no longer reflect the market.
    if (typeof p.fetchedAt === 'number' && (now - p.fetchedAt) > TRIGGER_COOLDOWN_MS) {
      if (seen[a.id] !== undefined) nextSeen[a.id] = seen[a.id];
      continue;
    }
    if (typeof a.targetPrice !== 'number' || !isFinite(a.targetPrice)) {
      if (seen[a.id] !== undefined) nextSeen[a.id] = seen[a.id];
      continue;
    }
    const hit = a.direction === 'above' ? p.price >= a.targetPrice : p.price <= a.targetPrice;
    // Alerts with no prior state get initialized to 'waiting' so they can
    // fire immediately if the condition is already met. This avoids the bug
    // where a new alert on an already-hit price would silently never trigger.
    const prior = seen[a.id] !== undefined ? seen[a.id] : 'waiting';
    if (hit) {
      // Determine if we're still within the cooldown window from a prior fire
      const priorHitAt = typeof prior === 'object' && prior !== null ? prior.at : 0;
      const inCooldown = typeof prior === 'object' && prior !== null && (now - priorHitAt) < TRIGGER_COOLDOWN_MS;
      const wasPreviouslyWaiting = prior === 'waiting';
      if (wasPreviouslyWaiting) {
        nextSeen[a.id] = { status: 'hit', at: now };
        newTriggers.push({
          ...a,
          triggeredAt: new Date().toISOString(),
          triggerPrice: p.price
        });
      } else if (typeof prior === 'object' && prior !== null) {
        // Already hit — preserve the existing hit timestamp (no re-fire)
        nextSeen[a.id] = prior;
      }
    } else {
      // Price is below/above target — only return to 'waiting' after cooldown
      if (typeof prior === 'object' && prior !== null && (now - prior.at) < TRIGGER_COOLDOWN_MS) {
        nextSeen[a.id] = prior; // keep in cooldown
      } else {
        nextSeen[a.id] = 'waiting';
      }
    }
  }
  let seenChanged = Object.keys(nextSeen).length !== Object.keys(seen).length;
  if (!seenChanged) {
    for (const k of Object.keys(nextSeen)) {
      const n = nextSeen[k], s = seen[k];
      if (n !== s && (typeof n !== 'object' || typeof s !== 'object' || n?.at !== s?.at || n?.status !== s?.status)) {
        seenChanged = true; break;
      }
    }
  }
  if (!seenChanged) {
    for (const k of Object.keys(seen)) {
      if (!presentIds.has(k)) { seenChanged = true; break; }
    }
  }
  return { nextSeen, newTriggers, seenChanged };
}
const Icon = _ref => {
  let {
    name,
    size = 15,
    className
  } = _ref;
  const paths = {
    refresh: React.createElement("g", null, React.createElement("path", {
      d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"
    }), React.createElement("path", {
      d: "M21 3v5h-5"
    }), React.createElement("path", {
      d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"
    }), React.createElement("path", {
      d: "M8 16H3v5"
    })),
    bell: React.createElement("g", null, React.createElement("path", {
      d: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"
    }), React.createElement("path", {
      d: "M10.3 21a1.94 1.94 0 0 0 3.4 0"
    })),
    moon: React.createElement("path", {
      d: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
    }),
    sun: React.createElement("g", null, React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "4"
    }), React.createElement("path", {
      d: "M12 2v2"
    }), React.createElement("path", {
      d: "M12 20v2"
    }), React.createElement("path", {
      d: "m4.93 4.93 1.41 1.41"
    }), React.createElement("path", {
      d: "m17.66 17.66 1.41 1.41"
    }), React.createElement("path", {
      d: "M2 12h2"
    }), React.createElement("path", {
      d: "M20 12h2"
    }), React.createElement("path", {
      d: "m6.34 17.66-1.41 1.41"
    }), React.createElement("path", {
      d: "m19.07 4.93-1.41 1.41"
    })),
    x: React.createElement("g", null, React.createElement("path", {
      d: "M18 6 6 18"
    }), React.createElement("path", {
      d: "m6 6 12 12"
    })),
    plus: React.createElement("g", null, React.createElement("path", {
      d: "M5 12h14"
    }), React.createElement("path", {
      d: "M12 5v14"
    })),
    minus: React.createElement("path", {
      d: "M5 12h14"
    }),
    check: React.createElement("g", null, React.createElement("path", {
      d: "M20 6 9 17l-5-5"
    })),
    checkCircle: React.createElement("g", null, React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "10"
    }), React.createElement("path", {
      d: "m9 12 2 2 4-4"
    })),
    alert: React.createElement("g", null, React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "10"
    }), React.createElement("path", {
      d: "M12 8v4"
    }), React.createElement("path", {
      d: "M12 16h.01"
    })),
    external: React.createElement("g", null, React.createElement("path", {
      d: "M15 3h6v6"
    }), React.createElement("path", {
      d: "M10 14 21 3"
    }), React.createElement("path", {
      d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
    })),
    maximize: React.createElement("g", null,
      React.createElement("path", { d: "M8 3H5a2 2 0 0 0-2 2v3" }),
      React.createElement("path", { d: "M21 8V5a2 2 0 0 0-2-2h-3" }),
      React.createElement("path", { d: "M3 16v3a2 2 0 0 0 2 2h3" }),
      React.createElement("path", { d: "M16 21h3a2 2 0 0 0 2-2v-3" })),
    briefcase: React.createElement("g", null, React.createElement("path", {
      d: "M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"
    }), React.createElement("rect", {
      width: "20",
      height: "14",
      x: "2",
      y: "6",
      rx: "2"
    })),
    eye: React.createElement("g", null, React.createElement("path", {
      d: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"
    }), React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "3"
    })),
    'eye-off': React.createElement("g", null, React.createElement("path", {
      d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"
    }), React.createElement("path", {
      d: "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"
    }), React.createElement("path", {
      d: "M14.12 14.12a3 3 0 1 1-4.24-4.24"
    }), React.createElement("line", { x1: "1", y1: "1", x2: "23", y2: "23" })),
    star: React.createElement("path", {
      d: "M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
    }),
    trash: React.createElement("g", null, React.createElement("path", {
      d: "M3 6h18"
    }), React.createElement("path", {
      d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
    }), React.createElement("path", {
      d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
    })),
    edit: React.createElement("g", null, React.createElement("path", {
      d: "M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"
    })),
    chevron: React.createElement("path", {
      d: "m9 18 6-6-6-6"
    }),
    'chevron-up': React.createElement("path", {
      d: "m18 15-6-6-6 6"
    }),
    'chevron-down': React.createElement("path", {
      d: "m6 9 6 6 6-6"
    }),
    download: React.createElement("g", null, React.createElement("path", {
      d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
    }), React.createElement("polyline", {
      points: "7 10 12 15 17 10"
    }), React.createElement("line", {
      x1: "12",
      y1: "15",
      x2: "12",
      y2: "3"
    })),
    share: React.createElement("g", null, React.createElement("circle", {
      cx: "18",
      cy: "5",
      r: "3"
    }), React.createElement("circle", {
      cx: "6",
      cy: "12",
      r: "3"
    }), React.createElement("circle", {
      cx: "18",
      cy: "19",
      r: "3"
    }), React.createElement("line", {
      x1: "8.59",
      y1: "13.51",
      x2: "15.42",
      y2: "17.49"
    }), React.createElement("line", {
      x1: "15.41",
      y1: "6.51",
      x2: "8.59",
      y2: "10.49"
    })),
    gauge: React.createElement("g", null, React.createElement("path", {
      d: "m12 14 4-4"
    }), React.createElement("path", {
      d: "M3.34 19a10 10 0 1 1 17.32 0"
    })),
    settings: React.createElement("g", null, React.createElement("circle", {
      cx: "12", cy: "12", r: "3"
    }), React.createElement("path", {
      d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
    })),
    globe: React.createElement("g", null, React.createElement("circle", {
      cx: "12", cy: "12", r: "10"
    }), React.createElement("path", {
      d: "M2 12h20"
    }), React.createElement("path", {
      d: "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
    })),
    list: React.createElement("g", null, React.createElement("line", {
      x1: "8",
      y1: "6",
      x2: "21",
      y2: "6"
    }), React.createElement("line", {
      x1: "8",
      y1: "12",
      x2: "21",
      y2: "12"
    }), React.createElement("line", {
      x1: "8",
      y1: "18",
      x2: "21",
      y2: "18"
    }), React.createElement("line", {
      x1: "3",
      y1: "6",
      x2: "3.01",
      y2: "6"
    }), React.createElement("line", {
      x1: "3",
      y1: "12",
      x2: "3.01",
      y2: "12"
    }), React.createElement("line", {
      x1: "3",
      y1: "18",
      x2: "3.01",
      y2: "18"
    })),
    activity: React.createElement("polyline", {
      points: "22 12 18 12 15 21 9 3 6 12 2 12"
    })
  };
  return React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className: className
  }, paths[name] || null);
};
// Owns prices/loading/lastUpdate and the 90s polling for a given ticker set.
// Returns a stable {prices, loading, lastUpdate, refresh} bundle.
// The loading guard uses a ref so the callback identity doesn't change on every
// loading toggle — this prevents the stale-closure race where two concurrent
// calls (visibility + interval) both read loading=false and double-fetch.
const PRICES_LS_KEY = 'pb.prices.v1';
const PRICES_MAX_AGE_MS = 3 * 24 * 3600 * 1000; // drop quotes older than 3 days
function usePriceFeed(tickersToFetch, toast) {
  // Rehydrate last-known prices instantly so the app paints real numbers on
  // open instead of em-dashes — the single biggest "premium fintech" perception
  // win. Stale entries (>3d) are dropped so we never show ancient data as live.
  const [prices, setPrices] = useState(() => {
    const saved = LS.get(PRICES_LS_KEY, null);
    if (!saved || typeof saved !== 'object') return {};
    const now = Date.now();
    const fresh = {};
    for (const k in saved) {
      const q = saved[k];
      if (q && typeof q.price === 'number' && (!q.fetchedAt || now - q.fetchedAt < PRICES_MAX_AGE_MS)) fresh[k] = q;
    }
    return fresh;
  });
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [failStreak, setFailStreak] = useState(0);
  // Debounced persist so a burst of merges writes once.
  const persistRef = useRef(null);
  const persistPrices = useCallback((obj) => {
    if (persistRef.current) clearTimeout(persistRef.current);
    persistRef.current = setTimeout(() => LS.set(PRICES_LS_KEY, obj), 1200);
  }, []);
  // Merge externally-fetched quotes (e.g. a just-added holding) so the
  // dashboard charts update the instant a position is created, without waiting
  // for the next 90s poll to cycle through every ticker.
  const mergePrices = useCallback((obj) => {
    if (!obj || !Object.keys(obj).length) return;
    setPrices(prev => { const next = { ...prev, ...obj }; persistPrices(next); return next; });
  }, [persistPrices]);
  const refresh = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const newPrices = await fetchQuoteBatch(tickersToFetch);
      const gotAny = Object.keys(newPrices).length > 0;
      if (gotAny) {
        setPrices(prev => { const next = { ...prev, ...newPrices }; persistPrices(next); return next; });
        setLastUpdate(new Date());
        setFailStreak(0);
      } else if (tickersToFetch.length > 0) {
        setFailStreak(prev => {
          const next = prev + 1;
          if (next === 2 && toast) toast('Price feed unreachable — using last known prices');
          return next;
        });
      }
    } catch (e) {
      console.error('Refresh failed:', e);
      if (toast) toast('Price refresh failed');
      setFailStreak(prev => prev + 1);
    }
    loadingRef.current = false;
    setLoading(false);
  }, [tickersToFetch, toast, persistPrices]);
  usePolledRefresh(refresh, 90000, 60000, tickersToFetch);
  return { prices, loading, lastUpdate, failStreak, refresh, mergePrices };
}
// Owns triggered history + alertSeenMap and runs the pure evaluator on every
// price/alert change. fireNotification is injected because its closure (toast,
// SW registration) lives in the parent. setTriggered is exposed for importData.
// alertSeenMap is read via a ref to avoid a feedback loop: updating the seen
// map would otherwise re-trigger this effect and risk double-firing.
function useAlertEngine(alerts, prices, fireNotification) {
  const [triggered, setTriggered] = usePersistedState('pb.triggered.v2', []);
  const [alertSeenMap, setAlertSeenMap] = usePersistedState('pb.alertSeen.v1', {});
  const seenRef = useRef(alertSeenMap);
  useEffect(() => { seenRef.current = alertSeenMap; }, [alertSeenMap]);
  useEffect(() => {
    const { nextSeen, newTriggers, seenChanged } = evaluateTriggers(alerts, prices, seenRef.current);
    if (seenChanged) setAlertSeenMap(nextSeen);
    if (newTriggers.length) {
      setTriggered(prev => [...newTriggers, ...prev].slice(0, MAX_TRIGGER_HISTORY));
      newTriggers.forEach(t => fireNotification(t));
    }
  }, [prices, alerts, fireNotification, setAlertSeenMap, setTriggered]);
  return { triggered, setTriggered, alertSeenMap, setAlertSeenMap };
}
// ─── Background price alerts ────────────────────────────────────────────────
// Mirror the alert config into IndexedDB (a store the service worker can also
// read) and register Periodic Background Sync, so the SW can fetch quotes and
// fire alert notifications even when the app is closed. On focus we reconcile
// any triggers the SW fired while we were away into the in-app history, and
// adopt its seen-map so the foreground engine doesn't re-fire them.
const BG_DB = 'playbook-bg', BG_STORE = 'kv', BG_KEY = 'alertState';
function bgIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BG_DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(BG_STORE)) req.result.createObjectStore(BG_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function bgIdbGet(key) {
  return bgIdbOpen().then(db => new Promise((resolve, reject) => {
    const r = db.transaction(BG_STORE, 'readonly').objectStore(BG_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
function bgIdbSet(key, val) {
  return bgIdbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(BG_STORE, 'readwrite');
    tx.objectStore(BG_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
async function bgWriteConfig(alerts, seen) {
  if (typeof indexedDB === 'undefined') return;
  try {
    const prev = (await bgIdbGet(BG_KEY)) || {};
    await bgIdbSet(BG_KEY, { ...prev, alerts, seen, updatedAt: Date.now() });
  } catch (_e) {}
}
async function registerPeriodicAlertSync() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) return;
    let status = { state: 'granted' };
    try { status = await navigator.permissions.query({ name: 'periodic-background-sync' }); } catch (_e) {}
    if (status.state === 'denied') return;
    await reg.periodicSync.register('check-alerts', { minInterval: 15 * 60 * 1000 });
  } catch (_e) {}
}
function useBackgroundAlerts(alerts, alertSeenMap, setAlertSeenMap, setTriggered, notifPerm) {
  // 1. Keep the SW's copy of the alert config current.
  useEffect(() => { bgWriteConfig(alerts, alertSeenMap); }, [alerts, alertSeenMap]);
  // 2. Register periodic background sync once notifications are allowed.
  useEffect(() => { if (notifPerm === 'granted') registerPeriodicAlertSync(); }, [notifPerm]);
  // 3. On mount + every time we return to the foreground, drain anything the
  //    SW fired while closed into the in-app history and adopt its seen-map.
  useEffect(() => {
    let alive = true;
    const drain = async () => {
      if (typeof indexedDB === 'undefined') return;
      try {
        const st = await bgIdbGet(BG_KEY);
        if (!alive || !st) return;
        const fired = st.bgTriggered || [];
        if (st.seen) setAlertSeenMap(prev => ({ ...prev, ...st.seen }));
        if (fired.length) {
          setTriggered(prev => {
            const have = new Set(prev.map(t => t.id + '|' + t.triggeredAt));
            const fresh = fired.filter(t => !have.has(t.id + '|' + t.triggeredAt));
            return fresh.length ? [...fresh, ...prev].slice(0, MAX_TRIGGER_HISTORY) : prev;
          });
          await bgIdbSet(BG_KEY, { ...st, bgTriggered: [] });
        }
      } catch (_e) {}
    };
    drain();
    const onVis = () => {
      if (!document.hidden) { drain(); return; }
      // Going to background — ask the SW to run one check now (covers the window
      // before periodic sync first fires, while the SW is still alive).
      try { navigator.serviceWorker.controller?.postMessage({ type: 'check-alerts' }); } catch (_e) {}
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVis); };
  }, [setAlertSeenMap, setTriggered]);
}
// Owns positions/watchlist/contributions/alerts + CRUD. fxRates is needed for
// purchase-date FX resolution; toast is injected for user-facing feedback.
// Raw setters are exposed so importData / cloud sync can replace state wholesale.
function usePortfolio(fxRates, toast) {
  const [positions, setPositions] = usePersistedState('pb.positions.v2', []);
  const [watchlist, setWatchlist] = usePersistedState('pb.watchlist.v2', []);
  const [alerts, setAlerts] = usePersistedState('pb.alerts.v2', []);
  const [contributions, setContributions] = usePersistedState('pb.contributions.v1', []);
  const [transactions, setTransactions] = usePersistedState('pb.transactions.v1', []);
  // Background-resolved sectors for holdings the static map can't classify,
  // keyed "MARKET:TICKER" → { sector, industry, at }. Persisted so the dashboard
  // allocation stays accurate across reloads without re-fetching.
  const [sectorCache, setSectorCache] = usePersistedState('pb.sectorCache.v1', {});
  useEffect(() => {
    setPositions(prev => {
      const merged = [];
      const seen = {};
      for (const p of prev) {
        const key = p.ticker + ':' + p.market;
        if (seen[key] != null) {
          const e = merged[seen[key]];
          const totalShares = e.shares + p.shares;
          const avgCost = (e.shares * e.costBasis + p.shares * p.costBasis) / totalShares;
          merged[seen[key]] = { ...e, shares: totalShares, costBasis: avgCost,
            notes: p.notes ? (e.notes ? e.notes + '; ' + p.notes : p.notes) : e.notes };
        } else {
          seen[key] = merged.length;
          merged.push(p);
        }
      }
      return merged.length === prev.length ? prev : merged;
    });
  }, []);
  const addPosition = async (ticker, market, shares, costBasis, notes, purchaseDate) => {
    const nativeCode = marketCurrency(market);
    const today = new Date().toISOString().slice(0, 10);
    const dateKey = purchaseDate && purchaseDate !== today ? purchaseDate : null;
    let rateAtCost = fxRates?.rates?.[nativeCode] || null;
    if (dateKey) {
      const hist = await fetchHistoricalFx(dateKey, nativeCode);
      if (hist != null) rateAtCost = hist;
    }
    const newShares = parseFloat(shares);
    const newCost = parseFloat(costBasis);
    const tickerUp = ticker.toUpperCase();
    setPositions(prev => {
      const existing = prev.find(p => p.ticker === tickerUp && p.market === market);
      if (existing) {
        const totalShares = existing.shares + newShares;
        const avgCost = (existing.shares * existing.costBasis + newShares * newCost) / totalShares;
        return prev.map(p => p.id === existing.id ? {
          ...p, shares: totalShares, costBasis: avgCost,
          notes: notes ? (p.notes ? p.notes + '; ' + notes : notes) : p.notes,
          fxRateAtCost: rateAtCost || p.fxRateAtCost
        } : p);
      }
      return [...prev, {
        id: uid(), ticker: tickerUp, market,
        shares: newShares, costBasis: newCost,
        notes: notes || '', addedAt: new Date().toISOString(),
        purchaseDate: purchaseDate || today,
        fxRateAtCost: rateAtCost, fxBase: 'USD'
      }];
    });
    setTransactions(prev => [...prev, {
      id: uid(), type: 'buy', ticker: tickerUp, market,
      shares: newShares, price: newCost, notes: notes || '',
      date: purchaseDate || today, createdAt: new Date().toISOString()
    }]);
    toast(positions.find(p => p.ticker === tickerUp && p.market === market) ? 'Shares added to existing position' : 'Position added');
  };
  // Bulk import (from file/paste). Resolves historical FX per dated row, then
  // applies every row in a single state update so duplicates within the batch
  // merge correctly and the UI only re-renders once. One summary toast.
  const importPositions = async (list) => {
    const today = new Date().toISOString().slice(0, 10);
    const prepared = [];
    for (const r of list) {
      const nativeCode = marketCurrency(r.market);
      const dateKey = r.purchaseDate && r.purchaseDate !== today ? r.purchaseDate : null;
      let rateAtCost = fxRates?.rates?.[nativeCode] || null;
      if (dateKey) {
        const h = await fetchHistoricalFx(dateKey, nativeCode);
        if (h != null) rateAtCost = h;
      }
      prepared.push({ ...r, rateAtCost });
    }
    let added = 0, merged = 0;
    setPositions(prev => {
      const next = [...prev];
      for (const r of prepared) {
        const tickerUp = r.ticker.toUpperCase();
        const idx = next.findIndex(p => p.ticker === tickerUp && p.market === r.market);
        if (idx >= 0) {
          const ex = next[idx];
          const totalShares = ex.shares + r.shares;
          const avgCost = totalShares > 0 ? (ex.shares * ex.costBasis + r.shares * r.costBasis) / totalShares : ex.costBasis;
          next[idx] = { ...ex, shares: totalShares, costBasis: avgCost, fxRateAtCost: r.rateAtCost || ex.fxRateAtCost };
          merged++;
        } else {
          next.push({
            id: uid(), ticker: tickerUp, market: r.market,
            shares: r.shares, costBasis: r.costBasis,
            notes: r.notes || '', addedAt: new Date().toISOString(),
            purchaseDate: r.purchaseDate || today,
            fxRateAtCost: r.rateAtCost, fxBase: 'USD'
          });
          added++;
        }
      }
      return next;
    });
    setTransactions(prev => [...prev, ...prepared.map(r => ({
      id: uid(), type: 'buy', ticker: r.ticker.toUpperCase(), market: r.market,
      shares: r.shares, price: r.costBasis, notes: r.notes || '',
      date: r.purchaseDate || today, createdAt: new Date().toISOString()
    }))]);
    toast(`Imported ${added} position${added !== 1 ? 's' : ''}${merged ? `, merged ${merged}` : ''}`);
    return { added, merged };
  };
  const sellPosition = (ticker, market, shares, sellPrice, date, notes) => {
    const tickerUp = ticker.toUpperCase();
    const numShares = parseFloat(shares);
    const price = parseFloat(sellPrice);
    const today = new Date().toISOString().slice(0, 10);
    setPositions(prev => prev.map(p => {
      if (p.ticker !== tickerUp || p.market !== market) return p;
      const remaining = p.shares - numShares;
      if (remaining <= 0.0001) return null;
      return { ...p, shares: remaining };
    }).filter(Boolean));
    setTransactions(prev => [...prev, {
      id: uid(), type: 'sell', ticker: tickerUp, market,
      shares: numShares, price, notes: notes || '',
      date: date || today, createdAt: new Date().toISOString()
    }]);
    toast('Sale recorded');
  };
  const updatePosition = async (id, updates) => {
    const existing = positions.find(p => p.id === id);
    const today = new Date().toISOString().slice(0, 10);
    let historicalFx = null;
    if (existing && updates.purchaseDate && updates.purchaseDate !== existing.purchaseDate && updates.purchaseDate !== today) {
      const nativeCode = marketCurrency(existing.market);
      historicalFx = await fetchHistoricalFx(updates.purchaseDate, nativeCode);
    }
    setPositions(prev => prev.map(p => {
      if (p.id !== id) return p;
      const nextUpdates = resolvePositionUpdates(p, updates, { fxRates, today, historicalFx });
      return { ...p, ...nextUpdates };
    }));
    toast('Position updated');
  };
  const removePosition = id => {
    setPositions(prev => prev.filter(p => p.id !== id));
    toast('Position removed');
  };
  const addContribution = (amount, currency, date, note) => {
    const rateAtContrib = fxRates?.rates?.[currency] || null;
    setContributions(prev => [...prev, {
      id: uid(), amount: parseFloat(amount), currency, date, note: note || '',
      fxRateAtContrib: rateAtContrib, fxBase: 'USD'
    }]);
    toast('Contribution logged');
  };
  const removeContribution = id => {
    setContributions(prev => prev.filter(c => c.id !== id));
    toast('Contribution removed');
  };
  // Bulk-add deposits/withdrawals from an import. Each entry's amount is already
  // signed (positive = deposit, negative = withdrawal).
  const importContributions = (entries) => {
    const rates = fxRates?.rates || {};
    const mapped = (entries || []).map(e => ({
      id: uid(),
      amount: parseFloat(e.amount),
      currency: e.currency || 'USD',
      date: e.date,
      note: e.note || '',
      fxRateAtContrib: rates[e.currency || 'USD'] || null,
      fxBase: 'USD'
    })).filter(e => isFinite(e.amount) && e.amount !== 0 && e.date);
    if (mapped.length === 0) return 0;
    setContributions(prev => [...prev, ...mapped]);
    toast(`Imported ${mapped.length} ${mapped.length === 1 ? 'entry' : 'entries'}`);
    return mapped.length;
  };
  const addWatch = (ticker, market, name) => {
    ticker = ticker.toUpperCase();
    if (watchlist.some(w => w.ticker === ticker && w.market === market)) {
      toast('Already on watchlist');
      return;
    }
    let resolvedName = name;
    if (!resolvedName) {
      const info = DATA.findInfo(ticker, market);
      if (info && info.name && info.name !== ticker) resolvedName = info.name;
    }
    setWatchlist(prev => [...prev, {
      id: uid(),
      ticker,
      market,
      name: resolvedName || null,
      addedAt: new Date().toISOString()
    }]);
    toast('Added ' + ticker);
  };
  const removeWatch = id => setWatchlist(prev => prev.filter(w => w.id !== id));
  const addAlert = (ticker, market, direction, targetPrice, note) => {
    const a = {
      id: uid(),
      ticker,
      market,
      direction,
      targetPrice: parseFloat(targetPrice),
      note: note || '',
      active: true,
      createdAt: new Date().toISOString()
    };
    setAlerts(prev => [...prev, a]);
    toast('Alert set');
  };
  const removeAlert = id => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  };
  return {
    positions, setPositions,
    watchlist, setWatchlist,
    alerts, setAlerts,
    contributions, setContributions,
    transactions, setTransactions,
    sectorCache, setSectorCache,
    addPosition, updatePosition, removePosition, sellPosition, importPositions,
    addContribution, removeContribution, importContributions,
    addWatch, removeWatch,
    addAlert, removeAlert
  };
}
const ToastContext = React.createContext(() => {});
function ToastProvider(_ref2) {
  let {
    children
  } = _ref2;
  const [toast, setToast] = useState(null);
  const show = useCallback(msg => {
    setToast(msg);
    setTimeout(() => setToast(null), 3600);
  }, []);
  return React.createElement(ToastContext.Provider, {
    value: show
  }, children, toast && React.createElement("div", {
    className: "toast"
  }, toast));
}
const useToast = () => React.useContext(ToastContext);
function App() {
  const [theme, setTheme] = usePersistedState('pb.theme.v2', 'dark');
  const [perplexityKey, setPerplexityKey] = usePersistedState('pb.perplexityKey.v1', '');
  const [displayCurrency, setDisplayCurrency] = usePersistedState('pb.displayCurrency.v1', 'USD');
  const [fxRates, setFxRates] = usePersistedState('pb.fxRates.v1', null);
  const [ribbonItems, setRibbonItems] = usePersistedState('pb.ribbonItems.v1', DEFAULT_RIBBON_ITEMS);
  const [ribbonMode, setRibbonMode] = usePersistedState('pb.ribbonMode.v1', 'rows');
  const [showSettings, setShowSettings] = useState(false);
  const TAB_LIST = [['dashboard', 'Dashboard'], ['current', 'Holdings'], ['watchlist', 'Watchlist'], ['heatmap', 'Heatmap'], ['picks', 'New picks'], ['hedges', 'Hedges'], ['tfsa', 'TFSA'], ['rules', 'Rules'], ['overview', 'Thesis']];
  const [view, setView] = useState('dashboard');
  const [viewTransDir, setViewTransDir] = useState(null);
  const navRef = useRef(null);
  const navPillRef = useRef(null);
  const mainRef = useRef(null);
  const childSwipeLockRef = useRef(false);
  const changeView = useCallback((newView, direction) => {
    if (newView === view) return;
    // Reset scroll instantly *before* the new view paints. A smooth scroll here
    // fights the content-height change (e.g. tall heatmap → short picks) and
    // reads as a jump; instant keeps the slide transition clean.
    window.scrollTo(0, 0);
    setViewTransDir(direction || null);
    setView(newView);
    requestAnimationFrame(() => {
      const btn = navRef.current?.querySelector(`[data-tab="${newView}"]`);
      if (btn) btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
    setTimeout(() => setViewTransDir(null), 350);
  }, [view]);
  // Slide the glassy iOS-style pill behind the active tab.
  const positionNavPill = useCallback(() => {
    const nav = navRef.current, pill = navPillRef.current;
    if (!nav || !pill) return;
    const btn = nav.querySelector(`[data-tab="${view}"]`);
    if (!btn) return;
    pill.style.transform = `translateX(${btn.offsetLeft}px)`;
    pill.style.width = btn.offsetWidth + 'px';
    pill.style.opacity = '1';
  }, [view]);
  useEffect(() => {
    const r = requestAnimationFrame(positionNavPill);
    window.addEventListener('resize', positionNavPill);
    return () => { cancelAnimationFrame(r); window.removeEventListener('resize', positionNavPill); };
  }, [positionNavPill]);
  const [newsByTicker, loadNewsRaw] = useTtlCache(15 * 60 * 1000);
  const [historyByTicker, loadHistoryRaw] = useTtlCache(15 * 60 * 1000);
  const [fundamentalsByTicker, loadFundamentalsRaw] = useTtlCache(6 * 60 * 60 * 1000);
  const [selected, setSelected] = useState(null);
  const [showAlerts, setShowAlerts] = useState(false);
  const [posModalEditId, setPosModalEditId] = useState(null);
  const [posModalOpen, setPosModalOpen] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [sellModalPos, setSellModalPos] = useState(null);
  const [notifPerm, setNotifPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [installEvent, setInstallEvent] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [marketFilter, setMarketFilter] = useState('US');
  const toast = useToast();
  const {
    positions, setPositions,
    watchlist, setWatchlist,
    alerts, setAlerts,
    contributions, setContributions,
    transactions, setTransactions,
    sectorCache, setSectorCache,
    addPosition, updatePosition, removePosition, sellPosition, importPositions,
    addContribution, removeContribution, importContributions,
    addWatch, removeWatch,
    addAlert, removeAlert
  } = usePortfolio(fxRates, toast);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  // Self-healing sector fill: any US holding the static classifier can't place
  // (→ "Other") gets one lightweight stockanalysis.com lookup, normalised and
  // persisted, so the allocation chart converges on real GICS sectors instead
  // of a fat "Other" wedge. Already-classified or already-attempted symbols are
  // skipped, so for most portfolios this does nothing.
  useEffect(() => {
    const pending = positions.filter(p => {
      if (p.market !== 'US') return false;
      const key = priceKey(p.market, p.ticker);
      if (sectorCache[key]) return false;
      return DATA.findSector(p.ticker, p.market).sector === 'Other';
    });
    if (pending.length === 0) return;
    let alive = true;
    (async () => {
      for (const p of pending) {
        if (!alive) break;
        const got = await fetchSectorStockAnalysis(p.ticker).catch(() => null);
        if (!alive) break;
        setSectorCache(prev => ({
          ...prev,
          [priceKey(p.market, p.ticker)]: { sector: got?.sector || null, industry: got?.industry || null, at: Date.now() }
        }));
      }
    })();
    return () => { alive = false; };
  }, [positions, sectorCache, setSectorCache]);
  const refreshFx = useCallback(async () => {
    const r = await fetchFxRates();
    if (r) setFxRates(r);
  }, [setFxRates]);
  useEffect(() => {
    const age = fxRates?.fetchedAt ? Date.now() - fxRates.fetchedAt : Infinity;
    if (age > 6 * 3600 * 1000) refreshFx();
    const handle = setInterval(refreshFx, 6 * 3600 * 1000);
    return () => clearInterval(handle);
  }, [refreshFx]);
  useEffect(() => {
    const handler = e => {
      e.preventDefault();
      setInstallEvent(e);
      if (!LS.get('pb.installDismissed.v2', false)) setShowInstallBanner(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isIOS && !standalone && !LS.get('pb.installDismissed.v2', false)) {
      setTimeout(() => setShowInstallBanner(true), 2500);
    }
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);
  useEffect(() => {
    const block = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);
  const tickersToFetch = useMemo(() => {
    const set = new Set();
    DATA.HOLDINGS.forEach(h => set.add('US:' + h.ticker));
    DATA.NEW_PICKS.forEach(p => set.add('US:' + p.ticker));
    DATA.HEDGES.forEach(h => set.add('US:' + h.ticker));
    set.add('US:VOO');
    ribbonItems.forEach(k => set.add(k));
    positions.forEach(p => set.add(priceKey(p.market, p.ticker)));
    watchlist.forEach(w => set.add(priceKey(w.market, w.ticker)));
    alerts.forEach(a => set.add(priceKey(a.market, a.ticker)));
    return Array.from(set).map(k => {
      const [m, ...rest] = k.split(':');
      return {
        market: m,
        ticker: rest.join(':')
      };
    });
  }, [positions, watchlist, alerts, ribbonItems]);
  const { prices, loading, lastUpdate, failStreak, refresh: refreshPrices, mergePrices } = usePriceFeed(tickersToFetch, toast);
  // Fetch one symbol now and merge it so dashboard charts update immediately
  // after a holding is added/imported, instead of waiting for the poll cycle.
  const seedQuote = useCallback(async (ticker, market) => {
    try {
      const q = await fetchQuote(ticker, market);
      if (q) mergePrices({ [priceKey(market, ticker)]: q });
    } catch (_e) {}
  }, [mergePrices]);
  const fireNotification = useCallback(async trig => {
    const sym = (trig.market === 'JSE' || trig.market === 'TFSA') ? 'R' : '$';
    const title = `${trig.ticker} ${trig.direction} ${sym}${trig.targetPrice.toFixed(2)}`;
    const body = `Now at ${sym}${trig.triggerPrice.toFixed(2)}${trig.note ? ` — ${trig.note}` : ''}`;
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'notify',
          title,
          body,
          tag: 'alert-' + trig.id,
          icon: './icon-192.png',
          badge: './icon-192.png'
        });
        return;
      }
    } catch (e) {}
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.showNotification(title, {
          body,
          tag: 'alert-' + trig.id,
          icon: './icon-192.png'
        });
        return;
      }
    } catch (e) {}
    try {
      if (Notification.permission === 'granted') {
        new Notification(title, {
          body,
          tag: 'alert-' + trig.id,
          icon: './icon-192.png'
        });
        return;
      }
    } catch (e) {}
    toast(`${title}: ${body}`);
  }, [toast]);
  const { triggered, setTriggered, alertSeenMap, setAlertSeenMap } = useAlertEngine(alerts, prices, fireNotification);
  // Background price-alert delivery: mirror config to the SW, register periodic
  // sync, and reconcile anything fired while the app was closed.
  useBackgroundAlerts(alerts, alertSeenMap, setAlertSeenMap, setTriggered, notifPerm);
  const requestNotifPerm = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      toast('Notifications not supported in this browser');
      return;
    }
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isIOS && !standalone) {
      toast('On iPhone, install to Home Screen first, then enable notifications');
      return;
    }
    try {
      const r = await Notification.requestPermission();
      setNotifPerm(r);
      if (r === 'granted') {
        toast('Notifications enabled');
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) {
            await reg.showNotification('Playbook', {
              body: 'Alerts are active',
              tag: 'welcome',
              icon: './icon-192.png'
            });
          } else {
            new Notification('Playbook', {
              body: 'Alerts are active',
              icon: './icon-192.png'
            });
          }
        } catch (e) {}
      } else {
        toast('Notifications: ' + r);
      }
    } catch (e) {
      toast('Could not request permission: ' + e.message);
    }
  }, [toast]);
  const clearTriggered = () => {
    setTriggered([]);
    toast('Cleared');
  };
  const loadHistory = useCallback((ticker, market, range) => {
    const r = range || '1y';
    return loadHistoryRaw(`${market}:${ticker}:${r}`, () => fetchHistory(ticker, market, r));
  }, [loadHistoryRaw]);
  const loadNews = useCallback((ticker, market) => {
    const info = DATA.findInfo(ticker, market);
    return loadNewsRaw(`${market}:${ticker}`, async () => {
      const [yahoo, ai] = await Promise.all([
        fetchNewsForTicker(ticker, market),
        fetchPerplexityNews(ticker, market, info?.name, perplexityKey)
      ]);
      const seen = new Set();
      const merged = [];
      for (const it of [...ai, ...yahoo]) {
        const k = (it.title || '').toLowerCase().slice(0, 60);
        if (k && !seen.has(k)) { seen.add(k); merged.push(it); }
      }
      return merged;
    });
  }, [loadNewsRaw, perplexityKey]);
  const handleInstall = async () => {
    if (installEvent) {
      installEvent.prompt();
      await installEvent.userChoice;
      setInstallEvent(null);
    }
    setShowInstallBanner(false);
    LS.set('pb.installDismissed.v2', true);
  };
  const dismissInstall = () => {
    setShowInstallBanner(false);
    LS.set('pb.installDismissed.v2', true);
  };
  const exportData = () => {
    const data = {
      positions,
      watchlist,
      alerts,
      triggered,
      contributions,
      transactions,
      exportedAt: new Date().toISOString(),
      version: 3
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `playbook-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Backup downloaded');
  };
  const importData = file => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.positions) setPositions(data.positions);
        if (data.watchlist) setWatchlist(data.watchlist);
        if (data.alerts) setAlerts(data.alerts);
        if (data.triggered) setTriggered(data.triggered);
        if (data.contributions) setContributions(data.contributions);
        if (data.transactions) setTransactions(data.transactions);
        toast('Backup restored');
      } catch (err) {
        toast('Invalid backup file');
      }
    };
    reader.readAsText(file);
  };
  const getPrice = (ticker, market) => prices[priceKey(market || 'US', ticker)];
  const loadFundamentals = useCallback((ticker, market) => {
    const info = DATA.findInfo(ticker, market);
    return loadFundamentalsRaw(`${market}:${ticker}`, () => fetchFundamentals(ticker, market, info?.name, perplexityKey));
  }, [loadFundamentalsRaw, perplexityKey]);
  const openDetail = (ticker, market, opts) => {
    setSelected({
      ticker,
      market: market || 'US',
      openAlerts: !!(opts && opts.openAlerts)
    });
    loadNews(ticker, market || 'US');
    loadHistory(ticker, market || 'US', '1y');
    loadFundamentals(ticker, market || 'US');
  };
  const views = {
    dashboard: React.createElement(DashboardView, {
      positions: positions,
      prices: prices,
      onOpenDetail: openDetail,
      contributions: contributions,
      onAddContribution: addContribution,
      onRemoveContribution: removeContribution,
      onImportContributions: importContributions,
      transactions: transactions,
      displayCurrency: displayCurrency,
      onSetDisplayCurrency: setDisplayCurrency,
      fxRates: fxRates,
      sectorCache: sectorCache,
      fundamentals: fundamentalsByTicker
    }),
    current: React.createElement(CurrentView, {
      prices: prices,
      positions: positions,
      marketFilter: marketFilter,
      setMarketFilter: setMarketFilter,
      onOpenDetail: openDetail,
      onAddPosition: () => {
        setPosModalEditId(null);
        setPosModalOpen(true);
      },
      onImportPositions: () => setShowImport(true),
      onSellPosition: pos => setSellModalPos(pos),
      onRemovePosition: removePosition
    }),
    watchlist: React.createElement(WatchlistView, {
      watchlist: watchlist,
      prices: prices,
      alerts: alerts,
      onAdd: addWatch,
      onRemove: removeWatch,
      onReorder: setWatchlist,
      onOpenDetail: openDetail,
      onAddAlert: addAlert,
      onRemoveAlert: removeAlert,
      childSwipeLockRef: childSwipeLockRef
    }),
    heatmap: React.createElement(HeatmapView, {
      positions: positions,
      prices: prices,
      onOpenDetail: openDetail
    }),
    picks: React.createElement(PicksView, {
      prices: prices,
      onOpenDetail: openDetail
    }),
    hedges: React.createElement(HedgesView, {
      prices: prices,
      onOpenDetail: openDetail
    }),
    tfsa: React.createElement(TFSAView, {
      positions: positions.filter(p => p.market === 'TFSA'),
      prices: prices,
      onOpenDetail: openDetail,
      onAddPosition: () => { setPosModalEditId(null); setPosModalOpen(true); },
      onSellPosition: pos => setSellModalPos(pos)
    }),
    rules: React.createElement(RulesView, null),
    overview: React.createElement(OverviewView, {
      prices: prices
    })
  };
  const recentTriggered24h = triggered.filter(t => Date.now() - new Date(t.triggeredAt).getTime() < 24 * 3600 * 1000).length;
  return React.createElement("div", {
    className: "app"
  }, React.createElement("header", {
    className: "header"
  }, React.createElement("div", {
    className: "header-inner"
  }, React.createElement("div", {
    className: "brand"
  }, React.createElement("div", {
    className: "brand-title"
  }, "Playbook")), React.createElement("div", {
    className: "status-chip",
    title: failStreak >= 2
      ? 'Price feed failing — last successful update shown'
      : (lastUpdate ? 'Last refresh ' + lastUpdate.toLocaleTimeString() : 'Loading…')
  }, React.createElement("span", {
    className: `dot ${loading ? 'loading' : failStreak >= 2 ? 'stale' : lastUpdate ? 'live' : 'loading'}`
  }), React.createElement("span", null, lastUpdate ? lastUpdate.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  }) : '…')), React.createElement("button", {
    className: `icon-btn ${loading ? 'spin' : ''}`,
    onClick: refreshPrices,
    "aria-label": "Refresh"
  }, React.createElement(Icon, {
    name: "refresh"
  })), React.createElement("button", {
    className: "icon-btn",
    onClick: () => setShowAlerts(true),
    "aria-label": "Alerts"
  }, React.createElement(Icon, {
    name: "bell"
  }), recentTriggered24h > 0 && React.createElement("span", {
    className: "badge"
  }, recentTriggered24h > 9 ? '9+' : recentTriggered24h), recentTriggered24h === 0 && alerts.length > 0 && React.createElement("span", {
    className: "badge blue"
  }, alerts.length > 9 ? '9+' : alerts.length)), React.createElement("button", {
    className: "icon-btn",
    onClick: () => setTheme(t => t === 'dark' ? 'light' : 'dark'),
    "aria-label": "Theme"
  }, React.createElement(Icon, {
    name: theme === 'dark' ? 'sun' : 'moon'
  })), React.createElement("button", {
    className: "icon-btn",
    onClick: () => setShowSettings(true),
    "aria-label": "Settings"
  }, React.createElement(Icon, {
    name: "settings"
  })))), React.createElement(Hero, {
    prices: prices,
    ribbonItems: ribbonItems,
    ribbonMode: ribbonMode
  }), React.createElement("nav", {
    className: "nav",
    ref: navRef
  }, React.createElement("div", {
    className: "nav-inner"
  }, React.createElement("div", { className: "nav-pill", ref: navPillRef }), TAB_LIST.map(_ref3 => {
    let [k, label] = _ref3;
    return React.createElement("button", {
      key: k,
      'data-tab': k,
      className: `nav-btn ${view === k ? 'active' : ''}`,
      onClick: () => {
        const oldIdx = TAB_LIST.findIndex(t => t[0] === view);
        const newIdx = TAB_LIST.findIndex(t => t[0] === k);
        changeView(k, newIdx > oldIdx ? 'left' : 'right');
      }
    }, label);
  }))), React.createElement("main", {
    ref: mainRef,
    className: viewTransDir ? `view-slide-${viewTransDir}` : ''
  }, views[view]), selected && React.createElement(DetailModal, {
    selected: selected,
    prices: prices,
    positions: positions,
    alerts: alerts.filter(a => a.ticker === selected.ticker && a.market === selected.market),
    news: newsByTicker[priceKey(selected.market, selected.ticker)],
    historyByTicker: historyByTicker,
    fundamentals: fundamentalsByTicker[priceKey(selected.market, selected.ticker)],
    fxRates: fxRates,
    onClose: () => setSelected(null),
    onAddAlert: addAlert,
    onRemoveAlert: removeAlert,
    onLoadNews: () => loadNews(selected.ticker, selected.market),
    onLoadHistory: (r) => loadHistory(selected.ticker, selected.market, r)
  }), showSettings && React.createElement(SettingsModal, {
    displayCurrency: displayCurrency,
    onSetDisplayCurrency: setDisplayCurrency,
    fxRates: fxRates,
    onRefreshFx: refreshFx,
    positions: positions,
    contributions: contributions,
    prices: prices,
    onExport: exportData,
    onImport: importData,
    ribbonItems: ribbonItems,
    onSetRibbonItems: setRibbonItems,
    ribbonMode: ribbonMode,
    onSetRibbonMode: setRibbonMode,
    onClose: () => setShowSettings(false)
  }), showAlerts && React.createElement(AlertsModal, {
    alerts: alerts,
    triggered: triggered,
    notifPerm: notifPerm,
    perplexityKey: perplexityKey,
    onSetPerplexityKey: setPerplexityKey,
    onClose: () => setShowAlerts(false),
    onRemoveAlert: removeAlert,
    onClearTriggered: clearTriggered,
    onRequestPerm: requestNotifPerm
  }), posModalOpen && React.createElement(PositionModal, {
    editId: posModalEditId,
    existing: posModalEditId ? positions.find(p => p.id === posModalEditId) : null,
    onClose: () => setPosModalOpen(false),
    onSave: (data, quote) => {
      if (posModalEditId) updatePosition(posModalEditId, data);
      else {
        addPosition(data.ticker, data.market, data.shares, data.costBasis, data.notes, data.purchaseDate);
        if (quote) mergePrices({ [priceKey(data.market, data.ticker)]: quote });
        else seedQuote(data.ticker, data.market);
      }
      setPosModalOpen(false);
    }
  }), showImport && React.createElement(ImportModal, {
    onClose: () => setShowImport(false),
    onImport: async (holdings) => {
      await importPositions(holdings);
      // Seed the imported symbols so the dashboard reflects them immediately.
      holdings.forEach(h => seedQuote(h.ticker, h.market));
    }
  }), sellModalPos && React.createElement(SellModal, {
    position: sellModalPos,
    prices: prices,
    onClose: () => setSellModalPos(null),
    onSell: (ticker, market, shares, price, date, notes) => {
      sellPosition(ticker, market, shares, price, date, notes);
      setSellModalPos(null);
    }
  }), showInstallBanner && React.createElement(InstallBanner, {
    isIOS: /iphone|ipad|ipod/i.test(navigator.userAgent),
    onInstall: handleInstall,
    onDismiss: dismissInstall,
    canPrompt: !!installEvent
  }));
}
function Hero(_ref4) {
  let {
    prices,
    ribbonItems,
    ribbonMode
  } = _ref4;
  const ribbonScrollRef = useRef(null);
  const ribbonAnimRef = useRef(null);
  const ribbonOffsetRef = useRef(0);
  const ribbonDragRef = useRef(null);

  useEffect(() => {
    if (ribbonMode !== 'marquee') return;
    const el = ribbonScrollRef.current;
    if (!el) return;
    let lastT = null;
    const speed = 30;
    const tick = (t) => {
      if (!lastT) lastT = t;
      if (!ribbonDragRef.current) {
        ribbonOffsetRef.current += (t - lastT) / 1000 * speed;
        const half = el.scrollWidth / 2;
        if (half > 0 && ribbonOffsetRef.current >= half) ribbonOffsetRef.current -= half;
        if (ribbonOffsetRef.current < 0) ribbonOffsetRef.current += half;
        el.style.transform = `translateX(-${ribbonOffsetRef.current}px)`;
      }
      lastT = t;
      ribbonAnimRef.current = requestAnimationFrame(tick);
    };
    ribbonAnimRef.current = requestAnimationFrame(tick);
    return () => { if (ribbonAnimRef.current) cancelAnimationFrame(ribbonAnimRef.current); };
  }, [ribbonMode, ribbonItems]);

  const onRibbonTouchStart = (e) => {
    const touch = e.touches[0];
    if (!touch) return;
    ribbonDragRef.current = { startX: touch.clientX, startOffset: ribbonOffsetRef.current };
  };
  const onRibbonTouchMove = (e) => {
    const drag = ribbonDragRef.current;
    if (!drag) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - drag.startX;
    ribbonOffsetRef.current = drag.startOffset - dx;
    const el = ribbonScrollRef.current;
    if (el) el.style.transform = `translateX(-${ribbonOffsetRef.current}px)`;
  };
  const onRibbonTouchEnd = () => { ribbonDragRef.current = null; };

  const renderPill = (key, suffix) => {
    const cat = RIBBON_CATALOG_MAP[key];
    if (!cat) return null;
    const quote = prices[key];
    const has = !!quote;
    const up = has && quote.changePct >= 0;
    const colorUp = cat.invertColor ? !up : up;
    return React.createElement("div", { key: key + (suffix || ''), className: "ribbon-pill" },
      React.createElement("span", { className: "ribbon-pill-label" }, cat.short),
      React.createElement("span", { className: "ribbon-pill-val" }, has ? quote.price.toLocaleString('en-US', { minimumFractionDigits: cat.decimals, maximumFractionDigits: cat.decimals }) : '—'),
      React.createElement("span", { className: `ribbon-pill-chg ${colorUp ? 'up' : 'down'}` },
        has ? (quote.changePct >= 0 ? '+' : '') + quote.changePct.toFixed(2) + '%' : ''
      )
    );
  };
  const sortedRibbon = RIBBON_CATALOG.filter(r => ribbonItems.includes(r.key)).map(r => r.key);
  const pills = sortedRibbon.map(k => renderPill(k)).filter(Boolean);

  const useMarquee = ribbonMode === 'marquee' && pills.length > 3;
  const ribbonEl = useMarquee
    ? React.createElement("div", {
        className: "ribbon-marquee",
        onTouchStart: onRibbonTouchStart,
        onTouchMove: onRibbonTouchMove,
        onTouchEnd: onRibbonTouchEnd,
        onTouchCancel: onRibbonTouchEnd
      }, React.createElement("div", { ref: ribbonScrollRef, className: "ribbon-marquee-track" },
        ...pills, ...sortedRibbon.map(k => renderPill(k, '-dup')).filter(Boolean)))
    : pills.length > 0 ? React.createElement("div", { className: "ribbon-grid" }, pills) : null;

  return React.createElement("section", {
    className: "hero"
  }, ribbonEl);
}
function PriceBlock(_ref5) {
  let {
    quote,
    size = 'md',
    showDailyRow = false
  } = _ref5;
  if (!quote) return React.createElement("span", {
    className: "mono text-dim"
  }, "\u2014");
  const up = quote.changePct >= 0;
  const currSymMap = { ZAR: 'R', GBP: '\u00a3', AUD: 'A$', EUR: '\u20ac' };
  const sym = currSymMap[quote.currency] || '$';
  const klass = size === 'xl' ? 'price price-xl' : size === 'lg' ? 'price price-lg' : 'price';
  const hasExt = quote.extPrice != null && quote.extChangePct != null;
  const extUp = hasExt && quote.extChangePct >= 0;
  const extLabel = quote.extKind === 'pre' ? 'Pre-market' : quote.extKind === 'post' ? 'After-hours' : '';
  const chgAbs = (typeof quote.change === 'number' && isFinite(quote.change)) ? quote.change : null;
  return React.createElement("div", {
    className: "price-block-wrap"
  }, React.createElement("div", {
    className: "flex items-baseline gap-2"
  }, React.createElement("span", {
    className: klass
  }, sym, quote.price.toFixed(2)), React.createElement("span", {
    className: `chg ${up ? 'up' : 'down'}`
  }, up ? '▲' : '▼', " ", up ? '+' : '', quote.changePct.toFixed(2), "%")),
  showDailyRow && React.createElement("div", { className: "daily-row" },
    React.createElement("span", { className: "daily-label" }, "Today"),
    React.createElement("span", { className: `daily-val mono ${up ? 'up' : 'down'}` },
      (up ? '+' : '') + quote.changePct.toFixed(2) + '%',
      chgAbs != null ? ' · ' + (up ? '+' : '-') + sym + Math.abs(chgAbs).toFixed(2) : ''
    )
  ),
  hasExt && React.createElement("div", {
    className: "ext-hours"
  }, React.createElement("span", {
    className: "ext-label"
  }, extLabel), React.createElement("span", {
    className: "ext-price mono"
  }, sym, quote.extPrice.toFixed(2)), React.createElement("span", {
    className: `ext-chg mono ${extUp ? 'up' : 'down'}`
  }, extUp ? '+' : '', quote.extChangePct.toFixed(2), "%")));
}
// SVG-based line chart for portfolio growth over time
function PortfolioLineChart({ positions, prices, contributions, displayCurrency, fxRates }) {
  const [range, setRange] = useState('1y');
  const [historyCache, setHistoryCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);
  const ranges = [
    { key: '1mo', label: '1M' }, { key: '3mo', label: '3M' }, { key: '6mo', label: '6M' },
    { key: '1y', label: '1Y' }, { key: '2y', label: '2Y' }, { key: '5y', label: '5Y' }, { key: 'all', label: 'All' }
  ];
  const rates = fxRates?.rates || null;
  const today = new Date().toISOString().slice(0, 10);

  const positionKeys = positions.map(p => priceKey(p.market, p.ticker)).sort().join(',');
  useEffect(() => {
    if (positions.length === 0) return;
    let cancelled = false;
    setLoading(true);
    const fetchAll = async () => {
      const needed = positions.filter(p => !historyCache[priceKey(p.market, p.ticker)]);
      if (needed.length === 0) { setLoading(false); return; }
      const results = {};
      await Promise.all(needed.map(async p => {
        const key = priceKey(p.market, p.ticker);
        const data = await fetchHistory(p.ticker, p.market, 'max');
        if (data && data.points.length > 0) results[key] = data.points;
      }));
      if (cancelled) return;
      setHistoryCache(prev => ({ ...prev, ...results }));
      setLoading(false);
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [positionKeys]);

  const cutoff = useMemo(() => {
    const d = new Date();
    if (range === '1mo') d.setMonth(d.getMonth() - 1);
    else if (range === '3mo') d.setMonth(d.getMonth() - 3);
    else if (range === '6mo') d.setMonth(d.getMonth() - 6);
    else if (range === '1y') d.setFullYear(d.getFullYear() - 1);
    else if (range === '2y') d.setFullYear(d.getFullYear() - 2);
    else if (range === '5y') d.setFullYear(d.getFullYear() - 5);
    else return null;
    return d.toISOString().slice(0, 10);
  }, [range]);

  const points = useMemo(() => {
    if (positions.length === 0) return [];
    const dateMap = {};
    const contribSorted = contributions.slice().sort((a, b) => a.date.localeCompare(b.date));

    positions.forEach(p => {
      const key = priceKey(p.market, p.ticker);
      const hist = historyCache[key];
      if (!hist || hist.length === 0) return;
      const native = marketCurrency(p.market);
      const entryDate = p.purchaseDate || p.addedAt?.slice(0, 10) || today;
      hist.forEach(pt => {
        const d = new Date(pt.t).toISOString().slice(0, 10);
        if (d < entryDate) return;
        if (!dateMap[d]) dateMap[d] = { date: d, value: 0, contributed: 0 };
        const val = convertCcy(p.shares * pt.p, native, displayCurrency, rates);
        if (val != null) dateMap[d].value += val;
      });
    });

    positions.forEach(p => {
      const key = priceKey(p.market, p.ticker);
      const hist = historyCache[key];
      if (hist && hist.length > 0) return;
      const q = prices[key];
      if (!q) return;
      const native = marketCurrency(p.market);
      const entryDate = p.purchaseDate || p.addedAt?.slice(0, 10) || today;
      const costVal = convertCcy(p.shares * p.costBasis, native, displayCurrency, rates) || 0;
      const curVal = convertCcy(p.shares * q.price, native, displayCurrency, rates) || 0;
      if (!dateMap[entryDate]) dateMap[entryDate] = { date: entryDate, value: 0, contributed: 0 };
      if (!dateMap[today]) dateMap[today] = { date: today, value: 0, contributed: 0 };
      Object.keys(dateMap).forEach(d => {
        if (d < entryDate) return;
        dateMap[d].value += d >= today ? curVal : costVal;
      });
    });

    let cumContrib = 0;
    contribSorted.forEach(c => {
      const conv = convertCcy(c.amount, c.currency, displayCurrency, rates);
      if (conv != null) cumContrib += conv;
    });
    const totalContrib = cumContrib;

    let runningContrib = 0;
    let contribIdx = 0;
    const sortedDates = Object.keys(dateMap).sort();
    sortedDates.forEach(d => {
      while (contribIdx < contribSorted.length && contribSorted[contribIdx].date <= d) {
        const conv = convertCcy(contribSorted[contribIdx].amount, contribSorted[contribIdx].currency, displayCurrency, rates);
        if (conv != null) runningContrib += conv;
        contribIdx++;
      }
      dateMap[d].contributed = runningContrib;
    });
    while (contribIdx < contribSorted.length) {
      const conv = convertCcy(contribSorted[contribIdx].amount, contribSorted[contribIdx].currency, displayCurrency, rates);
      if (conv != null) runningContrib += conv;
      contribIdx++;
    }
    if (sortedDates.length > 0) {
      const lastDate = sortedDates[sortedDates.length - 1];
      dateMap[lastDate].contributed = runningContrib;
    }

    if (dateMap[today]) {
      let liveValue = 0;
      positions.forEach(p => {
        const q = prices[priceKey(p.market, p.ticker)];
        if (!q) return;
        const native = marketCurrency(p.market);
        const val = convertCcy(p.shares * q.price, native, displayCurrency, rates);
        if (val != null) liveValue += val;
      });
      dateMap[today].value = liveValue;
      dateMap[today].contributed = totalContrib;
    }

    let all = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
    if (cutoff) all = all.filter(p => p.date >= cutoff);
    if (all.length > 300) {
      const step = Math.ceil(all.length / 300);
      const sampled = [all[0]];
      for (let i = step; i < all.length - 1; i += step) sampled.push(all[i]);
      sampled.push(all[all.length - 1]);
      return sampled;
    }
    return all;
  }, [positions, historyCache, contributions, displayCurrency, rates, cutoff, prices, today]);

  const W = 560, H = 220, PAD_L = 54, PAD_R = 16, PAD_T = 28, PAD_B = 32;
  const chartW = W - PAD_L - PAD_R, chartH = H - PAD_T - PAD_B;

  const getIdxFromEvent = useCallback((e) => {
    const svg = svgRef.current;
    if (!svg || points.length < 2) return null;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pxRatio = rect.width / W;
    const svgX = (clientX - rect.left) / pxRatio;
    const idx = Math.round(((svgX - PAD_L) / chartW) * (points.length - 1));
    return Math.max(0, Math.min(points.length - 1, idx));
  }, [points.length]);

  const emptyMsg = loading ? 'Loading historical prices…' : 'Add positions and log deposits to see portfolio growth.';
  if (points.length < 2) {
    return React.createElement("div", { className: "chart-line-wrap" },
      React.createElement("div", { className: "chart-ranges" },
        ranges.map(r => React.createElement("button", {
          key: r.key, className: `chart-range-btn ${range === r.key ? 'active' : ''}`,
          onClick: () => setRange(r.key) }, r.label))),
      React.createElement("div", { className: "chart-empty" },
        React.createElement("div", { className: "text-dim text-sm" }, emptyMsg)));
  }
  const allVals = points.flatMap(p => [p.value, p.contributed].filter(v => v != null && isFinite(v)));
  const minV = Math.min(...allVals) * 0.95;
  const maxV = Math.max(...allVals) * 1.05;
  const rangeV = maxV - minV || 1;
  const x = i => PAD_L + (i / (points.length - 1)) * chartW;
  const y = v => PAD_T + chartH - ((v - minV) / rangeV) * chartH;
  const valuePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const contribPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.contributed).toFixed(1)}`).join('');
  const areaPath = valuePath + `L${x(points.length - 1).toFixed(1)},${(PAD_T + chartH).toFixed(1)}L${PAD_L},${(PAD_T + chartH).toFixed(1)}Z`;
  const yTicks = 4;
  const yLabels = [];
  for (let i = 0; i <= yTicks; i++) {
    const val = minV + (rangeV * i / yTicks);
    yLabels.push({ val, y: y(val) });
  }
  const sym = CURRENCY_SYMBOLS[displayCurrency] || '$';
  const fmtShort = v => {
    if (v >= 1e6) return sym + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return sym + Math.round(v / 1e3).toLocaleString('en-US') + 'k';
    return sym + Math.round(v).toLocaleString('en-US');
  };
  const fmtFull = v => sym + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lastVal = points[points.length - 1];
  const firstVal = points[0];
  const gain = lastVal.value - firstVal.contributed;
  const gainPct = firstVal.contributed > 0 ? (gain / firstVal.contributed * 100) : 0;

  const hoverPoint = hoverIdx != null ? points[hoverIdx] : null;
  const hoverElements = [];
  if (hoverPoint != null && hoverIdx != null) {
    const hx = x(hoverIdx), hy = y(hoverPoint.value);
    hoverElements.push(
      React.createElement("line", { key: "hl", x1: hx, x2: hx, y1: PAD_T, y2: PAD_T + chartH,
        stroke: "var(--text-dim)", strokeWidth: "0.8", strokeDasharray: "3,2", opacity: "0.5" }),
      React.createElement("circle", { key: "hc", cx: hx, cy: hy, r: "5",
        fill: "var(--blue)", stroke: "var(--bg)", strokeWidth: "2.5" })
    );
    const label = fmtFull(hoverPoint.value);
    const estW = label.length * 7.5 + 16;
    const estH = 22;
    let lx = hx - estW / 2;
    if (lx < PAD_L) lx = PAD_L;
    if (lx + estW > W - PAD_R) lx = W - PAD_R - estW;
    let ly = hy - estH - 10;
    if (ly < 2) ly = hy + 12;
    hoverElements.push(
      React.createElement("rect", { key: "hr", x: lx, y: ly, width: estW, height: estH,
        rx: "6", fill: "var(--bg-raised)", stroke: "var(--border)", strokeWidth: "1" }),
      React.createElement("text", { key: "ht", x: lx + estW / 2, y: ly + estH / 2 + 4,
        textAnchor: "middle", fill: "var(--text)", fontSize: "11", fontFamily: "var(--mono)", fontWeight: "600" },
        label)
    );
    const dateLabel = hoverPoint.date.slice(5);
    hoverElements.push(
      React.createElement("text", { key: "hd", x: hx, y: PAD_T + chartH + 14,
        textAnchor: "middle", fill: "var(--text)", fontSize: "10", fontFamily: "var(--mono)", fontWeight: "600" },
        dateLabel)
    );
  }

  const onInteract = (e) => {
    const idx = getIdxFromEvent(e);
    if (idx != null) setHoverIdx(idx);
  };

  return React.createElement("div", { className: "chart-line-wrap" },
    React.createElement("div", { className: "chart-line-header" },
      React.createElement("div", { className: "chart-ranges" },
        ranges.map(r => React.createElement("button", {
          key: r.key, className: `chart-range-btn ${range === r.key ? 'active' : ''}`,
          onClick: () => setRange(r.key) }, r.label))),
      React.createElement("div", { className: "chart-line-meta" },
        React.createElement("span", { className: "chart-legend-item" },
          React.createElement("span", { className: "chart-legend-dot", style: { background: 'var(--blue)' } }), "Value"),
        React.createElement("span", { className: "chart-legend-item" },
          React.createElement("span", { className: "chart-legend-dot chart-legend-dot--dashed" }), "Cost"),
        loading ? React.createElement("span", { className: "text-dim text-xs" }, "Loading…")
          : React.createElement("span", { className: `chart-legend-gain ${gain >= 0 ? 'up' : 'down'}` },
          (gain >= 0 ? '+' : '') + gainPct.toFixed(1) + '%'))
    ),
    React.createElement("svg", {
      ref: svgRef,
      viewBox: `0 0 ${W} ${H}`, className: "chart-line-svg", preserveAspectRatio: "xMidYMid meet",
      style: { touchAction: 'none' },
      onMouseMove: onInteract,
      onMouseLeave: () => setHoverIdx(null),
      onTouchStart: onInteract,
      onTouchMove: onInteract,
      onTouchEnd: () => setHoverIdx(null)
    },
      React.createElement("defs", null,
        React.createElement("linearGradient", { id: "areaGrad", x1: "0", y1: "0", x2: "0", y2: "1" },
          React.createElement("stop", { offset: "0%", stopColor: "var(--blue)", stopOpacity: "0.25" }),
          React.createElement("stop", { offset: "100%", stopColor: "var(--blue)", stopOpacity: "0.02" }))),
      yLabels.map((l, i) => React.createElement("line", {
        key: i, x1: PAD_L, x2: W - PAD_R, y1: l.y, y2: l.y,
        stroke: "var(--border)", strokeWidth: "0.5", strokeDasharray: "3,3" })),
      yLabels.map((l, i) => React.createElement("text", {
        key: 'yl' + i, x: PAD_L - 6, y: l.y + 3.5,
        textAnchor: "end", fill: "var(--text-dim)", fontSize: "10", fontFamily: "var(--mono)" },
        fmtShort(l.val))),
      hoverIdx == null && React.createElement("text", {
        x: PAD_L, y: H - 6, fill: "var(--text-dim)", fontSize: "10", fontFamily: "var(--mono)" },
        points[0].date.slice(5)),
      hoverIdx == null && React.createElement("text", {
        x: W - PAD_R, y: H - 6, textAnchor: "end", fill: "var(--text-dim)", fontSize: "10", fontFamily: "var(--mono)" },
        points[points.length - 1].date.slice(5)),
      React.createElement("path", { d: areaPath, fill: "url(#areaGrad)" }),
      React.createElement("path", { d: contribPath, fill: "none", stroke: "var(--text-dim)", strokeWidth: "1.5", strokeDasharray: "4,3", opacity: "0.4" }),
      React.createElement("path", { d: valuePath, fill: "none", stroke: "var(--blue)", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" }),
      hoverIdx == null && React.createElement("circle", { cx: x(points.length - 1), cy: y(lastVal.value), r: "4", fill: "var(--blue)", stroke: "var(--bg-raised)", strokeWidth: "2" }),
      ...hoverElements,
      React.createElement("rect", { x: PAD_L, y: PAD_T, width: chartW, height: chartH,
        fill: "transparent", style: { cursor: 'crosshair' } })
    )
  );
}
// Resolve a held position to a canonical sector. Prefers a live/cached
// classification — the persisted background fill or an opened-stock fundamentals
// fetch — over the static map, so the allocation chart reflects real GICS
// sectors and keeps "Other" to genuinely unknown symbols only.
function resolvePositionSector(ticker, market, sectorCache, fundamentals) {
  const key = priceKey(market, ticker);
  const cached = sectorCache && sectorCache[key];
  if (cached && cached.sector) {
    const s = DATA.normalizeSector(cached.sector);
    if (s !== 'Other') return { sector: s, industry: cached.industry || s };
  }
  const fund = fundamentals && fundamentals[key] && fundamentals[key].data;
  if (fund && fund.sector) {
    const s = DATA.normalizeSector(fund.sector);
    if (s !== 'Other') return { sector: s, industry: fund.industry || s };
  }
  return DATA.findSector(ticker, market);
}
// SVG donut/pie chart — supports grouping by ticker, sector, or market
const MARKET_LABELS = { US: 'USA', JSE: 'SA', TFSA: 'TFSA', LSE: 'UK', ASX: 'AUS', FRA: 'EUR', PAR: 'EUR', AMS: 'EUR' };
function PortfolioPieChart({ positions, prices, displayCurrency, fxRates, onOpenDetail, sectorCache, fundamentals }) {
  const [mode, setMode] = useState('ticker');
  const [hovered, setHovered] = useState(null);
  const [openSector, setOpenSector] = useState(null);
  const modes = [
    { key: 'ticker', label: 'Holdings' },
    { key: 'sector', label: 'Sector' },
    { key: 'market', label: 'Market' }
  ];
  const rates = fxRates?.rates || null;
  // Build per-position values
  const posVals = [];
  positions.forEach(p => {
    const q = prices[priceKey(p.market, p.ticker)];
    if (!q) return;
    const native = marketCurrency(p.market);
    const val = convertCcy(p.shares * q.price, native, displayCurrency, rates);
    if (val != null && val > 0) {
      const info = DATA.findInfo(p.ticker, p.market) || {};
      const sectorInfo = resolvePositionSector(p.ticker, p.market, sectorCache, fundamentals) || {};
      posVals.push({ ticker: p.ticker, market: p.market, value: val, name: info.name || p.ticker, sector: sectorInfo.sector || 'Other' });
    }
  });
  // Group by mode, and (for the sector view) keep the member holdings per sector
  // so a tap can open a breakdown of exactly which stocks make up each wedge.
  const grouped = {};
  const sectorMembers = {};
  posVals.forEach(pv => {
    let key;
    if (mode === 'sector') key = pv.sector;
    else if (mode === 'market') key = MARKET_LABELS[pv.market] || pv.market;
    else key = pv.ticker;
    if (!grouped[key]) grouped[key] = { label: key, value: 0, market: pv.market, ticker: pv.ticker };
    grouped[key].value += pv.value;
    (sectorMembers[pv.sector] = sectorMembers[pv.sector] || []).push(pv);
  });
  Object.values(sectorMembers).forEach(list => list.sort((a, b) => b.value - a.value));
  // Sort by weight, but always sink "Other" to the bottom so it reads as the
  // residual it is rather than competing with real sectors near the top.
  const slices = Object.values(grouped).sort((a, b) => {
    const ao = a.label === 'Other', bo = b.label === 'Other';
    if (ao !== bo) return ao ? 1 : -1;
    return b.value - a.value;
  });
  let total = slices.reduce((s, sl) => s + sl.value, 0);
  if (slices.length === 0) {
    return React.createElement("div", { className: "chart-empty" },
      React.createElement("div", { className: "text-dim text-sm" }, "Add positions to see allocation breakdown."));
  }
  // Clicking a wedge/legend row: holdings → open the stock; sector → open the
  // sector members popup; market → no drill-down.
  const clickable = mode === 'ticker' || mode === 'sector';
  const handleSlice = (a) => {
    if (mode === 'ticker') onOpenDetail(a.ticker, a.market);
    else if (mode === 'sector') setOpenSector(a.label);
  };
  const COLORS = [
    'var(--blue)', 'var(--emerald)', 'var(--rose)', 'var(--amber)',
    'var(--purple)', '#06b6d4', '#ec4899', '#84cc16',
    '#f97316', '#6366f1', '#14b8a6', '#e879f9'
  ];
  const SIZE = 154, CX = SIZE / 2, CY = SIZE / 2, R = 61, INNER_R = 39;
  const RING_R = (R + INNER_R) / 2, RING_W = R - INNER_R;
  const single = slices.length === 1;
  let cumAngle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const angle = (s.value / total) * Math.PI * 2;
    const startAngle = cumAngle;
    cumAngle += angle;
    const endAngle = cumAngle;
    const largeArc = angle > Math.PI ? 1 : 0;
    const x1 = CX + R * Math.cos(startAngle), y1 = CY + R * Math.sin(startAngle);
    const x2 = CX + R * Math.cos(endAngle), y2 = CY + R * Math.sin(endAngle);
    const ix1 = CX + INNER_R * Math.cos(endAngle), iy1 = CY + INNER_R * Math.sin(endAngle);
    const ix2 = CX + INNER_R * Math.cos(startAngle), iy2 = CY + INNER_R * Math.sin(startAngle);
    // A single 100% holding can't be drawn as an arc path (start == end point
    // is degenerate and renders as a thin seam / nothing). Draw it as a stroked
    // ring circle instead so it shows a clean full donut.
    const d = single ? null
      : `M${x1},${y1}A${R},${R} 0 ${largeArc},1 ${x2},${y2}L${ix1},${iy1}A${INNER_R},${INNER_R} 0 ${largeArc},0 ${ix2},${iy2}Z`;
    return { ...s, d, color: COLORS[i % COLORS.length], pct: (s.value / total * 100) };
  });
  const sym = CURRENCY_SYMBOLS[displayCurrency] || '$';
  const fmtTotal = v => sym + Math.round(v).toLocaleString('en-US');
  return React.createElement("div", null,
    React.createElement("div", { className: "chart-ranges", style: { marginBottom: 10 } },
      modes.map(m => React.createElement("button", {
        key: m.key, className: `chart-range-btn ${mode === m.key ? 'active' : ''}`,
        onClick: () => { setMode(m.key); setHovered(null); }
      }, m.label))),
    React.createElement("div", { className: "chart-pie-wrap" },
      React.createElement("div", { className: "chart-pie-ring" },
        React.createElement("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, className: "chart-pie-svg" },
          single
            ? React.createElement("circle", {
                cx: CX, cy: CY, r: RING_R, fill: "none",
                stroke: arcs[0].color, strokeWidth: RING_W,
                style: { cursor: clickable ? 'pointer' : 'default' },
                onClick: () => clickable ? handleSlice(arcs[0]) : null
              })
            : arcs.map((a, i) => React.createElement("path", {
                key: i, d: a.d, fill: a.color,
                stroke: "var(--bg-raised)", strokeWidth: "1.5",
                style: { cursor: clickable ? 'pointer' : 'default', opacity: hovered != null && hovered !== i ? 0.4 : 1, transition: 'opacity 0.2s' },
                onMouseEnter: () => setHovered(i),
                onMouseLeave: () => setHovered(null),
                onClick: () => clickable ? handleSlice(a) : null
              }))),
        React.createElement("div", { className: "chart-pie-center" },
          hovered != null
            ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "chart-pie-center-tkr" }, arcs[hovered].label),
                React.createElement("div", { className: "chart-pie-center-pct" }, arcs[hovered].pct.toFixed(1) + '%'))
            : React.createElement(React.Fragment, null,
                React.createElement("div", { className: "chart-pie-center-label" }, "Total"),
                React.createElement("div", { className: "chart-pie-center-val" }, fmtTotal(total)))
        )
      ),
      React.createElement("div", { className: "chart-pie-legend" },
        arcs.map((a, i) => React.createElement("button", {
          key: i, className: "chart-pie-legend-item" + (clickable ? " is-clickable" : ""),
          onMouseEnter: () => setHovered(i),
          onMouseLeave: () => setHovered(null),
          onClick: () => clickable ? handleSlice(a) : null,
          title: mode === 'sector' ? 'See holdings in ' + a.label : undefined
        },
          React.createElement("span", { className: "chart-pie-legend-dot", style: { background: a.color } }),
          React.createElement("span", { className: "chart-pie-legend-tkr" }, a.label),
          React.createElement("span", { className: "chart-pie-legend-pct" }, a.pct.toFixed(1) + '%'),
          mode === 'sector' ? React.createElement(Icon, { name: "chevron", size: 11, className: "chart-pie-legend-go" }) : null
        ))
      )
    ),
    // Sector → "which of my stocks make up this" floating breakdown.
    openSector && mode === 'sector' ? React.createElement(SectorHoldingsPopup, {
      sectorName: openSector,
      members: sectorMembers[openSector] || [],
      sectorValue: (grouped[openSector] && grouped[openSector].value) || 0,
      portfolioTotal: total,
      displayCurrency: displayCurrency,
      onOpenDetail: onOpenDetail,
      onClose: () => setOpenSector(null)
    }) : null
  );
}
// Floating breakdown of exactly which holdings make up a sector wedge — opened
// by tapping a sector in the allocation chart. Lists each position with its
// value, share of the sector, and a proportional bar; tapping a row dives into
// that stock. Mirrors the heatmap's SectorDetailModal pop-in animation.
function SectorHoldingsPopup({ sectorName, members, sectorValue, portfolioTotal, displayCurrency, onOpenDetail, onClose }) {
  const [closing, setClosing] = useState(false);
  const close = useCallback(() => { setClosing(true); setTimeout(onClose, 200); }, [onClose]);
  useBodyScrollLock();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
  const sym = CURRENCY_SYMBOLS[displayCurrency] || '$';
  const fmtMoney = v => sym + Math.round(v).toLocaleString('en-US');
  const pctPort = portfolioTotal > 0 ? (sectorValue / portfolioTotal * 100) : 0;
  const top = members[0];
  return React.createElement("div", { className: "sector-modal" + (closing ? " closing" : "") },
    React.createElement("div", { className: "sector-modal-backdrop", onClick: close }),
    React.createElement("div", { className: "sector-modal-panel sh-panel", role: "dialog", "aria-label": sectorName + " holdings" },
      React.createElement("div", { className: "sector-modal-header" },
        React.createElement("div", { className: "sector-modal-titles" },
          React.createElement("div", { className: "sector-modal-title" }, sectorName),
          React.createElement("div", { className: "sector-modal-sub" },
            members.length, members.length === 1 ? " holding" : " holdings",
            " · ", pctPort.toFixed(1), "% of portfolio")),
        React.createElement("button", { className: "modal-close", onClick: close, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" }))),
      React.createElement("div", { className: "sector-modal-body" },
        React.createElement("div", { className: "sh-summary" },
          React.createElement("div", { className: "sh-summary-cell" },
            React.createElement("div", { className: "sh-summary-label" }, "Sector value"),
            React.createElement("div", { className: "sh-summary-val" }, fmtMoney(sectorValue))),
          React.createElement("div", { className: "sh-summary-cell" },
            React.createElement("div", { className: "sh-summary-label" }, "Holdings"),
            React.createElement("div", { className: "sh-summary-val" }, members.length)),
          React.createElement("div", { className: "sh-summary-cell" },
            React.createElement("div", { className: "sh-summary-label" }, "Largest"),
            React.createElement("div", { className: "sh-summary-val" }, top ? top.ticker : "—"))),
        React.createElement("div", { className: "sh-list" },
          members.length === 0
            ? React.createElement("div", { className: "text-dim text-sm", style: { padding: 16, textAlign: 'center' } }, "No holdings in this sector.")
            : members.map((m, i) => {
                const wSector = sectorValue > 0 ? (m.value / sectorValue * 100) : 0;
                return React.createElement("button", {
                  key: m.market + ':' + m.ticker + ':' + i, className: "sh-row",
                  onClick: () => { if (onOpenDetail) onOpenDetail(m.ticker, m.market); close(); }
                },
                  React.createElement("div", { className: "sh-row-top" },
                    React.createElement("div", { className: "sh-row-id" },
                      React.createElement("span", { className: "sh-row-tkr" }, m.ticker),
                      React.createElement("span", { className: "sh-row-mkt" }, MARKET_LABELS[m.market] || m.market),
                      React.createElement("span", { className: "sh-row-name" }, m.name)),
                    React.createElement("div", { className: "sh-row-figs" },
                      React.createElement("span", { className: "sh-row-val" }, fmtMoney(m.value)),
                      React.createElement("span", { className: "sh-row-wt" }, wSector.toFixed(1), "%"))),
                  React.createElement("div", { className: "sh-bar" },
                    React.createElement("div", { className: "sh-bar-fill", style: { width: Math.max(2, Math.min(100, wSector)) + '%' } })));
              }))
      )
    )
  );
}
function DashboardView(_ref6) {
  let {
    positions,
    prices,
    onOpenDetail,
    contributions,
    onAddContribution,
    onRemoveContribution,
    onImportContributions,
    transactions,
    displayCurrency,
    onSetDisplayCurrency,
    fxRates,
    sectorCache,
    fundamentals
  } = _ref6;
  const computeStats = list => {
    let cost = 0, value = 0, hasAllPrices = true;
    list.forEach(p => {
      const q = prices[priceKey(p.market, p.ticker)];
      const native = marketCurrency(p.market);
      const qCcy = q?.currency?.toUpperCase();
      const nativeUpper = native.toUpperCase();
      const sameCcy = !qCcy || qCcy === nativeUpper || qCcy === 'ZAC' && nativeUpper === 'ZAR' || qCcy === 'GBX' && nativeUpper === 'GBP';
      cost += p.shares * p.costBasis;
      if (q && sameCcy) value += p.shares * q.price; else hasAllPrices = false;
    });
    return { cost, value, pnl: value - cost, pnlPct: cost > 0 ? (value - cost) / cost * 100 : 0, hasAllPrices };
  };
  const currencyGroups = Object.values(
    positions.reduce((map, p) => {
      const mc = MARKET_CURRENCY[p.market];
      if (!mc) return map;
      if (!map[mc.code]) map[mc.code] = { ...mc, posns: [], fmtMarket: p.market };
      map[mc.code].posns.push(p);
      return map;
    }, {})
  ).map(g => ({ ...g, ...computeStats(g.posns) }));
  const rates = fxRates?.rates || null;
  const marketGroups = Object.values(
    positions.reduce((map, p) => {
      if (!map[p.market]) map[p.market] = { market: p.market, posns: [] };
      map[p.market].posns.push(p);
      return map;
    }, {})
  ).map(g => {
    let cost = 0, value = 0;
    const native = marketCurrency(g.market);
    g.posns.forEach(p => {
      const q = prices[priceKey(p.market, p.ticker)];
      const c = convertCcy(p.shares * p.costBasis, native, displayCurrency, rates);
      const v = q ? convertCcy(p.shares * q.price, native, displayCurrency, rates) : null;
      if (c != null) cost += c;
      if (v != null) value += v;
    });
    return { ...g, cost, value, pnl: value - cost, pnlPct: cost > 0 ? (value - cost) / cost * 100 : 0 };
  });
  const totalValue = marketGroups.reduce((s, g) => s + g.value, 0);
  const totalCost = marketGroups.reduce((s, g) => s + g.cost, 0);
  const totalPnl = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? totalPnl / totalCost * 100 : 0;
  const [contribModalOpen, setContribModalOpen] = useState(false);
  const [contribImportOpen, setContribImportOpen] = useState(false);
  const [showContribHistory, setShowContribHistory] = useState(false);
  const [showTxHistory, setShowTxHistory] = useState(false);
  const [txFilter, setTxFilter] = useState('all');
  const [valueHidden, setValueHidden] = usePersistedState('pb.valueHidden.v1', false);
  const totalContribDisplay = contributions.reduce((sum, c) => {
    const conv = convertCcy(c.amount, c.currency, displayCurrency, rates);
    return sum + (conv || 0);
  }, 0);
  const overallReturn = totalValue - totalContribDisplay;
  const overallReturnPct = totalContribDisplay > 0 ? (overallReturn / totalContribDisplay * 100) : 0;
  return React.createElement("div", { className: "dashboard-page" },
    // Empty state
    positions.length === 0 ? React.createElement("div", { className: "empty" },
      React.createElement(Icon, { name: "briefcase", size: 40 }),
      React.createElement("h3", null, "No positions yet"),
      React.createElement("p", null, "Add your holdings in the Holdings tab to see portfolio analytics."))
    : React.createElement(React.Fragment, null,
      // Stat cards row
      React.createElement("div", { className: "stat-card total-portfolio-card mb-4" },
        React.createElement("div", { className: "flex justify-between items-center" },
          React.createElement("div", { className: "stat-label" }, "Total Portfolio Value \xB7 " + displayCurrency),
          React.createElement("button", {
            className: "icon-btn",
            onClick: () => setValueHidden(v => !v),
            'aria-label': valueHidden ? "Show value" : "Hide value",
            style: { marginTop: -4, marginBottom: -4 }
          }, React.createElement(Icon, { name: valueHidden ? 'eye-off' : 'eye', size: 14 }))),
        React.createElement("div", { className: "stat-value", style: valueHidden ? { filter: 'blur(10px)', userSelect: 'none', WebkitUserSelect: 'none' } : {} },
          fmtCcy(totalValue, displayCurrency)),
        React.createElement("div", { className: `stat-sub ${totalPnlPct >= 0 ? 'up' : 'down'}`, style: valueHidden ? { filter: 'blur(6px)', userSelect: 'none', WebkitUserSelect: 'none' } : {} },
          totalPnlPct >= 0 ? '+' : '', totalPnlPct.toFixed(2), "% \xB7 ",
          fmtCcySigned(totalPnl, displayCurrency)),
        (() => {
          const snap = computeFxSnapshot({ positions, contributions, prices, fxRates, displayCurrency });
          const hasRates = !!fxRates?.rates;
          const totalContrib = contributions.reduce((s, c) => {
            const v = convertCcy(c.amount, c.currency, displayCurrency, fxRates?.rates || null);
            return s + (v || 0);
          }, 0);
          const overallProfit = totalValue - totalContrib;
          const fxGain = snap.fxGainOnCost;
          const hasFx = hasRates && Math.abs(fxGain) > 0.01;
          const hasContrib = totalContrib > 0;
          return (hasFx || hasContrib) ? React.createElement("div", {
            className: "portfolio-summary-row",
            style: valueHidden ? { filter: 'blur(6px)', userSelect: 'none', WebkitUserSelect: 'none' } : {}
          },
            hasFx && React.createElement("div", { className: "portfolio-summary-item" },
              React.createElement("span", { className: "portfolio-summary-label" },
                "Forex " + (fxGain >= 0 ? "gain" : "loss")),
              React.createElement("span", { className: `portfolio-summary-val ${fxGain >= 0 ? 'up' : 'down'}` },
                fmtCcySigned(fxGain, displayCurrency))),
            hasContrib && React.createElement("div", { className: "portfolio-summary-item" },
              React.createElement("span", { className: "portfolio-summary-label" }, "Overall profit"),
              React.createElement("span", { className: `portfolio-summary-val ${overallProfit >= 0 ? 'up' : 'down'}` },
                fmtCcySigned(overallProfit, displayCurrency)))
          ) : null;
        })()),
      // Portfolio growth chart
      React.createElement("div", { className: "card mb-4" },
        React.createElement("div", { className: "eyebrow", style: { marginBottom: 12 } }, "Portfolio Growth"),
        React.createElement(PortfolioLineChart, { positions, prices, contributions, displayCurrency, fxRates })),
      // Allocation pie chart
      React.createElement("div", { className: "card mb-4" },
        React.createElement("div", { className: "eyebrow", style: { marginBottom: 12 } }, "Allocation"),
        React.createElement(PortfolioPieChart, { positions, prices, displayCurrency, fxRates, onOpenDetail, sectorCache, fundamentals })),
      // Growth tracker
      React.createElement("div", { className: "card mb-4 growth-tracker-card" },
        React.createElement("div", { className: "growth-tracker-header" },
          React.createElement("div", null,
            React.createElement("div", { className: "growth-tracker-title" }, "Growth Tracker"),
            React.createElement("div", { className: "growth-tracker-subtitle" }, "Performance & returns")),
          React.createElement("div", { className: "growth-tracker-actions" },
            onImportContributions ? React.createElement("button", { className: "growth-deposit-btn ghost", onClick: () => setContribImportOpen(true), title: "Import deposits & withdrawals" },
              React.createElement(Icon, { name: "download", size: 11 }), "Import") : null,
            React.createElement("button", { className: "growth-deposit-btn", onClick: () => setContribModalOpen(true) },
              React.createElement(Icon, { name: "plus", size: 11 }), "Log deposit"))),
        React.createElement("div", { className: "growth-stats-grid" },
          React.createElement("div", { className: "growth-stat" },
            React.createElement("div", { className: "growth-stat-header" },
              React.createElement("div", { className: "growth-stat-label" }, "Overall Return"),
              React.createElement("div", { className: "growth-stat-sub" }, "vs. contributions")),
            totalContribDisplay > 0
              ? React.createElement("div", { className: "growth-currency-row" },
                  React.createElement("span", { className: "market-badge" }, displayCurrency),
                  React.createElement("span", { className: `growth-val ${overallReturn >= 0 ? 'up' : 'down'}` },
                    overallReturn >= 0 ? '+' : '\u2212',
                    fmtCcy(Math.abs(overallReturn), displayCurrency)),
                  React.createElement("span", { className: `growth-pct ${overallReturnPct >= 0 ? 'up' : 'down'}` },
                    overallReturnPct >= 0 ? '+' : '', overallReturnPct.toFixed(1), "%"))
              : React.createElement("div", { className: "text-dim text-sm", style: { padding: '10px 14px', background: 'var(--bg-elev)', borderRadius: 10 } }, "Log a deposit to track overall return."),
            totalContribDisplay > 0 && React.createElement("button", {
              className: "growth-contrib-total",
              onClick: () => setShowContribHistory(true)
            }, React.createElement("span", { className: "text-dim" }, "Total contributions"),
              React.createElement("span", { className: "mono" }, fmtCcy(totalContribDisplay, displayCurrency)),
              React.createElement(Icon, { name: "chevron", size: 12 }))),
          React.createElement("div", { className: "growth-stat" },
            React.createElement("div", { className: "growth-stat-header" },
              React.createElement("div", { className: "growth-stat-label" }, "Position P&L"),
              React.createElement("div", { className: "growth-stat-sub" }, "vs. cost basis")),
            currencyGroups.length > 0
              ? currencyGroups.map(g => React.createElement("div", { key: g.code, className: "growth-currency-row" },
                  React.createElement("span", { className: "market-badge" }, g.label),
                  React.createElement("span", { className: `growth-val ${g.pnl >= 0 ? 'up' : 'down'}` }, g.pnl >= 0 ? '+' : '\u2212', fmt(Math.abs(g.pnl), g.fmtMarket)),
                  React.createElement("span", { className: `growth-pct ${g.pnlPct >= 0 ? 'up' : 'down'}` }, g.pnlPct >= 0 ? '+' : '', g.pnlPct.toFixed(1), "%")))
              : React.createElement("div", { className: "text-dim text-sm", style: { padding: '10px 14px', background: 'var(--bg-elev)', borderRadius: 10 } }, "Add positions to see P&L."),
            (positions.length > 0 || transactions.length > 0) && React.createElement("button", {
              className: "growth-contrib-total",
              onClick: () => setShowTxHistory(true)
            }, React.createElement("span", { className: "text-dim" }, "Transaction history"),
              React.createElement(Icon, { name: "chevron", size: 12 }))))),
      // Contribution history modal
      showContribHistory && React.createElement("div", { className: "modal", onClick: e => { if (e.target.classList.contains('modal-backdrop')) setShowContribHistory(false); } },
        React.createElement("div", { className: "modal-backdrop", onClick: () => setShowContribHistory(false) }),
        React.createElement("div", { className: "modal-panel", style: { maxWidth: 480 } },
          React.createElement("div", { className: "modal-handle" }),
          React.createElement("div", { className: "modal-header" },
            React.createElement("div", null,
              React.createElement("div", { className: "modal-title" }, "Transaction History"),
              React.createElement("div", { className: "modal-subtitle" }, "All deposits and withdrawals")),
            React.createElement("button", { className: "modal-close", onClick: () => setShowContribHistory(false) },
              React.createElement(Icon, { name: "x" }))),
          React.createElement("div", { className: "modal-body" },
            contributions.length === 0
              ? React.createElement("div", { className: "text-dim text-sm", style: { textAlign: 'center', padding: 20 } }, "No transactions logged yet.")
              : contributions.slice().sort((a, b) => b.date.localeCompare(a.date)).map((c, i) =>
                React.createElement("div", { key: c.id || i, className: "transaction-row" },
                  React.createElement("div", { className: "transaction-info" },
                    React.createElement("div", { className: "transaction-date" }, new Date(c.date + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })),
                    c.note && React.createElement("div", { className: "transaction-note" }, c.note)),
                  React.createElement("div", { className: `transaction-amount ${c.amount >= 0 ? 'up' : 'down'}` },
                    (c.amount >= 0 ? '+' : '\u2212') + (CURRENCY_SYMBOLS[c.currency] || '') + Math.abs(c.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
                  React.createElement("button", { className: "btn btn-ghost btn-xs", onClick: () => { onRemoveContribution(c.id); } },
                    React.createElement(Icon, { name: "x", size: 10 })))),
            React.createElement("div", { className: "transaction-summary" },
              React.createElement("span", null, "Total: "),
              React.createElement("span", { className: "mono" }, fmtCcy(totalContribDisplay, displayCurrency)))))),
      // Transaction history modal
      showTxHistory && (() => {
        const txMarkets = ['all', ...Array.from(new Set(transactions.map(t => t.market)))];
        const filtered = txFilter === 'all' ? transactions : transactions.filter(t => t.market === txFilter);
        const sorted = filtered.slice().sort((a, b) => (b.date || b.createdAt).localeCompare(a.date || a.createdAt));
        return React.createElement("div", { className: "modal", onClick: e => { if (e.target.classList.contains('modal-backdrop')) setShowTxHistory(false); } },
          React.createElement("div", { className: "modal-backdrop", onClick: () => setShowTxHistory(false) }),
          React.createElement("div", { className: "modal-panel", style: { maxWidth: 520 } },
            React.createElement("div", { className: "modal-handle" }),
            React.createElement("div", { className: "modal-header" },
              React.createElement("div", null,
                React.createElement("div", { className: "modal-title" }, "Transaction History"),
                React.createElement("div", { className: "modal-subtitle" }, sorted.length, " transactions")),
              React.createElement("button", { className: "modal-close", onClick: () => setShowTxHistory(false) },
                React.createElement(Icon, { name: "x" }))),
            React.createElement("div", { className: "modal-body" },
              React.createElement("div", { className: "tx-filter-row" },
                txMarkets.map(m => React.createElement("button", {
                  key: m,
                  className: `tx-filter-btn ${txFilter === m ? 'active' : ''}`,
                  onClick: () => setTxFilter(m)
                }, m === 'all' ? 'All' : m))),
              sorted.length === 0
                ? React.createElement("div", { className: "text-dim text-sm", style: { textAlign: 'center', padding: 20 } }, "No transactions recorded yet.")
                : sorted.map(tx => {
                  const isBuy = tx.type === 'buy';
                  const total = tx.shares * tx.price;
                  const ccy = (MARKET_CURRENCY[tx.market] || MARKET_CURRENCY.US).sym;
                  return React.createElement("div", { key: tx.id, className: "transaction-row" },
                    React.createElement("div", { className: "transaction-info" },
                      React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                        React.createElement("span", { className: `tx-type-badge ${isBuy ? 'buy' : 'sell'}` }, isBuy ? 'BUY' : 'SELL'),
                        React.createElement("span", { style: { fontWeight: 600, fontSize: 13 } }, tx.ticker),
                        React.createElement("span", { className: "market-badge" }, tx.market)),
                      React.createElement("div", { className: "text-xs text-dim" },
                        tx.shares, " shares @ ", ccy, tx.price.toFixed(2),
                        tx.notes ? ' \xB7 ' + tx.notes : '')),
                    React.createElement("div", { style: { textAlign: 'right' } },
                      React.createElement("div", { className: `transaction-amount ${isBuy ? '' : 'up'}` },
                        (isBuy ? '-' : '+') + ccy + total.toFixed(2)),
                      React.createElement("div", { className: "text-xs text-dim" },
                        new Date(tx.date + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }))));
                }))));
      })(),
      // Contribution modal
      contribModalOpen ? React.createElement(ContributionModal, {
        onClose: () => setContribModalOpen(false),
        onOpenImport: onImportContributions ? () => setContribImportOpen(true) : null,
        onSave: (amount, currency, date, note) => { onAddContribution(amount, currency, date, note); setContribModalOpen(false); }
      }) : null,
      // Deposit / withdrawal bulk import
      contribImportOpen ? React.createElement(ContributionImportModal, {
        onClose: () => setContribImportOpen(false),
        onImport: (entries) => { if (onImportContributions) onImportContributions(entries); setContribImportOpen(false); }
      }) : null,
      ));
}
function CurrentView(_ref7) {
  let {
    prices,
    positions,
    marketFilter,
    setMarketFilter,
    onOpenDetail,
    onAddPosition,
    onImportPositions,
    onSellPosition,
    onRemovePosition
  } = _ref7;
  // Always offer the three primary US/SA tabs, then surface any other market
  // the user actually holds (LSE, ASX, FRA, PAR, AMS…) so imported non-US
  // holdings don't silently disappear from the Holdings view.
  const BASE_TABS = ['US', 'JSE', 'TFSA'];
  const marketOrder = MARKETS.map(m => m.value);
  const extraMarkets = Array.from(new Set(positions.map(p => p.market)))
    .filter(m => !BASE_TABS.includes(m))
    .sort((a, b) => marketOrder.indexOf(a) - marketOrder.indexOf(b));
  const tabs = [...BASE_TABS, ...extraMarkets];
  const tabLabel = (m) => MARKET_LABELS[m] || m;
  const activeMarket = tabs.includes(marketFilter) ? marketFilter : 'US';
  const countFor = (m) => positions.filter(p => p.market === m).length;

  const renderMarket = (market) => {
    const rows = positions.filter(p => p.market === market);
    if (rows.length === 0) {
      return React.createElement("div", { className: "empty" },
        React.createElement(Icon, { name: "briefcase", size: 40 }),
        React.createElement("h3", null, "No ", tabLabel(market), " positions yet"),
        React.createElement("p", null, "Add your ", tabLabel(market), " holdings using the Add button above."));
    }
    return React.createElement("div", null, React.createElement("div", {
      className: "eyebrow"
    }, "Your ", tabLabel(market), " positions"), React.createElement("div", {
      className: "row-list"
    }, rows.map(p => {
      const q = prices[priceKey(market, p.ticker)];
      const info = DATA.findInfo(p.ticker, market);
      const marketValue = q ? p.shares * q.price : null;
      const cost = p.shares * p.costBasis;
      const pnlPct = marketValue != null && cost > 0 ? (marketValue - cost) / cost * 100 : null;
      const remove = (e) => {
        e.stopPropagation();
        if (!onRemovePosition) return;
        if (window.confirm(`Remove ${p.ticker} (${tabLabel(market)}) from your holdings?\n\nThis deletes the position without recording a sale — use Sell instead if you actually sold.`)) {
          onRemovePosition(p.id);
        }
      };
      return React.createElement("button", {
        key: p.id,
        className: "row",
        onClick: () => onOpenDetail(p.ticker, market)
      }, React.createElement("div", {
        className: "row-main"
      }, React.createElement("div", {
        className: "row-head"
      }, React.createElement("span", {
        className: "tkr"
      }, p.ticker), React.createElement("span", {
        className: "text-sm text-dim"
      }, (info && info.name) || p.ticker)), React.createElement("div", {
        className: "row-meta"
      }, p.shares, " \xD7 ", fmt(p.costBasis, market), pnlPct != null && React.createElement("span", {
        className: `mono ${pnlPct >= 0 ? 'text-up' : 'text-down'}`
      }, " \xB7 ", pnlPct >= 0 ? '+' : '', pnlPct.toFixed(2), "%"),
        React.createElement("button", {
          className: "btn-sell-inline",
          onClick: e => { e.stopPropagation(); onSellPosition(p); }
        }, "Sell"),
        React.createElement("button", {
          className: "btn-remove-inline",
          title: "Remove holding",
          "aria-label": "Remove holding",
          onClick: remove
        }, React.createElement(Icon, { name: "trash", size: 12 })))),
        React.createElement("div", {
        className: "row-right"
      }, React.createElement(PriceBlock, {
        quote: q
      }), marketValue != null && React.createElement("div", {
        className: "text-xs text-dim mt-1 mono"
      }, fmt(marketValue, market))));
    })));
  };
  return React.createElement("div", null, React.createElement("div", {
    className: "flex justify-between items-center mb-3 flex-wrap",
    style: {
      gap: 10
    }
  }, React.createElement("div", {
    className: "toggle-group toggle-group-scroll"
  }, tabs.map(m => React.createElement("button", {
    key: m,
    className: `toggle-opt ${activeMarket === m ? 'active' : ''}`,
    onClick: () => setMarketFilter(m)
  }, tabLabel(m), " (", countFor(m), ")"))),
    React.createElement("div", { className: "flex gap-2 items-center" },
      React.createElement("button", { className: "btn btn-secondary btn-sm", onClick: onImportPositions },
        React.createElement(Icon, { name: "download", size: 13 }), " Import"),
      React.createElement("button", { className: "btn btn-primary btn-sm", onClick: onAddPosition },
        React.createElement(Icon, { name: "plus", size: 13 }), " Add"))),
    renderMarket(activeMarket));
}
const ALL_TICKERS = (() => {
  const seen = new Set();
  const result = [];
  const add = (ticker, name, market) => {
    const key = priceKey(market, ticker);
    if (!seen.has(key)) { seen.add(key); result.push({ ticker, name, market }); }
  };
  DATA.HOLDINGS.forEach(h => add(h.ticker, h.name, 'US'));
  DATA.NEW_PICKS.forEach(p => add(p.ticker, p.name, 'US'));
  DATA.HEDGES.forEach(h => add(h.ticker, h.name, 'US'));
  DATA.JSE_SUGGESTIONS.forEach(s => add(s.ticker, s.name, 'JSE'));
  (DATA.TFSA_SUGGESTIONS || []).forEach(s => add(s.ticker, s.name, 'TFSA'));
  (DATA.LSE_SUGGESTIONS || []).forEach(s => add(s.ticker, s.name, 'LSE'));
  (DATA.ASX_SUGGESTIONS || []).forEach(s => add(s.ticker, s.name, 'ASX'));
  (DATA.EU_SUGGESTIONS || []).forEach(s => add(s.ticker, s.name, s.exchange || 'FRA'));
  return result;
})();

const YAHOO_EXCHANGE_MAP = {
  'JO': 'JSE', 'JNB': 'JSE',
  'L': 'LSE', 'LSE': 'LSE',
  'AX': 'ASX', 'ASX': 'ASX',
  'F': 'FRA', 'DE': 'FRA', 'GER': 'FRA', 'FRA': 'FRA',
  'PA': 'PAR', 'PAR': 'PAR',
  'AS': 'AMS', 'AMS': 'AMS'
};
function parseYahooSymbol(sym) {
  if (!sym) return null;
  const dot = sym.lastIndexOf('.');
  if (dot > 0) {
    const suffix = sym.slice(dot + 1).toUpperCase();
    const market = YAHOO_EXCHANGE_MAP[suffix];
    if (market) return { ticker: sym.slice(0, dot), market };
  }
  return { ticker: sym, market: 'US' };
}
async function fetchYahooSearch(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  // Route through the shared, self-healing proxy chain (same one the price feed
  // uses) and try both Yahoo hosts — the old hard-coded 3-proxy list failed
  // often enough that name-based import matching couldn't find anything.
  const urls = [
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=18&newsCount=0&listsCount=0`,
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=18&newsCount=0&listsCount=0`,
  ];
  for (const url of urls) {
    const text = await fetchViaProxies(url, { timeoutMs: 8000 });
    if (!text) continue;
    let data;
    try { data = JSON.parse(text); } catch (_e) { continue; }
    if (!Array.isArray(data.quotes)) continue;
    const out = [];
    for (const item of data.quotes) {
      if (!item.symbol) continue;
      const qt = (item.quoteType || '').toUpperCase();
      if (qt && qt !== 'EQUITY' && qt !== 'ETF' && qt !== 'MUTUALFUND') continue;
      const parsed = parseYahooSymbol(item.symbol);
      if (!parsed) continue;
      const name = item.shortname || item.longname || parsed.ticker;
      cacheName(parsed.market, parsed.ticker, name);
      out.push({ ticker: parsed.ticker, market: parsed.market, name, exchange: item.exchDisp || '' });
    }
    if (out.length) return out;
  }
  return [];
}
// ── Fuzzy company-name matching for import ────────────────────────────────
// Strip legal suffixes / punctuation so "Broadcom Inc." ≈ "broadcom".
function normaliseCompanyName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,'’`()\/\-]/g, ' ')
    .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|holdings?|group|grp|ag|sa|nv|se|asa|spa|the|class|cls|adr|ads|ordinary|ord|shares?|reit|trust|fund|enterprises?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// Sørensen–Dice bigram similarity (0..1) — robust to typos/misspellings
// ("brodcom" ≈ "broadcom") which exact/substring checks miss.
function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let inter = 0, bn = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2); bn++;
    const c = grams.get(g);
    if (c > 0) { inter++; grams.set(g, c - 1); }
  }
  return (2 * inter) / ((a.length - 1) + bn);
}
// 0..1 similarity between a query and a candidate company name. Blends exact /
// prefix / substring / token-overlap / bigram / acronym signals so fuzzy and
// abbreviated inputs still land on the right company.
function companyNameScore(query, candidate) {
  const a = normaliseCompanyName(query);
  const b = normaliseCompanyName(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  let score = 0;
  if (b.startsWith(a) || a.startsWith(b)) score = Math.max(score, 0.92);
  else if (b.includes(a) || a.includes(b)) score = Math.max(score, 0.8);
  const at = a.split(' '), bt = b.split(' ');
  const aset = new Set(at), bset = new Set(bt);
  let inter = 0; aset.forEach(t => { if (bset.has(t)) inter++; });
  const uni = new Set([...at, ...bt]).size;
  let j = uni ? inter / uni : 0;
  if (at[0] && at[0] === bt[0]) j += 0.18; // first-word match (e.g. "Anglo …")
  score = Math.max(score, Math.min(0.9, j));
  // Typo tolerance on the despaced strings.
  score = Math.max(score, diceSimilarity(a.replace(/ /g, ''), b.replace(/ /g, '')) * 0.85);
  // Acronym: short query matches the candidate's word initials (IBM → I.B.M.).
  const aFlat = a.replace(/ /g, '');
  if (aFlat.length >= 2 && aFlat.length <= 5 && bt.length >= 2) {
    const initials = bt.map(w => w[0]).join('');
    if (initials === aFlat || initials.startsWith(aFlat)) score = Math.max(score, 0.72);
  }
  return Math.min(1, score);
}
// Decide whether a token looks like a stock symbol rather than a company name.
function looksLikeTickerToken(s) {
  const t = String(s || '').trim().toUpperCase();
  if (!t || /\s/.test(t)) return false;
  return /^[A-Z0-9]{1,5}([.\-:][A-Z]{1,4})?$/.test(t);
}
// Rank live-search + local candidates for a query, biased by the chosen market.
function rankImportCandidates(query, tickerHint, chosenMarket, remote) {
  const pool = [];
  const seen = new Set();
  const add = (c) => {
    if (!c || !c.ticker) return;
    const key = priceKey(c.market, c.ticker);
    if (seen.has(key)) return;
    seen.add(key);
    pool.push(c);
  };
  (remote || []).forEach(add);
  // Seed from the app's own known tickers so offline / proxy-down still matches
  // the curated universe (JSE, LSE, US holdings, etc.).
  const qUpper = String(query || '').toUpperCase();
  ALL_TICKERS.forEach(t => {
    if (t.ticker === qUpper || (tickerHint && t.ticker === String(tickerHint).toUpperCase()) ||
        companyNameScore(query, t.name) >= 0.6) {
      add({ ticker: t.ticker, market: t.market, name: t.name, exchange: '' });
    }
  });
  return pool.map(c => {
    const ns = companyNameScore(query, c.name);
    let score = ns * 100;
    if (c.market === chosenMarket) score += 45;                 // market guides the pick
    if (tickerHint && c.ticker.toUpperCase() === String(tickerHint).toUpperCase()) score += 35;
    if (c.ticker.toUpperCase() === qUpper) score += 25;          // query itself was a symbol
    return { ...c, score, nameScore: ns };
  }).sort((a, b) => b.score - a.score);
}
// Search live listings using several query variants (full name, suffix-stripped,
// first words, ticker hint), stopping early once a confident chosen-market match
// appears. This is what makes fuzzy / abbreviated company names resolve.
async function searchListingsMulti(query, tickerHint, chosenMarket) {
  const q = String(query || '').trim();
  const tried = new Set();
  const merged = [];
  const runSearch = async (term) => {
    const key = String(term || '').toLowerCase().trim();
    if (!key || tried.has(key)) return;
    tried.add(key);
    const r = await fetchYahooSearch(term);
    if (r && r.length) merged.push(...r);
  };
  const hasStrong = () => rankImportCandidates(q, tickerHint, chosenMarket, merged)
    .some(c => c.market === chosenMarket && c.nameScore >= 0.82);
  await runSearch(q);
  if (!hasStrong()) {
    const norm = normaliseCompanyName(q);
    const words = norm.split(' ').filter(Boolean);
    if (norm && norm !== q.toLowerCase()) await runSearch(norm);
    if (!hasStrong() && words.length > 2) await runSearch(words.slice(0, 2).join(' '));
    if (!hasStrong() && words.length > 1) await runSearch(words[0]);
    if (!hasStrong() && tickerHint) await runSearch(tickerHint);
  }
  return merged;
}
// ─────────────────────────────────────────────────────────────────────────
// Holdings import: parse CSV / TSV / Markdown / plain text natively, and XLSX
// and PDF via libraries loaded lazily from a CDN only when a file of that type
// is actually dropped. Everything funnels into a common {ticker, shares,
// costBasis, market, purchaseDate, name} shape that the preview UI can edit
// before committing. Designed to be forgiving: many broker exports vary wildly
// in column names, separators, currency symbols and number formats.
// ─────────────────────────────────────────────────────────────────────────
function loadScriptOnce(src) {
  loadScriptOnce._cache = loadScriptOnce._cache || {};
  if (loadScriptOnce._cache[src]) return loadScriptOnce._cache[src];
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
  loadScriptOnce._cache[src] = p;
  return p;
}
const XLSX_CDN = 'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js';
const PDFJS_CDN = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

// Header-name synonyms, checked in order. First matching column wins per field.
const IMPORT_SYNONYMS = {
  ticker: ['ticker', 'symbol', 'symb', 'code', 'instrument', 'security', 'scrip', 'share code', 'stock code', 'isin'],
  shares: ['shares', 'quantity', 'qty', 'units', 'no. of shares', 'number of shares', 'share qty', 'units held', 'quantity held', 'holding', 'holdings', 'nominal', 'volume', 'position'],
  cost:   ['cost basis', 'avg cost', 'average cost', 'avg. cost', 'cost price', 'unit cost', 'avg price', 'average price', 'avg. price', 'price paid', 'purchase price', 'buy price', 'avg buy price', 'book cost per share', 'entry price', 'vwap', 'cost'],
  total:  ['total cost', 'book cost', 'book value', 'amount invested', 'invested', 'total invested', 'cost value', 'total cost basis'],
  price:  ['last price', 'current price', 'market price', 'last', 'price', 'close'],
  market: ['market', 'exchange', 'mkt', 'listing'],
  currency: ['currency', 'ccy', 'curr'],
  name:   ['name', 'company', 'description', 'security name', 'stock', 'company name', 'instrument name'],
  date:   ['date', 'purchase date', 'buy date', 'trade date', 'acquired', 'date acquired', 'opened'],
};
const CURRENCY_TO_MARKET = { USD: 'US', ZAR: 'JSE', GBP: 'LSE', GBX: 'LSE', GBP_PENCE: 'LSE', AUD: 'ASX', EUR: 'FRA' };
const SUFFIX_TO_MARKET = { JO: 'JSE', JNB: 'JSE', L: 'LSE', LON: 'LSE', AX: 'ASX', ASX: 'ASX', DE: 'FRA', F: 'FRA', FRA: 'FRA', PA: 'PAR', AS: 'AMS' };

// Split a raw ticker like "AGL.JO" or "BHP:AX" into its market + bare symbol.
function splitTickerMarket(raw) {
  if (!raw) return { ticker: '', market: null };
  let s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  const m = s.match(/[.:]([A-Z]{1,4})$/);
  if (m && SUFFIX_TO_MARKET[m[1]]) {
    return { ticker: s.slice(0, m.index), market: SUFFIX_TO_MARKET[m[1]] };
  }
  return { ticker: s, market: null };
}
function inferMarket(currencyRaw, marketRaw, suffixMarket) {
  if (suffixMarket) return suffixMarket;
  const mr = (marketRaw || '').trim().toUpperCase();
  if (mr) {
    if (MARKET_CURRENCY[mr]) return mr;
    if (/(NYSE|NASDAQ|NMS|NYQ|US|AMEX)/.test(mr)) return 'US';
    if (/(JSE|JOHANNESBURG|JNB)/.test(mr)) return 'JSE';
    if (/(LSE|LONDON)/.test(mr)) return 'LSE';
    if (/(ASX|AUSTRAL)/.test(mr)) return 'ASX';
    if (/(XETRA|FRANKFURT|FRA|DAX)/.test(mr)) return 'FRA';
    if (/(PARIS|EURONEXT PAR)/.test(mr)) return 'PAR';
    if (/(AMSTERDAM)/.test(mr)) return 'AMS';
  }
  const cr = (currencyRaw || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (cr && CURRENCY_TO_MARKET[cr]) return CURRENCY_TO_MARKET[cr];
  return 'US';
}

// Split a single text line into cells, auto-detecting the delimiter. Falls back
// to runs of 2+ spaces (fixed-width / PDF text) when no real delimiter exists.
function splitLine(line) {
  if (line.includes('\t')) return line.split('\t').map(c => c.trim());
  // Markdown table row
  if (/^\s*\|/.test(line)) return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  const commaCount = (line.match(/,/g) || []).length;
  const semiCount = (line.match(/;/g) || []).length;
  if (semiCount > commaCount && semiCount >= 1) return splitCsvLine(line, ';');
  if (commaCount >= 1) return splitCsvLine(line, ',');
  // Whitespace-separated (2+ spaces) — common in copied PDF tables
  const ws = line.trim().split(/\s{2,}/).map(c => c.trim());
  if (ws.length > 1) return ws;
  return line.trim().split(/\s+/).map(c => c.trim());
}
// CSV splitter that respects double-quoted fields.
function splitCsvLine(line, delim) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delim && !inQ) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
function looksLikeHeader(cells) {
  const joined = cells.join(' ').toLowerCase();
  const all = [].concat(...Object.values(IMPORT_SYNONYMS));
  return all.some(syn => joined.includes(syn));
}
function matchColumn(headers, synonyms, used) {
  const norm = headers.map(h => (h || '').toLowerCase().trim());
  const free = (i) => i >= 0 && !(used && used.has(i));
  // Exact match first, then "contains" — skipping columns already claimed by a
  // more specific field (so "Book Cost" is taken as a total, not a per-share).
  for (const syn of synonyms) {
    const i = norm.findIndex((h, idx) => h === syn && free(idx));
    if (i >= 0) return i;
  }
  for (const syn of synonyms) {
    const i = norm.findIndex((h, idx) => h && h.includes(syn) && free(idx));
    if (i >= 0) return i;
  }
  return -1;
}

// Turn an array-of-rows (each an array of cells) into holding objects.
function rowsToHoldings(rows) {
  const cleaned = rows.filter(r => r && r.some(c => c && String(c).trim() !== '') && !/^[-\s|:]+$/.test(r.join('')));
  if (cleaned.length === 0) return [];
  let headerIdx = -1;
  for (let i = 0; i < Math.min(cleaned.length, 5); i++) {
    if (looksLikeHeader(cleaned[i])) { headerIdx = i; break; }
  }
  let cols, dataRows;
  if (headerIdx >= 0) {
    const headers = cleaned[headerIdx];
    const used = new Set();
    const claim = (syns) => { const i = matchColumn(headers, syns, used); if (i >= 0) used.add(i); return i; };
    // Order matters: claim the more specific fields first so generic ones
    // (e.g. "cost" containing "book cost") don't steal a total/value column.
    cols = {
      ticker:   claim(IMPORT_SYNONYMS.ticker),
      total:    claim(IMPORT_SYNONYMS.total),
      cost:     claim(IMPORT_SYNONYMS.cost),
      shares:   claim(IMPORT_SYNONYMS.shares),
      price:    claim(IMPORT_SYNONYMS.price),
      currency: claim(IMPORT_SYNONYMS.currency),
      market:   claim(IMPORT_SYNONYMS.market),
      date:     claim(IMPORT_SYNONYMS.date),
      name:     claim(IMPORT_SYNONYMS.name),
    };
    dataRows = cleaned.slice(headerIdx + 1);
    if (cols.ticker < 0 && cols.name < 0) { headerIdx = -1; }
  }
  if (headerIdx < 0) {
    // Positional fallback: assume [ticker, shares, cost, (market)].
    cols = { ticker: 0, shares: 1, cost: 2, total: -1, price: -1, market: 3, currency: -1, name: -1, date: -1 };
    dataRows = cleaned;
  }
  const get = (row, i) => (i >= 0 && i < row.length) ? String(row[i] != null ? row[i] : '').trim() : '';
  const isNumericCell = (c) => { const s = String(c || '').trim(); return s !== '' && isFinite(parseDecimal(s)) && /^[\d.,\s$£R€%+\-]+$/.test(s); };
  const holdings = [];
  for (const row of dataRows) {
    const nameCell = cols.name >= 0 ? get(row, cols.name) : '';
    const tickerCell = cols.ticker >= 0 ? get(row, cols.ticker) : '';
    const shares = parseDecimal(get(row, cols.shares));
    let cost = parseDecimal(get(row, cols.cost));
    if ((!isFinite(cost) || cost <= 0) && cols.total >= 0 && isFinite(shares) && shares > 0) {
      const tot = parseDecimal(get(row, cols.total));
      if (isFinite(tot) && tot > 0) cost = tot / shares;
    }
    if ((!isFinite(cost) || cost <= 0) && cols.price >= 0) {
      const pr = parseDecimal(get(row, cols.price));
      if (isFinite(pr) && pr > 0) cost = pr;
    }
    // Name-first: the markdown almost always lists company names, so the human
    // identifier (name column, else the ticker column) becomes the search query
    // that gets fuzzy-matched to a live listing. A bare symbol token is kept as
    // a hint, but we never coerce a company name into a fake ticker.
    let query = nameCell;
    let tickerHint = null;
    let suffixMarket = null;
    if (tickerCell) {
      const sp = splitTickerMarket(tickerCell);
      suffixMarket = sp.market;
      if (looksLikeTickerToken(tickerCell)) tickerHint = sp.ticker;
      if (!query) query = tickerCell;
    }
    if (!query) {
      const textCells = row.map(c => String(c || '').trim()).filter(c => c && !isNumericCell(c));
      textCells.sort((a, b) => b.length - a.length);
      query = textCells[0] || '';
      if (query && !tickerHint && looksLikeTickerToken(query)) {
        const sp = splitTickerMarket(query);
        tickerHint = sp.ticker; suffixMarket = suffixMarket || sp.market;
      }
    }
    if (!query) continue;
    const marketCol = cols.market >= 0 ? get(row, cols.market) : '';
    const currencyCol = cols.currency >= 0 ? get(row, cols.currency) : '';
    let marketHint = null;
    if (suffixMarket) marketHint = suffixMarket;
    else if (marketCol || currencyCol) marketHint = inferMarket(currencyCol, marketCol, null);
    let purchaseDate = '';
    if (cols.date >= 0) {
      const d = parseImportDate(get(row, cols.date));
      if (d) purchaseDate = d;
    }
    holdings.push({
      query: query.trim(),
      nameHint: nameCell,
      tickerHint,
      marketHint,
      shares: isFinite(shares) ? shares : null,
      costBasis: isFinite(cost) && cost > 0 ? cost : null,
      purchaseDate,
    });
  }
  return holdings;
}
function parseImportDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); // DD/MM/YYYY (assume day-first)
  if (m) {
    let d = +m[1], mo = +m[2];
    if (d > 12 && mo <= 12) { /* clearly DD/MM */ }
    else if (mo > 12) { [d, mo] = [mo, d]; } // was MM/DD
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return '';
}
// Strip leading markdown list markers ("- ", "* ", "+ ", "•", "1. ", "1) ")
// and trailing markdown emphasis so a plain "- **Broadcom**" line becomes
// "Broadcom" before we split it into cells.
function stripListMarker(line) {
  return String(line)
    .replace(/^\s{0,4}([-*+•·–—]\s+|\d{1,3}[.)]\s+)/, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s+/, '')
    .trim();
}
function parseHoldingsFromText(text) {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
    .map(stripListMarker)
    .filter(l => l.trim() !== '');
  const rows = lines.map(splitLine);
  return rowsToHoldings(rows);
}
async function parseXlsxFile(file) {
  await loadScriptOnce(XLSX_CDN);
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('Spreadsheet reader failed to load.');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const all = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });
    const holdings = rowsToHoldings(aoa);
    all.push(...holdings);
    if (holdings.length > 0) break; // first sheet that yields rows
  }
  return all;
}
async function parsePdfFile(file) {
  await loadScriptOnce(PDFJS_CDN);
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) throw new Error('PDF reader failed to load.');
  try { pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; } catch (_) {}
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Group text items into visual lines by their y-coordinate.
    const byY = {};
    for (const it of content.items) {
      if (!it.str || !it.transform) continue;
      const y = Math.round(it.transform[5]);
      (byY[y] = byY[y] || []).push({ x: it.transform[4], s: it.str });
    }
    Object.keys(byY).map(Number).sort((a, b) => b - a).forEach(y => {
      const cells = byY[y].sort((a, b) => a.x - b.x).map(o => o.s);
      lines.push(cells.join('  '));
    });
  }
  return parseHoldingsFromText(lines.join('\n'));
}
async function parseImportFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || /sheet|excel/.test(file.type)) {
    return parseXlsxFile(file);
  }
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    return parsePdfFile(file);
  }
  const text = await file.text();
  return parseHoldingsFromText(text);
}

// ── Deposit / withdrawal (cash-flow) import ────────────────────────────────
// Brokers and spreadsheets emit dates and amounts in wildly different shapes;
// these parsers are deliberately tolerant so a user can paste almost anything —
// "2026-01-15, 1000", "15/01/2026 R1 000 deposit", "Withdrawal,01 Feb 2026,500"
// — and get back clean { date, amount(signed), currency, note } rows.
const _MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function mkDate(y, mo, d) {
  if (!(y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function parseFlexibleDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m;
  // Spreadsheet serial date (days since 1899-12-30), e.g. 45292 → 2024-01-01.
  if (/^\d{5}$/.test(s)) {
    const n = parseInt(s, 10);
    if (n > 20000 && n < 60000) { const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); }
  }
  // ISO-ish: YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return mkDate(+m[1], +m[2], +m[3]);
  // D-M-Y or M-D-Y with a 4-digit year (default to international D/M/Y).
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    const a = +m[1], b = +m[2];
    if (b > 12 && a <= 12) return mkDate(+m[3], a, b);
    return mkDate(+m[3], b, a);
  }
  // D-M-Y with a 2-digit year.
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/))) {
    const yr = (+m[3] <= 79 ? 2000 : 1900) + +m[3];
    const a = +m[1], b = +m[2];
    if (b > 12 && a <= 12) return mkDate(yr, a, b);
    return mkDate(yr, b, a);
  }
  // "15 Jan 2026" / "15 January 2026"
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/))) { const mo = _MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo != null) return mkDate(+m[3], mo + 1, +m[1]); }
  // "Jan 15, 2026" / "January 15 2026"
  if ((m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) { const mo = _MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo != null) return mkDate(+m[3], mo + 1, +m[2]); }
  return null;
}
const _CCY_WORD = { usd: 'USD', zar: 'ZAR', gbp: 'GBP', aud: 'AUD', eur: 'EUR' };
function detectCurrencyToken(s) {
  if (!s) return null;
  const t = String(s).trim().toLowerCase();
  if (_CCY_WORD[t]) return _CCY_WORD[t];
  if (t === '$' || t === 'us$') return 'USD';
  if (t === '£') return 'GBP';
  if (t === '€') return 'EUR';
  if (t === 'a$') return 'AUD';
  if (t === 'r') return 'ZAR';
  return null;
}
function currencyInString(s) {
  if (/£/.test(s)) return 'GBP';
  if (/€/.test(s)) return 'EUR';
  if (/\bUSD\b/i.test(s) || /us\$/i.test(s)) return 'USD';
  if (/\bZAR\b/i.test(s)) return 'ZAR';
  if (/\bGBP\b/i.test(s)) return 'GBP';
  if (/\bAUD\b/i.test(s) || /a\$/i.test(s)) return 'AUD';
  if (/\bEUR\b/i.test(s)) return 'EUR';
  if (/^\s*r\s*[\d]/i.test(s)) return 'ZAR';
  if (/\$/.test(s)) return 'USD';
  return null;
}
// Decide whether a single cell is a money amount, returning its magnitude, sign
// and any embedded currency. Rejects tickers, quarters, share counts, etc.
function parseAmountCell(c) {
  if (!c || !/\d/.test(c)) return null;
  const trimmed = c.trim();
  const negative = /^\(.*\)$/.test(trimmed) || /^-/.test(trimmed) || /-$/.test(trimmed);
  const stripped = trimmed.replace(/[()\s]/g, '');
  // Optional currency marker, digits with separators, optional trailing code.
  if (!/^[-+]?(?:us\$|a\$|[$£€r])?[\d.,]+(?:usd|zar|gbp|aud|eur|\$|£|€)?$/i.test(stripped)) return null;
  const v = parseDecimal(trimmed);
  if (!isFinite(v) || v === 0) return null;
  return { value: Math.abs(v), negative: negative || v < 0, currency: currencyInString(trimmed) };
}
const _WITHDRAW_RE = /\b(withdraw|withdrawal|withdrawn|outflow|debit|redeem|redemption|disburse|disbursement|cash[\s-]?out)\b/i;
const _DEPOSIT_RE = /\b(deposit|contribution|contribute|inflow|credit|top[\s-]?up|funding|paid[\s-]?in)\b/i;
function parseCashFlowRows(rows) {
  const flows = [];
  for (const cells of rows) {
    if (!cells) continue;
    const clean = cells.map(c => String(c == null ? '' : c).trim()).filter(c => c !== '');
    if (clean.length === 0) continue;
    const joined = clean.join(' ');
    let date = null, amount = null, amountNeg = false, currency = null;
    const noteParts = [];
    for (const c of clean) {
      if (!date) { const d = parseFlexibleDate(c); if (d) { date = d; continue; } }
      if (amount == null) { const a = parseAmountCell(c); if (a) { amount = a.value; amountNeg = a.negative; if (a.currency) currency = a.currency; continue; } }
      const ccy = detectCurrencyToken(c);
      if (ccy && !currency) { currency = ccy; continue; }
      noteParts.push(c);
    }
    if (date == null || amount == null) continue; // header row or unparseable
    const isWithdraw = _WITHDRAW_RE.test(joined) && !_DEPOSIT_RE.test(joined);
    const negative = amountNeg || isWithdraw;
    const note = noteParts.join(' ').replace(/\s+/g, ' ').trim();
    flows.push({ date, amount: (negative ? -1 : 1) * Math.abs(amount), currency: currency || null, type: negative ? 'withdrawal' : 'deposit', note });
  }
  return flows;
}
// Pasted (comma-delimited) text fragments commas that live *inside* a value —
// a written date ("Jan 5, 2026") or a thousands-grouped amount ("$1,250.50").
// Stitch those neighbours back together before the row is interpreted. Only used
// for free text; spreadsheet cells already arrive intact.
function coalesceCashCells(cells) {
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    const cur = cells[i], next = cells[i + 1];
    // "Mon D" + "YYYY"  or  "D Mon" + "YYYY"
    if (next && /^\d{4}$/.test(next) && (/^[A-Za-z]{3,9}\.?\s+\d{1,2}$/.test(cur) || /^\d{1,2}\s+[A-Za-z]{3,9}\.?$/.test(cur))) { out.push(cur + ' ' + next); i++; continue; }
    // thousands-grouped number: "1" + "250.50", "$1" + "200" + "000", "(1" + "250)"
    if (next && /^[-+(]?\s*(?:us\$|a\$|[$£€r])?\s*\d{1,3}$/i.test(cur) && /^\d{3}(?:\.\d+)?\)?$/.test(next)) {
      let merged = cur;
      while (i + 1 < cells.length && /^\d{3}(?:\.\d+)?\)?$/.test(cells[i + 1])) { merged += cells[i + 1]; i++; if (/[.)]/.test(cells[i])) break; }
      out.push(merged); continue;
    }
    out.push(cur);
  }
  return out;
}
function parseCashFlowsFromText(text) {
  if (!text) return [];
  const rows = text.replace(/\r\n?/g, '\n').split('\n').map(stripListMarker).filter(l => l.trim() !== '').map(l => coalesceCashCells(splitLine(l)));
  return parseCashFlowRows(rows);
}
async function parseCashFlowFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || /sheet|excel/.test(file.type)) {
    await loadScriptOnce(XLSX_CDN);
    const XLSX = window.XLSX;
    if (!XLSX) throw new Error('Spreadsheet reader failed to load.');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    for (const sheetName of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, raw: false });
      const flows = parseCashFlowRows(aoa);
      if (flows.length > 0) return flows;
    }
    return [];
  }
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    throw new Error('PDF statements aren’t supported for cash flows — export to CSV/Excel, or paste the rows instead.');
  }
  const text = await file.text();
  return parseCashFlowsFromText(text);
}

function MarketPicker({ value, onChange, disabled, style }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const current = MARKETS.find(m => m.value === value) || MARKETS[0];
  useEffect(() => {
    const h = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return React.createElement('div', { className: 'market-picker', ref: wrapRef, style },
    React.createElement('button', {
      type: 'button',
      className: 'market-picker-btn',
      onClick: () => { if (!disabled) setOpen(o => !o); },
      disabled,
      'aria-haspopup': 'listbox',
      'aria-expanded': open
    },
      React.createElement('span', { className: 'market-picker-country' }, current.country),
      React.createElement('span', { className: 'market-picker-exch' }, current.exchange)
    ),
    open && React.createElement('div', { className: 'market-picker-menu', role: 'listbox' },
      MARKETS.map(m => React.createElement('button', {
        key: m.value,
        type: 'button',
        className: 'market-picker-opt' + (m.value === value ? ' active' : ''),
        onClick: () => { onChange(m.value); setOpen(false); },
        role: 'option',
        'aria-selected': m.value === value
      },
        React.createElement('span', { className: 'country' }, m.country),
        React.createElement('span', { className: 'exch' }, m.exchange)
      ))
    )
  );
}

function TickerSearch({ value, onChange, market, onMarketChange, onSelect, onEnter, disabled }) {
  const [query, setQuery] = useState(value || '');
  const [suggestions, setSuggestions] = useState([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const remoteReqId = useRef(0);
  const justSelected = useRef(false);

  useEffect(() => { setQuery(value || ''); }, [value]);

  const localSearch = (q) => {
    const lower = q.toLowerCase();
    return ALL_TICKERS.filter(t =>
      t.ticker.toLowerCase().startsWith(lower) || t.name.toLowerCase().includes(lower)
    ).sort((a, b) => {
      const aT = a.ticker.toLowerCase().startsWith(lower) ? 0 : 1;
      const bT = b.ticker.toLowerCase().startsWith(lower) ? 0 : 1;
      return aT - bT;
    }).slice(0, 8);
  };

  const search = (q) => {
    if (!q || q.length < 1) { setSuggestions([]); setOpen(false); return; }
    const matches = localSearch(q);
    setSuggestions(matches);
    setOpen(true);
    setActiveIdx(-1);
  };

  useEffect(() => {
    if (justSelected.current) { justSelected.current = false; setRemoteLoading(false); return; }
    if (!query || query.length < 2) { setRemoteLoading(false); return; }
    const reqId = ++remoteReqId.current;
    setRemoteLoading(true);
    const handle = setTimeout(async () => {
      const remote = await fetchYahooSearch(query);
      if (reqId !== remoteReqId.current) return;
      setRemoteLoading(false);
      if (!remote || remote.length === 0) return;
      setSuggestions(prev => {
        const keys = new Set(prev.map(p => priceKey(p.market, p.ticker)));
        const extra = remote.filter(r => !keys.has(priceKey(r.market, r.ticker)));
        const merged = [...prev, ...extra].slice(0, 14);
        if (merged.length > 0) setOpen(true);
        return merged;
      });
    }, 280);
    return () => { clearTimeout(handle); };
  }, [query]);

  const handleInput = (e) => {
    const v = e.target.value.toUpperCase();
    setQuery(v);
    onChange(v);
    search(v);
  };

  const selectSuggestion = (s) => {
    justSelected.current = true;
    remoteReqId.current++;
    setQuery(s.ticker);
    onChange(s.ticker);
    // Respect the account the user explicitly chose. A JSE-listed result is
    // valid for both a JSE and a TFSA account, so don't yank a TFSA selection
    // over to plain JSE — only switch when the listing is on a genuinely
    // different exchange than the one currently selected.
    if (onMarketChange && !sameUnderlyingExchange(s.market, market)) onMarketChange(s.market);
    if (onSelect) onSelect(s);
    setSuggestions([]);
    setOpen(false);
  };

  // Surface listings on the account the user already chose first, so the right
  // exchange's row is the obvious tap (and the default keyboard pick) instead of
  // a same-name foreign listing that would silently change their market.
  const ordered = useMemo(() => {
    if (!market || suggestions.length < 2) return suggestions;
    return suggestions
      .map((s, i) => ({ s, i }))
      .sort((a, b) => {
        const am = sameUnderlyingExchange(a.s.market, market) ? 0 : 1;
        const bm = sameUnderlyingExchange(b.s.market, market) ? 0 : 1;
        return am - bm || a.i - b.i;
      })
      .map(x => x.s);
  }, [suggestions, market]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, ordered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, -1)); }
    else if (e.key === 'Enter') {
      if (open && activeIdx >= 0) { e.preventDefault(); selectSuggestion(ordered[activeIdx]); }
      else if (onEnter) { setOpen(false); onEnter(); }
    } else if (e.key === 'Escape') { setOpen(false); }
  };

  useEffect(() => {
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return React.createElement('div', { ref: wrapRef, style: { position: 'relative', flex: 1 } },
    React.createElement('input', {
      type: 'text',
      className: 'ticker-search-input',
      placeholder: 'Search ticker or company\u2026',
      value: query,
      onChange: handleInput,
      onKeyDown: handleKeyDown,
      onFocus: () => { if (query && suggestions.length > 0) setOpen(true); },
      maxLength: 40,
      disabled,
      autoCapitalize: 'characters',
      autoComplete: 'off',
      style: { width: '100%' }
    }),
    open && (ordered.length > 0 || remoteLoading) && React.createElement('div', { className: 'ticker-dropdown' },
      ordered.map((s, i) =>
        React.createElement('div', {
          key: priceKey(s.market, s.ticker),
          className: 'ticker-suggestion' + (i === activeIdx ? ' active' : ''),
          onMouseDown: (e) => { e.preventDefault(); selectSuggestion(s); }
        },
          React.createElement('span', { className: 'tkr' }, s.ticker),
          React.createElement('span', { className: 'ticker-sug-name' }, s.name),
          React.createElement('span', { className: 'market-badge' }, s.market)
        )
      ),
      remoteLoading && React.createElement('div', { className: 'ticker-sug-loading' }, 'Searching global exchanges\u2026'),
      !remoteLoading && suggestions.length > 0 && React.createElement('div', { className: 'ticker-sug-hint' }, 'Don\u2019t see your stock? Type the exact symbol.')
    )
  );
}

function resolveTickerName(ticker, market, q) {
  if (q) {
    const yahooName = q.shortName || q.longName;
    if (yahooName && yahooName !== ticker) {
      cacheName(market, ticker, yahooName);
      return yahooName;
    }
  }
  const info = DATA.findInfo(ticker, market);
  if (info && info.name && info.name !== ticker) return info.name;
  const hit = ALL_TICKERS.find(t => t.ticker === ticker && t.market === market);
  if (hit && hit.name && hit.name !== ticker) return hit.name;
  // Learned/curated names (heatmap mega-caps, anything we've quoted before).
  const cached = cachedName(market, ticker);
  if (cached) return cached;
  return null;
}

function buildSuggestions(watchlist) {
  const taken = new Set(watchlist.map(w => priceKey(w.market, w.ticker)));
  const marketCount = {};
  watchlist.forEach(w => { marketCount[w.market] = (marketCount[w.market] || 0) + 1; });
  const preferredMarket = Object.entries(marketCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const sectorCount = {};
  watchlist.forEach(w => {
    const info = DATA.findInfo(w.ticker, w.market);
    if (info?.sector) sectorCount[info.sector] = (sectorCount[info.sector] || 0) + 1;
  });
  const popular = [];
  DATA.HOLDINGS.forEach(h => popular.push({ ticker: h.ticker, name: h.name, market: 'US', sector: h.sector }));
  DATA.NEW_PICKS.forEach(p => popular.push({ ticker: p.ticker, name: p.name, market: 'US', sector: p.sector }));
  DATA.HEDGES.forEach(h => popular.push({ ticker: h.ticker, name: h.name, market: 'US' }));
  (DATA.JSE_SUGGESTIONS || []).forEach(s => popular.push({ ticker: s.ticker, name: s.name, market: 'JSE' }));
  (DATA.TFSA_SUGGESTIONS || []).forEach(s => popular.push({ ticker: s.ticker, name: s.name, market: 'TFSA' }));
  (DATA.LSE_SUGGESTIONS || []).forEach(s => popular.push({ ticker: s.ticker, name: s.name, market: 'LSE' }));
  (DATA.ASX_SUGGESTIONS || []).forEach(s => popular.push({ ticker: s.ticker, name: s.name, market: 'ASX' }));
  (DATA.EU_SUGGESTIONS || []).forEach(s => popular.push({ ticker: s.ticker, name: s.name, market: s.exchange || 'FRA' }));
  const dedupe = new Set();
  const scored = [];
  popular.forEach(p => {
    const key = priceKey(p.market, p.ticker);
    if (dedupe.has(key) || taken.has(key)) return;
    dedupe.add(key);
    let score = 0;
    if (preferredMarket && p.market === preferredMarket) score += 4;
    if (p.sector && sectorCount[p.sector]) score += 2 * sectorCount[p.sector];
    if (p.market === 'US') score += 1;
    scored.push({ ...p, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 14);
}

function WatchlistView(_ref8) {
  let {
    watchlist,
    prices,
    alerts,
    onAdd,
    onRemove,
    onReorder,
    onOpenDetail,
    onAddAlert,
    onRemoveAlert,
    childSwipeLockRef
  } = _ref8;
  const [newTicker, setNewTicker] = useState('');
  const [newMarket, setNewMarket] = useState('US');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showSuggestions, setShowSuggestions] = usePersistedState('pb.watchlist.showSuggestions.v1', true);
  // Suggestion chips leave the list the instant they're added (the list is
  // derived from the watchlist), which left users unsure their tap registered.
  // We keep a short-lived "added" snapshot so the tapped chip morphs into a
  // green ✓ confirmation before fading, instead of silently vanishing.
  const [justAdded, setJustAdded] = useState([]);

  // Alert popup state
  const [alertPopup, setAlertPopup] = useState(null);
  const [alertDir, setAlertDir] = useState('above');
  const [alertTarget, setAlertTarget] = useState('');
  const [alertNote, setAlertNote] = useState('');
  const openAlertPopup = (ticker, market) => {
    const q = prices[priceKey(market, ticker)];
    setAlertPopup({ ticker, market });
    setAlertDir('above');
    setAlertTarget(q ? q.price.toFixed(2) : '');
    setAlertNote('');
  };
  const submitAlertPopup = () => {
    if (!alertPopup) return;
    const t = parseDecimal(alertTarget);
    if (!isFinite(t) || t <= 0) return;
    onAddAlert(alertPopup.ticker, alertPopup.market, alertDir, t, alertNote);
    setAlertNote('');
  };
  const popupAlerts = alertPopup ? alerts.filter(a => a.ticker === alertPopup.ticker && a.market === alertPopup.market) : [];
  const popupCcy = alertPopup ? (alertPopup.market === 'JSE' ? 'ZAR' : 'USD') : 'USD';

  // Swipe-to-delete state
  const [swipedId, setSwipedId] = useState(null);
  const swipeRefs = useRef(new Map());

  // Freeform long-press drag-to-reorder. Document-level pointer tracking keeps
  // vertical scroll native while horizontal swipe / drag stay responsive.
  const [draggingId, setDraggingId] = useState(null);
  const cardRefsRef = useRef(new Map());
  const setCardRef = useCallback((id) => (el) => {
    if (el) cardRefsRef.current.set(id, el);
    else cardRefsRef.current.delete(id);
  }, []);
  const longPressTimerRef = useRef(null);
  const pressOriginRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const hapticCtxRef = useRef(null);
  const activeGestureRef = useRef(null);
  const pointerTrackRef = useRef(null);
  const dragTouchBlockRef = useRef(null);

  const triggerHaptic = () => {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try { navigator.vibrate(20); } catch (_) {}
    }
    // Audio tick for iOS (vibrate API unsupported). Barely-audible 12ms pop
    // produced through the speaker — gives tactile-ish feedback on-device.
    const ctx = hapticCtxRef.current;
    if (ctx && ctx.state === 'running') {
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.value = 0.08;
        osc.frequency.value = 180;
        osc.start();
        osc.stop(ctx.currentTime + 0.012);
      } catch (_) {}
    }
  };

  const blockPageScroll = () => {
    if (dragTouchBlockRef.current) return;
    const prevent = (e) => { if (e.cancelable) e.preventDefault(); };
    document.addEventListener('touchmove', prevent, { passive: false });
    dragTouchBlockRef.current = prevent;
  };

  const unblockPageScroll = () => {
    if (!dragTouchBlockRef.current) return;
    document.removeEventListener('touchmove', dragTouchBlockRef.current, { passive: false });
    dragTouchBlockRef.current = null;
  };

  const detachPointerTracking = () => {
    const track = pointerTrackRef.current;
    if (!track) return;
    document.removeEventListener('pointermove', track.onMove);
    document.removeEventListener('pointerup', track.onUp);
    document.removeEventListener('pointercancel', track.onUp);
    pointerTrackRef.current = null;
    activeGestureRef.current = null;
    if (childSwipeLockRef) childSwipeLockRef.current = false;
  };

  // Clean up haptic AudioContext on unmount
  useEffect(() => {
    return () => {
      detachPointerTracking();
      unblockPageScroll();
      if (hapticCtxRef.current) try { hapticCtxRef.current.close(); } catch (_) {}
    };
  }, []);

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const naturalRectsRef = useRef(new Map());

  const displaceNeighbours = (originIdx, targetIdx) => {
    const rects = naturalRectsRef.current;
    const originRect = rects.get(watchlist[originIdx].id);
    if (!originRect) return;
    watchlist.forEach((w, i) => {
      if (i === originIdx) return;
      const el = cardRefsRef.current.get(w.id);
      if (!el) return;
      const naturalPos = rects.get(w.id);
      if (!naturalPos) { el.style.transform = ''; return; }
      const reordered = [...watchlist];
      const [moved] = reordered.splice(originIdx, 1);
      reordered.splice(targetIdx, 0, moved);
      const newLogicalIdx = reordered.findIndex(x => x.id === w.id);
      const origLogicalIdx = watchlist.findIndex(x => x.id === w.id);
      if (newLogicalIdx === origLogicalIdx) {
        el.style.transform = '';
      } else {
        const targetRect = rects.get(reordered[origLogicalIdx]?.id);
        if (targetRect) {
          const dy = targetRect.top - naturalPos.top;
          el.style.transform = dy ? `translateY(${dy}px)` : '';
        } else {
          el.style.transform = '';
        }
      }
    });
  };

  const startDrag = (id, pointerId, startY) => {
    const card = cardRefsRef.current.get(id);
    if (!card) return;
    triggerHaptic();
    const originIdx = watchlist.findIndex(w => w.id === id);
    if (originIdx < 0) return;
    naturalRectsRef.current.clear();
    watchlist.forEach(w => {
      const el = cardRefsRef.current.get(w.id);
      if (el) {
        el.style.transition = 'none';
        el.style.transform = '';
      }
    });
    watchlist.forEach(w => {
      const el = cardRefsRef.current.get(w.id);
      if (el) naturalRectsRef.current.set(w.id, el.getBoundingClientRect());
    });
    watchlist.forEach((w, i) => {
      const el = cardRefsRef.current.get(w.id);
      if (el && i !== originIdx) {
        el.style.transition = 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)';
      }
    });
    dragRef.current = {
      id, pointerId,
      pointerStartY: startY,
      originIdx, targetIdx: originIdx,
      moved: false,
    };
    blockPageScroll();
    card.style.transition = 'none';
    card.style.transform = 'scale(1.04)';
    card.style.zIndex = '50';
    try { card.setPointerCapture(pointerId); } catch (_) {}
    setDraggingId(id);
  };

  const onCardPointerDown = (e, id) => {
    if (e.target.closest('button,a,input,[data-no-drag]')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (dragRef.current) return;
    clearLongPress();
    if (!hapticCtxRef.current) {
      try { hapticCtxRef.current = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    }
    if (hapticCtxRef.current && hapticCtxRef.current.state === 'suspended') {
      try { hapticCtxRef.current.resume(); } catch (_) {}
    }
    if (swipedId && swipedId !== id) closeSwipe(swipedId);
    pressOriginRef.current = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      const po = pressOriginRef.current;
      if (!po || po.id !== id) return;
      startDrag(id, po.pointerId, po.y);
    }, 450);
    attachPointerTracking(id, e.pointerId, e.clientX, e.clientY);
  };

  const handleDocumentPointerMove = (e) => {
    const drag = dragRef.current;
    if (drag) {
      if (e.pointerId !== drag.pointerId) return;
      if (e.cancelable) e.preventDefault();
      const dy = e.clientY - drag.pointerStartY;
      const card = cardRefsRef.current.get(drag.id);
      if (card) card.style.transform = `translateY(${dy}px) scale(1.04)`;
      drag.moved = true;
      const pointerY = e.clientY;
      let targetIdx = drag.originIdx;
      const rects = naturalRectsRef.current;
      for (let i = 0; i < watchlist.length; i++) {
        if (i === drag.originIdx) continue;
        const r = rects.get(watchlist[i].id);
        if (!r) continue;
        const center = r.top + r.height / 2;
        if (i < drag.originIdx && pointerY < center) { targetIdx = i; break; }
        if (i > drag.originIdx && pointerY > center) { targetIdx = i; }
      }
      if (targetIdx !== drag.targetIdx) {
        drag.targetIdx = targetIdx;
        displaceNeighbours(drag.originIdx, targetIdx);
      }
      return;
    }

    const g = activeGestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;

    if (longPressTimerRef.current) {
      if (dx * dx + dy * dy > 100) clearLongPress();
    }

    if (!g.mode) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      g.mode = Math.abs(dx) > Math.abs(dy) ? 'swipe-h' : 'scroll-v';
    }

    if (g.mode === 'scroll-v') {
      // Stop tracking so native scroll stays on the compositor thread.
      const track = pointerTrackRef.current;
      if (track) document.removeEventListener('pointermove', track.onMove);
      return;
    }

    if (e.cancelable) e.preventDefault();
    if (childSwipeLockRef) childSwipeLockRef.current = true;
    clearLongPress();
    g.swipeLocked = true;
    g.dx = dx;
    const inner = swipeRefs.current.get(g.id);
    if (inner) {
      inner.classList.add('is-swiping');
      const clamped = Math.max(-80, Math.min(dx > 0 ? 0 : dx, 0));
      inner.style.transition = 'none';
      inner.style.transform = `translateX(${clamped}px)`;
    }
  };

  const handleDocumentPointerUp = (e) => {
    const drag = dragRef.current;
    if (drag && e.pointerId === drag.pointerId) {
      clearLongPress();
      pressOriginRef.current = null;
      finishDrag(e.type !== 'pointercancel');
      detachPointerTracking();
      return;
    }

    const g = activeGestureRef.current;
    if (g && e.pointerId === g.pointerId && g.swipeLocked) {
      const inner = swipeRefs.current.get(g.id);
      if (inner) {
        inner.classList.remove('is-swiping');
        if (g.dx < -50) {
          inner.style.transition = 'transform 250ms cubic-bezier(0.22, 1, 0.36, 1)';
          inner.style.transform = 'translateX(-80px)';
          setSwipedId(g.id);
        } else {
          inner.style.transition = 'transform 250ms cubic-bezier(0.22, 1, 0.36, 1)';
          inner.style.transform = '';
          setSwipedId(prev => prev === g.id ? null : prev);
        }
      }
    }
    clearLongPress();
    pressOriginRef.current = null;
    detachPointerTracking();
  };

  const attachPointerTracking = (id, pointerId, startX, startY) => {
    detachPointerTracking();
    activeGestureRef.current = { id, pointerId, startX, startY, mode: null, dx: 0, swipeLocked: false };
    const onMove = (ev) => handleDocumentPointerMove(ev);
    const onUp = (ev) => handleDocumentPointerUp(ev);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    pointerTrackRef.current = { onMove, onUp };
  };

  const finishDrag = (commit) => {
    const drag = dragRef.current;
    if (!drag) return;
    watchlist.forEach(w => {
      const el = cardRefsRef.current.get(w.id);
      if (el) {
        el.style.transition = '';
        el.style.transform = '';
        el.style.zIndex = '';
      }
    });
    try {
      const card = cardRefsRef.current.get(drag.id);
      if (card) card.releasePointerCapture(drag.pointerId);
    } catch (_) {}
    if (commit && drag.moved && drag.targetIdx !== drag.originIdx) {
      const arr = [...watchlist];
      const [m] = arr.splice(drag.originIdx, 1);
      arr.splice(drag.targetIdx, 0, m);
      onReorder(arr);
    }
    if (drag.moved) suppressClickRef.current = true;
    dragRef.current = null;
    unblockPageScroll();
    setDraggingId(null);
  };

  const closeSwipe = useCallback((id) => {
    const inner = swipeRefs.current.get(id);
    if (inner) {
      inner.classList.remove('is-swiping');
      inner.style.transition = 'transform 250ms cubic-bezier(0.22, 1, 0.36, 1)';
      inner.style.transform = '';
    }
    setSwipedId(prev => prev === id ? null : prev);
  }, []);

  const confirmDelete = (id) => {
    const inner = swipeRefs.current.get(id);
    if (inner) {
      inner.style.transition = 'transform 200ms ease-out';
      inner.style.transform = 'translateX(-100vw)';
    }
    setTimeout(() => onRemove(id), 220);
  };

  const submit = async () => {
    const t = newTicker.trim();
    if (!t) return;
    setVerifying(true);
    setVerifyError('');
    const q = await fetchQuote(t, newMarket);
    setVerifying(false);
    if (!q) {
      setVerifyError(`"${t}" not found on ${newMarket}. Check the symbol.`);
      return;
    }
    onAdd(t, newMarket, resolveTickerName(t.toUpperCase(), newMarket, q));
    setNewTicker('');
    setVerifyError('');
    setShowAddForm(false);
  };
  const suggestions = useMemo(() => buildSuggestions(watchlist), [watchlist]);
  const addSuggestion = (s) => {
    const key = priceKey(s.market, s.ticker);
    if (watchlist.some(w => priceKey(w.market, w.ticker) === key)) return;
    onAdd(s.ticker, s.market, s.name);
    triggerHaptic();
    setJustAdded(prev => prev.some(x => priceKey(x.market, x.ticker) === key) ? prev : [...prev, s]);
    setTimeout(() => setJustAdded(prev => prev.filter(x => priceKey(x.market, x.ticker) !== key)), 1700);
  };
  return React.createElement("div", null,
    React.createElement("div", { className: "flex justify-end mb-4" },
      React.createElement("button", { className: "btn btn-primary btn-sm", onClick: () => setShowAddForm(true) },
        React.createElement(Icon, { name: "plus", size: 13 }), " Add")),
    showAddForm && React.createElement("div", { className: "card mb-4 watchlist-add" },
      React.createElement("div", { className: "form-label" }, "Market"),
      React.createElement(MarketPicker, {
        value: newMarket,
        onChange: v => { setNewMarket(v); setVerifyError(''); },
        style: { width: '100%', marginBottom: 10 }
      }),
      React.createElement("div", { className: "form-label" }, "Ticker"),
      React.createElement("div", { className: "watchlist-search-row" },
        React.createElement(TickerSearch, {
          value: newTicker,
          onChange: v => { setNewTicker(v); setVerifyError(''); },
          market: newMarket,
          onMarketChange: v => setNewMarket(v),
          onEnter: submit
        }),
        React.createElement("button", {
          className: "btn btn-primary",
          onClick: submit,
          disabled: verifying,
          style: { flex: '0 0 auto' }
        }, verifying ? React.createElement(Icon, { name: "refresh", size: 13 }) : React.createElement(Icon, { name: "plus" }), verifying ? " ..." : " Add")
      ),
      verifyError ? React.createElement("div", { className: "verify-error" }, verifyError) : null,
      React.createElement("button", {
        className: "btn btn-ghost btn-sm",
        style: { marginTop: 8, width: '100%' },
        onClick: () => { setShowAddForm(false); setVerifyError(''); }
      }, "Cancel")
    ),
    watchlist.length === 0 ? React.createElement("div", { className: "empty" },
      React.createElement(Icon, { name: "eye", size: 40 }),
      React.createElement("h3", null, "Empty watchlist"),
      React.createElement("p", null, "Tap Add to track your first ticker."))
    : React.createElement("div", { className: "watchlist-list mb-6" },
      watchlist.map((w) => {
        const q = prices[priceKey(w.market, w.ticker)];
        const displayName = w.name || resolveTickerName(w.ticker, w.market, q) || w.ticker;
        const isDragging = draggingId === w.id;
        let athBadge = null;
        if (q && q.yearHigh && q.yearHigh > 0) {
          const pct = (q.price - q.yearHigh) / q.yearHigh * 100;
          const atAth = q.price >= q.yearHigh * 0.995;
          athBadge = React.createElement("div", {
            className: `ath-badge ${atAth ? 'at-high' : 'below-high'}`
          }, React.createElement("span", { className: "ath-badge-label" }, "52W Hi"),
             React.createElement("span", { className: "ath-badge-val" }, atAth ? 'ATH' : pct.toFixed(1) + '%'));
        }
        const ac = alerts.filter(a => a.ticker === w.ticker && a.market === w.market).length;
        return React.createElement("div", {
          key: w.id,
          ref: setCardRef(w.id),
          className: "swipe-card-outer" + (isDragging ? " dragging" : ""),
          onPointerDown: (e) => onCardPointerDown(e, w.id),
          onContextMenu: e => e.preventDefault()
        },
          React.createElement("div", { className: "swipe-delete-bg", onClick: () => confirmDelete(w.id) }, "Delete"),
          React.createElement("div", {
            className: "swipe-card-inner pos-card",
            ref: el => { if (el) swipeRefs.current.set(w.id, el); else swipeRefs.current.delete(w.id); },
            onClick: () => {
              if (suppressClickRef.current) { suppressClickRef.current = false; return; }
              if (dragRef.current) return;
              if (swipedId === w.id) { closeSwipe(w.id); return; }
              onOpenDetail(w.ticker, w.market);
            }
          },
            React.createElement("div", { className: "pos-head" },
              React.createElement("div", { className: "flex-1" },
                React.createElement("div", { className: "flex items-center gap-2" },
                  React.createElement("span", { className: "tkr" }, w.ticker),
                  React.createElement("span", { className: "market-badge" }, w.market)),
                React.createElement("div", { className: "tkr-name" }, displayName)),
              React.createElement("div", { className: "flex items-center gap-2" },
                athBadge)),
            React.createElement("div", { style: { position: 'relative' } },
              React.createElement(PriceBlock, { quote: q, size: "lg", showDailyRow: true }),
              React.createElement("button", {
                className: "card-alert-bell",
                "data-no-drag": true,
                onClick: e => { e.stopPropagation(); openAlertPopup(w.ticker, w.market); },
                "aria-label": "Alerts"
              }, React.createElement(Icon, { name: "bell", size: 13 }),
                ac > 0 && React.createElement("span", { className: "card-alert-count" }, ac)))));
      })),

    alertPopup && React.createElement("div", { className: "alert-popup-overlay" },
      React.createElement("div", { className: "alert-popup-backdrop", onClick: () => setAlertPopup(null) }),
      React.createElement("div", { className: "alert-popup-panel" },
        React.createElement("div", { className: "alert-popup-header" },
          React.createElement("div", null,
            React.createElement("div", { className: "modal-title" }, alertPopup.ticker),
            React.createElement("div", { className: "modal-subtitle" }, "Price alerts \xB7 ", React.createElement("span", { className: "market-badge" }, alertPopup.market))),
          React.createElement("button", { className: "modal-close", onClick: () => setAlertPopup(null), "aria-label": "Close" },
            React.createElement(Icon, { name: "x" }))),
        popupAlerts.length > 0 && React.createElement("div", {
          style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }
        }, popupAlerts.map(a => React.createElement("div", {
          key: a.id, className: "alert-item"
        }, React.createElement("div", null,
          React.createElement("div", { className: "mono text-sm" },
            a.direction === 'above' ? '↑ above ' : '↓ below ', fmt(a.targetPrice, alertPopup.market)),
          a.note && React.createElement("div", { className: "text-xs text-dim mt-1" }, a.note)),
          React.createElement("button", {
            className: "btn btn-ghost btn-xs",
            onClick: () => onRemoveAlert(a.id), "aria-label": "Remove"
          }, React.createElement(Icon, { name: "x", size: 12 }))))),
        React.createElement("div", { className: "alert-form" },
          React.createElement("div", { className: "alert-dir-group", role: "radiogroup", "aria-label": "Trigger direction" },
            React.createElement("button", {
              type: "button", role: "radio", "aria-checked": alertDir === 'above',
              className: `alert-dir-btn up ${alertDir === 'above' ? 'active' : ''}`,
              onClick: () => setAlertDir('above')
            }, React.createElement("span", { className: "alert-dir-arrow" }, "↑"),
              React.createElement("span", { className: "alert-dir-label" }, "Above")),
            React.createElement("button", {
              type: "button", role: "radio", "aria-checked": alertDir === 'below',
              className: `alert-dir-btn down ${alertDir === 'below' ? 'active' : ''}`,
              onClick: () => setAlertDir('below')
            }, React.createElement("span", { className: "alert-dir-arrow" }, "↓"),
              React.createElement("span", { className: "alert-dir-label" }, "Below"))
          ),
          React.createElement("div", { className: "alert-target-row" },
            React.createElement("div", { className: "input-prefix-wrap alert-target-wrap" },
              React.createElement("span", { className: "prefix" }, popupCcy === 'ZAR' ? 'R' : '$'),
              React.createElement("input", {
                type: "text", inputMode: "decimal",
                autoComplete: "off", autoCorrect: "off", spellCheck: false,
                placeholder: "Target price", value: alertTarget,
                onChange: e => setAlertTarget(sanitizeDecimalInput(e.target.value)),
                className: "alert-target-input"
              }))),
          React.createElement("input", {
            type: "text", placeholder: "Note (optional)",
            value: alertNote, onChange: e => setAlertNote(e.target.value),
            maxLength: "80", className: "alert-note-input"
          }),
          React.createElement("button", {
            className: `btn btn-block mt-3 alert-submit ${alertDir === 'above' ? 'up' : 'down'}`,
            onClick: submitAlertPopup
          }, React.createElement(Icon, { name: "plus" }),
            " Alert when ", alertDir === 'above' ? 'above ' : 'below ',
            alertTarget && isFinite(parseDecimal(alertTarget)) ? (popupCcy === 'ZAR' ? 'R' : '$') + parseDecimal(alertTarget).toFixed(2) : 'target')))),

    React.createElement("div", { className: "eyebrow suggestions-head" },
      React.createElement("span", null, "Suggested for you"),
      React.createElement("button", {
        className: "btn btn-ghost btn-xs",
        onClick: () => setShowSuggestions(v => !v),
        'aria-label': showSuggestions ? "Hide suggestions" : "Show suggestions"
      }, showSuggestions ? "Hide" : "Show")),
    showSuggestions && (suggestions.length === 0 && justAdded.length === 0
      ? React.createElement("div", { className: "text-sm text-dim" }, "No more suggestions — you're tracking the popular names already.")
      : React.createElement("div", { className: "chip-row" },
          justAdded.map(s => React.createElement("div", {
            key: 'added:' + priceKey(s.market, s.ticker),
            className: "chip added"
          }, React.createElement(Icon, { name: "checkCircle", size: 13 }),
             " ", s.ticker, React.createElement("span", { className: "chip-sub" }, "Added to watchlist"))),
          suggestions.map(s => React.createElement("button", {
            key: priceKey(s.market, s.ticker),
            className: "chip",
            onClick: () => addSuggestion(s)
          }, React.createElement(Icon, { name: "plus", size: 12, className: "chip-plus" }),
             " ", s.ticker, React.createElement("span", { className: "chip-sub" }, s.name, " \xB7 ", s.market)))))
  );
}

function heatColor(pct, isLight) {
  if (pct == null || !isFinite(pct)) {
    return isLight ? { bg: 'rgb(228, 228, 231)', fg: '#52525b' } : { bg: 'rgb(60, 60, 66)', fg: '#a1a1aa' };
  }
  const clamped = Math.max(-3, Math.min(3, pct));
  const t = Math.abs(clamped) / 3;
  let lo, hi, fg;
  if (isLight) {
    // Light mode: pale tint near 0% → deep, saturated colour at the extremes.
    // Dark text on the pale tiles, white once the fill is strong enough.
    lo = clamped >= 0 ? [220, 252, 231] : [254, 226, 226];
    hi = clamped >= 0 ? [21, 128, 61] : [185, 28, 28];
    fg = t > 0.5 ? '#ffffff' : (clamped >= 0 ? '#14532d' : '#7f1d1d');
  } else {
    lo = clamped >= 0 ? [38, 73, 56] : [73, 38, 45];
    hi = clamped >= 0 ? [22, 163, 74] : [220, 38, 38];
    fg = '#ffffff';
  }
  const r = Math.round(lo[0] + (hi[0] - lo[0]) * t);
  const g = Math.round(lo[1] + (hi[1] - lo[1]) * t);
  const b = Math.round(lo[2] + (hi[2] - lo[2]) * t);
  return { bg: `rgb(${r}, ${g}, ${b})`, fg };
}
function squarify(items, rect) {
  if (!items || items.length === 0 || rect.w <= 0 || rect.h <= 0) return [];
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const result = [];
  layoutSquarify(sorted, { ...rect }, result);
  return result;
}
function layoutSquarify(items, rect, result) {
  if (items.length === 0 || rect.w <= 0 || rect.h <= 0) return;
  if (items.length === 1) {
    result.push({ ...items[0], x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    return;
  }
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return;
  const shortSide = Math.min(rect.w, rect.h);
  const area = rect.w * rect.h;
  let row = [items[0]];
  let i = 1;
  let bestWorst = computeWorst(row, shortSide, total, area);
  while (i < items.length) {
    const candidate = [...row, items[i]];
    const cw = computeWorst(candidate, shortSide, total, area);
    if (cw > bestWorst && row.length > 0) break;
    row = candidate;
    bestWorst = cw;
    i++;
  }
  const rowSum = row.reduce((s, it) => s + it.value, 0);
  const rowArea = (rowSum / total) * area;
  if (rect.w >= rect.h) {
    const colW = rowArea / rect.h;
    let yOff = 0;
    for (let k = 0; k < row.length; k++) {
      const item = row[k];
      const itemH = k === row.length - 1 ? (rect.h - yOff) : (item.value / rowSum) * rect.h;
      result.push({ ...item, x: rect.x, y: rect.y + yOff, w: colW, h: itemH });
      yOff += itemH;
    }
    layoutSquarify(items.slice(i), { x: rect.x + colW, y: rect.y, w: rect.w - colW, h: rect.h }, result);
  } else {
    const rowH = rowArea / rect.w;
    let xOff = 0;
    for (let k = 0; k < row.length; k++) {
      const item = row[k];
      const itemW = k === row.length - 1 ? (rect.w - xOff) : (item.value / rowSum) * rect.w;
      result.push({ ...item, x: rect.x + xOff, y: rect.y, w: itemW, h: rowH });
      xOff += itemW;
    }
    layoutSquarify(items.slice(i), { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH }, result);
  }
}
function computeWorst(row, shortSide, totalValue, totalArea) {
  if (row.length === 0) return Infinity;
  const sum = row.reduce((s, i) => s + i.value, 0);
  if (sum <= 0) return Infinity;
  const rowArea = (sum / totalValue) * totalArea;
  const rowLength = rowArea / shortSide;
  if (rowLength <= 0) return Infinity;
  let maxRatio = 0;
  for (const item of row) {
    const itemArea = (item.value / totalValue) * totalArea;
    const itemBreadth = itemArea / rowLength;
    if (itemBreadth <= 0) return Infinity;
    const ratio = Math.max(rowLength / itemBreadth, itemBreadth / rowLength);
    if (ratio > maxRatio) maxRatio = ratio;
  }
  return maxRatio;
}
function buildSectorHierarchy(rows) {
  // rows: [{ticker, sector, industry, value, changePct, market}]
  const sectors = {};
  for (const r of rows) {
    const chg = (typeof r.changePct === 'number' && isFinite(r.changePct)) ? r.changePct : null;
    if (!sectors[r.sector]) sectors[r.sector] = { name: r.sector, value: 0, weightedChg: 0, chgValue: 0, industries: {} };
    if (!sectors[r.sector].industries[r.industry]) sectors[r.sector].industries[r.industry] = { name: r.industry, value: 0, weightedChg: 0, chgValue: 0, tickers: [] };
    sectors[r.sector].value += r.value;
    sectors[r.sector].industries[r.industry].value += r.value;
    if (chg != null) {
      // Only rows with a live quote contribute to the weighted average, so the
      // header figure stays accurate while a heatmap is still streaming in.
      sectors[r.sector].weightedChg += chg * r.value;
      sectors[r.sector].chgValue += r.value;
      sectors[r.sector].industries[r.industry].weightedChg += chg * r.value;
      sectors[r.sector].industries[r.industry].chgValue += r.value;
    }
    sectors[r.sector].industries[r.industry].tickers.push(r);
  }
  const sectorList = Object.values(sectors).map(s => {
    const industries = Object.values(s.industries).map(ind => ({
      name: ind.name, value: ind.value, tickers: ind.tickers,
      avgChange: ind.chgValue > 0 ? ind.weightedChg / ind.chgValue : 0
    }));
    return { name: s.name, value: s.value, industries, avgChange: s.chgValue > 0 ? s.weightedChg / s.chgValue : 0 };
  });
  return sectorList;
}
function layoutTreemap(sectors, w, h) {
  const SECTOR_HEADER = 22;
  const INDUSTRY_HEADER = 14;
  const cells = [];
  const sectorRects = squarify(sectors.map(s => ({ ref: s, value: s.value })), { x: 0, y: 0, w, h });
  for (const sr of sectorRects) {
    const sec = sr.ref;
    cells.push({ kind: 'sector', name: sec.name, avgChange: sec.avgChange, x: sr.x, y: sr.y, w: sr.w, h: sr.h });
    const innerY = sr.y + SECTOR_HEADER;
    const innerH = Math.max(0, sr.h - SECTOR_HEADER);
    if (innerH < 24 || sr.w < 30) continue;
    const industries = sec.industries;
    const useIndustries = industries.length > 1 && innerH >= 40;
    if (!useIndustries) {
      const allTickers = industries.flatMap(ind => ind.tickers);
      const trects = squarify(allTickers.map(t => ({ ref: t, value: t.value })), { x: sr.x, y: innerY, w: sr.w, h: innerH });
      for (const tr of trects) cells.push({ kind: 'ticker', ref: tr.ref, x: tr.x, y: tr.y, w: tr.w, h: tr.h });
      continue;
    }
    const indRects = squarify(industries.map(ind => ({ ref: ind, value: ind.value })), { x: sr.x, y: innerY, w: sr.w, h: innerH });
    for (const ir of indRects) {
      const ind = ir.ref;
      cells.push({ kind: 'industry', name: ind.name, avgChange: ind.avgChange, x: ir.x, y: ir.y, w: ir.w, h: ir.h });
      const tInnerY = ir.y + (ir.h >= 40 ? INDUSTRY_HEADER : 0);
      const tInnerH = Math.max(0, ir.h - (ir.h >= 40 ? INDUSTRY_HEADER : 0));
      if (tInnerH < 16 || ir.w < 22) continue;
      const trects = squarify(ind.tickers.map(t => ({ ref: t, value: t.value })), { x: ir.x, y: tInnerY, w: ir.w, h: tInnerH });
      for (const tr of trects) cells.push({ kind: 'ticker', ref: tr.ref, x: tr.x, y: tr.y, w: tr.w, h: tr.h });
    }
  }
  return cells;
}
function useContainerWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const el = ref.current;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
// Each GICS-style sector maps to the SPDR sector ETF that tracks it. We treat
// the ETF's own price history as a proxy for "the size / health of the sector"
// over time — it's a clean, liquid, well-known instrument per sector and lets us
// show multi-horizon trend without needing a sector-market-cap time series.
const SECTOR_ETF = {
  'Technology':              { etf: 'XLK',  name: 'Technology Select Sector' },
  'Communication Services':  { etf: 'XLC',  name: 'Communication Services' },
  'Consumer Cyclical':       { etf: 'XLY',  name: 'Consumer Discretionary' },
  'Consumer Defensive':      { etf: 'XLP',  name: 'Consumer Staples' },
  'Energy':                  { etf: 'XLE',  name: 'Energy Select Sector' },
  'Financial Services':      { etf: 'XLF',  name: 'Financial Select Sector' },
  'Financials':             { etf: 'XLF',  name: 'Financial Select Sector' },
  'Healthcare':              { etf: 'XLV',  name: 'Health Care Select Sector' },
  'Industrials':             { etf: 'XLI',  name: 'Industrial Select Sector' },
  'Basic Materials':         { etf: 'XLB',  name: 'Materials Select Sector' },
  'Materials':               { etf: 'XLB',  name: 'Materials Select Sector' },
  'Real Estate':             { etf: 'XLRE', name: 'Real Estate Select Sector' },
  'Utilities':               { etf: 'XLU',  name: 'Utilities Select Sector' },
};
const SECTOR_TREND_WINDOWS = [
  { key: '1W', days: 7 },
  { key: '1M', days: 30 },
  { key: '1Y', days: 365 },
  { key: '2Y', days: 730 },
  { key: '3Y', days: 1095 },
  { key: '5Y', days: 1825 },
];
const SECTOR_TREND_CACHE = {};
async function fetchSectorTrend(sectorName) {
  const map = SECTOR_ETF[sectorName];
  if (!map) return { unsupported: true };
  const cached = SECTOR_TREND_CACHE[map.etf];
  if (cached && Date.now() - cached.fetchedAt < 6 * 3600 * 1000) return cached;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${map.etf}?interval=1d&range=5y`;
  const text = await fetchViaProxies(url, { timeoutMs: 9000 });
  if (!text) return null;
  let result;
  try { result = JSON.parse(text)?.chart?.result?.[0]; } catch (_e) { return null; }
  const ts = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) return null;
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === 'number' && isFinite(c) && c > 0) bars.push({ t: ts[i] * 1000, p: c });
  }
  if (bars.length < 2) return null;
  const latest = bars[bars.length - 1].p;
  const now = bars[bars.length - 1].t;
  const closeAtOrBefore = (targetMs) => {
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].t <= targetMs) return bars[i].p; }
    return null;
  };
  const trends = SECTOR_TREND_WINDOWS.map(w => {
    const past = closeAtOrBefore(now - w.days * 86400000);
    const pct = past && past > 0 ? (latest - past) / past * 100 : null;
    return { key: w.key, pct };
  });
  const entry = { etf: map.etf, name: map.name, trends, fetchedAt: Date.now() };
  SECTOR_TREND_CACHE[map.etf] = entry;
  return entry;
}
function HeatmapTreemap(_ref8c) {
  let { rows, aspectRatio, minHeight, onOpenDetail, onOpenSector, loading, height: fixedHeight, width: fixedWidth } = _ref8c;
  const [containerRef, measuredWidth] = useContainerWidth();
  const width = fixedWidth || measuredWidth;
  const sectors = useMemo(() => buildSectorHierarchy(rows), [rows]);
  const height = fixedHeight || (width > 0 ? Math.max(minHeight || 360, width * (aspectRatio || 0.7)) : (minHeight || 360));
  const cells = useMemo(() => width > 0 ? layoutTreemap(sectors, width, height) : [], [sectors, width, height]);
  const isLight = typeof document !== 'undefined' && document.documentElement && document.documentElement.dataset.theme === 'light';
  return React.createElement("div", { ref: containerRef, className: "treemap", style: { height: height + 'px', width: fixedWidth ? fixedWidth + 'px' : undefined } },
    cells.map((cell, idx) => {
      if (cell.kind === 'sector' || cell.kind === 'industry') {
        const isSec = cell.kind === 'sector';
        // A framing box around the whole group makes it obvious which tiles
        // belong to which sector / industry, plus the label strip on top.
        return [
          React.createElement("div", {
            key: (isSec ? 'sbox:' : 'ibox:') + cell.name + ':' + idx,
            className: isSec ? 'tm-sector-box' : 'tm-industry-box',
            style: { left: cell.x + 'px', top: cell.y + 'px', width: cell.w + 'px', height: cell.h + 'px' }
          }),
          React.createElement("div", {
            key: cell.kind + ':' + cell.name + ':' + idx,
            className: (isSec ? 'tm-sector-label' : 'tm-industry-label') + (isSec && onOpenSector ? ' tm-sector-label-tap' : ''),
            style: { left: cell.x + 'px', top: cell.y + 'px', width: cell.w + 'px' },
            onClick: isSec && onOpenSector ? (e) => { e.stopPropagation(); onOpenSector(cell.name); } : undefined,
            role: isSec && onOpenSector ? 'button' : undefined,
            title: isSec && onOpenSector ? 'Open ' + cell.name + ' sector' : undefined
          },
            React.createElement("span", { className: "tm-label-name" }, cell.name),
            React.createElement("span", { className: `tm-label-chg ${cell.avgChange >= 0 ? 'up' : 'down'}` },
              ' ', (cell.avgChange >= 0 ? '+' : '') + cell.avgChange.toFixed(2) + '%'
            ),
            isSec && onOpenSector ? React.createElement("span", { className: "tm-sector-expand" },
              React.createElement(Icon, { name: "maximize", size: 10 })) : null
          )
        ];
      }
      const t = cell.ref;
      const hasData = t.changePct != null && isFinite(t.changePct);
      const c = heatColor(hasData ? t.changePct : null, isLight);
      // Inset each tile so neighbours are separated by a clean gutter (the dark
      // container shows through), giving the grid breathing room instead of the
      // cramped hairline-border look. Smaller gap on very small cells.
      const GAP = cell.w < 26 || cell.h < 20 ? 1.5 : 2.5;
      const iw = Math.max(0, cell.w - GAP * 2);
      const ih = Math.max(0, cell.h - GAP * 2);
      const showPct = hasData && iw >= 38 && ih >= 30;
      const showTkr = iw >= 20 && ih >= 15;
      const tkrSize = Math.max(9, Math.min(20, Math.sqrt(iw * ih) / 6));
      const pctSize = Math.max(8, tkrSize - 4);
      const radius = Math.min(6, iw / 4, ih / 4);
      return React.createElement("button", {
        key: 't:' + priceKey(t.market, t.ticker),
        className: 'tm-cell' + (hasData ? '' : (loading ? ' loading' : ' nodata')),
        style: {
          left: (cell.x + GAP) + 'px', top: (cell.y + GAP) + 'px',
          width: iw + 'px', height: ih + 'px',
          borderRadius: radius + 'px',
          background: c.bg, color: c.fg
        },
        onClick: () => onOpenDetail && onOpenDetail(t.ticker, t.market),
        title: hasData ? `${t.ticker} ${t.changePct >= 0 ? '+' : ''}${t.changePct.toFixed(2)}%` : t.ticker
      },
        showTkr ? React.createElement("span", { className: 'tm-cell-tkr', style: { fontSize: tkrSize + 'px' } }, t.ticker) : null,
        showPct ? React.createElement("span", { className: 'tm-cell-pct', style: { fontSize: pctSize + 'px' } },
          (t.changePct >= 0 ? '+' : '') + t.changePct.toFixed(2) + '%'
        ) : null
      );
    })
  );
}
// Reusable pinch / scroll / double-tap zoom + drag-pan treemap. Zoom is realised
// by RE-LAYING-OUT the treemap at a larger pixel size (not a CSS scale) so cells
// physically grow and their labels stay sharp. Used both by the fullscreen
// heatmap and the in-place sector popup, so the popup behaves exactly like the
// big heatmap without ever going fullscreen.
function ZoomPanHeatmap(_refZP) {
  let { rows, loading, onOpenDetail, onOpenSector, lockScroll, stageClass, contentClass } = _refZP;
  useBodyScrollLock(!!lockScroll);
  const wrapRef = useRef(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [z, setZ] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const ptrs = useRef(new Map());
  const pinch = useRef(null);
  const drag = useRef(null);
  const movedRef = useRef(false);
  const rafRef = useRef(0);
  const nextRef = useRef({ z: 1, x: 0, y: 0 });
  const MIN = 1, MAX = 5;
  const commit = (nz, x, y) => {
    nz = Math.max(MIN, Math.min(MAX, nz));
    const el = wrapRef.current;
    if (el) { const w = el.clientWidth, h = el.clientHeight; x = Math.min(0, Math.max(w - w * nz, x)); y = Math.min(0, Math.max(h - h * nz, y)); }
    nextRef.current = { z: nz, x, y };
    zRef.current = nz; panRef.current = { x, y };
    if (!rafRef.current) rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setZ(nextRef.current.z); setPan({ x: nextRef.current.x, y: nextRef.current.y });
    });
  };
  const reset = () => { movedRef.current = false; commit(1, 0, 0); };
  useEffect(() => {
    const measure = () => { const el = wrapRef.current; if (el) setStage({ w: el.clientWidth, h: el.clientHeight }); };
    measure();
    // Re-measure on the next frame too — inside an animating popup the first
    // measurement can land mid-transition.
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, []);
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const onDown = e => {
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.current.size === 2) {
        const [a, b] = [...ptrs.current.values()];
        pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zRef.current, px: panRef.current.x, py: panRef.current.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, rect: el.getBoundingClientRect() };
        drag.current = null; movedRef.current = true;
      } else if (ptrs.current.size === 1) {
        drag.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y };
        movedRef.current = false;
      }
    };
    const onMove = e => {
      if (!ptrs.current.has(e.pointerId)) return;
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.current.size === 2 && pinch.current) {
        const [a, b] = [...ptrs.current.values()];
        const nd = Math.hypot(a.x - b.x, a.y - b.y);
        const g = pinch.current;
        const nz = Math.max(MIN, Math.min(MAX, g.z * (nd / g.d)));
        const k = nz / g.z;
        const fx = g.mx - g.rect.left, fy = g.my - g.rect.top;
        commit(nz, fx - (fx - g.px) * k, fy - (fy - g.py) * k);
        e.preventDefault();
      } else if (ptrs.current.size === 1 && drag.current && zRef.current > 1.01) {
        const g = drag.current;
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        if (Math.abs(dx) + Math.abs(dy) > 5) movedRef.current = true;
        commit(zRef.current, g.px + dx, g.py + dy);
        e.preventDefault();
      }
    };
    const onUp = e => {
      ptrs.current.delete(e.pointerId);
      if (ptrs.current.size < 2) pinch.current = null;
      if (ptrs.current.size === 0) drag.current = null;
    };
    const onWheel = e => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const fx = e.clientX - rect.left, fy = e.clientY - rect.top;
      const cz = zRef.current;
      const nz = Math.max(MIN, Math.min(MAX, cz * (e.deltaY < 0 ? 1.18 : 0.85)));
      const k = nz / cz;
      commit(nz, fx - (fx - panRef.current.x) * k, fy - (fy - panRef.current.y) * k);
    };
    const onDbl = e => { e.preventDefault(); if (zRef.current > 1.01) commit(1, 0, 0); else { const rect = el.getBoundingClientRect(); const fx = e.clientX - rect.left, fy = e.clientY - rect.top; const nz = 2.5; commit(nz, fx - fx * nz, fy - fy * nz); } };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove, { passive: false });
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDbl);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDbl);
    };
  }, []);
  // Suppress tap-throughs that happened during a pan/pinch gesture.
  const handleOpen = (tk, mk) => { if (movedRef.current) return; onOpenDetail && onOpenDetail(tk, mk); };
  const handleSector = onOpenSector ? (name) => { if (movedRef.current) return; onOpenSector(name); } : undefined;
  const cw = Math.round(stage.w * z), ch = Math.round(stage.h * z);
  return React.createElement("div", { className: stageClass || "zoompan-stage", ref: wrapRef },
    React.createElement("div", {
      className: contentClass || "zoompan-content",
      style: { transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`, width: cw + 'px', height: ch + 'px' }
    },
      stage.w > 0 ? React.createElement(HeatmapTreemap, { rows: rows, width: cw, height: ch, onOpenDetail: handleOpen, onOpenSector: handleSector, loading: loading }) : null
    ),
    z > 1.01 ? React.createElement("div", { className: "zoompan-badge" },
      React.createElement("span", null, z.toFixed(1) + '×'),
      React.createElement("button", { className: "zoompan-reset", onClick: reset }, "Reset")
    ) : null
  );
}
// Full-screen pinch-to-zoom & pan heatmap — thin chrome around ZoomPanHeatmap.
function HeatmapFullscreen(_refFS) {
  let { rows, title, loading, onOpenDetail, onOpenSector, onClose } = _refFS;
  return React.createElement("div", { className: "heatmap-fs" },
    React.createElement("div", { className: "heatmap-fs-bar" },
      React.createElement("div", { className: "heatmap-fs-title" }, title || 'Heatmap',
        React.createElement("span", { className: "heatmap-fs-hint" }, "Pinch, scroll or double-tap to zoom · drag to pan · tap a sector name to dive in")),
      React.createElement("div", { className: "heatmap-fs-actions" },
        React.createElement("button", { className: "btn btn-ghost btn-xs", onClick: onClose, "aria-label": "Close fullscreen" },
          React.createElement(Icon, { name: "x", size: 16 }))
      )
    ),
    React.createElement(ZoomPanHeatmap, {
      rows: rows, loading: loading, onOpenDetail: onOpenDetail, onOpenSector: onOpenSector,
      lockScroll: true, stageClass: "heatmap-fs-stage", contentClass: "heatmap-fs-content"
    })
  );
}
// iOS-style "zoom into the sector" popup. Springs up from a scaled-down,
// translucent state into the centre of the screen, focuses the heatmap on a
// single sector, and pulls multi-horizon trend for the sector's proxy ETF.
function SectorDetailModal({ sectorName, rows, exchangeLabel, onClose, onOpenDetail }) {
  const [trend, setTrend] = useState(null);
  const [trendLoading, setTrendLoading] = useState(true);
  const [closing, setClosing] = useState(false);

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 240);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    setTrendLoading(true);
    setTrend(null);
    fetchSectorTrend(sectorName).then(t => { if (alive) { setTrend(t); setTrendLoading(false); } });
    return () => { alive = false; };
  }, [sectorName]);

  useBodyScrollLock();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [close]);

  // Relative size: this sector's market-cap weight vs every other sector on the
  // same heatmap, plus its rank, so the user can gauge how big it is.
  const sizeCtx = useMemo(() => {
    const agg = {};
    let total = 0;
    rows.forEach(r => {
      const v = r.value || 0;
      agg[r.sector] = (agg[r.sector] || 0) + v;
      total += v;
    });
    const list = Object.entries(agg).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    const rank = list.findIndex(s => s.name === sectorName) + 1;
    const me = list.find(s => s.name === sectorName);
    const largest = list.length ? list[0].value : 0;
    return {
      total, count: list.length, rank,
      value: me ? me.value : 0,
      share: total > 0 && me ? me.value / total * 100 : 0,
      relToLargest: largest > 0 && me ? me.value / largest * 100 : 0,
      top: list.slice(0, 6),
    };
  }, [rows, sectorName]);

  const sectorRows = useMemo(() => rows.filter(r => r.sector === sectorName), [rows, sectorName]);
  const dataRows = sectorRows.filter(r => r.changePct != null && isFinite(r.changePct));
  const up = dataRows.filter(r => r.changePct > 0).length;
  const down = dataRows.filter(r => r.changePct < 0).length;
  const totalVal = dataRows.reduce((s, r) => s + r.value, 0);
  const dayAvg = totalVal > 0 ? dataRows.reduce((s, r) => s + r.changePct * r.value, 0) / totalVal : 0;

  const trendRow = trend && trend.trends
    ? React.createElement("div", { className: "sector-trend-grid" },
        trend.trends.map(t => React.createElement("div", { key: t.key, className: "sector-trend-cell" },
          React.createElement("div", { className: "sector-trend-key" }, t.key),
          React.createElement("div", {
            className: "sector-trend-val " + (t.pct == null ? 'flat' : t.pct >= 0 ? 'up' : 'down')
          }, t.pct == null ? '—' : (t.pct >= 0 ? '+' : '') + t.pct.toFixed(1) + '%')
        )))
    : (trendLoading
        ? React.createElement("div", { className: "sector-trend-loading" }, "Loading sector trend…")
        : React.createElement("div", { className: "sector-trend-loading" },
            trend && trend.unsupported ? "No trend proxy for this sector." : "Sector trend unavailable right now."));

  return React.createElement("div", { className: "sector-modal" + (closing ? " closing" : "") },
    React.createElement("div", { className: "sector-modal-backdrop", onClick: close }),
    React.createElement("div", { className: "sector-modal-panel", role: "dialog", "aria-label": sectorName + " sector" },
      React.createElement("div", { className: "sector-modal-header" },
        React.createElement("div", { className: "sector-modal-titles" },
          React.createElement("div", { className: "sector-modal-title" }, sectorName),
          React.createElement("div", { className: "sector-modal-sub" },
            exchangeLabel ? exchangeLabel + " · " : "",
            sectorRows.length, " companies",
            trend && trend.etf ? React.createElement("span", { className: "sector-proxy-tag" }, " proxy ", trend.etf) : null)),
        React.createElement("button", { className: "modal-close", onClick: close, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" }))),

      React.createElement("div", { className: "sector-modal-body" },
        // Snapshot stat strip
        React.createElement("div", { className: "sector-stat-strip" },
          React.createElement("div", { className: "sector-stat" },
            React.createElement("div", { className: "sector-stat-label" }, "Today"),
            React.createElement("div", { className: "sector-stat-val " + (dayAvg >= 0 ? 'up' : 'down') },
              (dayAvg >= 0 ? '+' : '') + dayAvg.toFixed(2) + '%')),
          React.createElement("div", { className: "sector-stat" },
            React.createElement("div", { className: "sector-stat-label" }, "Breadth"),
            React.createElement("div", { className: "sector-stat-val" },
              React.createElement("span", { className: "stat-up" }, "▲", up),
              " ",
              React.createElement("span", { className: "stat-down" }, "▼", down))),
          React.createElement("div", { className: "sector-stat" },
            React.createElement("div", { className: "sector-stat-label" }, "Weight"),
            React.createElement("div", { className: "sector-stat-val" }, sizeCtx.share.toFixed(1) + '%')),
          React.createElement("div", { className: "sector-stat" },
            React.createElement("div", { className: "sector-stat-label" }, "Size rank"),
            React.createElement("div", { className: "sector-stat-val" }, sizeCtx.rank > 0 ? '#' + sizeCtx.rank + ' / ' + sizeCtx.count : '—'))),

        // Relative-size bar vs the biggest sector
        React.createElement("div", { className: "sector-size-block" },
          React.createElement("div", { className: "sector-size-head" },
            React.createElement("span", null, "Size vs largest sector"),
            React.createElement("span", { className: "text-dim" }, sizeCtx.relToLargest.toFixed(0) + '%')),
          React.createElement("div", { className: "sector-size-track" },
            React.createElement("div", { className: "sector-size-fill", style: { width: Math.max(2, Math.min(100, sizeCtx.relToLargest)) + '%' } }))),

        // Multi-horizon trend
        React.createElement("div", { className: "sector-trend-block" },
          React.createElement("div", { className: "sector-section-label" }, "Sector trend",
            trend && trend.name ? React.createElement("span", { className: "text-dim" }, " · ", trend.name) : null),
          trendRow,
          React.createElement("div", { className: "sector-trend-note" }, "Total return of the sector's proxy ETF over each window.")),

        // Focused heatmap of just this sector — pinch / scroll / double-tap to
        // zoom and drag to pan, exactly like the big heatmap, but contained.
        React.createElement("div", { className: "sector-heat-block" },
          React.createElement("div", { className: "sector-section-label" }, "Companies",
            React.createElement("span", { className: "text-dim" }, " · pinch / scroll to zoom, drag to pan")),
          sectorRows.length > 0
            ? React.createElement("div", { className: "sector-zoom-wrap" },
                React.createElement(ZoomPanHeatmap, {
                  rows: sectorRows,
                  loading: false,
                  lockScroll: false,
                  stageClass: "sector-zoom-stage",
                  contentClass: "heatmap-fs-content",
                  // Keep the sector popup mounted underneath so closing the
                  // stock card returns the user to the sector exactly where they
                  // left off. The stock card (z-index 95) layers above it.
                  onOpenDetail: (tk, mk) => { onOpenDetail && onOpenDetail(tk, mk); }
                }))
            : React.createElement("div", { className: "text-dim text-sm" }, "No live data for this sector yet.")))));
}
function HeatmapView(_ref8b) {
  let { positions, prices, onOpenDetail } = _ref8b;
  const exchanges = DATA.HEATMAPS;
  const [mode, setMode] = usePersistedState('pb.heatmap.mode.v1', 'market');
  const [selectedId, setSelectedId] = usePersistedState('pb.heatmap.exchange.v1', exchanges[0].id);
  const [portfolioFilter, setPortfolioFilter] = usePersistedState('pb.heatmap.pf.v1', 'all');
  const exchange = exchanges.find(e => e.id === selectedId) || exchanges[0];
  // Last-good rows are persisted per exchange so reopening the tab paints the
  // previous heatmap instantly while a fresh fetch runs in the background.
  const [persisted, setPersisted] = usePersistedState('pb.heatmap.lastgood.v1', {});
  const [cache, setCache] = useState(() => ({ ...persisted }));
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [sectorDetail, setSectorDetail] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(() => persisted[exchanges[0].id]?.fetchedAt ? new Date(persisted[exchanges[0].id].fetchedAt) : null);
  const cacheKey = exchange.id;
  const cached = cache[cacheKey];
  const loadRef = useRef(false);
  const mkSkeleton = (c) => ({ ticker: c.t, market: exchange.market, sector: c.s, industry: c.i, value: c.m, price: null, changePct: null });
  const load = useCallback(async (force) => {
    if (loadRef.current) return;
    const existing = cache[cacheKey];
    if (!force && existing && existing.fetchedAt && Date.now() - existing.fetchedAt < 300_000) return;
    loadRef.current = true;
    setLoading(true);
    setError(null);
    const constituents = exchange.constituents;
    setProgress({ done: 0, total: constituents.length });
    // Paint the full grid immediately — its layout is driven by market cap
    // (known up-front), so structure is stable and only colour fills in as
    // quotes arrive. On a refresh we keep the previous (stale) colours visible
    // and overwrite them per batch, so cells never flash back to grey.
    const prevMap = {};
    if (existing && existing.rows) existing.rows.forEach(r => { if (r.changePct != null) prevMap[priceKey(r.market, r.ticker)] = r; });
    const buildRows = (quotes) => constituents.map(c => {
      const key = priceKey(exchange.market, c.t);
      const q = quotes[key];
      if (q) return { ticker: c.t, market: exchange.market, sector: c.s, industry: c.i, value: c.m, price: q.price, changePct: q.changePct };
      const prev = prevMap[key];
      return prev || mkSkeleton(c);
    });
    setCache(prev => ({ ...prev, [cacheKey]: { rows: buildRows({}), fetchedAt: 0 } }));
    try {
      const items = constituents.map(c => ({ ticker: c.t, market: exchange.market }));
      const quotes = await fetchQuoteBatchLight(items, (done, total, partial) => {
        setProgress({ done, total });
        if (partial) setCache(prev => ({ ...prev, [cacheKey]: { rows: buildRows(partial), fetchedAt: 0 } }));
      });
      const rows = buildRows(quotes);
      if (rows.filter(r => r.changePct != null).length === 0) {
        setError('No live data returned. Try again shortly.');
        setCache(prev => { const n = { ...prev }; delete n[cacheKey]; return n; });
      } else {
        const entry = { rows, fetchedAt: Date.now() };
        setCache(prev => ({ ...prev, [cacheKey]: entry }));
        setPersisted(prev => ({ ...prev, [cacheKey]: entry }));
        setLastUpdate(new Date());
      }
    } catch (e) {
      setError('Failed to load heatmap. Check your connection.');
    } finally {
      loadRef.current = false;
      setLoading(false);
      setProgress(null);
    }
  }, [cacheKey, exchange, cache, setPersisted]);
  useEffect(() => {
    if (mode === 'market') {
      const e = cache[cacheKey];
      if (e && e.fetchedAt) setLastUpdate(new Date(e.fetchedAt));
      load(false);
    }
  }, [cacheKey, mode]);
  const portfolioMarkets = useMemo(() => {
    const mkts = new Set();
    positions.forEach(p => mkts.add(p.market));
    return Array.from(mkts).sort();
  }, [positions]);
  const portfolioRows = useMemo(() => {
    if (mode !== 'portfolio') return [];
    return positions.filter(p => portfolioFilter === 'all' || p.market === portfolioFilter).map(p => {
      const q = prices[priceKey(p.market, p.ticker)];
      if (!q || q.changePct == null) return null;
      const sec = DATA.findSector(p.ticker, p.market);
      const positionValue = p.shares * q.price;
      if (positionValue <= 0) return null;
      return { ticker: p.ticker, market: p.market, sector: sec.sector, industry: sec.industry, value: positionValue, price: q.price, changePct: q.changePct };
    }).filter(Boolean);
  }, [mode, positions, prices, portfolioFilter]);
  const activeRows = mode === 'market' ? (cached ? cached.rows : []) : portfolioRows;
  const stats = useMemo(() => {
    if (!activeRows || activeRows.length === 0) return null;
    const dataRows = activeRows.filter(r => r.changePct != null && isFinite(r.changePct));
    if (dataRows.length === 0) return null;
    const up = dataRows.filter(r => r.changePct > 0).length;
    const down = dataRows.filter(r => r.changePct < 0).length;
    const flat = dataRows.length - up - down;
    const totalVal = dataRows.reduce((s, r) => s + r.value, 0);
    const wAvg = totalVal > 0 ? dataRows.reduce((s, r) => s + r.changePct * r.value, 0) / totalVal : 0;
    return { up, down, flat, avg: wAvg, total: dataRows.length };
  }, [activeRows]);
  const aspectRatio = mode === 'market' ? 0.62 : 0.5;
  const minHeight = mode === 'market' ? 480 : 360;
  const progressPct = progress ? Math.round(progress.done / progress.total * 100) : 0;
  return React.createElement("div", null,
    React.createElement("div", { className: "heatmap-mode-toggle" },
      React.createElement("button", {
        className: `heatmap-mode-btn ${mode === 'portfolio' ? 'active' : ''}`,
        onClick: () => setMode('portfolio')
      }, "Portfolio"),
      React.createElement("button", {
        className: `heatmap-mode-btn ${mode === 'market' ? 'active' : ''}`,
        onClick: () => setMode('market')
      }, "Market")
    ),
    mode === 'market' ? React.createElement("div", { className: "heatmap-toggle" },
      exchanges.map(ex => React.createElement("button", {
        key: ex.id,
        className: `heatmap-toggle-btn ${ex.id === selectedId ? 'active' : ''}`,
        onClick: () => setSelectedId(ex.id)
      }, ex.label))
    ) : null,
    mode === 'portfolio' && portfolioMarkets.length > 1 ? React.createElement("div", { className: "heatmap-toggle" },
      React.createElement("button", {
        className: `heatmap-toggle-btn ${portfolioFilter === 'all' ? 'active' : ''}`,
        onClick: () => setPortfolioFilter('all')
      }, "All"),
      portfolioMarkets.map(m => React.createElement("button", {
        key: m,
        className: `heatmap-toggle-btn ${portfolioFilter === m ? 'active' : ''}`,
        onClick: () => setPortfolioFilter(m)
      }, m))
    ) : null,
    React.createElement("div", { className: "heatmap-meta" },
      React.createElement("div", { className: "heatmap-meta-left" },
        stats ? React.createElement(React.Fragment, null,
          React.createElement("span", { className: "stat-up" }, "▲ ", stats.up),
          React.createElement("span", { className: "stat-down" }, "▼ ", stats.down),
          stats.flat > 0 ? React.createElement("span", { className: "stat-flat" }, "● ", stats.flat) : null,
          React.createElement("span", { className: `stat-avg ${stats.avg >= 0 ? 'up' : 'down'}` },
            "weighted ", stats.avg >= 0 ? '+' : '', stats.avg.toFixed(2), '%'
          )
        ) : React.createElement("span", { className: "text-dim text-sm" }, loading ? "Fetching live quotes…" : (mode === 'portfolio' && positions.length === 0 ? "Add positions to see your portfolio heatmap." : ""))
      ),
      React.createElement("div", { className: "heatmap-meta-right" },
        mode === 'market' && lastUpdate ? React.createElement("span", { className: "text-dim text-sm" },
          "Updated ", lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        ) : null,
        activeRows.length > 0 ? React.createElement("button", {
          className: "btn btn-ghost btn-xs",
          onClick: () => setFullscreen(true),
          "aria-label": "Open heatmap fullscreen"
        }, React.createElement(Icon, { name: "maximize", size: 13 }), " Expand") : null,
        mode === 'market' ? React.createElement("button", {
          className: `btn btn-ghost btn-xs ${loading ? 'spin' : ''}`,
          onClick: () => load(true),
          disabled: loading,
          "aria-label": "Refresh heatmap"
        }, React.createElement(Icon, { name: "refresh", size: 13 }), " ", loading ? "Loading" : "Refresh") : null
      )
    ),
    error && mode === 'market' ? React.createElement("div", { className: "verify-error" }, error) : null,
    mode === 'market' && loading ? React.createElement("div", { className: "heatmap-progress" },
      React.createElement("div", { className: "heatmap-progress-bar" },
        React.createElement("div", { className: "heatmap-progress-fill", style: { width: progressPct + '%' } })),
      React.createElement("span", { className: "heatmap-progress-text" },
        progress ? progress.done + " / " + progress.total + " quotes" : "Loading " + exchange.label + "…")
    ) : null,
    activeRows.length > 0 ? React.createElement(HeatmapTreemap, {
      rows: activeRows,
      aspectRatio: aspectRatio,
      minHeight: minHeight,
      onOpenDetail: onOpenDetail,
      onOpenSector: (name) => setSectorDetail(name),
      loading: loading
    }) : (mode === 'portfolio' && !loading ? React.createElement("div", { className: "heatmap-loading" }, positions.length === 0 ? "You don't have any positions yet." : (portfolioRows.length === 0 && portfolioFilter !== 'all' ? "No " + portfolioFilter + " positions with live data." : "Waiting for live quotes…")) : null),
    activeRows.length > 0 ? React.createElement("div", { className: "heatmap-sector-hint" },
      React.createElement(Icon, { name: "maximize", size: 11 }), " Tap a sector name to zoom in") : null,
    fullscreen ? React.createElement(HeatmapFullscreen, {
      rows: activeRows,
      loading: loading,
      title: mode === 'market' ? exchange.label : 'Your portfolio',
      onOpenDetail: (tk, mk) => { setFullscreen(false); onOpenDetail && onOpenDetail(tk, mk); },
      onOpenSector: (name) => setSectorDetail(name),
      onClose: () => setFullscreen(false)
    }) : null,
    sectorDetail ? React.createElement(SectorDetailModal, {
      sectorName: sectorDetail,
      rows: activeRows,
      exchangeLabel: mode === 'market' ? exchange.label : 'Your portfolio',
      onOpenDetail: onOpenDetail,
      onClose: () => setSectorDetail(null)
    }) : null
  );
}
function PicksView(_ref9) {
  let {
    prices,
    onOpenDetail
  } = _ref9;
  return React.createElement("div", null, React.createElement("div", {
    className: "grid grid-2"
  }, DATA.NEW_PICKS.map(p => {
    const q = prices['US:' + p.ticker];
    const upsideNow = q && p.entryPrice ? (p.targetPrice - q.price) / q.price * 100 : null;
    return React.createElement("div", {
      key: p.ticker,
      className: "pos-card",
      onClick: () => onOpenDetail(p.ticker, 'US')
    }, React.createElement("div", {
      className: "pos-head"
    }, React.createElement("div", {
      className: "flex-1"
    }, React.createElement("div", {
      className: "flex items-center gap-2"
    }, React.createElement("span", {
      className: "tkr"
    }, p.ticker), React.createElement("span", {
      className: "market-badge"
    }, p.allocation, "%")), React.createElement("div", {
      className: "tkr-name"
    }, p.name, " \xB7 ", p.sector)), React.createElement("span", {
      className: `pill ${p.conviction === 'HIGH' ? 'pill-buy' : 'pill-hold'}`
    }, p.conviction)), React.createElement("div", {
      className: "current-price-label"
    }, "Current"), React.createElement(PriceBlock, {
      quote: q,
      size: "lg"
    }), React.createElement("div", {
      className: "kv-row mt-3"
    }, React.createElement("div", {
      className: "kv"
    }, React.createElement("div", {
      className: "kv-label"
    }, "Entry"), React.createElement("div", {
      className: "kv-val"
    }, fmt(p.entryPrice, 'US'))), React.createElement("div", {
      className: "kv"
    }, React.createElement("div", {
      className: "kv-label"
    }, "Target"), React.createElement("div", {
      className: "kv-val"
    }, fmt(p.targetPrice, 'US'))), React.createElement("div", {
      className: "kv"
    }, React.createElement("div", {
      className: "kv-label"
    }, "Upside"), React.createElement("div", {
      className: "kv-val up"
    }, upsideNow != null ? (upsideNow >= 0 ? '+' : '') + upsideNow.toFixed(0) + '%' : '+' + p.upside + '%'))), React.createElement("div", {
      className: "text-sm text-muted mt-3",
      style: {
        lineHeight: 1.5
      }
    }, p.thesis));
  })));
}
function HedgesView(_ref0) {
  let {
    prices,
    onOpenDetail
  } = _ref0;
  return React.createElement("div", null, React.createElement("div", {
    className: "grid grid-2"
  }, DATA.HEDGES.map(h => {
    const q = prices['US:' + h.ticker];
    return React.createElement("div", {
      key: h.ticker,
      className: "pos-card",
      onClick: () => onOpenDetail(h.ticker, 'US')
    }, React.createElement("div", {
      className: "pos-head"
    }, React.createElement("div", {
      className: "flex-1"
    }, React.createElement("div", {
      className: "flex items-center gap-2"
    }, React.createElement("span", {
      className: "tkr"
    }, h.ticker), React.createElement("span", {
      className: "market-badge"
    }, h.allocation, "%")), React.createElement("div", {
      className: "tkr-name"
    }, h.name))), React.createElement(PriceBlock, {
      quote: q,
      size: "lg"
    }), React.createElement("div", {
      className: "text-xs text-dim mono mt-2",
      style: {
        letterSpacing: '0.1em',
        textTransform: 'uppercase'
      }
    }, h.role), React.createElement("div", {
      className: "text-sm text-muted mt-2"
    }, h.rationale));
  })), React.createElement("div", {
    className: "mt-6"
  }, React.createElement("div", {
    className: "eyebrow"
  }, "Explicitly skipped"), React.createElement("div", {
    className: "card"
  }, React.createElement("ul", {
    className: "bullet-list"
  }, React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "TLT"), " \u2014 17-yr duration too sensitive to Fed error. IEF covers it with less drawdown risk.")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "VIXY / UVXY"), " \u2014 constant contango decay. Structural money-loser for retail holders.")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "SH / SPXS"), " \u2014 inverse equity erodes via compounding. Cash beats inverse ETFs over any holding period >1 month.")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "GDXJ"), " \u2014 too correlated with tech beta. IAU alone delivers the gold exposure cleanly."))))));
}
function TFSAView({ positions, prices, onOpenDetail, onAddPosition, onSellPosition }) {
  const TFSA_ANNUAL_LIMIT = 46000;
  const TFSA_LIFETIME_LIMIT = 500000;
  const totalValue = positions.reduce((s, p) => {
    const q = prices['TFSA:' + p.ticker];
    return s + (q ? p.shares * q.price : p.shares * p.costBasis);
  }, 0);
  const totalCost = positions.reduce((s, p) => s + p.shares * p.costBasis, 0);
  const pnl = totalValue - totalCost;
  const pnlPct = totalCost > 0 ? pnl / totalCost * 100 : 0;
  return React.createElement("div", null,
    React.createElement("div", { className: "card mb-4" },
      React.createElement("div", { className: "eyebrow", style: { marginBottom: 8 } }, "TFSA Overview"),
      React.createElement("div", { className: "kv-row" },
        React.createElement("div", { className: "kv" },
          React.createElement("div", { className: "kv-label" }, "Value"),
          React.createElement("div", { className: "kv-val mono" }, "R", totalValue.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))),
        React.createElement("div", { className: "kv" },
          React.createElement("div", { className: "kv-label" }, "Cost"),
          React.createElement("div", { className: "kv-val mono" }, "R", totalCost.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))),
        React.createElement("div", { className: "kv" },
          React.createElement("div", { className: "kv-label" }, "P&L"),
          React.createElement("div", { className: `kv-val mono ${pnl >= 0 ? 'text-up' : 'text-down'}` },
            (pnl >= 0 ? '+' : '') + "R" + Math.abs(pnl).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            " (", pnlPct >= 0 ? '+' : '', pnlPct.toFixed(1), "%)"))),
      React.createElement("div", { className: "text-xs text-dim", style: { marginTop: 10 } },
        "Annual limit: R", TFSA_ANNUAL_LIMIT.toLocaleString(), " \xB7 Lifetime limit: R", TFSA_LIFETIME_LIMIT.toLocaleString())),
    React.createElement("div", { className: "flex justify-between items-center mb-3" },
      React.createElement("div", { className: "eyebrow", style: { marginBottom: 0 } }, "Holdings"),
      React.createElement("button", { className: "btn btn-primary btn-sm", onClick: onAddPosition },
        React.createElement(Icon, { name: "plus", size: 13 }), " Add")),
    positions.length === 0
      ? React.createElement("div", { className: "empty" },
          React.createElement(Icon, { name: "briefcase", size: 40 }),
          React.createElement("h3", null, "No TFSA holdings"),
          React.createElement("p", null, "Add JSE-listed ETFs and equities to your Tax-Free Savings Account."))
      : React.createElement("div", { className: "row-list" },
          positions.map(p => {
            const q = prices['TFSA:' + p.ticker];
            const info = DATA.findInfo(p.ticker, 'TFSA');
            const mv = q ? p.shares * q.price : null;
            const cost = p.shares * p.costBasis;
            const pp = mv != null && cost > 0 ? (mv - cost) / cost * 100 : null;
            return React.createElement("button", {
              key: p.id, className: "row",
              onClick: () => onOpenDetail(p.ticker, 'TFSA')
            }, React.createElement("div", { className: "row-main" },
              React.createElement("div", { className: "row-head" },
                React.createElement("span", { className: "tkr" }, p.ticker),
                React.createElement("span", { className: "text-sm text-dim" }, info.name || p.ticker)),
              React.createElement("div", { className: "row-meta" },
                p.shares, " \xD7 ", fmt(p.costBasis, 'TFSA'),
                pp != null && React.createElement("span", {
                  className: `mono ${pp >= 0 ? 'text-up' : 'text-down'}`
                }, " \xB7 ", pp >= 0 ? '+' : '', pp.toFixed(2), "%"),
                React.createElement("button", {
                  className: "btn-sell-inline",
                  onClick: e => { e.stopPropagation(); onSellPosition(p); }
                }, "Sell"))),
              React.createElement("div", { className: "row-right" },
                React.createElement(PriceBlock, { quote: q }),
                mv != null && React.createElement("div", {
                  className: "text-xs text-dim mt-1 mono"
                }, fmt(mv, 'TFSA'))));
          })),
    React.createElement("div", { className: "card mt-4" },
      React.createElement("div", { className: "eyebrow", style: { marginBottom: 6 } }, "TFSA Rules"),
      React.createElement("ul", { className: "bullet-list" },
        React.createElement("li", null, React.createElement("span", null, "R", TFSA_ANNUAL_LIMIT.toLocaleString(), " annual contribution limit")),
        React.createElement("li", null, React.createElement("span", null, "R", TFSA_LIFETIME_LIMIT.toLocaleString(), " lifetime contribution limit")),
        React.createElement("li", null, React.createElement("span", null, "All gains, dividends, and interest are ", React.createElement("strong", null, "tax-free"))),
        React.createElement("li", null, React.createElement("span", null, "Only JSE-listed equities, ETFs, and unit trusts are eligible")),
        React.createElement("li", null, React.createElement("span", null, "Withdrawals reduce available contribution room permanently")),
        React.createElement("li", null, React.createElement("span", null, "40% penalty on contributions exceeding the annual limit")))));
}
function RulesView() {
  return React.createElement("div", null, React.createElement("div", {
    className: "eyebrow"
  }, "Trim rules"), React.createElement("div", {
    className: "card mb-4"
  }, React.createElement("ul", {
    className: "bullet-list"
  }, React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "+100% gain"), " \u2014 trim 25% of position, bank profits")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "+150% gain"), " \u2014 trim another 20% of remainder")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "+200% gain"), " \u2014 trim another 20%, let the rest ride")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "-20% from cost"), " \u2014 re-examine thesis, never average down without fresh conviction")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "Position >12% of book"), " \u2014 trim to 10% regardless of gain")))), React.createElement("div", {
    className: "eyebrow"
  }, "Thesis-break triggers"), React.createElement("div", {
    className: "card mb-4"
  }, React.createElement("ul", {
    className: "bullet-list"
  }, React.createElement("li", null, React.createElement("span", null, "Hyperscaler capex cut by top-3 player (MSFT, GOOGL, META, AMZN, ORCL)")), React.createElement("li", null, React.createElement("span", null, "Core CPI above 3.2% for two consecutive prints")), React.createElement("li", null, React.createElement("span", null, "Brent above $120 \u2014 consumer weakness trigger")), React.createElement("li", null, React.createElement("span", null, "VOO drawdown >15% from buy-zone \u2014 deploy all cash")), React.createElement("li", null, React.createElement("span", null, "Any position where CEO reneges on publicly-stated commitment (the MSTR lesson)")))), React.createElement("div", {
    className: "eyebrow"
  }, "Key risks"), React.createElement("div", {
    className: "grid grid-2 mb-4"
  }, DATA.RISKS.map((r, i) => React.createElement("div", {
    key: i,
    className: "card"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-2",
    style: {
      gap: 8
    }
  }, React.createElement("div", {
    className: "font-semibold",
    style: {
      fontSize: 14,
      lineHeight: 1.3
    }
  }, r.title), React.createElement("span", {
    className: `pill ${r.probability === 'HIGH' ? 'pill-danger' : 'pill-warn'}`
  }, r.probability)), React.createElement("div", {
    className: "text-sm text-muted"
  }, r.impact)))), React.createElement("div", {
    className: "eyebrow"
  }, "SA tax-year discipline"), React.createElement("div", {
    className: "card"
  }, React.createElement("ul", {
    className: "bullet-list"
  }, React.createElement("li", null, React.createElement("span", null, "Tax year ends 28 February. Split disposals across 28 Feb + 1 March for two annual R40k CGT exclusions.")), React.createElement("li", null, React.createElement("span", null, "Combined shelter: up to R80k of gains untaxed per year.")), React.createElement("li", null, React.createElement("span", null, "At 40% marginal rate with 40% inclusion, each exclusion = ~R12,800 saved.")), React.createElement("li", null, React.createElement("span", null, "Keep broker IT3(c) certificates for each tax year.")))));
}
function OverviewView(_ref1) {
  let {
    prices
  } = _ref1;
  return React.createElement("div", null, React.createElement("div", {
    className: "grid grid-3"
  }, DATA.PILLARS.map(p => React.createElement("div", {
    key: p.num,
    className: "card"
  }, React.createElement("div", {
    className: "mono text-xs text-dim mb-3",
    style: {
      letterSpacing: '0.2em'
    }
  }, p.num), React.createElement("h3", {
    className: "serif font-bold mb-2",
    style: {
      fontSize: 20,
      lineHeight: 1.2
    }
  }, p.title), React.createElement("p", {
    className: "text-sm text-muted",
    style: {
      lineHeight: 1.6
    }
  }, p.body), React.createElement("div", {
    className: "mono text-xs text-dim mt-3",
    style: {
      paddingTop: 12,
      borderTop: '1px solid var(--border)',
      letterSpacing: '0.15em',
      textTransform: 'uppercase'
    }
  }, "\u2192 ", p.action)))), React.createElement("div", {
    className: "mt-6"
  }, React.createElement("div", {
    className: "eyebrow"
  }, "Live snapshot \u2014 key names"), React.createElement("div", {
    className: "grid grid-4"
  }, ['NVDA', 'GOOGL', 'C', 'ASML'].map(t => {
    const q = prices['US:' + t];
    const h = DATA.HOLDINGS.find(x => x.ticker === t);
    return React.createElement("div", {
      key: t,
      className: "pos-card"
    }, React.createElement("div", {
      className: "flex justify-between items-center mb-2"
    }, React.createElement("span", {
      className: "tkr-sm"
    }, t), React.createElement("span", {
      className: `pill pill-${h?.actionType || 'hold'}`
    }, h?.action.split(' ')[0] || 'HOLD')), React.createElement(PriceBlock, {
      quote: q
    }));
  }))));
}
function PriceChart(_refChart) {
  let { history, loading, range, onRangeChange, currency, quote } = _refChart;
  const [hover, setHover] = useState(null);
  const sym = ({ ZAR: 'R', GBP: '\u00a3', AUD: 'A$', EUR: '\u20ac' })[currency] || '$';
  const ranges = [
    { key: '1d', label: '1D' },
    { key: '5d', label: '1W' },
    { key: '1mo', label: '1M' },
    { key: '3mo', label: '3M' },
    { key: '6mo', label: '6M' },
    { key: '1y', label: '1Y' },
    { key: '5y', label: '5Y' },
    { key: 'max', label: 'Max' }
  ];
  const rangeBar = React.createElement("div", { className: "chart-ranges" },
    ranges.map(r => React.createElement("button", {
      key: r.key,
      className: `chart-range-btn ${range === r.key ? 'active' : ''}`,
      onClick: () => onRangeChange(r.key)
    }, r.label))
  );
  const rawPoints = history && history.data && history.data.points ? history.data.points : null;
  if (!rawPoints || rawPoints.length < 2) {
    const dataMissing = history && history.data === null && !loading;
    if (dataMissing) {
      return React.createElement("div", { className: "chart-block" }, rangeBar,
        React.createElement("div", { className: "chart-empty" }, 'Chart data unavailable'));
    }
    // Shimmer skeleton while the series loads \u2014 reads as a premium fintech app
    // instead of a bare "Loading\u2026" string.
    return React.createElement("div", { className: "chart-block" }, rangeBar,
      React.createElement("div", { className: "chart-skeleton" },
        React.createElement("div", { className: "chart-skeleton-line" }),
        React.createElement("div", { className: "chart-skeleton-shimmer" })
      )
    );
  }
  const is1d = range === '1d';
  // For the intraday view, the daily % must agree with the header (which is
  // measured from the previous close, not the first intraday bar). We draw a
  // dashed prev-close baseline and report the live quote's change verbatim, and
  // append the live price so the line ends exactly where the header sits.
  const baseline = is1d && quote && typeof quote.prevClose === 'number' && quote.prevClose > 0 ? quote.prevClose : null;
  let points = rawPoints;
  if (is1d && quote && typeof quote.price === 'number' && quote.price > 0) {
    const lastP = rawPoints[rawPoints.length - 1].p;
    if (Math.abs(lastP - quote.price) / quote.price > 0.0005) {
      points = [...rawPoints, { t: Date.now(), p: quote.price, session: rawPoints[rawPoints.length - 1].session || 'regular' }];
    }
  }
  const W = 600, H = 180;
  const PL = 2, PR = 2, PT = 6, PB = 6;
  const prs = points.map(p => p.p);
  let min = Math.min(...prs);
  let max = Math.max(...prs);
  if (baseline != null) { min = Math.min(min, baseline); max = Math.max(max, baseline); }
  const span = max - min || 1;
  const chartW = W - PL - PR;
  const chartH = H - PT - PB;
  const xFor = i => PL + (i / (points.length - 1)) * chartW;
  const yFor = p => PT + (1 - (p - min) / span) * chartH;
  const d = points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(2)},${yFor(pt.p).toFixed(2)}`).join(' ');
  const areaD = d + ` L${xFor(points.length - 1).toFixed(2)},${H - PB} L${PL},${H - PB} Z`;
  // Extended-hours segmentation — 1d only. We split the line so the pre-market
  // and after-hours portions read as dashed/translucent with shaded bands and a
  // labelled market-open divider, while the regular session stays solid.
  const hasExtHours = is1d && points.some(p => p.session && p.session !== 'regular');
  const hasRegular = hasExtHours && points.some(p => p.session === 'regular');
  const openIdx = hasRegular ? points.findIndex(p => p.session === 'regular') : -1;
  const postIdx = hasExtHours ? points.findIndex(p => p.session === 'post') : -1;
  const segPath = (i0, i1) => {
    if (i0 < 0 || i1 < i0) return '';
    let s = '';
    for (let i = i0; i <= i1; i++) s += (i === i0 ? 'M' : 'L') + xFor(i).toFixed(2) + ',' + yFor(points[i].p).toFixed(2) + ' ';
    return s.trim();
  };
  // allExt = the whole intraday line is extended-hours (e.g. viewing during the
  // pre-market session before the open) → draw the entire line dashed.
  const allExt = hasExtHours && !hasRegular;
  const hasPre = hasRegular && openIdx > 0;
  const hasPost = hasRegular && postIdx >= 0;
  const regStart = openIdx >= 0 ? openIdx : 0;
  const regEnd = postIdx >= 0 ? postIdx : points.length - 1;
  const preSegD = hasPre ? segPath(0, openIdx) : '';
  const regSegD = hasRegular ? segPath(regStart, regEnd) : '';
  const postSegD = hasPost ? segPath(postIdx, points.length - 1) : '';
  const openX = hasPre ? xFor(openIdx) : null;
  const postX = hasPost ? xFor(postIdx) : null;
  const hasPreBars = hasExtHours && points.some(p => p.session === 'pre');
  const hasPostBars = hasExtHours && points.some(p => p.session === 'post');
  const extColor = '#94a3b8';
  const first = points[0].p;
  const last = points[points.length - 1].p;
  // Daily move is anchored to prev close / live quote so it matches the header.
  const retPct = (is1d && quote && typeof quote.changePct === 'number') ? quote.changePct
    : (baseline != null ? (last - baseline) / baseline * 100
    : (first > 0 ? (last - first) / first * 100 : 0));
  const up = retPct >= 0;
  const color = up ? '#10b981' : '#f43f5e';
  const gradId = `grad-${up ? 'up' : 'down'}`;
  const onMove = e => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const x = (clientX - rect.left) / rect.width * W;
    if (x < PL || x > W - PR) { setHover(null); return; }
    const idx = Math.round((x - PL) / chartW * (points.length - 1));
    if (idx >= 0 && idx < points.length) setHover({ idx, x: xFor(idx), y: yFor(points[idx].p) });
  };
  const label = ranges.find(r => r.key === range)?.label || range;
  return React.createElement("div", { className: "chart-block" },
    rangeBar,
    React.createElement("div", { className: "chart-wrap" },
      React.createElement("svg", {
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: "none",
        className: "chart-svg",
        onMouseMove: onMove,
        onMouseLeave: () => setHover(null),
        onTouchStart: onMove,
        onTouchMove: onMove,
        onTouchEnd: () => setHover(null)
      },
        React.createElement("defs", null,
          React.createElement("linearGradient", { id: gradId, x1: "0", y1: "0", x2: "0", y2: "1" },
            React.createElement("stop", { offset: "0%", stopColor: color, stopOpacity: 0.3 }),
            React.createElement("stop", { offset: "100%", stopColor: color, stopOpacity: 0 })
          )
        ),
        React.createElement("path", { d: areaD, fill: `url(#${gradId})` }),
        hasPre && React.createElement("rect", {
          x: PL, y: PT, width: Math.max(0, openX - PL), height: chartH,
          fill: extColor, fillOpacity: 0.09
        }),
        hasPost && React.createElement("rect", {
          x: postX, y: PT, width: Math.max(0, (W - PR) - postX), height: chartH,
          fill: extColor, fillOpacity: 0.07
        }),
        baseline != null && React.createElement("line", {
          x1: PL, y1: yFor(baseline), x2: W - PR, y2: yFor(baseline),
          stroke: "#a1a1aa", strokeWidth: 0.5, strokeDasharray: "3,3", strokeOpacity: 0.6,
          vectorEffect: "non-scaling-stroke"
        }),
        hasPre && React.createElement("line", {
          x1: openX, y1: PT, x2: openX, y2: H - PB,
          stroke: extColor, strokeWidth: 1, strokeDasharray: "2,2", strokeOpacity: 0.9,
          vectorEffect: "non-scaling-stroke"
        }),
        // Extended-hours portions: dashed + translucent. Regular session: solid.
        hasExtHours
          ? React.createElement(React.Fragment, null,
              allExt && React.createElement("path", { d, fill: "none", stroke: extColor, strokeWidth: 1.5, strokeDasharray: "3,2.5", strokeOpacity: 0.9, vectorEffect: "non-scaling-stroke" }),
              preSegD && React.createElement("path", { d: preSegD, fill: "none", stroke: extColor, strokeWidth: 1.4, strokeDasharray: "3,2.5", strokeOpacity: 0.85, vectorEffect: "non-scaling-stroke" }),
              postSegD && React.createElement("path", { d: postSegD, fill: "none", stroke: extColor, strokeWidth: 1.4, strokeDasharray: "3,2.5", strokeOpacity: 0.85, vectorEffect: "non-scaling-stroke" }),
              regSegD && React.createElement("path", { d: regSegD, fill: "none", stroke: color, strokeWidth: 1.6, vectorEffect: "non-scaling-stroke" })
            )
          : React.createElement("path", { d, fill: "none", stroke: color, strokeWidth: 1.5, vectorEffect: "non-scaling-stroke" }),
        hover && React.createElement("g", null,
          React.createElement("line", { x1: hover.x, y1: PT, x2: hover.x, y2: H - PB, stroke: "#71717a", strokeWidth: 0.5, strokeDasharray: "2,2", vectorEffect: "non-scaling-stroke" }),
          React.createElement("circle", { cx: hover.x, cy: hover.y, r: 3.5, fill: color, style: { stroke: 'var(--bg)' }, strokeWidth: 1.2 })
        )
      ),
      hover && React.createElement("div", {
        className: "chart-tooltip",
        style: { left: `${(hover.x / W) * 100}%` }
      },
        React.createElement("div", { className: "mono" }, sym + points[hover.idx].p.toFixed(2)),
        React.createElement("div", { className: "chart-tooltip-date" }, (() => {
          const d = new Date(points[hover.idx].t);
          if (range === '1d') {
            return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
          }
          if (range === '5d') {
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' +
              d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
          }
          return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        })())
      ),
      hasPre && React.createElement("div", {
        className: "chart-open-tag",
        style: { left: `${(openX / W) * 100}%` }
      }, "OPEN")
    ),
    hasExtHours && React.createElement("div", { className: "chart-session-legend" },
      hasPreBars && React.createElement("span", { className: "chart-session-item" },
        React.createElement("span", { className: "chart-session-swatch pre" }), "Pre-market"),
      hasPostBars && React.createElement("span", { className: "chart-session-item" },
        React.createElement("span", { className: "chart-session-swatch pre" }), "After-hours"),
      hasRegular && React.createElement("span", { className: "chart-session-item" },
        React.createElement("span", { className: "chart-session-swatch reg", style: { borderTopColor: color } }), "Regular session")
    ),
    React.createElement("div", { className: "chart-summary" },
      React.createElement("div", null,
        React.createElement("span", { className: "chart-sum-label" }, label + ' return'),
        React.createElement("span", { className: `chart-sum-val mono ${up ? 'text-up' : 'text-down'}` },
          (up ? '+' : '') + retPct.toFixed(2) + '%'
        )
      ),
      React.createElement("div", { className: "chart-range-stats" },
        React.createElement("span", { className: "chart-sum-label" }, 'High'),
        React.createElement("span", { className: "mono" }, sym + max.toFixed(2)),
        React.createElement("span", { className: "chart-sum-label", style: { marginLeft: 10 } }, 'Low'),
        React.createElement("span", { className: "mono" }, sym + min.toFixed(2))
      )
    )
  );
}
function fmtLarge(n) {
  if (n == null || !isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
function fmtPct(n, digits = 2) {
  if (n == null || !isFinite(n)) return null;
  return (n >= 0 ? '' : '') + n.toFixed(digits) + '%';
}
function EarningsBadge(_refEB) {
  let { fundamentals } = _refEB;
  const f = fundamentals?.data;
  if (!f || !f.earningsDate) return null;
  const now = Date.now();
  const d = new Date(f.earningsDate);
  const end = f.earningsDateEnd ? new Date(f.earningsDateEnd) : null;
  const endMs = end ? end.getTime() : f.earningsDate;
  if (endMs < now - 24 * 3600 * 1000) return null;
  const days = Math.round((f.earningsDate - now) / (24 * 3600 * 1000));
  const isPast = f.earningsDate < now && endMs >= now;
  const dateLabel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const rangeLabel = end && end.toDateString() !== d.toDateString()
    ? dateLabel + ' – ' + end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : dateLabel;
  let when;
  if (isPast) when = 'Reporting window';
  else if (days <= 0) when = 'Today';
  else if (days === 1) when = 'Tomorrow';
  else if (days <= 7) when = 'In ' + days + ' days';
  else when = 'In ' + days + ' days';
  const urgent = days <= 7 && !isPast;
  return React.createElement("div", { className: `earnings-badge${urgent ? ' urgent' : ''}` },
    React.createElement("div", { className: "earnings-icon" },
      React.createElement(Icon, { name: "alert", size: 14 })
    ),
    React.createElement("div", { className: "earnings-body" },
      React.createElement("div", { className: "earnings-title" }, "Upcoming earnings"),
      React.createElement("div", { className: "earnings-date" }, rangeLabel, " · ", when)
    ),
    f.epsEst != null && React.createElement("div", { className: "earnings-est" },
      React.createElement("div", { className: "earnings-est-label" }, "EPS est."),
      React.createElement("div", { className: "mono earnings-est-val" }, f.epsEst.toFixed(2))
    )
  );
}
// Representative sector forward P/E benchmarks (broad-market estimates, early
// 2026). Used as the "Industry fwd P/E" comparator when a live per-industry
// figure isn't available (no free CORS source provides one without a key).
const SECTOR_FWD_PE = {
  'technology': 27, 'information technology': 27,
  'communication services': 19, 'communications': 19,
  'consumer cyclical': 22, 'consumer discretionary': 22,
  'consumer defensive': 19, 'consumer staples': 19,
  'healthcare': 17, 'health care': 17,
  'financial services': 15, 'financials': 15, 'financial': 15,
  'industrials': 20, 'industrial': 20,
  'energy': 12,
  'basic materials': 16, 'materials': 16,
  'real estate': 18,
  'utilities': 17,
};
function sectorForwardPE(sector) {
  if (!sector) return null;
  const v = SECTOR_FWD_PE[String(sector).trim().toLowerCase()];
  return (typeof v === 'number') ? v : null;
}
// Convert a Yahoo currency code (e.g. ZAc, GBp, USD) to its 3-letter base.
function baseCurrency(code, market) {
  const c = (code || '').toUpperCase();
  if (c.startsWith('ZA')) return 'ZAR';
  if (c.startsWith('GB')) return 'GBP';
  if (c.startsWith('AU')) return 'AUD';
  if (c.startsWith('EU') || c === 'EUR') return 'EUR';
  if (c === 'USD' || c === 'USC') return 'USD';
  if (c.length === 3) return c;
  return (MARKET_CURRENCY[market]?.code) || 'USD';
}
function FundamentalsBlock(_refFB) {
  let { fundamentals, quote, market, fxRates } = _refFB;
  const loading = fundamentals && fundamentals.loading && !fundamentals.data;
  const f = fundamentals?.data || {};
  const cur = quote?.price && quote.price > 0 ? quote.price : null;
  const ccySym = ({ ZAR: 'R', GBP: '\u00a3', AUD: 'A$', EUR: '\u20ac' })[quote?.currency] || '$';
  const nativeCode = baseCurrency(f.currency || quote?.currency, market);
  // Market cap normalised to USD (FX base is USD: rates[code] = units per 1 USD).
  let mcapUsd = null;
  if (f.marketCap != null && isFinite(f.marketCap)) {
    if (nativeCode === 'USD') mcapUsd = f.marketCap;
    else { const rate = fxRates?.rates?.[nativeCode]; if (rate) mcapUsd = f.marketCap / rate; }
  }
  const quarterLabel = (() => {
    const ms = f.mostRecentQuarter || f.lastFiscalYearEnd;
    return ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : null;
  })();
  const signed = (n, d = 1) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
  const tone = (n) => n >= 0 ? 'text-up' : 'text-down';
  // \u2500\u2500 Headline analytics (the metrics the user explicitly tracks) \u2500\u2500
  const headline = [];
  const hpush = (label, value, opts) => { if (value != null) headline.push({ label, value, ...(opts || {}) }); };
  if (f.peTrailing != null) hpush('P/E (TTM)', f.peTrailing.toFixed(2), { sub: quarterLabel ? 'Q ended ' + quarterLabel : null });
  if (f.peForward != null) hpush('Forward P/E', f.peForward.toFixed(2));
  if (mcapUsd != null) { const m = fmtLarge(mcapUsd); if (m) hpush('Market cap', '$' + m, { sub: nativeCode !== 'USD' ? 'USD' : null }); }
  if (f.debtToEquity != null) hpush('Debt / equity', (f.debtToEquity / 100).toFixed(2));
  if (f.freeCashflow != null) { const v = fmtLarge(f.freeCashflow); if (v) hpush('Free cash flow', ccySym + v, { cls: f.freeCashflow >= 0 ? 'text-up' : 'text-down' }); }
  if (f.profitMargin != null) hpush('Profit margin', f.profitMargin.toFixed(1) + '%', { cls: tone(f.profitMargin) });
  if (f.earningsGrowth != null) hpush('Profit growth', signed(f.earningsGrowth), { cls: tone(f.earningsGrowth), sub: 'YoY net income' });
  if (f.revenue != null) { const r = fmtLarge(f.revenue); if (r) hpush('Revenue', ccySym + r, { sub: 'TTM' }); }
  if (f.revenueGrowth != null) hpush('Revenue growth', signed(f.revenueGrowth), { cls: tone(f.revenueGrowth), sub: 'YoY' });
  const headlineKeys = new Set(['P/E (TTM)', 'Forward P/E', 'Market cap', 'Debt / equity', 'Free cash flow', 'Profit margin', 'Profit growth', 'Revenue', 'Revenue growth']);
  const stats = [];
  const push = (label, value, sub) => {
    if (value == null || value === '' || (typeof value === 'number' && !isFinite(value))) return;
    if (headlineKeys.has(label)) return;
    stats.push({ label, value, sub });
  };
  const yearHigh = f.yearHigh || quote?.yearHigh;
  const yearLow = f.yearLow || quote?.yearLow;
  if (f.eps != null) push('EPS (TTM)', ccySym + f.eps.toFixed(2));
  if (f.dividendYield != null) push('Dividend yield', f.dividendYield.toFixed(2) + '%');
  if (f.bookValue != null) push('NAV / share', ccySym + f.bookValue.toFixed(2));
  if (f.bookValue != null && cur != null && f.bookValue > 0) {
    const diff = (cur - f.bookValue) / f.bookValue * 100;
    const prem = diff >= 0;
    push(prem ? 'NAV premium' : 'NAV discount', (prem ? '+' : '') + diff.toFixed(1) + '%');
  } else if (f.priceToBook != null) {
    const diff = (f.priceToBook - 1) * 100;
    const prem = diff >= 0;
    push(prem ? 'NAV premium' : 'NAV discount', (prem ? '+' : '') + diff.toFixed(1) + '%');
  }
  if (f.pegRatio != null) push('PEG', f.pegRatio.toFixed(2));
  if (f.priceToBook != null) push('P/B', f.priceToBook.toFixed(2));
  if (f.priceToSales != null) push('P/S', f.priceToSales.toFixed(2));
  if (f.beta != null) push('Beta', f.beta.toFixed(2));
  if (f.operatingMargin != null) push('Op margin', f.operatingMargin.toFixed(1) + '%');
  if (f.roe != null) push('ROE', f.roe.toFixed(1) + '%');
  if (f.currentRatio != null) push('Current ratio', f.currentRatio.toFixed(2));
  if (f.ebitda != null) { const e = fmtLarge(f.ebitda); if (e) push('EBITDA', ccySym + e); }
  if (quote?.dayHigh != null && quote?.dayLow != null) {
    push("Day range", ccySym + quote.dayLow.toFixed(2) + ' – ' + ccySym + quote.dayHigh.toFixed(2));
  }
  if (yearHigh != null && yearLow != null) {
    push("52W range", ccySym + yearLow.toFixed(2) + ' – ' + ccySym + yearHigh.toFixed(2));
  }
  if (quote?.volume != null) { const v = fmtLarge(quote.volume); if (v) push('Volume', v); }
  if (f.avgVolume != null) { const v = fmtLarge(f.avgVolume); if (v) push('Avg volume', v); }
  const targetSection = f.targetMean ? React.createElement("div", { className: "analyst-card" },
    React.createElement("div", { className: "eyebrow" }, "Analyst targets", f.analystCount ? ' · ' + f.analystCount + ' analysts' : ''),
    React.createElement("div", { className: "analyst-row" },
      React.createElement("div", null,
        React.createElement("div", { className: "analyst-label" }, "Mean target"),
        React.createElement("div", { className: "mono analyst-val" }, fmt(f.targetMean, market))
      ),
      cur && React.createElement("div", null,
        React.createElement("div", { className: "analyst-label" }, "Upside"),
        React.createElement("div", { className: `mono analyst-val ${f.targetMean > cur ? 'text-up' : 'text-down'}` },
          ((f.targetMean - cur) / cur * 100).toFixed(1) + '%'
        )
      ),
      f.recommendation && React.createElement("div", null,
        React.createElement("div", { className: "analyst-label" }, "Consensus"),
        React.createElement("div", { className: `mono analyst-val rec-${f.recommendation}` }, f.recommendation.replace('_', ' '))
      )
    ),
    (f.targetLow != null && f.targetHigh != null) && React.createElement("div", { className: "analyst-range" },
      React.createElement("span", { className: "analyst-range-label" }, "Range"),
      React.createElement("span", { className: "mono" }, fmt(f.targetLow, market), " – ", fmt(f.targetHigh, market))
    )
  ) : null;
  const sectorRow = (f.sector || f.industry) ? React.createElement("div", { className: "sector-row" },
    f.sector && React.createElement("span", { className: "sector-chip" }, f.sector),
    f.industry && React.createElement("span", { className: "sector-chip muted" }, f.industry)
  ) : null;
  const ai = f.source === 'perplexity';
  const empty = !loading && headline.length === 0 && stats.length === 0 && !targetSection && !sectorRow;
  return React.createElement("div", { className: "fundamentals-block" },
    React.createElement("div", { className: "eyebrow", style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      React.createElement("span", null, "Key stats & ratios"),
      ai && React.createElement("span", { className: "news-ai-badge" }, "AI"),
      loading && React.createElement("span", { className: "text-xs" }, "Loading\u2026")
    ),
    sectorRow,
    headline.length > 0 && React.createElement("div", { className: "fundamentals-grid headline" },
      headline.map((s, i) => React.createElement("div", { key: 'h' + i, className: "fund-cell" },
        React.createElement("div", { className: "fund-label" }, s.label),
        React.createElement("div", { className: "fund-val mono" + (s.cls ? ' ' + s.cls : '') }, s.value),
        s.sub ? React.createElement("div", { className: "fund-sub" }, s.sub) : null
      ))
    ),
    stats.length > 0 && React.createElement("div", { className: "fundamentals-grid" },
      stats.map((s, i) => React.createElement("div", { key: i, className: "fund-cell" },
        React.createElement("div", { className: "fund-label" }, s.label),
        React.createElement("div", { className: "fund-val mono" }, s.value)
      ))
    ),
    targetSection,
    empty && React.createElement("div", { className: "fundamentals-empty" },
      "Fundamentals unavailable. Yahoo blocks this data without auth — add a Perplexity API key in the Alerts panel to fetch AI-sourced fundamentals as a fallback."
    )
  );
}
function DetailModal(_ref10) {
  let {
    selected,
    prices,
    positions,
    alerts,
    news,
    historyByTicker,
    fundamentals,
    fxRates,
    onClose,
    onAddAlert,
    onRemoveAlert,
    onLoadNews,
    onLoadHistory
  } = _ref10;
  const {
    ticker,
    market
  } = selected;
  const info = DATA.findInfo(ticker, market);
  const liveQuote = prices[priceKey(market, ticker)];
  // Stocks opened from the heatmap / picks aren't in the main price feed, so
  // fetch their quote on demand — this gives the detail its price, change and
  // company name instead of just a bare ticker.
  const [fetchedQuote, setFetchedQuote] = useState(null);
  useEffect(() => {
    setFetchedQuote(null);
    if (!liveQuote) {
      let alive = true;
      fetchQuote(ticker, market).then(q => { if (alive && q) setFetchedQuote(q); });
      return () => { alive = false; };
    }
  }, [ticker, market]);
  const quote = liveQuote || fetchedQuote;
  const displayName = resolveTickerName(ticker, market, quote) || null;
  const ccy = market === 'JSE' ? 'ZAR' : 'USD';
  const pos = positions ? positions.find(p => p.ticker === ticker && p.market === market) : null;
  const [dir, setDir] = useState('above');
  const [target, setTarget] = useState(quote ? quote.price.toFixed(2) : '');
  const [note, setNote] = useState('');
  const [range, setRange] = useState('1y');
  const [showAlertForm, setShowAlertForm] = useState(!!selected.openAlerts);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const history = historyByTicker ? historyByTicker[priceKey(market, ticker) + ':' + range] : null;
  useEffect(() => {
    if (quote && !target) setTarget(quote.price.toFixed(2));
  }, [quote]);
  useEffect(() => {
    if (onLoadHistory) onLoadHistory(range);
  }, [range]);
  const submitAlert = () => {
    const t = parseDecimal(target);
    if (!isFinite(t) || t <= 0) return;
    onAddAlert(ticker, market, dir, t, note);
    setNote('');
  };
  return React.createElement("div", {
    className: "modal",
    onClick: e => {
      if (e.target.classList.contains('modal')) onClose();
    }
  }, React.createElement("div", {
    className: "modal-backdrop",
    onClick: onClose
  }), React.createElement("div", {
    className: "modal-panel",
    ref: panelRef
  }, React.createElement("div", {
    className: "modal-handle"
  }), React.createElement("div", {
    className: "modal-header"
  }, React.createElement("div", { style: { minWidth: 0 } }, React.createElement("div", {
    className: "modal-title"
  }, ticker), React.createElement("div", {
    className: "modal-subtitle"
  }, displayName ? React.createElement(React.Fragment, null, displayName, " \xB7 ") : null, React.createElement("span", {
    className: "market-badge"
  }, market))), React.createElement("button", {
    className: "modal-close",
    onClick: onClose,
    "aria-label": "Close"
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "modal-body"
  }, 
    React.createElement("div", { style: { position: 'relative' } },
      React.createElement(PriceBlock, { quote: quote, size: "xl", showDailyRow: true }),
      React.createElement("button", {
        className: "detail-alert-bell",
        onClick: () => setShowAlertForm(f => !f),
        "aria-label": "Price alerts"
      }, React.createElement(Icon, { name: "bell", size: 16 }),
        alerts.length > 0 && React.createElement("span", { className: "detail-alert-count" }, alerts.length))
    ),

    pos && quote && React.createElement("div", { className: "holding-card" },
      React.createElement("div", { className: "eyebrow" }, "Your position"),
      React.createElement("div", { className: "kv-row" },
        React.createElement("div", { className: "kv" },
          React.createElement("div", { className: "kv-label" }, "Shares"),
          React.createElement("div", { className: "kv-val mono" }, pos.shares)
        ),
        React.createElement("div", { className: "kv" },
          React.createElement("div", { className: "kv-label" }, "Avg price"),
          React.createElement("div", { className: "kv-val mono" }, fmt(pos.costBasis, market))
        ),
        React.createElement("div", { className: "kv" },
          React.createElement("div", { className: "kv-label" }, "Current"),
          React.createElement("div", { className: "kv-val mono" }, fmt(quote.price, market))
        )
      ),
      React.createElement("div", { className: "kv-row" },
        React.createElement("div", { className: "kv" },
          React.createElement("div", { className: "kv-label" }, "Market value"),
          React.createElement("div", { className: "kv-val mono" }, fmt(pos.shares * quote.price, market))
        ),
        React.createElement("div", { className: "kv" },
          React.createElement("div", { className: "kv-label" }, "Cost basis"),
          React.createElement("div", { className: "kv-val mono" }, fmt(pos.shares * pos.costBasis, market))
        ),
        React.createElement("div", { className: "kv" },
          React.createElement("div", { className: "kv-label" }, "P&L"),
          (() => {
            const pl = (quote.price - pos.costBasis) * pos.shares;
            const plPct = pos.costBasis > 0 ? ((quote.price - pos.costBasis) / pos.costBasis * 100) : 0;
            return React.createElement("div", { className: `kv-val mono ${pl >= 0 ? 'text-up' : 'text-down'}` },
              fmtCcySigned(pl, ccy), " (", plPct >= 0 ? '+' : '', plPct.toFixed(1), "%)");
          })()
        )
      )
    ),

    quote && quote.yearHigh ? React.createElement("div", {
      className: "ath-strip"
    }, React.createElement("span", { className: "eyebrow" }, "52W High"),
      React.createElement("span", { className: "mono" }, fmt(quote.yearHigh, market)),
      React.createElement("span", {
        className: `mono ${quote.price >= quote.yearHigh * 0.995 ? 'text-up' : 'text-muted'}`
      }, quote.price >= quote.yearHigh * 0.995 ? 'At high' : ((quote.price - quote.yearHigh) / quote.yearHigh * 100).toFixed(2) + '%')) : null,
    React.createElement(EarningsBadge, { fundamentals: fundamentals }),
    React.createElement(PriceChart, {
      history: history, loading: history?.loading,
      range: range, onRangeChange: setRange,
      currency: quote?.currency || ccy,
      quote: quote
    }),
    React.createElement(FundamentalsBlock, { fundamentals: fundamentals, quote: quote, market: market, fxRates: fxRates }),

    showAlertForm && React.createElement("div", null,
      React.createElement("div", { className: "eyebrow", style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        React.createElement("span", null, "Price alerts"),
        React.createElement("span", { className: "text-xs" }, alerts.length, " active")),
      alerts.length > 0 && React.createElement("div", {
        style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }
      }, alerts.map(a => React.createElement("div", {
        key: a.id, className: "alert-item"
      }, React.createElement("div", null,
        React.createElement("div", { className: "mono text-sm" },
          a.direction === 'above' ? '↑ above ' : '↓ below ', fmt(a.targetPrice, market)),
        a.note && React.createElement("div", { className: "text-xs text-dim mt-1" }, a.note)),
        React.createElement("button", {
          className: "btn btn-ghost btn-xs",
          onClick: () => onRemoveAlert(a.id), "aria-label": "Remove"
        }, React.createElement(Icon, { name: "x", size: 12 }))))),
      React.createElement("div", { className: "card alert-form" },
        React.createElement("div", { className: "alert-dir-group", role: "radiogroup", "aria-label": "Trigger direction" },
          React.createElement("button", {
            type: "button", role: "radio", "aria-checked": dir === 'above',
            className: `alert-dir-btn up ${dir === 'above' ? 'active' : ''}`,
            onClick: () => setDir('above')
          }, React.createElement("span", { className: "alert-dir-arrow" }, "↑"),
            React.createElement("span", { className: "alert-dir-label" }, "Above")),
          React.createElement("button", {
            type: "button", role: "radio", "aria-checked": dir === 'below',
            className: `alert-dir-btn down ${dir === 'below' ? 'active' : ''}`,
            onClick: () => setDir('below')
          }, React.createElement("span", { className: "alert-dir-arrow" }, "↓"),
            React.createElement("span", { className: "alert-dir-label" }, "Below"))
        ),
        React.createElement("div", { className: "alert-target-row" },
          React.createElement("div", { className: "input-prefix-wrap alert-target-wrap" },
            React.createElement("span", { className: "prefix" }, ccy === 'ZAR' ? 'R' : '$'),
            React.createElement("input", {
              type: "text", inputMode: "decimal",
              autoComplete: "off", autoCorrect: "off", spellCheck: false,
              placeholder: "Target price", value: target,
              onChange: e => setTarget(sanitizeDecimalInput(e.target.value)),
              className: "alert-target-input"
            })
          )
        ),
        React.createElement("input", {
          type: "text", placeholder: "Note (optional)",
          value: note, onChange: e => setNote(e.target.value),
          maxLength: "80", className: "alert-note-input"
        }),
        React.createElement("button", {
          className: `btn btn-block mt-3 alert-submit ${dir === 'above' ? 'up' : 'down'}`,
          onClick: submitAlert
        }, React.createElement(Icon, { name: "plus" }),
          " Alert when ", dir === 'above' ? 'above ' : 'below ',
          target && isFinite(parseDecimal(target)) ? (ccy === 'ZAR' ? 'R' : '$') + parseDecimal(target).toFixed(2) : 'target')
      )
    ),

    React.createElement("div", null, React.createElement("div", {
      className: "eyebrow",
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
    }, React.createElement("span", null, "News"), news?.loading && React.createElement("span", {
      className: "text-xs"
    }, "Loading…")), news && news.data && news.data.length > 0 ? React.createElement("div", null, news.data.map((n, i) => React.createElement("a", {
      key: i,
      href: n.link && n.link !== '#' ? n.link : undefined,
      target: "_blank", rel: "noopener",
      className: `news-item${n.ai ? ' news-item-ai' : ''}`
    }, React.createElement("div", { className: "news-title" },
      n.ai && React.createElement("span", { className: "news-ai-badge" }, "AI"), n.title),
      n.summary && React.createElement("div", { className: "news-summary" }, n.summary),
      React.createElement("div", { className: "news-meta" },
        React.createElement("span", null, n.source),
        n.pubDate && React.createElement(React.Fragment, null,
          React.createElement("span", null, "·"),
          React.createElement("span", null, timeAgo(n.pubDate))),
        React.createElement(Icon, { name: "external", size: 11 }))))) : React.createElement("div", {
      className: "text-sm text-dim"
    }, news?.loading ? 'Fetching headlines…' : 'No recent headlines found. Yahoo Finance RSS may be rate-limited — try again later.')))));
}
function AlertsModal(_ref11) {
  let {
    alerts,
    triggered,
    notifPerm,
    perplexityKey,
    onSetPerplexityKey,
    onClose,
    onRemoveAlert,
    onClearTriggered,
    onRequestPerm
  } = _ref11;
  const [pkDraft, setPkDraft] = useState(perplexityKey || '');
  const [pkReveal, setPkReveal] = useState(false);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  useEffect(() => { setPkDraft(perplexityKey || ''); }, [perplexityKey]);
  const savePk = () => {
    const v = pkDraft.trim();
    onSetPerplexityKey(v);
  };
  const clearPk = () => {
    setPkDraft('');
    onSetPerplexityKey('');
  };
  const pkConfigured = !!perplexityKey;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const iOSNeedsInstall = isIOS && !standalone;
  const recentTriggered = triggered.slice(0, 30);
  return React.createElement("div", {
    className: "modal"
  }, React.createElement("div", {
    className: "modal-backdrop",
    onClick: onClose
  }), React.createElement("div", {
    className: "modal-panel",
    ref: panelRef
  }, React.createElement("div", {
    className: "modal-handle"
  }), React.createElement("div", {
    className: "modal-header"
  }, React.createElement("div", null, React.createElement("div", {
    className: "modal-title"
  }, "Alerts"), React.createElement("div", {
    className: "modal-subtitle"
  }, "Price triggers \xB7 triggered history")), React.createElement("button", {
    className: "modal-close",
    onClick: onClose,
    "aria-label": "Close"
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "modal-body"
  }, iOSNeedsInstall ? React.createElement("div", {
    className: "perm-box warn"
  }, React.createElement("div", {
    className: "perm-title"
  }, React.createElement(Icon, {
    name: "alert",
    size: 14
  }), " iOS: install to Home Screen first"), React.createElement("div", {
    className: "perm-body"
  }, "iPhone notifications only work from a home-screen-installed PWA (iOS 16.4+). Tap the Share button in Safari, then \"Add to Home Screen\", then reopen from the home screen and enable notifications.")) : notifPerm === 'default' ? React.createElement("div", {
    className: "perm-box"
  }, React.createElement("div", {
    className: "perm-title"
  }, React.createElement(Icon, {
    name: "bell",
    size: 14
  }), " Enable notifications"), React.createElement("div", {
    className: "perm-body"
  }, "Get a push when a price crosses your target. In-app alerts also fire as toasts while the app is open."), React.createElement("button", {
    className: "btn btn-primary",
    onClick: onRequestPerm
  }, React.createElement(Icon, {
    name: "bell"
  }), " Enable notifications")) : notifPerm === 'granted' ? React.createElement("div", {
    className: "perm-box ok"
  }, React.createElement("div", {
    className: "perm-title"
  }, React.createElement(Icon, {
    name: "checkCircle",
    size: 14
  }), " Notifications enabled"), React.createElement("div", {
    className: "perm-body"
  }, "Alerts fire while the app is open, and in the background when it's installed to your home screen — Android/Chrome checks your alerts periodically even when the app is closed. On iPhone, background checks aren't supported, so keep the app recently used for lock-screen delivery.")) : notifPerm === 'denied' ? React.createElement("div", {
    className: "perm-box err"
  }, React.createElement("div", {
    className: "perm-title"
  }, React.createElement(Icon, {
    name: "x",
    size: 14
  }), " Notifications blocked"), React.createElement("div", {
    className: "perm-body"
  }, "You previously blocked notifications. Re-enable in Settings \u2192 Notifications \u2192 Playbook (or Safari).")) : React.createElement("div", {
    className: "perm-box warn"
  }, React.createElement("div", {
    className: "perm-title"
  }, "Notifications not supported"), React.createElement("div", {
    className: "perm-body"
  }, "This browser doesn't support web notifications. Alerts will still show as in-app toasts.")),
    React.createElement("div", { className: `perm-box ${pkConfigured ? 'ok' : ''}` },
      React.createElement("div", { className: "perm-title" },
        React.createElement(Icon, { name: pkConfigured ? "checkCircle" : "bell", size: 14 }),
        " AI news (Perplexity)", pkConfigured ? " · configured" : ""
      ),
      React.createElement("div", { className: "perm-body" },
        pkConfigured
          ? "Perplexity is fetching relevant headlines alongside Yahoo Finance RSS. Paste a new key to replace it, or clear to disable."
          : "Paste a Perplexity API key to pull AI-curated headlines alongside Yahoo Finance RSS. The key is stored locally in your browser."
      ),
      React.createElement("div", { className: "pk-row" },
        React.createElement("input", {
          type: pkReveal ? "text" : "password",
          autoComplete: "off",
          spellCheck: false,
          placeholder: "pplx-…",
          value: pkDraft,
          onChange: e => setPkDraft(e.target.value),
          className: "pk-input"
        }),
        React.createElement("button", {
          className: "btn btn-ghost btn-xs",
          type: "button",
          onClick: () => setPkReveal(v => !v),
          "aria-label": pkReveal ? "Hide key" : "Reveal key"
        }, pkReveal ? "Hide" : "Show")
      ),
      React.createElement("div", { className: "pk-actions" },
        React.createElement("button", {
          className: "btn btn-primary btn-xs",
          type: "button",
          disabled: pkDraft.trim() === (perplexityKey || ''),
          onClick: savePk
        }, pkConfigured ? "Update key" : "Save key"),
        pkConfigured && React.createElement("button", {
          className: "btn btn-ghost btn-xs",
          type: "button",
          onClick: clearPk
        }, "Remove")
      )
    ),
    React.createElement("div", null, React.createElement("div", {
    className: "eyebrow",
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, React.createElement("span", null, "Triggered (", triggered.length, ")"), triggered.length > 0 && React.createElement("button", {
    className: "btn btn-ghost btn-xs",
    onClick: () => {
      if (confirm('Clear all triggered history?')) onClearTriggered();
    }
  }, "Clear all")), triggered.length === 0 ? React.createElement("div", {
    className: "text-sm text-dim"
  }, "No alerts have triggered yet.") : React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, recentTriggered.map(t => React.createElement("div", {
    key: t.id,
    className: "alert-item"
  }, React.createElement("div", null, React.createElement("div", null, React.createElement("span", {
    className: "tkr-sm"
  }, t.ticker), " ", React.createElement("span", {
    className: "market-badge"
  }, t.market), " ", React.createElement("span", {
    className: "mono text-sm"
  }, t.direction === 'above' ? '↑ ' : '↓ ', fmt(t.targetPrice, t.market))), React.createElement("div", {
    className: "text-xs text-dim mt-1"
  }, timeAgo(t.triggeredAt), " \xB7 hit at ", fmt(t.triggerPrice, t.market))))))), React.createElement("div", null, React.createElement("div", {
    className: "eyebrow"
  }, "Active (", alerts.length, ")"), alerts.length === 0 ? React.createElement("div", {
    className: "text-sm text-dim"
  }, "No active alerts. Tap any ticker to set one.") : React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, alerts.map(a => React.createElement("div", {
    key: a.id,
    className: "alert-item"
  }, React.createElement("div", null, React.createElement("div", null, React.createElement("span", {
    className: "tkr-sm"
  }, a.ticker), " ", React.createElement("span", {
    className: "market-badge"
  }, a.market)), React.createElement("div", {
    className: "mono text-sm"
  }, a.direction === 'above' ? '↑ above ' : '↓ below ', fmt(a.targetPrice, a.market)), a.note && React.createElement("div", {
    className: "text-xs text-dim mt-1"
  }, a.note)), React.createElement("button", {
    className: "btn btn-ghost btn-xs",
    onClick: () => onRemoveAlert(a.id),
    "aria-label": "Remove"
  }, React.createElement(Icon, {
    name: "x",
    size: 12
  })))))))));
}
function ContributionModal({ onClose, onSave, onOpenImport }) {
  const [flow, setFlow] = useState('deposit'); // 'deposit' | 'withdraw'
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const isWithdraw = flow === 'withdraw';
  const submit = () => {
    const a = parseDecimal(amount);
    if (!isFinite(a) || a <= 0) return;
    // Withdrawals are stored as negative cash flows so the contribution history
    // and overall-return maths net them out automatically.
    onSave(isWithdraw ? -a : a, currency, date, note);
  };
  const ccy = currency === 'ZAR' ? 'R' : '$';
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel", style: { maxWidth: 420 }, ref: panelRef },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, isWithdraw ? "Log withdrawal" : "Log deposit"),
          React.createElement("div", { className: "modal-subtitle" }, isWithdraw ? "Record cash taken out of your portfolio" : "Record cash deposited from outside your portfolio")
        ),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" })
        )
      ),
      React.createElement("div", { className: "modal-body" },
        React.createElement("div", { className: "flow-toggle" },
          React.createElement("button", {
            type: "button", className: "flow-toggle-btn" + (!isWithdraw ? " active deposit" : ""),
            onClick: () => setFlow('deposit')
          }, React.createElement(Icon, { name: "plus", size: 12 }), "Deposit"),
          React.createElement("button", {
            type: "button", className: "flow-toggle-btn" + (isWithdraw ? " active withdraw" : ""),
            onClick: () => setFlow('withdraw')
          }, React.createElement(Icon, { name: "minus", size: 12 }), "Withdrawal")
        ),
        onOpenImport ? React.createElement("button", {
          className: "contrib-import-link", type: "button",
          onClick: () => { onClose(); onOpenImport(); }
        }, React.createElement(Icon, { name: "download", size: 12 }), "Import deposits & withdrawals from a file or list") : null,
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Currency"),
          React.createElement("select", { value: currency, onChange: e => setCurrency(e.target.value) },
            React.createElement("option", { value: "USD" }, "USD ($)"),
            React.createElement("option", { value: "ZAR" }, "ZAR (R)"),
            React.createElement("option", { value: "GBP" }, "GBP (\u00a3)"),
            React.createElement("option", { value: "AUD" }, "AUD (A$)"),
            React.createElement("option", { value: "EUR" }, "EUR (\u20ac)")
          )
        ),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Amount"),
          React.createElement("div", { className: "input-prefix-wrap" },
            React.createElement("span", { className: "prefix" }, ccy),
            React.createElement("input", {
              type: "text", inputMode: "decimal",
              autoComplete: "off", autoCorrect: "off", spellCheck: false,
              placeholder: "0.00", value: amount,
              onChange: e => setAmount(sanitizeDecimalInput(e.target.value)),
              autoFocus: true,
              onKeyDown: e => { if (e.key === 'Enter') submit(); }
            })
          )
        ),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Date"),
          React.createElement("input", { type: "date", value: date, onChange: e => setDate(e.target.value) })
        ),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Note (optional)"),
          React.createElement("input", {
            type: "text", placeholder: "e.g. Monthly DCA, bonus deposit",
            value: note, onChange: e => setNote(e.target.value), maxLength: 100
          })
        ),
        React.createElement("div", { className: "form-actions" },
          React.createElement("button", { className: "btn btn-ghost", onClick: onClose }, "Cancel"),
          React.createElement("button", { className: "btn btn-primary", onClick: submit }, isWithdraw ? "Add withdrawal" : "Add deposit")
        )
      )
    )
  );
}
// Import a batch of deposits / withdrawals from pasted text or a CSV/XLSX file.
// Two stages: paste/drop → an editable review table where each dated amount can
// be flipped between deposit and withdrawal and re-currencied before committing.
function ContributionImportModal({ onClose, onImport }) {
  const [stage, setStage] = useState('input'); // 'input' | 'review'
  const [rows, setRows] = useState([]);
  const [pasteText, setPasteText] = useState('');
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [defaultCurrency, setDefaultCurrency] = useState('USD');
  const fileRef = useRef(null);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, () => { if (stage === 'input') onClose(); });
  useBodyScrollLock();

  const toRows = (flows) => flows.map(f => ({
    id: uid(),
    date: f.date || '',
    amount: f.amount != null ? String(Math.abs(f.amount)) : '',
    type: ((f.amount != null && f.amount < 0) || f.type === 'withdrawal') ? 'withdrawal' : 'deposit',
    currency: f.currency || defaultCurrency,
    note: f.note || '',
    include: true
  }));
  const handleParsed = (flows) => {
    if (!flows || flows.length === 0) {
      setParseError("Couldn't find any dated amounts. Paste rows like “2026-01-15, 1000” or “15 Jan 2026, 500, withdrawal”.");
      return;
    }
    setRows(toRows(flows));
    setStage('review');
    setParseError('');
  };
  const handlePaste = () => {
    if (!pasteText.trim()) return;
    setParsing(true); setParseError('');
    try { handleParsed(parseCashFlowsFromText(pasteText)); }
    catch (e) { setParseError('Could not parse that text.'); }
    finally { setParsing(false); }
  };
  const handleFiles = async (files) => {
    const file = files && files[0];
    if (!file) return;
    setParsing(true); setParseError('');
    try { handleParsed(await parseCashFlowFile(file)); }
    catch (e) { setParseError(e?.message || 'Could not read that file. Try CSV, XLSX, or paste the rows instead.'); }
    finally { setParsing(false); }
  };

  const updateRow = (id, patch) => setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  const removeRow = (id) => setRows(prev => prev.filter(r => r.id !== id));
  const rowValid = (r) => r.include && r.date && isFinite(parseDecimal(r.amount)) && parseDecimal(r.amount) > 0;
  const validRows = rows.filter(rowValid);
  const sym = (c) => CURRENCY_SYMBOLS[c] || '';
  const deposits = validRows.filter(r => r.type === 'deposit');
  const withdrawals = validRows.filter(r => r.type === 'withdrawal');

  const doImport = () => {
    const entries = validRows.map(r => ({
      amount: (r.type === 'withdrawal' ? -1 : 1) * Math.abs(parseDecimal(r.amount)),
      currency: r.currency, date: r.date, note: r.note
    }));
    if (entries.length === 0) return;
    onImport(entries);
    onClose();
  };

  const CCYS = ['USD', 'ZAR', 'GBP', 'AUD', 'EUR'];
  const inputStage = React.createElement(React.Fragment, null,
    React.createElement("div", { className: "form-group" },
      React.createElement("label", { className: "form-label" }, "Default currency"),
      React.createElement("select", { value: defaultCurrency, onChange: e => setDefaultCurrency(e.target.value) },
        CCYS.map(c => React.createElement("option", { key: c, value: c }, c + ' (' + (CURRENCY_SYMBOLS[c] || '') + ')')))),
    React.createElement("div", {
      className: "import-drop" + (dragOver ? " over" : ""),
      onClick: () => fileRef.current && fileRef.current.click(),
      onDragOver: e => { e.preventDefault(); setDragOver(true); },
      onDragLeave: () => setDragOver(false),
      onDrop: e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }
    },
      React.createElement(Icon, { name: parsing ? "refresh" : "download", size: 24, className: parsing ? "spin" : "" }),
      React.createElement("div", { className: "import-drop-title" }, parsing ? "Reading…" : "Drop a CSV or Excel file, or tap to browse"),
      React.createElement("div", { className: "import-drop-sub" }, "Columns in any order: date · amount · type · currency · note"),
      React.createElement("input", {
        ref: fileRef, type: "file", accept: ".csv,.tsv,.txt,.xlsx,.xls", style: { display: 'none' },
        onChange: e => { handleFiles(e.target.files); e.target.value = ''; }
      })),
    React.createElement("div", { className: "import-or" }, React.createElement("span", null, "or paste rows")),
    React.createElement("textarea", {
      className: "import-paste", value: pasteText, placeholder: "2026-01-15, 1000, deposit, Monthly DCA\n2026-02-20, 500, withdrawal\n15 Mar 2026, R2 500, deposit",
      onChange: e => setPasteText(e.target.value), rows: 5
    }),
    parseError ? React.createElement("div", { className: "verify-error", style: { marginTop: 10 } }, parseError) : null,
    React.createElement("div", { className: "form-actions" },
      React.createElement("button", { className: "btn btn-ghost", onClick: onClose }, "Cancel"),
      React.createElement("button", { className: "btn btn-primary", onClick: handlePaste, disabled: parsing || !pasteText.trim() }, parsing ? "Reading…" : "Review")));

  const reviewStage = React.createElement(React.Fragment, null,
    React.createElement("div", { className: "cfi-summary" },
      React.createElement("span", null, validRows.length, " of ", rows.length, " ready"),
      React.createElement("span", { className: "cfi-summary-sep" }, "·"),
      React.createElement("span", { className: "up" }, deposits.length, " deposit", deposits.length === 1 ? "" : "s"),
      React.createElement("span", { className: "cfi-summary-sep" }, "·"),
      React.createElement("span", { className: "down" }, withdrawals.length, " withdrawal", withdrawals.length === 1 ? "" : "s")),
    React.createElement("div", { className: "cfi-list" },
      rows.map(r => React.createElement("div", { className: "cfi-row" + (r.include ? "" : " excluded") + (r.include && !rowValid(r) ? " invalid" : ""), key: r.id },
        React.createElement("div", { className: "cfi-row-head" },
          React.createElement("button", {
            className: "cfi-type-toggle " + r.type, type: "button",
            onClick: () => updateRow(r.id, { type: r.type === 'withdrawal' ? 'deposit' : 'withdrawal' }),
            title: "Toggle deposit / withdrawal"
          }, React.createElement(Icon, { name: r.type === 'withdrawal' ? 'minus' : 'plus', size: 11 }), r.type === 'withdrawal' ? 'Out' : 'In'),
          React.createElement("input", { className: "cfi-date", type: "date", value: r.date, onChange: e => updateRow(r.id, { date: e.target.value }) }),
          React.createElement("button", { className: "cfi-remove", onClick: () => removeRow(r.id), "aria-label": "Remove" }, React.createElement(Icon, { name: "x", size: 12 }))),
        React.createElement("div", { className: "cfi-row-body" },
          React.createElement("div", { className: "cfi-amount-wrap" },
            React.createElement("span", { className: "cfi-amount-sym" }, sym(r.currency)),
            React.createElement("input", {
              className: "cfi-amount", type: "text", inputMode: "decimal", value: r.amount, placeholder: "0.00",
              onChange: e => updateRow(r.id, { amount: sanitizeDecimalInput(e.target.value) })
            })),
          React.createElement("select", { className: "cfi-ccy", value: r.currency, onChange: e => updateRow(r.id, { currency: e.target.value }) },
            CCYS.map(c => React.createElement("option", { key: c, value: c }, c))),
          React.createElement("input", { className: "cfi-note", type: "text", value: r.note, placeholder: "Note", maxLength: 100, onChange: e => updateRow(r.id, { note: e.target.value }) })))),
    ),
    React.createElement("div", { className: "form-actions" },
      React.createElement("button", { className: "btn btn-ghost", onClick: () => setStage('input') }, "Back"),
      React.createElement("button", { className: "btn btn-primary", onClick: doImport, disabled: validRows.length === 0 },
        "Import ", validRows.length, " ", validRows.length === 1 ? "entry" : "entries")));

  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: () => { if (stage === 'input') onClose(); } }),
    React.createElement("div", { className: "modal-panel", style: { maxWidth: 520 }, ref: panelRef },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, "Import deposits & withdrawals"),
          React.createElement("div", { className: "modal-subtitle" }, stage === 'input' ? "Paste a list or drop a file — amounts and dates" : "Check each row, flip deposits/withdrawals, then import")),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" }, React.createElement(Icon, { name: "x" }))),
      React.createElement("div", { className: "modal-body" }, stage === 'input' ? inputStage : reviewStage)));
}
function ImportModal({ onClose, onImport }) {
  const [stage, setStage] = useState('input'); // 'input' | 'review'
  const [rows, setRows] = useState([]);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [importing, setImporting] = useState(false);
  // The market the user expects these holdings to live on. It biases every
  // name→listing match (e.g. "Anglo American" → AGL.JO on JSE vs AAL.L on LSE).
  const [chosenMarket, setChosenMarket] = useState('US');
  const fileRef = useRef(null);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, () => { if (stage === 'input') onClose(); });
  useBodyScrollLock();

  const toRows = (holdings, market) => holdings.map(h => ({
    id: uid(),
    query: h.query || '',
    tickerHint: h.tickerHint || null,
    market: h.marketHint || market,
    ticker: '',                 // resolved live symbol
    resolvedName: h.nameHint || h.query || '',
    candidates: [],
    shares: h.shares != null ? String(h.shares) : '',
    costBasis: h.costBasis != null ? String(h.costBasis) : '',
    purchaseDate: h.purchaseDate || '',
    status: null,               // null | 'resolving' | 'ok' | 'notfound'
    currentPrice: null,
    include: true,
    showAlts: false,
  }));

  const handleParsed = (holdings) => {
    if (!holdings || holdings.length === 0) {
      setParseError("Couldn't find anything to import. Paste a list of company names (one per line) — e.g. \"Broadcom\", \"Naspers\" — or broker rows like \"Broadcom, 10, 800\".");
      return;
    }
    const r = toRows(holdings, chosenMarket);
    setRows(r);
    setStage('review');
    setParseError('');
    resolveRows(r);
  };

  const handleFiles = async (files) => {
    const file = files && files[0];
    if (!file) return;
    setParsing(true); setParseError('');
    try {
      const holdings = await parseImportFile(file);
      handleParsed(holdings);
    } catch (e) {
      setParseError(e?.message || 'Could not read that file. Try CSV, XLSX, or paste the rows instead.');
    } finally {
      setParsing(false);
    }
  };

  const handlePaste = () => {
    if (!pasteText.trim()) return;
    setParsing(true); setParseError('');
    try {
      handleParsed(parseHoldingsFromText(pasteText));
    } catch (e) {
      setParseError('Could not parse that text.');
    } finally {
      setParsing(false);
    }
  };

  // Resolve one row: search live listings by the company name, rank with the
  // chosen market biasing the pick, then confirm with a real quote. Falls back
  // to the bare ticker hint and to other-market candidates so a name still
  // resolves even when its primary listing isn't on the chosen exchange.
  const resolveRow = async (r) => {
    const market = r.market;
    const remote = await searchListingsMulti(r.query, r.tickerHint, market).catch(() => []);
    const ranked = rankImportCandidates(r.query, r.tickerHint, market, remote);
    let pick = ranked.find(c => c.market === market) || ranked[0] || null;
    let q = pick ? await fetchQuote(pick.ticker, pick.market).catch(() => null) : null;
    if (!q && r.tickerHint) {
      const hq = await fetchQuote(r.tickerHint, market).catch(() => null);
      if (hq) { pick = { ticker: r.tickerHint, market, name: resolveTickerName(r.tickerHint, market, hq) || r.query, nameScore: 1 }; q = hq; }
    }
    if (!q && ranked.length) {
      for (const c of ranked.slice(0, 4)) {
        const cq = await fetchQuote(c.ticker, c.market).catch(() => null);
        if (cq) { pick = c; q = cq; break; }
      }
    }
    // Confidence = how well the matched listing's name fits the query. Low
    // confidence (or a pick that landed off the chosen market) is surfaced so
    // the user can sanity-check or pick an alternative.
    const conf = q && pick ? (pick.nameScore != null ? pick.nameScore : companyNameScore(r.query, pick.name || '')) : 0;
    const offMarket = !!(q && pick && pick.market !== market);
    return {
      ticker: q && pick ? pick.ticker : (r.tickerHint || ''),
      market: q && pick ? pick.market : market,
      resolvedName: q && pick ? (pick.name || resolveTickerName(pick.ticker, pick.market, q) || r.query) : r.resolvedName,
      currentPrice: q ? q.price : null,
      status: q ? 'ok' : 'notfound',
      confidence: conf,
      lowConfidence: !!(q && (conf < 0.5 || offMarket)),
      candidates: ranked.slice(0, 7),
    };
  };

  const resolveRows = async (list) => {
    setResolving(true);
    setRows(prev => prev.map(x => list.some(l => l.id === x.id) ? { ...x, status: 'resolving' } : x));
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const r = list[i++];
        if (!r.query.trim()) { setRows(prev => prev.map(x => x.id === r.id ? { ...x, status: 'notfound' } : x)); continue; }
        const res = await resolveRow(r);
        setRows(prev => prev.map(x => x.id === r.id ? { ...x, ...res } : x));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
    setResolving(false);
  };

  const updateRow = (id, patch) => setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const removeRow = (id) => setRows(prev => prev.filter(r => r.id !== id));

  // Re-resolve a single row (after the user edits its search text or market).
  const reResolveRow = async (id) => {
    let target = null;
    setRows(prev => prev.map(r => { if (r.id === id) { target = r; return { ...r, status: 'resolving' }; } return r; }));
    if (!target) return;
    const res = await resolveRow({ ...target, status: 'resolving' });
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...res } : r));
  };

  // User explicitly picks one of the alternative listings.
  const chooseCandidate = async (id, cand) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ticker: cand.ticker, market: cand.market, resolvedName: cand.name, status: 'resolving', showAlts: false, lowConfidence: false } : r));
    const q = await fetchQuote(cand.ticker, cand.market).catch(() => null);
    setRows(prev => prev.map(r => r.id === id ? {
      ...r,
      status: q ? 'ok' : 'notfound',
      currentPrice: q ? q.price : null,
      lowConfidence: false,
      resolvedName: q ? (resolveTickerName(cand.ticker, cand.market, q) || cand.name) : cand.name,
    } : r));
  };

  // One-tap "these are all JSE / US / …": set the bias market, apply it to every
  // included row, and re-run name matching so each maps to that exchange.
  const setAllMarket = (market) => {
    setChosenMarket(market);
    const next = rows.map(r => r.include ? { ...r, market, status: null, currentPrice: null, ticker: '' } : r);
    setRows(next);
    resolveRows(next.filter(r => r.include));
  };

  const hasShares = (r) => isFinite(parseDecimal(r.shares)) && parseDecimal(r.shares) > 0;
  const hasCost = (r) => isFinite(parseDecimal(r.costBasis)) && parseDecimal(r.costBasis) > 0;
  // Importable only once matched to a confirmed live listing with valid qty/cost.
  const validRows = rows.filter(r => r.include && r.ticker.trim() && r.status === 'ok' && hasShares(r) && hasCost(r));
  const notFoundCount = rows.filter(r => r.include && r.status === 'notfound').length;
  const needQtyCount = rows.filter(r => r.include && r.status === 'ok' && (!hasShares(r) || !hasCost(r))).length;

  const doImport = async () => {
    if (validRows.length === 0) return;
    setImporting(true);
    try {
      await onImport(validRows.map(r => ({
        ticker: r.ticker.trim().toUpperCase(),
        market: r.market,
        shares: parseDecimal(r.shares),
        costBasis: parseDecimal(r.costBasis),
        purchaseDate: r.purchaseDate || null,
        notes: '',
      })));
      onClose();
    } finally {
      setImporting(false);
    }
  };

  const renderInput = () => React.createElement("div", { className: "modal-body" },
    React.createElement("div", { className: "import-market-pick" },
      React.createElement("div", { className: "form-label" }, "Which market are these holdings on?"),
      React.createElement("div", { className: "import-bulk-chips" },
        MARKETS.map(m => React.createElement("button", {
          key: m.value, type: "button",
          className: "import-bulk-chip" + (chosenMarket === m.value ? " active" : ""),
          onClick: () => setChosenMarket(m.value),
          title: m.country + " · " + m.exchange
        }, m.label))),
      React.createElement("div", { className: "form-help" }, "Guides name matching — e.g. “Naspers” → NPN on JSE. You can change any row afterwards.")
    ),
    React.createElement("div", {
      className: "import-drop" + (dragOver ? " over" : ""),
      onDragOver: e => { e.preventDefault(); setDragOver(true); },
      onDragLeave: () => setDragOver(false),
      onDrop: e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); },
      onClick: () => fileRef.current?.click()
    },
      React.createElement(Icon, { name: parsing ? "refresh" : "download", size: 26, className: parsing ? "spin" : "" }),
      React.createElement("div", { className: "import-drop-title" }, parsing ? "Reading your file…" : "Drop a file or tap to browse"),
      React.createElement("div", { className: "import-drop-sub" }, "CSV · Excel (.xlsx) · PDF · Markdown · plain text"),
      React.createElement("input", {
        ref: fileRef, type: "file", accept: ".csv,.tsv,.txt,.md,.xls,.xlsx,.pdf,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf",
        style: { display: 'none' },
        onChange: e => handleFiles(e.target.files)
      })
    ),
    React.createElement("div", { className: "import-or" }, React.createElement("span", null, "or paste company names")),
    React.createElement("textarea", {
      className: "import-paste",
      placeholder: "One company per line — names are fine, we'll find the live listing:\n\nBroadcom\nNaspers\nApple, 10, 150.25\nAnglo American, 100, 480",
      value: pasteText,
      onChange: e => setPasteText(e.target.value),
      rows: 6
    }),
    parseError ? React.createElement("div", { className: "verify-error", style: { marginTop: 10 } }, parseError) : null,
    React.createElement("div", { className: "form-actions", style: { marginTop: 14 } },
      React.createElement("button", { className: "btn btn-secondary", onClick: onClose }, "Cancel"),
      React.createElement("button", {
        className: "btn btn-primary",
        onClick: handlePaste,
        disabled: !pasteText.trim() || parsing
      }, "Match holdings")
    )
  );

  const statusDot = (r) => {
    if (r.status === 'resolving') return React.createElement("span", { className: "import-status checking", title: "Matching…" });
    if (r.status === 'ok') return React.createElement("span", { className: "import-status ok", title: r.currentPrice != null ? ("Matched · now " + fmt(r.currentPrice, r.market)) : "Matched" });
    if (r.status === 'notfound') return React.createElement("span", { className: "import-status bad", title: "No live match on this market" });
    return React.createElement("span", { className: "import-status", title: "Not matched" });
  };

  const renderCard = (r) => {
    const sharesBad = !(isFinite(parseDecimal(r.shares)) && parseDecimal(r.shares) > 0);
    const costBad = !(isFinite(parseDecimal(r.costBasis)) && parseDecimal(r.costBasis) > 0);
    const alts = (r.candidates || []).filter(c => !(c.ticker === r.ticker && c.market === r.market)).slice(0, 6);
    const lowConf = r.status === 'ok' && r.lowConfidence;
    return React.createElement("div", { key: r.id, className: "import-card" + (r.include ? "" : " excluded") + (r.status === 'notfound' ? " is-bad" : "") + (lowConf ? " is-low" : "") },
      React.createElement("div", { className: "import-card-top" },
        React.createElement("label", { className: "import-check" },
          React.createElement("input", { type: "checkbox", checked: r.include, onChange: e => updateRow(r.id, { include: e.target.checked }) })),
        React.createElement("input", {
          className: "import-query-input",
          value: r.query, placeholder: "Company name",
          autoComplete: "off", spellCheck: false,
          onChange: e => updateRow(r.id, { query: e.target.value }),
          onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); reResolveRow(r.id); } },
          onBlur: () => { if (r.query.trim() && r.status !== 'resolving') reResolveRow(r.id); }
        }),
        React.createElement("button", { className: "import-del", onClick: () => removeRow(r.id), "aria-label": "Remove row" },
          React.createElement(Icon, { name: "x", size: 13 }))
      ),
      React.createElement("div", { className: "import-card-match" },
        statusDot(r),
        r.ticker
          ? React.createElement(React.Fragment, null,
              React.createElement("span", { className: "import-match-tkr" }, r.ticker),
              React.createElement("span", { className: "import-match-name" }, r.resolvedName || ''),
              lowConf ? React.createElement("span", { className: "import-conf-low", title: "Loose match — please confirm or pick an alternative" }, "check?") : null)
          : React.createElement("span", { className: "import-match-name text-dim" },
              r.status === 'resolving' ? "Searching live listings…" : (r.status === 'notfound' ? "No match — try the exact name or another market" : "Not matched yet")),
        React.createElement("select", {
          className: "import-input import-select import-card-market", value: r.market,
          onChange: e => { updateRow(r.id, { market: e.target.value, status: 'resolving', ticker: '' }); reResolveRow(r.id); }
        }, MARKETS.map(m => React.createElement("option", { key: m.value, value: m.value }, m.label))),
        alts.length > 0 ? React.createElement("button", {
          className: "btn btn-ghost btn-xs import-alts-toggle",
          onClick: () => updateRow(r.id, { showAlts: !r.showAlts, manualSearch: false })
        }, r.showAlts ? "Hide" : "Change") : null,
        React.createElement("button", {
          className: "btn btn-ghost btn-xs import-alts-toggle" + (r.manualSearch ? " active" : ""),
          onClick: () => updateRow(r.id, { manualSearch: !r.manualSearch, showAlts: false }),
          title: "Search live listings and pick the exact one"
        }, r.manualSearch ? "Close" : (r.status === 'notfound' ? "Find" : "Search")),
        React.createElement("button", {
          className: "btn btn-ghost btn-xs import-alts-toggle",
          onClick: () => reResolveRow(r.id), title: "Re-match"
        }, React.createElement(Icon, { name: "refresh", size: 12 }))
      ),
      r.showAlts && alts.length > 0 ? React.createElement("div", { className: "import-alts" },
        alts.map(c => React.createElement("button", {
          key: priceKey(c.market, c.ticker), className: "import-alt",
          onClick: () => chooseCandidate(r.id, c)
        },
          React.createElement("span", { className: "import-alt-tkr" }, c.ticker),
          React.createElement("span", { className: "market-badge" }, c.market),
          React.createElement("span", { className: "import-alt-name" }, c.name)))
      ) : null,
      // Manual matcher: search every live exchange by name or symbol and pick the
      // exact listing when auto-matching missed or the user wants a different one.
      r.manualSearch ? React.createElement("div", { className: "import-manual-search" },
        React.createElement("div", { className: "import-manual-hint" }, "Search by company name or symbol, then tap the right listing:"),
        React.createElement(TickerSearch, {
          value: r.query,
          market: r.market,
          onChange: () => {},
          onMarketChange: () => {},
          onSelect: (sel) => { updateRow(r.id, { manualSearch: false }); chooseCandidate(r.id, { ticker: sel.ticker, market: sel.market, name: sel.name }); }
        })
      ) : null,
      React.createElement("div", { className: "import-card-qty" },
        React.createElement("div", { className: "import-qty-field" },
          React.createElement("span", { className: "import-qty-label" }, "Shares"),
          React.createElement("input", {
            className: "import-input" + (sharesBad ? " bad" : ""),
            inputMode: "decimal", value: r.shares, placeholder: "0",
            onChange: e => updateRow(r.id, { shares: sanitizeDecimalInput(e.target.value) })
          })),
        React.createElement("div", { className: "import-qty-field" },
          React.createElement("span", { className: "import-qty-label" }, "Cost/share (", (MARKET_CURRENCY[r.market] || MARKET_CURRENCY.US).code, ")"),
          React.createElement("input", {
            className: "import-input" + (costBad ? " bad" : ""),
            inputMode: "decimal", value: r.costBasis, placeholder: "0.00",
            onChange: e => updateRow(r.id, { costBasis: sanitizeDecimalInput(e.target.value) })
          })))
    );
  };

  const renderReview = () => React.createElement("div", { className: "modal-body" },
    React.createElement("div", { className: "import-review-head" },
      React.createElement("span", null, validRows.length, " of ", rows.length, " ready"),
      notFoundCount > 0 ? React.createElement("span", { className: "text-down text-xs" }, notFoundCount, " unmatched") : null,
      resolving ? React.createElement("span", { className: "text-dim text-xs" }, "Matching…") : React.createElement("button", {
        className: "btn btn-ghost btn-xs", onClick: () => resolveRows(rows.filter(r => r.include))
      }, React.createElement(Icon, { name: "refresh", size: 12 }), " Re-match all")
    ),
    React.createElement("div", { className: "import-bulk-market" },
      React.createElement("span", { className: "import-bulk-label" }, "Match all rows against exchange"),
      React.createElement("div", { className: "import-bulk-chips" },
        MARKETS.map(m => React.createElement("button", {
          key: m.value,
          type: "button",
          className: "import-bulk-chip" + (chosenMarket === m.value ? " active" : ""),
          onClick: () => setAllMarket(m.value),
          title: m.country + " · " + m.exchange + " · " + (MARKET_CURRENCY[m.value] || MARKET_CURRENCY.US).code
        }, m.label)))
    ),
    React.createElement("div", { className: "import-cards" }, rows.map(renderCard)),
    (notFoundCount > 0 || needQtyCount > 0) && !resolving ? React.createElement("div", { className: "import-gate-note" },
      notFoundCount > 0
        ? `${notFoundCount} row${notFoundCount !== 1 ? 's' : ''} couldn't be matched to a live listing — refine the name, switch the market, or tap Change to pick from alternatives. Only matched holdings import.`
        : `${needQtyCount} matched row${needQtyCount !== 1 ? 's' : ''} still need shares and cost before importing.`
    ) : null,
    React.createElement("div", { className: "form-actions", style: { marginTop: 14 } },
      React.createElement("button", { className: "btn btn-secondary", onClick: () => { setStage('input'); setRows([]); } }, "Back"),
      React.createElement("button", {
        className: "btn btn-primary", onClick: doImport,
        disabled: validRows.length === 0 || importing || resolving
      }, importing ? "Importing…" : resolving ? "Matching…" : "Import " + validRows.length + " holding" + (validRows.length !== 1 ? "s" : ""))
    )
  );

  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: stage === 'input' ? onClose : undefined }),
    React.createElement("div", { className: "modal-panel", ref: panelRef, style: { maxWidth: 620 } },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, "Import holdings"),
          React.createElement("div", { className: "modal-subtitle" }, stage === 'input' ? "Match company names to live listings" : "Review matches before importing")
        ),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" }, React.createElement(Icon, { name: "x" }))
      ),
      stage === 'input' ? renderInput() : renderReview()
    )
  );
}
function PositionModal(_ref12) {
  let {
    editId,
    existing,
    onClose,
    onSave
  } = _ref12;
  const isEdit = !!editId;
  const [ticker, setTicker] = useState(existing?.ticker || '');
  const [market, setMarket] = useState(existing?.market || 'US');
  const [shares, setShares] = useState(existing?.shares?.toString() || '');
  const [costBasis, setCostBasis] = useState(existing?.costBasis?.toString() || '');
  const [notes, setNotes] = useState(existing?.notes || '');
  const todayISO = new Date().toISOString().slice(0, 10);
  const [purchaseDate, setPurchaseDate] = useState(existing?.purchaseDate || todayISO);
  const [verifying, setVerifying] = useState(false);
  const [tickerError, setTickerError] = useState('');
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const submit = async () => {
    if (!ticker.trim()) return;
    const s = parseDecimal(shares);
    const c = parseDecimal(costBasis);
    if (!isFinite(s) || s <= 0) return;
    if (!isFinite(c) || c <= 0) return;
    if (purchaseDate && purchaseDate > todayISO) {
      setTickerError('Purchase date cannot be in the future.');
      return;
    }
    let verifiedQuote = null;
    if (!isEdit) {
      setVerifying(true);
      setTickerError('');
      verifiedQuote = await fetchQuote(ticker.trim(), market);
      setVerifying(false);
      if (!verifiedQuote) {
        setTickerError(`"${ticker.trim()}" not found on ${market}. Check the symbol.`);
        return;
      }
    }
    // Pass the quote we just fetched up so the feed can seed it instantly — the
    // dashboard pie/line then update the moment the position is added.
    onSave({
      ticker: ticker.trim().toUpperCase(),
      market, shares: s, costBasis: c, notes,
      purchaseDate: purchaseDate || null
    }, verifiedQuote);
  };
  const ccy = (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).sym;
  return React.createElement("div", {
    className: "modal"
  }, React.createElement("div", {
    className: "modal-backdrop",
    onClick: onClose
  }), React.createElement("div", {
    className: "modal-panel",
    ref: panelRef,
    style: {
      maxWidth: 480
    }
  }, React.createElement("div", {
    className: "modal-handle"
  }), React.createElement("div", {
    className: "modal-header"
  }, React.createElement("div", null, React.createElement("div", {
    className: "modal-title"
  }, isEdit ? 'Edit position' : 'Add position'), React.createElement("div", {
    className: "modal-subtitle"
  }, "Stored locally on this device")), React.createElement("button", {
    className: "modal-close",
    onClick: onClose,
    "aria-label": "Close"
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "modal-body"
  }, React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Market"), React.createElement(MarketPicker, {
    value: market,
    onChange: v => setMarket(v),
    disabled: isEdit
  })), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Ticker"), React.createElement(TickerSearch, {
    value: ticker,
    onChange: v => { setTicker(v); setTickerError(''); },
    market: market,
    onMarketChange: m2 => { setMarket(m2); setTickerError(''); },
    disabled: isEdit
  }), tickerError ? React.createElement("div", { className: "verify-error" }, tickerError) : null), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Shares"), React.createElement("input", {
    type: "text",
    inputMode: "decimal",
    autoComplete: "off",
    autoCorrect: "off",
    spellCheck: false,
    placeholder: "10",
    value: shares,
    onChange: e => setShares(sanitizeDecimalInput(e.target.value))
  })), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Cost basis per share"), React.createElement("div", {
    className: "input-prefix-wrap"
  }, React.createElement("span", {
    className: "prefix"
  }, ccy), React.createElement("input", {
    type: "text",
    inputMode: "decimal",
    autoComplete: "off",
    autoCorrect: "off",
    spellCheck: false,
    placeholder: "0.00",
    value: costBasis,
    onChange: e => setCostBasis(sanitizeDecimalInput(e.target.value))
  })), React.createElement("div", {
    className: "form-help"
  }, "What you paid per share (your average if you bought in tranches).")), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Purchase date"), React.createElement("input", {
    type: "date",
    value: purchaseDate,
    max: todayISO,
    onChange: e => setPurchaseDate(e.target.value)
  }), React.createElement("div", {
    className: "form-help"
  }, "Used to price FX gain/loss against the rate on the day you bought.")), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Notes (optional)"), React.createElement("textarea", {
    maxLength: "200",
    placeholder: "e.g. TFSA, held since Oct 2024",
    value: notes,
    onChange: e => setNotes(e.target.value)
  })), React.createElement("div", {
    className: "form-actions"
  }, React.createElement("button", {
    className: "btn btn-secondary",
    onClick: onClose
  }, "Cancel"), React.createElement("button", {
    className: "btn btn-primary",
    onClick: submit,
    disabled: verifying
  }, verifying ? 'Verifying…' : isEdit ? 'Save changes' : 'Add position')))));
}
function SellModal({ position, prices, onClose, onSell }) {
  const [shares, setShares] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const todayISO = new Date().toISOString().slice(0, 10);
  const [sellDate, setSellDate] = useState(todayISO);
  const [notes, setNotes] = useState('');
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const q = prices[priceKey(position.market, position.ticker)];
  useEffect(() => {
    if (q && !sellPrice) setSellPrice(q.price.toFixed(2));
  }, [q]);
  const ccy = (MARKET_CURRENCY[position.market] || MARKET_CURRENCY.US).sym;
  const numShares = parseDecimal(shares);
  const numPrice = parseDecimal(sellPrice);
  const valid = isFinite(numShares) && numShares > 0 && numShares <= position.shares && isFinite(numPrice) && numPrice > 0;
  const pnl = valid ? (numPrice - position.costBasis) * numShares : null;
  const submit = () => {
    if (!valid) return;
    onSell(position.ticker, position.market, numShares, numPrice, sellDate, notes);
    onClose();
  };
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel", ref: panelRef, style: { maxWidth: 480 } },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, "Sell ", position.ticker),
          React.createElement("div", { className: "modal-subtitle" },
            position.shares, " shares held \xB7 avg ", ccy, position.costBasis.toFixed(2))),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" }))),
      React.createElement("div", { className: "modal-body" },
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Shares to sell"),
          React.createElement("input", {
            type: "text", inputMode: "decimal",
            autoComplete: "off", autoCorrect: "off", spellCheck: false,
            placeholder: position.shares.toString(),
            value: shares, onChange: e => setShares(sanitizeDecimalInput(e.target.value))
          }),
          React.createElement("div", { className: "form-help" },
            "Max: ", position.shares,
            numShares > position.shares && React.createElement("span", { className: "text-down" }, " — exceeds your holding"))),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Sell price per share"),
          React.createElement("div", { className: "input-prefix-wrap" },
            React.createElement("span", { className: "prefix" }, ccy),
            React.createElement("input", {
              type: "text", inputMode: "decimal",
              autoComplete: "off", autoCorrect: "off", spellCheck: false,
              placeholder: q ? q.price.toFixed(2) : '0.00',
              value: sellPrice, onChange: e => setSellPrice(sanitizeDecimalInput(e.target.value))
            }))),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Sale date"),
          React.createElement("input", {
            type: "date", value: sellDate, max: todayISO,
            onChange: e => setSellDate(e.target.value)
          })),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Notes (optional)"),
          React.createElement("input", {
            type: "text", maxLength: "200", placeholder: "e.g. Trimmed after earnings",
            value: notes, onChange: e => setNotes(e.target.value)
          })),
        pnl != null && React.createElement("div", {
          className: `card ${pnl >= 0 ? 'sell-pnl-up' : 'sell-pnl-down'}`,
          style: { padding: '10px 14px', textAlign: 'center' }
        },
          React.createElement("div", { className: "text-xs text-dim" }, "Estimated P&L"),
          React.createElement("div", { className: `mono font-semibold ${pnl >= 0 ? 'text-up' : 'text-down'}`, style: { fontSize: 18 } },
            (pnl >= 0 ? '+' : '') + ccy + Math.abs(pnl).toFixed(2))),
        React.createElement("div", { className: "form-actions" },
          React.createElement("button", { className: "btn btn-secondary", onClick: onClose }, "Cancel"),
          React.createElement("button", {
            className: "btn btn-danger", onClick: submit, disabled: !valid
          }, "Record sale")))));
}
function computeFxSnapshot({ positions, contributions, prices, fxRates, displayCurrency }) {
  const rates = fxRates?.rates || null;
  let combinedValue = 0;
  let combinedCostToday = 0;
  let combinedCostAtPurchase = 0;
  let anyPositionMissing = false;
  positions.forEach(p => {
    const q = prices[priceKey(p.market, p.ticker)];
    const native = marketCurrency(p.market);
    const valueNative = q ? p.shares * q.price : null;
    const costNative = p.shares * p.costBasis;
    const valueInDisplay = convertCcy(valueNative, native, displayCurrency, rates);
    const costNowInDisplay = convertCcy(costNative, native, displayCurrency, rates);
    const fxAtCost = p.fxRateAtCost && isFinite(p.fxRateAtCost) && p.fxRateAtCost > 1e-6 ? p.fxRateAtCost : null;
    const fxNative = rates && rates[native] && isFinite(rates[native]) && rates[native] > 1e-6 ? rates[native] : null;
    const fxDisplay = rates && rates[displayCurrency] && isFinite(rates[displayCurrency]) && rates[displayCurrency] > 1e-6 ? rates[displayCurrency] : null;
    const costAtPurchaseUSD = fxAtCost
      ? costNative / fxAtCost
      : (fxNative ? costNative / fxNative : null);
    const costAtPurchaseDisplay = costAtPurchaseUSD != null && isFinite(costAtPurchaseUSD) && fxDisplay
      ? costAtPurchaseUSD * fxDisplay
      : null;
    if (valueInDisplay != null) combinedValue += valueInDisplay;
    else anyPositionMissing = true;
    if (costNowInDisplay != null) combinedCostToday += costNowInDisplay;
    if (costAtPurchaseDisplay != null) combinedCostAtPurchase += costAtPurchaseDisplay;
  });
  let contributedAtSnapshot = 0;
  let contributedAtToday = 0;
  contributions.forEach(c => {
    const todayConv = convertCcy(c.amount, c.currency, displayCurrency, rates);
    if (todayConv != null) contributedAtToday += todayConv;
    const contribRate = c.fxRateAtContrib && isFinite(c.fxRateAtContrib) && c.fxRateAtContrib > 1e-6 ? c.fxRateAtContrib : null;
    const dispRate = rates && rates[displayCurrency] && isFinite(rates[displayCurrency]) && rates[displayCurrency] > 1e-6 ? rates[displayCurrency] : null;
    if (contribRate && dispRate) {
      const usd = c.amount / contribRate;
      if (isFinite(usd)) contributedAtSnapshot += usd * dispRate;
    } else if (todayConv != null) {
      contributedAtSnapshot += todayConv;
    }
  });
  const priceGain = combinedValue - combinedCostToday;
  const fxGainOnCost = combinedCostToday - combinedCostAtPurchase;
  const totalGain = combinedValue - combinedCostAtPurchase;
  const fxGainOnContrib = contributedAtToday - contributedAtSnapshot;
  return {
    combinedValue, combinedCostToday, combinedCostAtPurchase,
    priceGain, fxGainOnCost, totalGain,
    contributedAtToday, contributedAtSnapshot, fxGainOnContrib,
    anyPositionMissing
  };
}

function FxSummary({ positions, contributions, prices, fxRates, displayCurrency, onSetDisplayCurrency }) {
  const hasRates = !!fxRates?.rates;
  const snap = useMemo(
    () => computeFxSnapshot({ positions, contributions, prices, fxRates, displayCurrency }),
    [positions, contributions, prices, fxRates, displayCurrency]
  );
  const trackedContribs = contributions.filter(c => c.fxRateAtContrib).length;
  const isZAR = displayCurrency === 'ZAR';
  return React.createElement("div", { className: "card mb-4" },
    React.createElement("div", { className: "flex justify-between items-center mb-3" },
      React.createElement("div", { className: "eyebrow", style: { marginBottom: 0 } },
        "Combined · ", displayCurrency),
      React.createElement("div", { className: "ccy-toggle", onClick: () => onSetDisplayCurrency(isZAR ? 'USD' : 'ZAR') },
        React.createElement("span", { className: `ccy-toggle-label ${!isZAR ? 'active' : ''}` }, "$"),
        React.createElement("div", { className: `ccy-toggle-track ${isZAR ? 'on' : ''}` },
          React.createElement("div", { className: "ccy-toggle-thumb" })),
        React.createElement("span", { className: `ccy-toggle-label ${isZAR ? 'active' : ''}` }, "R"))
    ),
    !hasRates ? React.createElement("div", { className: "text-sm text-dim" },
      "Loading live FX rates\u2026 open Settings to retry."
    ) : React.createElement(React.Fragment, null,
      React.createElement("div", { className: "fx-combined mb-3" },
        React.createElement("div", { className: "fx-combined-label" }, "Portfolio value (" + displayCurrency + ")"),
        React.createElement("div", { className: "fx-combined-value" },
          fmtCcy(snap.combinedValue, displayCurrency)),
        snap.combinedCostAtPurchase > 0 && React.createElement("div", {
          className: "mt-2 flex gap-2 items-baseline", style: { flexWrap: 'wrap' }
        },
          React.createElement("span", { className: `mono text-sm ${snap.totalGain >= 0 ? 'text-up' : 'text-down'}` },
            fmtCcySigned(snap.totalGain, displayCurrency)),
          React.createElement("span", { className: "text-xs text-dim" },
            "total return vs. cost at purchase FX")
        )
      ),
      React.createElement("div", { className: "fx-breakdown-row" },
        React.createElement("span", { className: "lbl" }, "Price P&L (native moves)"),
        React.createElement("span", { className: `val ${snap.priceGain >= 0 ? 'text-up' : 'text-down'}` },
          fmtCcySigned(snap.priceGain, displayCurrency))
      ),
      React.createElement("div", { className: "fx-breakdown-row" },
        React.createElement("span", { className: "lbl" }, "FX impact on cost basis"),
        React.createElement("span", { className: `val ${snap.fxGainOnCost >= 0 ? 'text-up' : 'text-down'}` },
          fmtCcySigned(snap.fxGainOnCost, displayCurrency))
      ),
      contributions.length > 0 && React.createElement("div", { className: "fx-breakdown-row" },
        React.createElement("span", { className: "lbl" },
          "FX impact on contributions",
          trackedContribs < contributions.length ? React.createElement("span", {
            className: "text-xs text-dim", style: { marginLeft: 6 }
          }, "(" + trackedContribs + "/" + contributions.length + " tracked)") : null
        ),
        React.createElement("span", { className: `val ${snap.fxGainOnContrib >= 0 ? 'text-up' : 'text-down'}` },
          fmtCcySigned(snap.fxGainOnContrib, displayCurrency))
      ),
      React.createElement("div", { className: "text-xs text-dim mt-2" },
        "Rates: " + fxRates.source + " \u00B7 updated ",
        new Date(fxRates.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      )
    )
  );
}

function SettingsModal({ displayCurrency, onSetDisplayCurrency, fxRates, onRefreshFx,
                        positions, contributions, prices, onExport, onImport,
                        ribbonItems, onSetRibbonItems, ribbonMode, onSetRibbonMode, onClose }) {
  const [refreshing, setRefreshing] = useState(false);
  const [activeSection, setActiveSection] = useState('display');
  const fileInputRef = useRef(null);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const snap = useMemo(
    () => computeFxSnapshot({ positions, contributions, prices, fxRates, displayCurrency }),
    [positions, contributions, prices, fxRates, displayCurrency]
  );
  const refresh = async () => {
    setRefreshing(true);
    try { await onRefreshFx(); } finally { setRefreshing(false); }
  };
  const rates = fxRates?.rates || {};
  const sections = [
    { key: 'display', label: 'Display', icon: 'globe' },
    { key: 'ribbon', label: 'Ribbon', icon: 'activity' },
    { key: 'fx', label: 'FX Rates', icon: 'refresh' },
    { key: 'data', label: 'Data', icon: 'download' },
  ];
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel settings-panel", ref: panelRef },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", { className: "modal-title" }, "Settings"),
        React.createElement("button", { className: "modal-close", onClick: onClose, 'aria-label': "Close" },
          React.createElement(Icon, { name: "x" })
        )
      ),
      React.createElement("div", { className: "settings-tabs" },
        sections.map(s => React.createElement("button", {
          key: s.key,
          className: `settings-tab ${activeSection === s.key ? 'active' : ''}`,
          onClick: () => setActiveSection(s.key)
        }, React.createElement(Icon, { name: s.icon, size: 13 }), " ", s.label))
      ),
      React.createElement("div", { className: "modal-body" },
        activeSection === 'display' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Display currency"),
              React.createElement("div", { className: "settings-row-desc" }, "Portfolio totals and FX shown in this currency")
            ),
            React.createElement("select", {
              value: displayCurrency,
              onChange: e => onSetDisplayCurrency(e.target.value),
              style: { width: 'auto', minWidth: 110 }
            }, DISPLAY_CURRENCIES.map(c => React.createElement("option", {
              key: c.code, value: c.code
            }, c.sym + " " + c.code)))
          ),
          React.createElement("div", { className: "settings-info-box" },
            React.createElement("div", { className: "settings-info-title" },
              React.createElement(Icon, { name: "globe", size: 12 }), " How FX gain/loss is calculated"),
            React.createElement("div", { className: "settings-info-body" },
              "When you add a position, the live exchange rate is stored. Price P&L tracks native-currency changes. FX impact shows how much your ", displayCurrency, " value has shifted purely from currency moves.")
          )
        ),
        activeSection === 'ribbon' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-row mb-3" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Display mode"),
              React.createElement("div", { className: "settings-row-desc" },
                ribbonItems.length <= 3
                  ? "With 3 or fewer items, pills display in a row."
                  : "Choose how extra pills are laid out.")
            ),
            ribbonItems.length > 3 && React.createElement("select", {
              value: ribbonMode,
              onChange: e => onSetRibbonMode(e.target.value),
              style: { width: 'auto', minWidth: 110 }
            },
              React.createElement("option", { value: "rows" }, "Rows of 3"),
              React.createElement("option", { value: "marquee" }, "Scrolling ticker"))
          ),
          React.createElement("div", { className: "settings-section-title mb-2" }, "Select items"),
          React.createElement("div", { className: "settings-row-desc mb-3" }, "Tap to toggle. Drag is not supported — items appear in catalog order."),
          React.createElement("div", { className: "ribbon-catalog-grid" },
            RIBBON_CATALOG.map(item => {
              const active = ribbonItems.includes(item.key);
              return React.createElement("button", {
                key: item.key,
                className: `ribbon-catalog-item ${active ? 'active' : ''}`,
                onClick: () => {
                  if (active) onSetRibbonItems(ribbonItems.filter(k => k !== item.key));
                  else onSetRibbonItems([...ribbonItems, item.key]);
                }
              },
                React.createElement("span", { className: "ribbon-catalog-short" }, item.short),
                React.createElement("span", { className: "ribbon-catalog-name" }, item.label)
              );
            })
          )
        ),
        activeSection === 'fx' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "flex justify-between items-center mb-3" },
            React.createElement("div", { className: "settings-section-title" }, "Live exchange rates"),
            React.createElement("button", {
              className: `btn btn-secondary btn-sm ${refreshing ? 'spin' : ''}`,
              onClick: refresh, disabled: refreshing
            }, React.createElement(Icon, { name: "refresh", size: 12 }),
               refreshing ? " Refreshing..." : " Refresh now")
          ),
          fxRates ? React.createElement(React.Fragment, null,
            React.createElement("div", { className: "card", style: { padding: 0, overflow: 'hidden' } },
              DISPLAY_CURRENCIES.filter(c => c.code !== displayCurrency).map((c, i, arr) => {
                const one = convertCcy(1, c.code, displayCurrency, rates);
                return React.createElement("div", { key: c.code, className: "fx-rate-row",
                  style: i < arr.length - 1 ? { borderBottom: '1px solid var(--border)' } : {} },
                  React.createElement("span", { className: "from" },
                    React.createElement("span", { className: "mono", style: { fontWeight: 600 } }, c.code),
                    React.createElement("span", { className: "text-dim text-xs" }, " · " + c.label)
                  ),
                  React.createElement("span", { className: "arrow" }, "→"),
                  React.createElement("span", { className: "rate mono" },
                    one != null ? (CURRENCY_SYMBOLS[displayCurrency] + one.toLocaleString('en-US', { maximumFractionDigits: 4 })) : '—'
                  )
                );
              })
            ),
            React.createElement("div", { className: "text-xs text-dim mt-2" },
              "Source: ", fxRates.source, " · fetched ",
              new Date(fxRates.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            )
          ) : React.createElement("div", { className: "settings-empty" },
            React.createElement(Icon, { name: "refresh", size: 24 }),
            React.createElement("p", null, "Rates not loaded — tap Refresh now.")
          )
        ),
        activeSection === 'data' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-data-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Backup data"),
              React.createElement("div", { className: "settings-row-desc" }, "Export positions, watchlist, alerts and contributions as JSON")
            ),
            React.createElement("button", { className: "btn btn-secondary btn-sm", onClick: onExport },
              React.createElement(Icon, { name: "download", size: 13 }), " Export")
          ),
          React.createElement("div", { className: "settings-data-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Restore backup"),
              React.createElement("div", { className: "settings-row-desc" }, "Import from a previously exported JSON backup file")
            ),
            React.createElement("button", { className: "btn btn-secondary btn-sm", onClick: () => fileInputRef.current?.click() },
              React.createElement(Icon, { name: "share", size: 13 }), " Import")
          ),
          React.createElement("input", {
            ref: fileInputRef, type: "file", accept: "application/json",
            style: { display: 'none' },
            onChange: e => { if (e.target.files[0]) onImport(e.target.files[0]); e.target.value = ''; }
          }),
          React.createElement("div", { className: "settings-info-box mt-3" },
            React.createElement("div", { className: "settings-info-body" },
              "Backups include all your positions, watchlist tickers, price alerts, and contribution history."
            )
          )
        )
      )
    )
  );
}

function InstallBanner(_ref13) {
  let {
    isIOS,
    onInstall,
    onDismiss,
    canPrompt
  } = _ref13;
  return React.createElement("div", {
    className: "install-banner"
  }, React.createElement("div", {
    className: "ib-icon"
  }, React.createElement(Icon, {
    name: "download",
    size: 18
  })), React.createElement("div", {
    className: "ib-text"
  }, React.createElement("b", null, "Install Playbook"), React.createElement("small", null, isIOS ? 'Tap Share → Add to Home Screen for full-screen & notifications' : 'Install for price alerts & notifications')), !isIOS && canPrompt && React.createElement("button", {
    className: "btn btn-primary btn-sm",
    onClick: onInstall
  }, "Install"), React.createElement("button", {
    className: "icon-btn",
    onClick: onDismiss,
    style: {
      width: 30,
      height: 30
    },
    "aria-label": "Close"
  }, React.createElement(Icon, {
    name: "x",
    size: 12
  })));
}
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('React crash:', error, info.componentStack); }
  render() {
    if (this.state.error) return React.createElement("div", { style: { padding: 32, color: '#f43f5e', fontFamily: 'monospace', whiteSpace: 'pre-wrap' } },
      React.createElement("h2", null, "Something went wrong"),
      React.createElement("pre", null, String(this.state.error?.stack || this.state.error)));
    return this.props.children;
  }
}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(ErrorBoundary, null, React.createElement(ToastProvider, null, React.createElement(App, null))));
// SW registration handled in index.html with auto-update logic