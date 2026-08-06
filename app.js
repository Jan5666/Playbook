"use strict";

const {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback
} = React;
const DATA = window.PB_DATA;
// Shared market-hours + alert evaluation (pb-core.js, loaded before this script
// in index.html). One implementation, shared with backend/worker.js, so the
// foreground app and the always-on push server can never disagree on whether an
// alert fired. If this is undefined the script tag is missing/failed to load.
const PBCore = window.PBCore;
// ─── Backup namespace ────────────────────────────────────────────────────────
// Every piece of user data the app persists lives under the `pb.` prefix in
// localStorage. A backup is therefore just the full set of those keys — new
// persisted state is captured automatically, with no hand-maintained field list
// to fall out of date. The SKIP set is volatile/re-derivable cache that isn't
// worth carrying (and, for the churny ones like prices, must NOT trigger a cloud
// sync on every write — see `_backupNotify`).
const BACKUP_PREFIX = 'pb.';
const BACKUP_SKIP = new Set([
  'pb.prices.v1',          // live quote cache, refetched on load
  'pb.nameCache.v1',       // ticker→name cache, rebuilt on demand
  'pb.fxRates.v1',         // refreshed from network
  'pb.sectorCache.v1',     // sector classifications, refetched
  'pb.heatmap.lastgood.v1',// last-good heatmap snapshot, recomputed
  'pb.rotation.lastgood.v1',// last-good rotation aggregates + series, recomputed
  'pb.installDismissed.v2',// per-device UI nag state
  'pb.hotStocks.v1',       // trending-stock suggestion cache, refetched
  'pb.backup.lastSync.v1'  // sync bookkeeping — excluding it avoids a sync loop
]);
// Installed by useCloudBackup; called (debounced) whenever durable state changes
// so the cloud copy is kept current. Null when cloud backup is off.
let _backupNotify = null;
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
      if (_backupNotify && key.startsWith(BACKUP_PREFIX) && !BACKUP_SKIP.has(key)) _backupNotify();
      return true;
    } catch (e) {
      console.warn('LS.set failed:', e);
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
      if (_backupNotify && key.startsWith(BACKUP_PREFIX) && !BACKUP_SKIP.has(key)) _backupNotify();
    } catch (e) {}
  }
};
// Snapshot every durable `pb.*` key as raw JSON strings so a restore round-trips
// byte-for-byte. The envelope carries a version + timestamp for forward compat.
function gatherBackup() {
  const keys = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(BACKUP_PREFIX) || BACKUP_SKIP.has(k)) continue;
    const v = localStorage.getItem(k);
    if (v != null) keys[k] = v;
  }
  return { v: 1, app: 'playbook', exportedAt: new Date().toISOString(), keys };
}
// Legacy (v3) flat exports stored named fields instead of raw pb.* keys. Map them
// back so old backup files still restore.
const LEGACY_KEY_MAP = {
  positions: 'pb.positions.v2',
  watchlist: 'pb.watchlist.v2',
  watchlistGroups: 'pb.watchlistGroups.v1',
  alerts: 'pb.alerts.v2',
  triggered: 'pb.triggered.v2',
  contributions: 'pb.contributions.v1',
  transactions: 'pb.transactions.v1',
  tfsaDeposits: 'pb.tfsa.deposits.v1'
};
// Write a backup envelope (or legacy flat object) back into localStorage. Returns
// the number of keys restored, or -1 if the payload wasn't recognisable.
function applyBackup(payload) {
  if (!payload || typeof payload !== 'object') return -1;
  let keys = null;
  if (payload.keys && typeof payload.keys === 'object') {
    keys = payload.keys; // new envelope: { key: rawJsonString }
  } else {
    keys = {};           // legacy flat: { positions: [...], ... }
    for (const field in LEGACY_KEY_MAP) {
      if (payload[field] !== undefined) keys[LEGACY_KEY_MAP[field]] = JSON.stringify(payload[field]);
    }
    if (Object.keys(keys).length === 0) return -1;
  }
  let n = 0;
  for (const k in keys) {
    if (!k.startsWith(BACKUP_PREFIX)) continue;
    try { localStorage.setItem(k, keys[k]); n++; } catch (_e) {}
  }
  return n;
}

// ─── Cloud-backup crypto ─────────────────────────────────────────────────────
// The recovery code is the only secret. From it we derive (a) a lookup key —
// SHA-256(code) — under which the encrypted blob is stored server-side, so the
// server never sees the code itself, and (b) an AES-GCM key via PBKDF2 that
// encrypts the snapshot client-side. The Worker stores opaque ciphertext: even
// with full KV access it cannot read your portfolio without the code. Losing the
// code means the cloud copy is unrecoverable — that's the trade-off for zero-knowledge.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford-ish: no I/L/O/U ambiguity
function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[bytes[i] % 32];
  return s.replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3'); // 60 bits, shown as XXXX-XXXX-XXXX
}
function normalizeCode(s) { return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function formatCode(s) { return normalizeCode(s).replace(/(.{4})/g, '$1-').replace(/-$/, ''); }
function _b64(bytes) {
  const a = new Uint8Array(bytes); let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}
function _unb64(b64) {
  const s = atob(b64); const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function deriveAesKey(code, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
async function encryptBlob(code, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(code, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { v: 1, salt: _b64(salt), iv: _b64(iv), ct: _b64(ct) };
}
async function decryptBlob(code, blob) {
  const key = await deriveAesKey(code, _unb64(blob.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _unb64(blob.iv) }, key, _unb64(blob.ct));
  return new TextDecoder().decode(pt);
}

// Save a backup to disk. In an iOS standalone PWA an `<a download>` is silently
// ignored, so prefer the Web Share sheet (saves into Files / iCloud Drive);
// fall back to a download anchor on desktop and browsers without file sharing.
async function saveBackupFile(jsonString) {
  const filename = `playbook-backup-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const file = new File([jsonString], filename, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Playbook backup' });
      return; // user saved or cancelled within the sheet
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user dismissed the share sheet
    // otherwise fall through to the download path
  }
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true, code: 'backup-saved' };
}
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
  const load = useCallback(async (key, fetcher, force = false) => {
    const existing = cacheRef.current[key];
    if (!force && existing && existing.data && Date.now() - existing.fetchedAt < ttlMs) return existing.data;
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
// useSwipeDownToClose moved to pb-modals.js (Phase 4 inc 34).
// MARKET_CURRENCY (native currency + display symbol per market) and the money
// helpers below it now live in pb-core.js so they can be unit-tested outside the
// 14k-line app.js. Bound to local names; canonical source is pb-core.js.
const MARKET_CURRENCY = PBCore.MARKET_CURRENCY;
const MARKETS = PBContent.MARKETS;
// JSE and TFSA are the same underlying exchange — a TFSA account just tracks
// JSE-listed shares (.JO) tax-free — so a JSE-listed search result is valid for
// either account. Used so picking a listing never silently flips the account
// the user explicitly chose (e.g. TFSA → JSE) when both map to the same listing.
// Canonical source is pb-core.js: yahooSymbol/centDivisor already encode the same
// fact, and the import matcher (pb-import.js, no access to app.js) needs it too.
const sameUnderlyingExchange = PBCore.sameUnderlyingExchange;
const DISPLAY_CURRENCIES = PBContent.DISPLAY_CURRENCIES;
const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS;
const RIBBON_CATALOG = PBContent.RIBBON_CATALOG;
const RIBBON_CATALOG_MAP = PBContent.RIBBON_CATALOG_MAP;
const DEFAULT_RIBBON_ITEMS = ['US:^SPX', 'US:^VIX'];
const INDICATOR_INFO = PBContent.INDICATOR_INFO;
const RULES = PBContent.RULES;
// The CORS proxy ladder now lives in pb-data.js (client-only network layer).
// Bound here so app.js call sites are unchanged. PBData is loaded before app.js.
const fetchViaProxies = PBData.fetchViaProxies;
// FX_PROXIES moved to pb-data.js with the two FX readers (GAPS #7). It is
// module-private there - only fetchFxRates / fetchHistoricalFx use it - so it is
// deliberately not bound back here.
// Yahoo reports JSE in cents (ZAc) and LSE in pence (GBp / GBX) for some
// instruments. Values reported in those units must be divided by 100 to get
// the natural unit (rand, pound). Matching is case-insensitive and accepts
// the pence-suffix forms because Yahoo isn't perfectly consistent.
const priceKey = PBCore.priceKey;
const buildFetchPlan = PBCore.buildFetchPlan;
// The quote/price/history providers, batchers, and ticker→name cache now live in
// pb-data.js (client-only network layer). Bound here so app.js call sites are
// unchanged; the indicator catalog (UI/content config) is injected once.
PBData.configure({ indicatorCatalog: RIBBON_CATALOG_MAP, displayCurrencies: DISPLAY_CURRENCIES });
const fetchQuote = PBData.fetchQuote;
const fetchQuoteBatch = PBData.fetchQuoteBatch;
const fetchQuoteBatchLight = PBData.fetchQuoteBatchLight;
const fetchQuoteLight = PBData.fetchQuoteLight;
const fetchHistory = PBData.fetchHistory;
const searchUnitTrusts = PBData.searchUnitTrusts;
// Bound here to keep the PBData delegation guard green even though the only former
// caller (HoldingRow) now lives in pb-views.js (Phase 4 inc 28).
const isUnitTrustId = PBData.isUnitTrustId;
const cacheName = PBData.cacheName;
const cachedName = PBData.cachedName;
// centDivisor + yahooSymbol now live in pb-core.js — the shared core the client
// and the push Worker both import — so both build identical Yahoo symbols and
// apply identical cent/pence price units. They used to be copy-pasted into each
// and had drifted (the Worker fetched the wrong instrument for ^SPX/^VIX and
// mis-scaled some JSE/LSE units). Bound to local names here; canonical source is
// pb-core.js. PBCore is initialized at the top of this file (window.PBCore), well
// before any call site below, so these const bindings are TDZ-safe.
const centDivisor = PBCore.centDivisor;
const yahooSymbol = PBCore.yahooSymbol;
// Blended-average-cost merge (the one true copy of the formula three call sites
// below — startup dedup, addPosition, importPositions — used to inline). Pure
// arithmetic; FX conversion of the incoming lot stays at the call site.
const mergeCostBasis = PBCore.mergeCostBasis;
// Build a [{t, p}] daily-bar series from a Yahoo chart result, applying the
// cent-unit divisor so callers can reason in natural units (rand, pound).
// The Yahoo chart parsers (buildDailyBars, marketDayKey, derivePrevClose,
// deriveIntradayExt, parseYahooQuote) now live in pb-core.js — pure, unit-tested
// over synthetic chart payloads (backend/test/quote-parsers.test.mjs). Bound to
// local names for the call sites below; marketDayKey stays core-internal (only
// derivePrevClose uses it) so it isn't rebound here. deriveIntradayExt gained an
// optional `now` arg in core for testing; the call site below uses the default.
const buildDailyBars = PBCore.buildDailyBars;
const derivePrevClose = PBCore.derivePrevClose;
const deriveIntradayExt = PBCore.deriveIntradayExt;
const parseYahooQuote = PBCore.parseYahooQuote;
// General numeric parser (currency-symbol / thousands-separator tolerant).
// Moved to pb-core.js (client-only pure util); ~40 call sites below unchanged.
const parseDecimal = PBCore.parseDecimal;
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
      // First value that is actually a number. `v(a) || v(b)` - what this used
      // to be - throws away a legitimate 0 (a zero-beta ETF, a debt-free
      // balance sheet) and silently reaches for the fallback field instead.
      const firstNum = (...xs) => { for (const x of xs) { const n = v(x); if (n != null) return n; } return null; };
      const firstPct = (...xs) => { for (const x of xs) { const n = v(x); if (n != null) return n * 100; } return null; };
      // Analyst targets arrive in the quote's own units - pence/cents for
      // GBp/ZAc listings - like bookValue; scale them to natural units so the
      // card's upside math against the (already-scaled) quote price is right.
      const tgt = x => { const n = v(x); return n != null ? n / divisor : null; };
      // Two currencies, never one (see PBCore.fundamentalsMoney): the price
      // module quotes the LISTING currency, financialData names the currency the
      // STATEMENTS are filed in, and for a JSE name reporting in dollars those
      // differ. `price` is the authority for anything priced, `financialCurrency`
      // for anything reported.
      const listingCcy = PBCore.baseCurrencyCode(curr, market);
      const statementCcy = PBCore.baseCurrencyCode(fd.financialCurrency || curr, market);
      // Per-share book value follows the STATEMENTS, so the pence/cents divisor
      // only applies when the statements are filed in the listing's currency -
      // dividing a dollar-denominated NAV by 100 because the share trades in
      // cents is how a NAV premium turns into nonsense.
      const bookRaw = v(ks.bookValue);
      const bookValue = bookRaw != null ? (statementCcy === listingCcy ? bookRaw / divisor : bookRaw) : null;
      // Yahoo has shipped BOTH conventions for summaryDetail.dividendYield
      // (0.0243 and 2.43 for one and the same 2.43%) and nothing in the payload
      // says which one arrived. Derive it instead from two figures whose units
      // are unambiguous AND identical - the trailing annual rate over the price
      // it is paid on - so the pence/cents divisor cancels out of the ratio.
      const divRate = firstNum(sd.trailingAnnualDividendRate, sd.dividendRate);
      const divPrice = firstNum(pr.regularMarketPrice, sd.previousClose);
      const dividendYield = (divRate != null && divPrice > 0) ? divRate / divPrice * 100 : null;
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
        marketCap: firstNum(sd.marketCap, pr.marketCap),
        peTrailing: firstNum(sd.trailingPE, ks.trailingPE),
        peForward: firstNum(sd.forwardPE, ks.forwardPE),
        pegRatio: v(ks.pegRatio),
        priceToBook: firstNum(ks.priceToBook, sd.priceToBook),
        bookValue,
        priceToSales: firstNum(ks.priceToSalesTrailing12Months, sd.priceToSalesTrailing12Months),
        eps: v(ks.trailingEps),
        epsForward: v(ks.forwardEps),
        beta: firstNum(sd.beta, ks.beta),
        dividendYield,
        dividendRate: divRate != null ? divRate / divisor : null,
        payoutRatio: pct(sd.payoutRatio),
        profitMargin: firstPct(fd.profitMargins, ks.profitMargins),
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
        targetMean: tgt(fd.targetMeanPrice),
        targetHigh: tgt(fd.targetHighPrice),
        targetLow: tgt(fd.targetLowPrice),
        recommendation: fd.recommendationKey || null,
        analystCount: v(fd.numberOfAnalystOpinions),
        volume: firstNum(sd.volume, sd.regularMarketVolume),
        avgVolume: firstNum(sd.averageVolume, sd.averageVolume10days),
        // Price-shaped fields, so they carry the quote's pence/cents units just
        // like the targets do. Left raw, a JSE 52-week range rendered 100x the
        // share price it was drawn next to.
        yearHigh: tgt(sd.fiftyTwoWeekHigh),
        yearLow: tgt(sd.fiftyTwoWeekLow),
        fiftyDayAvg: tgt(sd.fiftyDayAverage),
        twoHundredDayAvg: tgt(sd.twoHundredDayAverage),
        earningsDate,
        earningsDateEnd,
        epsEst,
        revEst,
        dividendDate: dvFwd ? dvFwd * 1000 : null,
        sector: ap.sector || null,
        industry: ap.industry || null,
        employees: v(ap.fullTimeEmployees),
        // Statement currency (revenue, EBITDA, cash flow, EPS) vs listing
        // currency (the market cap). `curr` is Yahoo's raw quote code and can be
        // a minor unit ("ZAc"), so both are normalised to a major-unit base.
        currency: statementCcy,
        marketCapCurrency: listingCcy,
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
    PAR: 'Euronext Paris', AMS: 'Euronext Amsterdam', US: 'US markets',
    CRYPTO: 'cryptocurrency (USD spot market)'
  }[market] || market;
  const prompt = `Return current fundamentals for ${name} (ticker ${ticker}, ${exchangeLabel}) as compact JSON only, no prose, no markdown.

Shape (null for unknown values):
{
  "currency": string (ISO 4217 code the FINANCIAL STATEMENTS below are reported in, e.g. "USD"),
  "marketCapCurrency": string (ISO 4217 code the market cap is quoted in - the currency the share TRADES in),
  "marketCap": number (absolute, in marketCapCurrency, e.g. 2500000000000),
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
      // The model is asked to name both currencies explicitly. It used to name
      // neither, and an empty string made every reader assume the market's own
      // currency - so a dollar answer about a rand-listed company was read as
      // rand. An unparseable/absent code falls back to the market, which is the
      // right guess for the large majority of listings.
      currency: PBCore.baseCurrencyCode(typeof p.currency === 'string' ? p.currency : '', market),
      marketCapCurrency: PBCore.baseCurrencyCode(typeof p.marketCapCurrency === 'string' ? p.marketCapCurrency : '', market),
      divisor: 1,
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
// stockanalysis.com exchange codes for its international quote endpoint
// (/api/symbol/q/<EXCHANGE>:<TICKER>). US listings use the /s/<TICKER> path;
// everything else is namespaced by exchange. TFSA is JSE under the hood.
const SA_EXCHANGE = {
  JSE: 'JSE', TFSA: 'JSE', LSE: 'LON', ASX: 'ASX',
  FRA: 'FRA', PAR: 'EPA', AMS: 'AMS'
};
// Build the stockanalysis.com API base for a listing. US (and crypto, which we
// don't source here) use the bare /s/ stock path; other exchanges use the
// /q/<EXCHANGE>:<TICKER> quote path so JSE/LSE/ASX/EU holdings resolve too.
function stockAnalysisBase(ticker, market) {
  const t = encodeURIComponent(String(ticker).toUpperCase());
  const ex = SA_EXCHANGE[market];
  if (ex) return `https://stockanalysis.com/api/symbol/q/${ex}:${t}`;
  return `https://stockanalysis.com/api/symbol/s/${t}`;
}
// stockanalysis.com's /api/symbol endpoints went dark on 2026-07-12: every
// path 404s (only the /api/quotes endpoint survives, and it has no
// fundamentals). The requests stay as a cheap opportunistic probe so the
// source self-heals if the API ever comes back. Analyst targets now arrive
// via the /forecast/ page-data instead (fetchAnalystForecastSA below); sector
// and earnings date stay lost until then (Yahoo's timeseries covers ratios).
//
// One direct, time-boxed request per URL - NEVER the 6-proxy cascade. The
// site serves Access-Control-Allow-Origin: * again (PR #22's no-CORS
// observation flipped back), and a dead URL through the proxy chain burned
// ~25s (two proxies hang until their 8s abort) INSIDE the Promise.all that
// gates the card's stats render - live timeseries data sat ready at ~400ms
// while the block showed "Loading...". That render stall was the "missing
// fundamentals" bug. Any direct-fetch failure mode (404, CORS, network) is
// sub-second, and the abort timer bounds a hanging edge.
async function fetchJsonDirect(url, timeoutMs = 4000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(url, { signal: ctrl ? ctrl.signal : undefined });
    if (!r.ok) return null;
    return await r.json();
  } catch (_e) {
    return null;
  } finally { if (t) clearTimeout(t); }
}
async function fetchFundamentalsStockAnalysis(ticker, market) {
  const base = stockAnalysisBase(ticker, market);
  const getJson = (path) => fetchJsonDirect(`${base}/${path}`);
  let ov = null, st = null;
  try {
    const [ovr, str] = await Promise.all([getJson('overview'), getJson('statistics')]);
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
    // stockanalysis reports each listing in its own exchange currency (rand for
    // JSE, pence-free pounds for LSE, …) in natural units — so the divisor is 1
    // and the currency follows the market, not a hardcoded USD. Market cap is
    // quoted the same way, hence the identical code for both.
    currency: (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).code,
    marketCapCurrency: (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).code,
    divisor: 1,
    fetchedAt: Date.now(),
    source: 'stockanalysis'
  };
  // Require at least a couple of real values to count as a hit.
  const filled = Object.values(result).filter(v => typeof v === 'number' && isFinite(v)).length;
  return filled >= 3 ? result : null;
}
// stockanalysis.com's public /forecast/ pages still ship their SvelteKit
// page-data (__data.json) even though the /api/symbol tree is 404-dead - it
// carries the S&P Global analyst consensus (price targets + ratings) the dead
// API used to supply. Unlike /api/symbol this endpoint sends NO
// Access-Control-Allow-Origin header (verified 2026-07-12 with an explicit
// Origin request header), so a direct browser fetch can never read it - it
// HAS to ride the CORS-proxy chain, same as the Yahoo timeseries. The outer
// Promise.race time-box keeps the lesson of the dead-API stall (see
// fundamentals-parse.test.mjs): even a pathological proxy-chain crawl cannot
// hold the card's stats render hostage - worst case the card ships without
// analyst targets for one TTL cycle, which is exactly the pre-fix behaviour.
async function fetchAnalystForecastSA(ticker, market) {
  if (market === 'CRYPTO') return null;
  const t = encodeURIComponent(String(ticker).toUpperCase());
  const ex = SA_EXCHANGE[market];
  const url = ex
    ? `https://stockanalysis.com/quote/${ex.toLowerCase()}/${t}/forecast/__data.json`
    : `https://stockanalysis.com/stocks/${t.toLowerCase()}/forecast/__data.json`;
  const work = (async () => {
    const text = await fetchViaProxies(url, { timeoutMs: 8000 });
    if (!text) return null;
    let data;
    try { data = JSON.parse(text); } catch (_e) { return null; }
    return PBCore.parseSAForecast(data, market);
  })();
  const timeBox = new Promise(resolve => setTimeout(() => resolve(null), 12000));
  return Promise.race([work, timeBox]);
}
// Yahoo's fundamentals-timeseries API — the endpoint Yahoo's own statistics
// page reads — is NOT crumb-gated like v10 quoteSummary, so it works keyless
// through the same CORS-proxy chain that already serves quotes and charts in
// production. It supplies valuation ratios plus statement items the parser
// (pb-core.js) derives margins/ROE/debt-to-equity/growth from. Types Yahoo doesn't know
// are simply absent from the response, so unrecognised names cost nothing.
const YF_TIMESERIES_TYPES = [
  'quarterlyMarketCap', 'trailingMarketCap',
  'quarterlyPeRatio', 'trailingPeRatio',
  'quarterlyForwardPeRatio', 'trailingForwardPeRatio',
  'quarterlyPegRatio', 'trailingPegRatio',
  'quarterlyPsRatio', 'trailingPsRatio',
  'quarterlyPbRatio', 'trailingPbRatio',
  'annualTotalRevenue', 'trailingTotalRevenue',
  'annualNetIncome', 'trailingNetIncome',
  'annualDilutedEPS', 'trailingDilutedEPS',
  'annualOperatingIncome', 'trailingOperatingIncome',
  'annualFreeCashFlow', 'trailingFreeCashFlow',
  'annualOperatingCashFlow', 'trailingOperatingCashFlow',
  'annualEBITDA', 'trailingEBITDA',
  'annualNormalizedEBITDA', 'trailingNormalizedEBITDA',
  'annualStockholdersEquity', 'annualTotalDebt',
  'annualCurrentAssets', 'annualCurrentLiabilities'
].join(',');
async function fetchFundamentalsYahooTimeseries(ticker, market) {
  const sym = yahooSymbol(ticker, market);
  const now = Math.floor(Date.now() / 1000);
  const p1 = now - 5 * 365 * 24 * 3600; // 5y back: enough for YoY growth off annuals
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const h of hosts) {
    const url = `https://${h}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}` +
      `?symbol=${encodeURIComponent(sym)}&type=${YF_TIMESERIES_TYPES}&period1=${p1}&period2=${now}` +
      `&merge=false&padTimeSeries=true&lang=en-US&region=US`;
    const text = await fetchViaProxies(url, { timeoutMs: 10000 });
    if (!text) continue;
    let data;
    try { data = JSON.parse(text); } catch (_e) { continue; }
    const parsed = PBCore.parseFundamentalsTimeseries(data, market);
    if (parsed) return parsed;
  }
  return null;
}
// Trailing-twelve-month dividends, straight off the chart API's dividend
// events. Neither keyless stats source carries a dividend yield any more (the
// timeseries never did, stockanalysis's symbol API is 404-dead), so without
// this the card simply has no yield for almost every holding. Deliberately its
// OWN url: `events=div` rides an interval=1d request, and the quote fetch's
// daily bars are load-bearing for the day move (see the includePrePost rule in
// CLAUDE.md) - they do not get to share a request.
// The outer time-box is the lesson of the dead-API stall (fundamentals-parse
// .test.mjs): this rides the same Promise.all that gates the card's stats
// render, so a crawling proxy chain on a nice-to-have field must never be what
// the user waits for. Worst case the card ships without a yield for one TTL.
async function fetchDividendEventsYahoo(ticker, market) {
  const sym = yahooSymbol(ticker, market);
  const work = (async () => {
    const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
    for (const h of hosts) {
      const url = `https://${h}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y&events=div`;
      const text = await fetchViaProxies(url, { timeoutMs: 5000 });
      if (!text) continue;
      let data;
      try { data = JSON.parse(text); } catch (_e) { continue; }
      const parsed = PBCore.parseDividendEvents(data, market);
      if (parsed) return parsed;
    }
    return null;
  })();
  const timeBox = new Promise(resolve => setTimeout(() => resolve(null), 10000));
  return Promise.race([work, timeBox]);
}
async function fetchFundamentals(ticker, market, companyName, perplexityKey) {
  // Free keyless sources first, in parallel: stockanalysis.com (analyst
  // targets, earnings date, sector) and Yahoo's fundamentals-timeseries
  // (valuation ratios + statement-derived metrics). Each fails independently
  // in production — stockanalysis intermittently blocks the shared CORS
  // proxies, quoteSummary is crumb-gated — so partial results are MERGED
  // (earlier source wins per field) instead of first-hit-wins. Crypto has no
  // fundamentals on either, so it goes straight to quoteSummary.
  const parts = [];
  if (market !== 'CRYPTO') {
    const [fcast, div, sa, ts] = await Promise.all([
      fetchAnalystForecastSA(ticker, market),
      fetchDividendEventsYahoo(ticker, market),
      fetchFundamentalsStockAnalysis(ticker, market),
      fetchFundamentalsYahooTimeseries(ticker, market)
    ]);
    if (fcast) parts.push(fcast);
    // Ahead of the stats sources on purpose: a yield computed from dividends
    // actually paid, over the price they are paid on, beats any source's
    // pre-computed field (Yahoo's is percent-or-fraction ambiguous).
    if (div) parts.push(div);
    if (sa) parts.push(sa);
    if (ts) parts.push(ts);
  }
  // quoteSummary usually 401s without a crumb, but it's free to try when the
  // primary sources came up empty (and it's the only non-AI crypto source).
  // The forecast and dividend parts carry only their own narrow fields, so
  // neither counts as having fundamentals - the stats fallbacks still fire.
  const NON_STATS_SOURCES = new Set(['sa-forecast', 'yahoo-div']);
  const hasStats = () => parts.some(p => !NON_STATS_SOURCES.has(p.source));
  if (!hasStats()) {
    const yahoo = await fetchFundamentalsYahoo(ticker, market);
    if (yahoo) parts.push(yahoo);
  }
  if (!hasStats() && perplexityKey) {
    const ai = await fetchFundamentalsPerplexity(ticker, market, companyName, perplexityKey);
    if (ai) parts.push(ai);
  }
  const merged = PBCore.mergeFundamentals(parts);
  // None of the keyless primaries carries an earnings date any more (the
  // timeseries parser never did, the SA symbol API is dead) — backfill it
  // from the overview page-data probe, which is 12h-cached and usually
  // already warmed by the Hot Topics sweep.
  if (merged && merged.earningsDate == null && market === 'US') {
    const ed = await fetchEarningsDateSA(ticker);
    if (ed) merged.earningsDate = ed;
  }
  return merged;
}
// Lightweight sector/industry lookup for the background allocator fill — one
// CORS-open request to stockanalysis.com (US listings). Used to self-heal any
// holding the static map can't classify, so the dashboard stops dumping odd
// tickers into "Other". Returns raw labels; the caller normalises them.
async function fetchSectorStockAnalysis(ticker) {
  try {
    // Direct + time-boxed like fetchFundamentalsStockAnalysis (see the note
    // there): the API is 404-dead and CORS-open again, so riding the proxy
    // cascade only burns ~25s and shared-proxy rate limits per lookup.
    const j = await fetchJsonDirect(`https://stockanalysis.com/api/symbol/s/${encodeURIComponent(String(ticker).toUpperCase())}/overview`);
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
    PAR: 'Euronext Paris', AMS: 'Euronext Amsterdam', US: 'US markets',
    CRYPTO: 'cryptocurrency (USD spot market)'
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
// ─── Hot Topics: earnings calendar + macro/energy events ─────────────────────
// Big-name universe used to (a) hint the AI and (b) drive the no-key fallback.
const HOT_MEGACAPS = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','ORCL','NFLX','AMD',
  'JPM','V','MA','BAC','WMT','COST','HD','PG','KO','XOM','CVX','LLY','UNH','JNJ',
  'CRM','ADBE','PLTR','MU','INTC','DIS','BA','CAT','GE','TSM','ASML','MSTR'
];
const HOT_JSE = ['NPN','PRX','FSR','SBK','CPI','BTI','AGL','BHG','SOL','MTN','SHP','CFR','GFI','ANG'];
const BUILTIN_MACRO_2026 = PBContent.BUILTIN_MACRO_2026;
// Normalize a date-only 'YYYY-MM-DD' string or a ms timestamp to local midnight.
function hotToDate(v) {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) { const d = new Date(v); d.setHours(0, 0, 0, 0); return d; }
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function hotDayDiff(date) {
  if (!date) return NaN;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  return Math.round((date - t0) / 86400000);
}
// Format LOCAL Y-M-D — never toISOString(), which rolls a local-midnight Date
// back a day in positive-UTC-offset zones (e.g. SAST UTC+2) and shifts dates.
function hotDateKey(v) {
  const d = hotToDate(v);
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// One Perplexity call returns earnings + macro + news, minimizing token cost.
async function fetchHotTopicsAI(apiKey, tickers) {
  if (!apiKey) return null;
  const today = new Date().toISOString().slice(0, 10);
  const watched = (tickers || []).slice(0, 40).join(', ');
  const prompt = `Today is ${today}. Build a market "hot topics" briefing for an investor. Respond with STRICT JSON only (no markdown, no prose), exactly this shape:
{
 "earnings": [{"ticker":"AAPL","company":"Apple","date":"YYYY-MM-DD","when":"BMO|AMC|TBD","market":"US|JSE|LSE|EU"}],
 "macro": [{"date":"YYYY-MM-DD","title":"...","type":"Fed|ECB|BOJ|BOE|SARB|Data|Energy|Geo","detail":"max 90 chars"}],
 "news": [{"title":"...","summary":"max 140 chars","date":"YYYY-MM-DD","source":"...","url":"https://..."}]
}
earnings: big-name / market-moving companies reporting in the next 30 days (global mega-caps and notable JSE names). Always include any of these tickers that report in that window: ${watched}.
macro: scheduled central-bank meetings (US Fed, ECB, Bank of Japan, Bank of England, South Africa SARB), major US/global data (CPI, PCE, jobs/NFP), OPEC+/energy and clearly market-moving geopolitical events in the next 30 days.
news: the 5 most important market-moving or global-energy news items right now.
Order every array by date ascending. Use real, accurate dates; if unsure of a date, omit that item.`;
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'You return only valid JSON. No prose, no markdown fences.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 2000
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch (_e) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try { parsed = JSON.parse(m[0]); } catch (_e2) { return null; }
    }
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_e) { return null; }
}
// Per-ticker upcoming earnings date from stockanalysis.com's overview
// page-data (__data.json). The /api/symbol tree this used to read died
// upstream on 2026-07-12 (GAPS.md #18); the SvelteKit page-data still ships
// the date, but sends no ACAO header, so — like the forecast page-data — it
// has to ride the CORS-proxy chain, with an outer time-box so a pathological
// proxy crawl can't stall the Hot Topics build. Cached 12h (nulls too).
// Reliable for US names; JSE/other are left to the AI path, which covers
// exchanges stockanalysis doesn't.
const SA_EARN_CACHE = {};
async function fetchEarningsDateSA(ticker) {
  const up = (ticker || '').toUpperCase();
  if (!up) return null;
  const c = SA_EARN_CACHE[up];
  if (c && Date.now() - c.fetchedAt < 12 * 3600 * 1000) return c.date;
  try {
    const url = `https://stockanalysis.com/stocks/${encodeURIComponent(up.toLowerCase())}/__data.json`;
    const work = (async () => {
      const text = await fetchViaProxies(url, { timeoutMs: 8000 });
      if (!text) return null;
      let data;
      try { data = JSON.parse(text); } catch (_e) { return null; }
      return PBCore.parseSAOverviewEarnings(data);
    })();
    const timeBox = new Promise(resolve => setTimeout(() => resolve(null), 12000));
    const ms = await Promise.race([work, timeBox]);
    SA_EARN_CACHE[up] = { date: ms, fetchedAt: Date.now() };
    return ms;
  } catch (_e) { return null; }
}
// Bounded-concurrency map so a ~40-ticker sweep doesn't open 40 sockets at once.
async function poolMap(items, concurrency, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}
// Merge live AI output (when a key is set) with actively-fetched earnings dates
// for US names, the built-in macro calendar, and any cached fundamentals.
async function buildHotTopics(apiKey, userSymbols, fundamentals, heldTickers) {
  // The full universe (holdings + watchlist + curated mega-cap/JSE names) drives
  // which stocks the briefing covers. The "Yours" badge, however, must reflect
  // only actual portfolio holdings — so it's keyed off a separate held-set.
  const universeTickers = new Set((userSymbols || []).map(s => s.ticker));
  const owned = heldTickers instanceof Set ? heldTickers : universeTickers;
  // Fetch the AI briefing and the US earnings sweep in parallel to cut latency.
  const usSymbols = (userSymbols || []).filter(s => s.market === 'US');
  const [ai, saDates] = await Promise.all([
    fetchHotTopicsAI(apiKey, [...universeTickers]),
    poolMap(usSymbols, 8, s => fetchEarningsDateSA(s.ticker).catch(() => null))
  ]);

  // ── Earnings (deduped by ticker — one upcoming report per name) ──
  const earnings = [];
  const seenEarn = new Set();
  const pushEarn = (e) => {
    const ticker = (e.ticker || '').toUpperCase();
    if (!ticker || seenEarn.has(ticker)) return;
    if (!hotToDate(e.date)) return;
    seenEarn.add(ticker);
    earnings.push({
      ticker,
      company: e.company || cachedName(e.market || 'US', ticker) || '',
      market: e.market || 'US',
      date: hotDateKey(e.date),
      when: e.when || 'TBD',
      yours: owned.has(ticker)
    });
  };
  // Priority: AI (has BMO/AMC + company) → live US sweep → cached fundamentals.
  if (ai && Array.isArray(ai.earnings)) ai.earnings.forEach(pushEarn);
  usSymbols.forEach((s, i) => { if (saDates[i]) pushEarn({ ticker: s.ticker, market: 'US', date: saDates[i], when: 'TBD' }); });
  for (const s of userSymbols || []) {
    const f = fundamentals?.[s.market + ':' + s.ticker]?.data;
    if (f && f.earningsDate) pushEarn({ ticker: s.ticker, market: s.market, date: f.earningsDate, when: 'TBD', company: f.name });
  }
  const upcomingEarnings = earnings
    .filter(e => { const d = hotDayDiff(hotToDate(e.date)); return d >= 0 && d <= 31; })
    .sort((a, b) => hotToDate(a.date) - hotToDate(b.date));

  // ── Macro ──
  const macro = [];
  const seenMacro = new Set();
  const pushMacro = (m) => {
    const d = hotToDate(m.date);
    if (!d) return;
    const diff = hotDayDiff(d);
    if (diff < 0 || diff > 45) return;
    const key = hotDateKey(m.date) + '|' + (m.type || '').toUpperCase();
    if (seenMacro.has(key)) return;
    seenMacro.add(key);
    macro.push({ date: hotDateKey(m.date), title: m.title || '', type: (m.type || 'Event'), detail: m.detail || '' });
  };
  if (ai && Array.isArray(ai.macro)) ai.macro.forEach(pushMacro);
  BUILTIN_MACRO_2026.forEach(pushMacro);
  macro.sort((a, b) => hotToDate(a.date) - hotToDate(b.date));

  // ── News ──
  const news = (ai && Array.isArray(ai.news) ? ai.news : [])
    .filter(n => n && n.title)
    .slice(0, 6)
    .map(n => ({ title: String(n.title).slice(0, 200), summary: n.summary ? String(n.summary).slice(0, 200) : '', source: n.source || 'Perplexity', link: n.url || '#', pubDate: n.date || null, ai: true }));

  return { earnings: upcomingEarnings, macro, news, aiUsed: !!ai, generatedAt: Date.now() };
}
// The FX providers (fetchFxRates, fetchHistoricalFx) + their FX_PROXIES ladder and
// HISTORICAL_FX_CACHE now live in pb-data.js - the client-only network layer - so the
// last network code leaves app.js (GAPS #7). Behaviour was pinned by a before/after
// characterization matrix first (backend/test/fx-providers.test.mjs): proxy-ladder order,
// the no-store / force-cache directives, the >=2-rate threshold, and the rule that a
// failed historical lookup is NOT cached. DISPLAY_CURRENCIES is injected into pb-data via
// PBData.configure above (pb-data never reaches into app.js/pb-content globals). Bound to
// local names here so the 4 call sites below are unchanged; PBData is initialized before
// app.js runs, so these binds are TDZ-safe.
const fetchFxRates = PBData.fetchFxRates;
const fetchHistoricalFx = PBData.fetchHistoricalFx;
// The money helpers (convertCcy, contribInDisplay, marketCurrency, positionCostCcy,
// valuePositionInCostCcy, resolvePositionUpdates) now live in pb-core.js — pure,
// unit-tested in isolation (backend/test/money-math.test.mjs). Bound to local
// names here so the ~20 call sites below are unchanged. PBCore is initialized at
// the top of this file, well before any of these run, so the bindings are TDZ-safe.
const convertCcy = PBCore.convertCcy;
const contribInDisplay = PBCore.contribInDisplay;
const marketCurrency = PBCore.marketCurrency;
const positionCostCcy = PBCore.positionCostCcy;
const valuePositionInCostCcy = PBCore.valuePositionInCostCcy;
const resolvePositionUpdates = PBCore.resolvePositionUpdates;
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
// Plain number with thousands separators + 2 decimals (no currency symbol).
// Use wherever a price/value is concatenated with its own symbol so large
// figures read as "1,929.68" rather than "1929.68".
function fmtNum(n, decimals = 2) {
  if (n == null || !isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
// Returns the catalog descriptor for a macro/market indicator (those carrying a
// `unit`), or null for ordinary stocks. `unit` is the single flag that flips a
// detail card into "indicator" mode.
function indicatorFor(market, ticker) {
  const c = RIBBON_CATALOG_MAP[priceKey(market, ticker)];
  return (c && c.unit) ? c : null;
}
// Unit-aware value formatter for indicators: yields/CPI as "4.45%", DXY/DJT as
// "98.50"/"16,120", Global Liquidity as "$18.05T", payrolls as "+172K", and the
// Fear & Greed score as a bare 0–100 integer.
function fmtIndicator(cat, v, opts) {
  if (v == null || !isFinite(v)) return '—';
  const d = cat && cat.decimals != null ? cat.decimals : 2;
  const signed = opts && opts.signed;
  const sign = v > 0 ? '+' : (v < 0 ? '−' : '');
  const abs = Math.abs(v);
  switch (cat && cat.unit) {
    case 'pct':    return (signed ? sign : (v < 0 ? '−' : '')) + abs.toFixed(d) + '%';
    case 'score':  return (signed ? sign : '') + String(Math.round(abs));
    case 'usd_t':  return (signed ? sign : (v < 0 ? '−' : '')) + '$' + abs.toFixed(d) + 'T';
    case 'k_jobs': return (signed ? sign : (v < 0 ? '−' : '')) + abs.toLocaleString('en-US', { maximumFractionDigits: 0 }) + 'K';
    case 'index':  return (signed ? sign : (v < 0 ? '−' : '')) + abs.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    default:       return (signed ? sign : (v < 0 ? '−' : '')) + fmtNum(abs, d);
  }
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
// Adapter over the shared evaluator in pb-core.js (the same one backend/worker.js
// runs, so foreground and server-push verdicts can't drift). The client holds
// quotes as { price, fetchedAt } objects and must not fire on stale data, so we
// build the number-keyed price map the core expects, dropping any quote older
// than the cooldown (the server skips this — it fetches fresh each run). The
// trigger state machine itself lives in PBCore.evaluateAlerts.
function evaluateTriggers(alerts, prices, seen) {
  const now = Date.now();
  const nums = {};
  for (const a of alerts) {
    const key = priceKey(a.market, a.ticker);
    const p = prices[key];
    if (!p || typeof p.price !== 'number' || !isFinite(p.price)) continue;
    // Skip stale prices (>cooldown old) — triggers must not fire on outdated
    // data that may no longer reflect the market.
    if (typeof p.fetchedAt === 'number' && (now - p.fetchedAt) > PBCore.TRIGGER_COOLDOWN_MS) continue;
    nums[key] = p.price;
  }
  const { nextSeen, newTriggers } = PBCore.evaluateAlerts(alerts, nums, seen, { now });
  // Preserve the prior "did the persisted seen-map change?" semantics exactly
  // (length, per-key value, and dropped-alert detection) so persistence cadence
  // is unchanged from before the shared-core swap.
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
      if (!(k in nextSeen)) { seenChanged = true; break; }
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
    search: React.createElement("g", null, React.createElement("circle", {
      cx: "11", cy: "11", r: "7"
    }), React.createElement("path", {
      d: "m21 21-4.35-4.35"
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
    flame: React.createElement("g", null, React.createElement("path", {
      d: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
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
    image: React.createElement("g", null, React.createElement("rect", {
      x: "3", y: "3", width: "18", height: "18", rx: "2", ry: "2"
    }), React.createElement("circle", {
      cx: "8.5", cy: "8.5", r: "1.5"
    }), React.createElement("path", {
      d: "M21 15l-5-5L5 21"
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
    }),
    grip: React.createElement("g", { fill: "currentColor", stroke: "none" },
      React.createElement("circle", { cx: "9", cy: "6", r: "1.4" }),
      React.createElement("circle", { cx: "15", cy: "6", r: "1.4" }),
      React.createElement("circle", { cx: "9", cy: "12", r: "1.4" }),
      React.createElement("circle", { cx: "15", cy: "12", r: "1.4" }),
      React.createElement("circle", { cx: "9", cy: "18", r: "1.4" }),
      React.createElement("circle", { cx: "15", cy: "18", r: "1.4" })),
    link: React.createElement("g", null, React.createElement("path", {
      d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
    }), React.createElement("path", {
      d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
    })),
    sort: React.createElement("g", null, React.createElement("path", {
      d: "m3 8 4-4 4 4"
    }), React.createElement("path", {
      d: "M7 4v16"
    }), React.createElement("path", {
      d: "m21 16-4 4-4-4"
    }), React.createElement("path", {
      d: "M17 20V4"
    })),
    filter: React.createElement("polygon", {
      points: "22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"
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
const PRICES_PERSIST_MS = 1200;       // trailing quiet period before a price write
const PRICES_PERSIST_MAX_MS = 10000;  // hard checkpoint ceiling for a merge stream
// How long one price sweep may hold the UI in "Updating…" before the feed admits
// defeat. Not a cancellation — the sweep runs on and its batches keep painting —
// just the point past which the chip must stop claiming progress and the refresh
// button must become pressable again. Comfortably longer than a healthy full
// sweep on mobile data, comfortably shorter than a user's patience.
const SWEEP_WATCHDOG_MS = 60000;
// ─── Market hours ────────────────────────────────────────────────────────────
// Sessions table + marketOpen/anyMarketOpen now live in pb-core.js (loaded before
// this script), shared with backend/worker.js so the poll cadence and the push
// server agree on what's open. These bindings keep the existing call sites
// (marketOpen / anyMarketOpen / MARKET_SESSIONS) working unchanged.
const MARKET_SESSIONS = PBCore.SESSIONS;
const marketOpen = PBCore.marketOpen;
const anyMarketOpen = PBCore.anyMarketOpen;
const marketSession = PBCore.marketSession;
const quoteTradedToday = PBCore.quoteTradedToday;
const fmtAgo = PBCore.fmtAgo;
const refreshChipState = PBCore.refreshChipState;
// One shared ticking clock so the freshness chip can re-render "Updated Ns ago"
// without touching the price feed. ~5s cadence is plenty (the chip never needs
// sub-5s precision); this is the only timer the refresh-confidence UX adds.
function useNow(intervalMs = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
function usePriceFeed(order, fetchKey) {
  // Seed the store's prices slice once from the rehydrated localStorage cache so
  // the app paints real numbers on open. The map now lives in PBStore, not React
  // state — so a batch merge re-renders only store subscribers, not all of App.
  useState(() => {
    const saved = LS.get(PRICES_LS_KEY, null);
    const now = Date.now();
    const fresh = {};
    if (saved && typeof saved === 'object') {
      for (const k in saved) {
        const q = saved[k];
        if (q && typeof q.price === 'number' && (!q.fetchedAt || now - q.fetchedAt < PRICES_MAX_AGE_MS)) fresh[k] = q;
      }
    }
    PBStore.setPricesMap(fresh);
    return null;
  });
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  // Latest fetch order, read by runFetch so a queued follow-up sweep (e.g. one
  // forced after a tab switch floats the active list to the front) uses the newest
  // order, not the order captured when the in-flight sweep began.
  const orderRef = useRef(order);
  orderRef.current = order;
  const [lastUpdate, setLastUpdate] = useState(null);
  const [failStreak, setFailStreak] = useState(0);
  // Debounced persist so a burst of merges writes once. The scheduler lives in
  // pb-store.js (Node-testable; see backend/test/write-scheduler.test.mjs) and
  // fixes three things the old inline setTimeout got wrong: it reads the map at
  // fire time so a queued write can never persist a stale snapshot, it
  // checkpoints every PRICES_PERSIST_MAX_MS so a merge stream arriving faster
  // than the quiet period cannot defer the write forever, and it can be flushed
  // on the way out (below). The 1200ms quiet period itself is unchanged.
  const persistRef = useRef(null);
  if (!persistRef.current) {
    persistRef.current = PBStore.createWriteScheduler({
      write: () => LS.set(PRICES_LS_KEY, PBStore.getPrices()),
      delay: PRICES_PERSIST_MS,
      maxDelay: PRICES_PERSIST_MAX_MS
    });
  }
  const persistPrices = useCallback(() => { persistRef.current.schedule(); }, []);
  // iOS freezes/discards a backgrounded PWA and kills pending timers, so a sweep
  // that lands just before the user swipes away would otherwise never reach
  // localStorage — and the seed-on-open above would paint stale numbers.
  useEffect(() => {
    const flush = () => { persistRef.current.flush(); };
    const onHide = () => { if (document.hidden) flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, []);
  // Plausibility-gate a quote batch against the currently accepted quotes
  // before it reaches the store: a transiently mis-scaled Yahoo response (the
  // pence/cents divisor glitch) is held back so it never renders a bogus
  // holding value, while a real split/repricing is accepted once it persists
  // (PBCore.guardQuote owns the rules). Rejected symbols keep their last good
  // quote; untouched symbols are not cloned, preserving the memo contract.
  const guardBatch = useCallback((obj) => {
    const cur = PBStore.getPrices();
    const now = Date.now();
    const out = {};
    for (const k in obj) out[k] = obj[k] ? PBCore.guardQuote(cur[k], obj[k], now).quote : obj[k];
    return out;
  }, []);
  // Merge externally-fetched quotes (e.g. a just-added holding) so the
  // dashboard charts update the instant a position is created, without waiting
  // for the next 90s poll to cycle through every ticker.
  const mergePrices = useCallback((obj) => {
    if (!obj || !Object.keys(obj).length) return;
    PBStore.mergePrices(guardBatch(obj));
    persistPrices();
  }, [persistPrices, guardBatch]);
  // A manual tap that arrives mid-fetch sets this so the in-flight run loops
  // once more (with cache-bust) the moment it finishes — the press always ends
  // in genuinely fresh data instead of being silently dropped by the guard.
  const pendingForceRef = useRef(false);
  // Which sweep owns the shared loading flags. A sweep that outlives its watchdog
  // and finishes AFTER a newer one started must not clear the newer one's spinner
  // or its "Updating…" chip, so every release is checked against this.
  const sweepSeqRef = useRef(0);
  const runFetch = useCallback(async (cacheBust) => {
    const seq = ++sweepSeqRef.current;
    loadingRef.current = true;
    setLoading(true);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (seq !== sweepSeqRef.current) return;   // a newer sweep owns the flags now
      loadingRef.current = false;
      setLoading(false);
    };
    // A sweep must never be able to latch the UI on "Updating…". Every individual
    // network read is deadlined in pb-data (fetchWithDeadline), but a sweep is
    // dozens of them plus batch sequencing, so a bad enough network can still run
    // far longer than anyone will wait — and while loadingRef stays true both the
    // auto-poll and the manual button early-return, which is exactly how "I press
    // refresh and nothing happens" used to feel.
    //
    // The watchdog does NOT cancel the sweep: its onBatch merges keep painting as
    // they land. It releases the UI so the chip can tell the truth and the next
    // press starts a genuinely fresh, cache-busted run.
    const watchdog = setTimeout(() => {
      if (seq !== sweepSeqRef.current) return;
      setFailStreak(prev => prev + 1);
      release();
    }, SWEEP_WATCHDOG_MS);
    try {
      do {
        const force = cacheBust || pendingForceRef.current;
        pendingForceRef.current = false;
        const newPrices = await fetchQuoteBatch(orderRef.current, {
          cacheBust: force,
          // Merge each batch as it lands so holdings paint progressively.
          onBatch: (partial) => { PBStore.mergePrices(guardBatch(partial)); persistPrices(); }
        });
        if (Object.keys(newPrices).length > 0) {
          setLastUpdate(new Date());
          setFailStreak(0);
        } else if (orderRef.current.length > 0) {
          setFailStreak(prev => prev + 1);
        }
      } while (pendingForceRef.current);
    } catch (e) {
      console.error('Refresh failed:', e);
      // Drop the queued force too: the sweep it was meant to ride is over, and
      // leaving it set would make the NEXT press loop an extra time for nothing.
      pendingForceRef.current = false;
      setFailStreak(prev => prev + 1);
    }
    clearTimeout(watchdog);
    release();
  }, [persistPrices, guardBatch]);
  // Auto-poll: skip if a fetch is already running (no point double-polling).
  const refresh = useCallback(() => {
    if (loadingRef.current) return;
    runFetch(false);
  }, [runFetch]);
  // Manual refresh button: never a no-op. If idle, fetch now with cache-bust;
  // if a poll is mid-flight, flag a forced re-run so it fires the instant the
  // current sweep ends.
  const refreshNow = useCallback(() => {
    if (loadingRef.current) { pendingForceRef.current = true; return; }
    runFetch(true);
  }, [runFetch]);
  // Battery-aware cadence: 45s while any tracked market is open (incl. US pre/
  // post hours — see MARKET_SESSIONS) so the "today" move stays close to live,
  // 5 min when every market is shut (prices barely move overnight). A
  // low-frequency meta-timer flips the rate at open/close boundaries; server
  // push covers the fully-closed app.
  const OPEN_POLL_MS = 45000;
  const CLOSED_POLL_MS = 300000;
  const [pollMs, setPollMs] = useState(() => anyMarketOpen(order) ? OPEN_POLL_MS : CLOSED_POLL_MS);
  useEffect(() => {
    const recompute = () => setPollMs(anyMarketOpen(order) ? OPEN_POLL_MS : CLOSED_POLL_MS);
    recompute();
    const id = setInterval(recompute, 60000);
    return () => clearInterval(id);
  }, [order]);
  // Refetch on tab-visible whenever the cache is older than the open-market
  // cadence, so returning to the app never shows a stale day move while waiting
  // out the next interval tick.
  usePolledRefresh(refresh, pollMs, OPEN_POLL_MS, fetchKey);
  return { loading, lastUpdate, failStreak, refresh, refreshNow, mergePrices };
}
// Owns triggered history + alertSeenMap and runs the pure evaluator on every
// price/alert change. fireNotification is injected because its closure (toast,
// SW registration) lives in the parent. setTriggered is exposed for importData.
// alertSeenMap is read via a ref to avoid a feedback loop: updating the seen
// map would otherwise re-trigger this effect and risk double-firing.
function useAlertEngine(alerts, fireNotification) {
  const [triggered, setTriggered] = usePersistedState('pb.triggered.v2', []);
  const [alertSeenMap, setAlertSeenMap] = usePersistedState('pb.alertSeen.v1', {});
  const seenRef = useRef(alertSeenMap);
  useEffect(() => { seenRef.current = alertSeenMap; }, [alertSeenMap]);
  useEffect(() => {
    const run = () => {
      // Preview mode shows a demo book — don't fire real alerts from a demo
      // session (background SW alerts keep running on the real config).
      if (PBStore.getSetting('previewMode')) return;
      const { nextSeen, newTriggers, seenChanged } = evaluateTriggers(alerts, PBStore.getPrices(), seenRef.current);
      if (seenChanged) setAlertSeenMap(nextSeen);
      if (newTriggers.length) {
        setTriggered(prev => [...newTriggers, ...prev].slice(0, MAX_TRIGGER_HISTORY));
        newTriggers.forEach(t => fireNotification(t));
      }
    };
    run();                              // evaluate immediately on alerts change
    return PBStore.subscribe(run);      // and on every subsequent price change
  }, [alerts, fireNotification, setAlertSeenMap, setTriggered]);
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
// ─── Server push (premium always-on alerts) ─────────────────────────────────
// The static PWA can only check prices while it's awake. The optional backend
// (see backend/) does it server-side and delivers a real push, so alerts land
// within ~a minute even with the app fully closed — the one path to iOS parity,
// at near-zero phone battery. This layer subscribes the device, keeps the
// server's alert copy synced, and heartbeats on foreground so the server
// suppresses duplicates while you're actively in the app.
const PUSH_CLIENT_KEY = 'pb.clientId.v1';
function pushClientId() {
  let id = LS.get(PUSH_CLIENT_KEY, null);
  if (!id || typeof id !== 'string') { id = uid() + uid() + uid(); LS.set(PUSH_CLIENT_KEY, id); }
  return id;
}
function normalizeBackend(url) { return (url || '').trim().replace(/\/+$/, ''); }
function pushSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined';
}
function vapidKeyToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
async function getOrCreatePushSub(vapidPublicKey) {
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKeyToBytes(vapidPublicKey)
  });
}
async function backendPost(base, path, payload) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json().catch(() => ({}));
}
// Cloud backup: an encrypted, always-current copy of every durable pb.* key,
// stored on the same Worker as push (its URL is reused). This is what survives
// deleting + re-adding the home-screen icon — the one thing on-device storage
// can't guarantee on iOS. Zero-knowledge: see the crypto helpers up top.
function useCloudBackup(backendBase, toast) {
  const [enabled, setEnabled] = usePersistedState('pb.backup.enabled.v1', false);
  const [code, setCode] = usePersistedState('pb.backup.code.v1', '');
  const [lastSync, setLastSync] = usePersistedState('pb.backup.lastSync.v1', 0);
  const [status, setStatus] = useState('off'); // off | idle | syncing | synced | error
  const base = normalizeBackend(backendBase);
  const ready = !!(enabled && base && code);

  // A ref so the long-lived _backupNotify closure always reads current values.
  const stateRef = useRef({ base, code, enabled });
  useEffect(() => { stateRef.current = { base, code, enabled }; }, [base, code, enabled]);

  const pushNow = useCallback(async () => {
    const s = stateRef.current;
    if (!s.enabled || !s.base || !s.code) return;
    try {
      setStatus('syncing');
      const norm = normalizeCode(s.code);
      const blob = await encryptBlob(norm, JSON.stringify(gatherBackup()));
      const key = await sha256Hex(norm);
      const r = await backendPost(s.base, '/backup', { key, blob });
      setLastSync((r && r.updatedAt) || Date.now());
      setStatus('synced');
    } catch (_e) {
      setStatus('error');
    }
  }, [setLastSync]);

  // Wire durable writes → debounced cloud push, plus one flush on mount/enable so
  // the cloud copy reflects this session even if the last one didn't get to sync.
  useEffect(() => {
    if (!ready) { _backupNotify = null; setStatus(enabled && !base ? 'error' : 'off'); return; }
    let t = null;
    _backupNotify = () => { clearTimeout(t); t = setTimeout(() => pushNow(), 4000); };
    setStatus('idle');
    pushNow();
    return () => { clearTimeout(t); _backupNotify = null; };
  }, [ready, enabled, base, pushNow]);

  const enable = useCallback(() => {
    setCode(prev => prev || generateRecoveryCode());
    setEnabled(true);
  }, [setCode, setEnabled]);
  const disable = useCallback(() => { setEnabled(false); setStatus('off'); }, [setEnabled]);

  // Pull the cloud copy for an entered code, decrypt, adopt it, then reload so all
  // persisted state re-initialises. Used after re-adding the icon on a fresh wipe.
  const restore = useCallback(async (inputCode) => {
    const norm = normalizeCode(inputCode);
    if (norm.length < 8) throw new Error('Enter your full recovery code');
    const b = normalizeBackend(stateRef.current.base);
    if (!b) throw new Error('Set the backend URL under Connections first');
    const res = await fetch(b + '/backup?key=' + (await sha256Hex(norm)));
    if (res.status === 404) throw new Error('No cloud backup found for that code');
    if (!res.ok) throw new Error('Server error (' + res.status + ')');
    const rec = await res.json();
    let plain;
    try { plain = await decryptBlob(norm, rec.blob); }
    catch (_e) { throw new Error('Wrong recovery code for this backup'); }
    const n = applyBackup(JSON.parse(plain));
    if (n < 0) throw new Error('Backup was unreadable');
    // Persist the entered code + enabled flag synchronously — the usePersistedState
    // effect won't run before we reload — so cloud sync resumes for THIS code even
    // if the restored snapshot predated these keys.
    LS.set('pb.backup.code.v1', formatCode(norm));
    LS.set('pb.backup.enabled.v1', true);
    setCode(formatCode(norm));
    setEnabled(true);
    // Reload so every usePersistedState (holdings, settings, ribbon, …) re-reads the
    // freshly written localStorage — the same wholesale-adoption path as file import.
    // Without this the restored data sits in storage but the live UI never updates.
    setTimeout(() => location.reload(), 600);
    return rec.updatedAt;
  }, [setCode, setEnabled]);

  return { enabled, code, status, lastSync, ready, base, enable, disable, pushNow, restore };
}
async function registerPushWithBackend(base, alerts) {
  const r = await fetch(base + '/vapid-public-key');
  if (!r.ok) throw new Error('server unreachable (' + r.status + ')');
  const { publicKey } = await r.json();
  if (!publicKey) throw new Error('server has no VAPID key set');
  const sub = await getOrCreatePushSub(publicKey);
  await backendPost(base, '/subscribe', { clientId: pushClientId(), subscription: sub.toJSON(), alerts });
  return true;
}
// pushBackend is owned by the parent (persisted); setPushBackend lets connect()
// save a freshly-entered URL. Status: off|connecting|connected|error|unsupported.
function usePushBackend(pushBackend, setPushBackend, alerts, notifPerm) {
  const [pushStatus, setPushStatus] = useState('off');
  const base = normalizeBackend(pushBackend);
  const alertsRef = useRef(alerts);
  useEffect(() => { alertsRef.current = alerts; }, [alerts]);
  // Auto-(re)register on open when configured + permitted. Idempotent: reuses an
  // existing subscription and upserts the server record keyed by clientId.
  useEffect(() => {
    let alive = true;
    if (!base) { setPushStatus('off'); return; }
    if (!pushSupported()) { setPushStatus('unsupported'); return; }
    if (notifPerm !== 'granted') { setPushStatus('error'); return; }
    setPushStatus('connecting');
    registerPushWithBackend(base, alertsRef.current)
      .then(() => { if (alive) setPushStatus('connected'); })
      .catch(() => { if (alive) setPushStatus('error'); });
    return () => { alive = false; };
  }, [base, notifPerm]);
  // Keep the server's alert list current (debounced).
  useEffect(() => {
    if (pushStatus !== 'connected' || !base) return;
    const t = setTimeout(() => {
      backendPost(base, '/sync', { clientId: pushClientId(), alerts }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [alerts, pushStatus, base]);
  // Heartbeat while foregrounded so the server's "recently active" flag stays
  // fresh (<90s) and it suppresses pushes the in-app engine is already handling.
  useEffect(() => {
    if (pushStatus !== 'connected' || !base) return;
    const beat = () => { if (!document.hidden) backendPost(base, '/sync', { clientId: pushClientId() }).catch(() => {}); };
    beat();
    const id = setInterval(beat, 60000);
    document.addEventListener('visibilitychange', beat);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', beat); };
  }, [pushStatus, base]);
  const connectPush = useCallback(async (url) => {
    const b = normalizeBackend(url);
    if (!b) return { ok: false, code: 'push-no-url' };
    if (!/^https:\/\//i.test(b)) return { ok: false, code: 'push-not-https' };
    if (!pushSupported()) {
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
      return { ok: false, code: 'push-unsupported', isIOS };
    }
    if (notifPerm !== 'granted') return { ok: false, code: 'push-no-perm' };
    setPushStatus('connecting');
    try {
      await registerPushWithBackend(b, alertsRef.current);
      setPushBackend(b);
      setPushStatus('connected');
      return { ok: true, code: 'push-connected' };
    } catch (e) {
      setPushStatus('error');
      return { ok: false, code: 'push-connect-failed', detail: e.message || 'error' };
    }
  }, [notifPerm, setPushBackend]);
  const testPush = useCallback(async () => {
    if (!base) return null;
    try {
      const r = await backendPost(base, '/test', { clientId: pushClientId() });
      return r.ok ? { ok: true, code: 'push-test-sent' } : { ok: false, code: 'push-test-failed', status: r.status };
    } catch (_e) { return { ok: false, code: 'push-test-error' }; }
  }, [base]);
  const disconnectPush = useCallback(async () => {
    if (base) { try { await backendPost(base, '/unsubscribe', { clientId: pushClientId() }); } catch (_e) {} }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (_e) {}
    setPushBackend('');
    setPushStatus('off');
    return { ok: true, code: 'push-disconnected' };
  }, [base, setPushBackend]);
  return { pushStatus, connectPush, testPush, disconnectPush };
}
// Owns positions/watchlist/contributions/alerts + CRUD. fxRates is needed for
// purchase-date FX resolution. Mutators return { ok, code, ...data } outcomes
// (see describeOutcome) instead of toasting directly — the App edge toasts them.
// Raw setters are exposed so importData / cloud sync can replace state wholesale.
function usePortfolio(fxRates) {
  const positions = PBStore.useCollection('positions');
  const setPositions = useCallback(v => PBStore.setCollection('positions', v), []);
  const watchlist = PBStore.useCollection('watchlist');
  const setWatchlist = useCallback(v => PBStore.setCollection('watchlist', v), []);
  // User-defined watchlists. The built-in "Watchlist" list (id 'default') is
  // always present and implicit, so this array holds only the extra lists the
  // user creates. Each watchlist item carries a `listIds` array — a stock can
  // belong to several lists at once. Legacy entries with a single `listId` (or
  // none) are normalised by watchListIds().
  const watchlistGroups = PBStore.useCollection('watchlistGroups');
  const setWatchlistGroups = useCallback(v => PBStore.setCollection('watchlistGroups', v), []);
  const alerts = PBStore.useCollection('alerts');
  const setAlerts = useCallback(v => PBStore.setCollection('alerts', v), []);
  const contributions = PBStore.useCollection('contributions');
  const setContributions = useCallback(v => PBStore.setCollection('contributions', v), []);
  const transactions = PBStore.useCollection('transactions');
  const setTransactions = useCallback(v => PBStore.setCollection('transactions', v), []);
  // TFSA deposit log — drives the annual (R46k) / lifetime (R500k) contribution
  // bars. Two kinds of entry live here: 'manual' (the user logs cash they put in,
  // e.g. a baseline for what they contributed before/outside the app) and
  // 'purchase' (auto-appended below whenever a TFSA holding is bought in-app, so
  // ongoing buys count toward the limits without manual logging). All entries are
  // editable/removable so the user can correct double-counts.
  const tfsaDeposits = PBStore.useCollection('tfsaDeposits');
  const setTfsaDeposits = useCallback(v => PBStore.setCollection('tfsaDeposits', v), []);
  // Background-resolved sectors for holdings the static map can't classify,
  // keyed "MARKET:TICKER" → { sector, industry, at }. Persisted so the dashboard
  // allocation stays accurate across reloads without re-fetching.
  const sectorCache = PBStore.useCollection('sectorCache');
  const setSectorCache = useCallback(v => PBStore.setCollection('sectorCache', v), []);
  // Per-instrument sector breakdowns for ETFs/funds, keyed "MARKET:TICKER" →
  // [{ sector, weight }]. When present, the allocation charts split that holding's
  // value across these sectors (normalised) instead of dumping it into one bucket
  // — giving a true look-through sector mix. Shared across accounts that hold the
  // same fund (e.g. a normal + TFSA position). Future AI auto-fills this from the
  // fund's latest MDD / fact sheet.
  const sectorWeights = PBStore.useCollection('sectorWeights');
  const setSectorWeights = useCallback(v => PBStore.setCollection('sectorWeights', v), []);
  const setSectorWeightsFor = (key, weights) => {
    setSectorWeights(prev => {
      const next = { ...prev };
      if (weights && weights.length) next[key] = weights;
      else delete next[key];
      return next;
    });
  };
  // Preview mode (Settings → Preview): swap in the static demo book read-only.
  // Real localStorage is never touched — the store keeps holding the real data,
  // we just don't show it — and every mutator below short-circuits to a toast.
  const previewMode = PBStore.useSetting('previewMode');
  const [, setDemoTick] = useState(0);
  const [previewLoadError, setPreviewLoadError] = useState(0);
  // Self-heal: an installed PWA can launch on a stale cached index.html that
  // predates the demo-data.js script tag (iOS keeps old start pages around long
  // after app.js itself has updated). Without PB_DEMO the toggle and badge show
  // but the swap silently never happens — so pull the dataset in on demand the
  // moment preview is requested, and say so if it can't be fetched.
  useEffect(() => {
    if (!previewMode || (typeof window !== 'undefined' && window.PB_DEMO)) return;
    if (document.querySelector('script[data-pb-demo]')) return;
    const el = document.createElement('script');
    el.src = './demo-data.js';
    el.setAttribute('data-pb-demo', '1');
    el.onload = () => setDemoTick(t => t + 1);
    el.onerror = () => {
      el.remove();
      setPreviewLoadError(n => n + 1);
    };
    document.head.appendChild(el);
  }, [previewMode]);
  const DEMO = (typeof window !== 'undefined' && window.PB_DEMO) || null;
  const inPreview = !!(previewMode && DEMO);
  const guardPreview = (fn) => (...args) => {
    if (inPreview) return { ok: false, code: 'preview-readonly' };
    return fn(...args);
  };
  useEffect(() => {
    setPositions(prev => {
      const merged = [];
      const seen = {};
      for (const p of prev) {
        const key = p.ticker + ':' + p.market;
        if (seen[key] != null) {
          const e = merged[seen[key]];
          const { shares, costBasis } = mergeCostBasis(e.shares, e.costBasis, p.shares, p.costBasis);
          merged[seen[key]] = { ...e, shares, costBasis,
            notes: p.notes ? (e.notes ? e.notes + '; ' + p.notes : p.notes) : e.notes };
        } else {
          seen[key] = merged.length;
          merged.push(p);
        }
      }
      return merged.length === prev.length ? prev : merged;
    });
  }, []);
  const addPosition = async (ticker, market, shares, costBasis, notes, purchaseDate, costCurrency) => {
    const nativeCode = marketCurrency(market);
    // The cost basis is denominated in costCurrency when given (e.g. a crypto
    // holding bought in ZAR), otherwise in the market's native currency. The
    // FX-at-cost rate is taken against whichever currency the cost is actually
    // in, so the FX gain/loss breakdown reasons about the right exposure.
    const costCode = (costCurrency && costCurrency !== nativeCode) ? costCurrency : null;
    const fxCode = costCode || nativeCode;
    const today = new Date().toISOString().slice(0, 10);
    const dateKey = purchaseDate && purchaseDate !== today ? purchaseDate : null;
    let rateAtCost = fxRates?.rates?.[fxCode] || null;
    if (dateKey) {
      const hist = await fetchHistoricalFx(dateKey, fxCode);
      if (hist != null) rateAtCost = hist;
    }
    const newShares = parseFloat(shares);
    const newCost = parseFloat(costBasis);
    const tickerUp = ticker.toUpperCase();
    // C4 fix: read the live store, not the possibly-stale reactive `positions`
    // closure, so rapid successive adds report the correct message.
    const existedBefore = (PBStore.getCollection('positions') || [])
      .some(p => p.ticker === tickerUp && p.market === market);
    setPositions(prev => {
      const existing = prev.find(p => p.ticker === tickerUp && p.market === market);
      if (existing) {
        // Buying more of a holding only updates shares/cost. The instrument's
        // sector breakdown lives in the separate pb.sectorWeights map keyed by
        // MARKET:TICKER, so it is untouched here and the allocation structure the
        // user set for this fund stays in place through every top-up.
        const exCcy = positionCostCcy(existing);
        const addCcy = costCode || nativeCode;
        // If the top-up was entered in a different currency than the holding's
        // existing cost basis, convert it across at today's rate before averaging
        // so the blended avg cost stays in one coherent currency.
        const addCost = addCcy === exCcy ? newCost
          : (convertCcy(newCost, addCcy, exCcy, fxRates?.rates || null) ?? newCost);
        const { shares, costBasis } = mergeCostBasis(existing.shares, existing.costBasis, newShares, addCost);
        return prev.map(p => p.id === existing.id ? {
          ...p, shares, costBasis,
          notes: notes ? (p.notes ? p.notes + '; ' + notes : notes) : p.notes,
          fxRateAtCost: rateAtCost || p.fxRateAtCost
        } : p);
      }
      return [...prev, {
        id: uid(), ticker: tickerUp, market,
        shares: newShares, costBasis: newCost,
        costCurrency: costCode || undefined,
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
    // A TFSA buy is a contribution — auto-log it so the limit bars stay current.
    if (market === 'TFSA' && isFinite(newShares * newCost) && newShares * newCost > 0) {
      setTfsaDeposits(prev => [...prev, {
        id: uid(), amount: newShares * newCost, date: purchaseDate || today,
        note: 'Bought ' + tickerUp, source: 'purchase', ticker: tickerUp
      }]);
    }
    return { ok: true, code: existedBefore ? 'shares-added' : 'position-added' };
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
          const { shares, costBasis } = mergeCostBasis(ex.shares, ex.costBasis, r.shares, r.costBasis);
          next[idx] = { ...ex, shares, costBasis, name: ex.name || r.name || null, fxRateAtCost: r.rateAtCost || ex.fxRateAtCost };
          merged++;
        } else {
          next.push({
            id: uid(), ticker: tickerUp, market: r.market, name: r.name || null,
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
    // Imported TFSA buys count as contributions too (see addPosition).
    const tfsaBuys = prepared
      .filter(r => r.market === 'TFSA' && isFinite(r.shares * r.costBasis) && r.shares * r.costBasis > 0)
      .map(r => ({
        id: uid(), amount: r.shares * r.costBasis, date: r.purchaseDate || today,
        note: 'Bought ' + r.ticker.toUpperCase(), source: 'purchase', ticker: r.ticker.toUpperCase()
      }));
    if (tfsaBuys.length) setTfsaDeposits(prev => [...prev, ...tfsaBuys]);
    // Learn any sector the user assigned to an unrecognised symbol during import,
    // so the allocation chart classifies it from now on instead of "Other".
    const learned = {};
    for (const r of prepared) {
      if (!r.sector) continue;
      const s = DATA.normalizeSector(r.sector);
      if (s && s !== 'Other') learned[priceKey(r.market, r.ticker.toUpperCase())] = { sector: s, industry: r.sector, at: Date.now() };
    }
    if (Object.keys(learned).length) setSectorCache(prev => ({ ...prev, ...learned }));
    return { ok: true, code: 'positions-imported', added, merged };
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
    return { ok: true, code: 'sale-recorded' };
  };
  const updatePosition = async (id, updates) => {
    const existing = positions.find(p => p.id === id);
    const today = new Date().toISOString().slice(0, 10);
    // The cost-basis FX rate depends on the holding's native currency (its market)
    // and its purchase date — so refetch it when either changes (e.g. re-pointing
    // a US holding to a JSE listing flips USD→ZAR).
    const nextMarket = updates.market || (existing && existing.market);
    const nextDate = updates.purchaseDate || (existing && existing.purchaseDate);
    const marketChanged = !!(existing && updates.market && updates.market !== existing.market);
    const dateChanged = !!(existing && updates.purchaseDate && updates.purchaseDate !== existing.purchaseDate);
    // The cost basis can be denominated in a currency other than the market's
    // native one (crypto bought in ZAR), so the FX-at-cost rate tracks the cost
    // currency and is refetched when it, the date, or the market changes.
    const nextCostCode = (updates.costCurrency !== undefined ? updates.costCurrency : (existing && existing.costCurrency)) || marketCurrency(nextMarket);
    const costCcyChanged = !!(existing && updates.costCurrency !== undefined && (updates.costCurrency || null) !== (existing.costCurrency || null));
    let historicalFx = null;
    if (existing && (marketChanged || dateChanged || costCcyChanged) && nextDate && nextDate !== today) {
      historicalFx = await fetchHistoricalFx(nextDate, nextCostCode);
    }
    setPositions(prev => prev.map(p => {
      if (p.id !== id) return p;
      const nextUpdates = resolvePositionUpdates(p, updates, { fxRates, today, historicalFx });
      return { ...p, ...nextUpdates };
    }));
    return { ok: true, code: 'position-updated' };
  };
  const removePosition = id => {
    setPositions(prev => prev.filter(p => p.id !== id));
    return { ok: true, code: 'position-removed' };
  };
  // Bulk delete (Settings → Manage holdings). One state update for the whole set.
  const removePositions = ids => {
    const set = new Set(ids);
    if (set.size === 0) return;
    setPositions(prev => prev.filter(p => !set.has(p.id)));
    return { ok: true, code: 'holdings-deleted', count: set.size };
  };
  const addContribution = (amount, currency, date, note, usdLanded) => {
    const amt = parseFloat(amount);
    const landed = parseFloat(usdLanded);
    // If the user recorded how much USD actually arrived (e.g. R18 000 sent →
    // $1 000 landed), lock in the *real* achieved rate (source units per USD) so
    // overall profit measures what they put in against what they hold now. Else
    // fall back to the market rate at deposit time.
    const hasLanded = currency !== 'USD' && isFinite(landed) && landed > 0;
    const rateAtContrib = hasLanded
      ? Math.abs(amt) / landed
      : (fxRates?.rates?.[currency] || null);
    setContributions(prev => [...prev, {
      id: uid(), amount: amt, currency, date, note: note || '',
      fxRateAtContrib: rateAtContrib, fxBase: 'USD',
      ...(hasLanded ? { usdLanded: landed } : {})
    }]);
    return { ok: true, code: 'contribution-logged' };
  };
  const removeContribution = id => {
    setContributions(prev => prev.filter(c => c.id !== id));
    return { ok: true, code: 'contribution-removed' };
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
    return { ok: true, code: 'contributions-imported', count: mapped.length };
  };
  // ── TFSA deposit log CRUD ──
  const addTfsaDeposit = (amount, date, note) => {
    const amt = parseFloat(amount);
    if (!isFinite(amt) || amt === 0 || !date) return { ok: false, code: 'deposit-missing-fields' };
    setTfsaDeposits(prev => [...prev, { id: uid(), amount: amt, date, note: note || '', source: 'manual' }]);
    return { ok: true, code: 'deposit-logged' };
  };
  const updateTfsaDeposit = (id, updates) => {
    setTfsaDeposits(prev => prev.map(d => {
      if (d.id !== id) return d;
      const next = { ...d, ...updates };
      if (updates.amount != null) next.amount = parseFloat(updates.amount);
      return next;
    }));
    return { ok: true, code: 'deposit-updated' };
  };
  const removeTfsaDeposit = (id) => {
    setTfsaDeposits(prev => prev.filter(d => d.id !== id));
    return { ok: true, code: 'deposit-removed' };
  };
  // Bulk-remove several deposits at once (multi-select in the deposit log). The
  // annual + lifetime counters are derived from the remaining list, so they
  // recompute automatically once these are gone.
  const removeTfsaDeposits = (ids) => {
    const set = new Set(ids || []);
    if (set.size === 0) return;
    setTfsaDeposits(prev => prev.filter(d => !set.has(d.id)));
    return { ok: true, code: 'deposits-removed', count: set.size };
  };
  const addWatch = (ticker, market, name, listId) => {
    ticker = ticker.toUpperCase();
    const list = listId || 'default';
    const existing = watchlist.find(w => w.ticker === ticker && w.market === market);
    if (existing) {
      // Already tracked — a stock can live in several lists, so just add it to
      // this one too (rather than moving it out of the others).
      if (watchListIds(existing).includes(list)) return { ok: false, code: 'watch-already', list };
      setWatchlist(prev => prev.map(w => (w.ticker === ticker && w.market === market)
        ? { ...w, listIds: [...watchListIds(w), list], listId: undefined } : w));
      return { ok: true, code: 'watch-added', ticker };
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
      listIds: [list],
      addedAt: new Date().toISOString()
    }]);
    return { ok: true, code: 'watch-added', ticker };
  };
  const removeWatch = id => setWatchlist(prev => prev.filter(w => w.id !== id));
  // Move a single watch entry into a different list (legacy single-list helper,
  // kept for import/sync compatibility).
  const moveWatch = (id, listId) => setWatchlist(prev => prev.map(w => w.id === id ? { ...w, listIds: [listId || 'default'], listId: undefined } : w));
  // Toggle a stock's membership in one list. Adding when untracked creates the
  // entry; removing its last remaining list drops it from the watchlist entirely.
  const toggleWatchList = (ticker, market, name, listId) => {
    ticker = (ticker || '').toUpperCase();
    const list = listId || 'default';
    const existing = watchlist.find(w => w.ticker === ticker && w.market === market);
    if (!existing) return addWatch(ticker, market, name, list);
    const ids = watchListIds(existing);
    if (ids.includes(list)) {
      const next = ids.filter(x => x !== list);
      if (next.length === 0) {
        setWatchlist(prev => prev.filter(w => !(w.ticker === ticker && w.market === market)));
        return { ok: true, code: 'watch-removed', ticker };
      }
      setWatchlist(prev => prev.map(w => (w.ticker === ticker && w.market === market) ? { ...w, listIds: next, listId: undefined } : w));
      return { ok: true, code: 'watch-removed-list' };
    }
    setWatchlist(prev => prev.map(w => (w.ticker === ticker && w.market === market) ? { ...w, listIds: [...ids, list], listId: undefined } : w));
    return { ok: true, code: 'watch-added-list' };
  };
  const addWatchGroup = (name) => {
    const nm = (name || '').trim();
    if (!nm) return null;
    const g = { id: uid(), name: nm, createdAt: new Date().toISOString() };
    setWatchlistGroups(prev => [...prev, g]);
    return { ok: true, code: 'watchgroup-created', name: nm, id: g.id };
  };
  const renameWatchGroup = (id, name) => {
    const nm = (name || '').trim();
    if (!nm) return;
    setWatchlistGroups(prev => prev.map(g => g.id === id ? { ...g, name: nm } : g));
  };
  const removeWatchGroup = (id) => {
    if (id === 'default') return;
    // Keep the stocks — just drop this list from their membership, falling back
    // to the built-in list if it was the only one they were filed under.
    setWatchlist(prev => prev.map(w => {
      const ids = watchListIds(w);
      if (!ids.includes(id)) return w;
      const next = ids.filter(x => x !== id);
      return { ...w, listIds: next.length ? next : ['default'], listId: undefined };
    }));
    setWatchlistGroups(prev => prev.filter(g => g.id !== id));
    return { ok: true, code: 'watchgroup-deleted' };
  };
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
    return { ok: true, code: 'alert-set' };
  };
  const removeAlert = id => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  };
  return {
    // Read side: preview substitutes the demo book; the store itself never
    // changes, so flipping the setting off restores the real data instantly.
    positions: inPreview ? DEMO.positions : positions, setPositions,
    watchlist: inPreview ? DEMO.watchlist : watchlist, setWatchlist,
    watchlistGroups: inPreview ? [] : watchlistGroups, setWatchlistGroups,
    alerts, setAlerts,
    contributions: inPreview ? DEMO.contributions : contributions, setContributions,
    transactions: inPreview ? DEMO.transactions : transactions, setTransactions,
    tfsaDeposits: inPreview ? DEMO.tfsaDeposits : tfsaDeposits, setTfsaDeposits,
    sectorCache, setSectorCache,
    sectorWeights, setSectorWeights, setSectorWeightsFor,
    previewLoadError,
    // Write side: every user-facing mutator is read-only in preview (raw
    // setters stay live — cloud restore/import wiring uses them deliberately).
    addPosition: guardPreview(addPosition), updatePosition: guardPreview(updatePosition),
    removePosition: guardPreview(removePosition), removePositions: guardPreview(removePositions),
    sellPosition: guardPreview(sellPosition), importPositions: guardPreview(importPositions),
    addContribution: guardPreview(addContribution), removeContribution: guardPreview(removeContribution),
    importContributions: guardPreview(importContributions),
    addTfsaDeposit: guardPreview(addTfsaDeposit), updateTfsaDeposit: guardPreview(updateTfsaDeposit),
    removeTfsaDeposit: guardPreview(removeTfsaDeposit), removeTfsaDeposits: guardPreview(removeTfsaDeposits),
    addWatch: guardPreview(addWatch), removeWatch: guardPreview(removeWatch),
    moveWatch: guardPreview(moveWatch), toggleWatchList: guardPreview(toggleWatchList),
    addWatchGroup: guardPreview(addWatchGroup), renameWatchGroup: guardPreview(renameWatchGroup),
    removeWatchGroup: guardPreview(removeWatchGroup),
    addAlert: guardPreview(addAlert), removeAlert: guardPreview(removeAlert)
  };
}

// ─── Toast copy: the single place user-facing outcome messages live ───────────
// Data-layer mutators/actions return { ok, code, ...data } outcomes (no strings).
// The App edge maps each outcome to copy here and shows the toast. Returns null
// for outcomes that must not toast (no-ops, silent success, unknown codes).
function describeOutcome(o) {
  if (!o || typeof o.code !== 'string') return null;
  const d = o;
  switch (o.code) {
    // positions
    case 'position-added':         return 'Position added';
    case 'shares-added':           return 'Shares added to existing position';
    case 'positions-imported':     return `Imported ${d.added} position${d.added !== 1 ? 's' : ''}` + (d.merged ? `, merged ${d.merged}` : '');
    case 'sale-recorded':          return 'Sale recorded';
    case 'position-updated':       return 'Position updated';
    case 'position-removed':       return 'Position removed';
    case 'holdings-deleted':       return d.count === 1 ? 'Holding deleted' : `${d.count} holdings deleted`;
    // contributions
    case 'contribution-logged':    return 'Contribution logged';
    case 'contribution-removed':   return 'Contribution removed';
    case 'contributions-imported': return `Imported ${d.count} ${d.count === 1 ? 'entry' : 'entries'}`;
    // TFSA deposits
    case 'deposit-missing-fields': return 'Enter an amount and date';
    case 'deposit-logged':         return 'Deposit logged';
    case 'deposit-updated':        return 'Deposit updated';
    case 'deposit-removed':        return 'Deposit removed';
    case 'deposits-removed':       return d.count === 1 ? 'Deposit removed' : `${d.count} deposits removed`;
    // watchlist
    case 'watch-added':            return 'Added ' + d.ticker;
    case 'watch-already':          return 'Already on ' + (d.list === 'default' ? 'watchlist' : 'that list');
    case 'watch-removed':          return 'Removed ' + d.ticker;
    case 'watch-removed-list':     return 'Removed from list';
    case 'watch-added-list':       return 'Added to list';
    case 'watchgroup-created':     return `List "${d.name}" created`;
    case 'watchgroup-deleted':     return 'List deleted';
    // alerts
    case 'alert-set':              return 'Alert set';
    // preview
    case 'preview-readonly':       return 'Preview mode is on — turn it off in Settings to edit your real portfolio.';
    case 'preview-load-failed':    return 'Couldn’t load the demo portfolio — check your connection and toggle Preview again.';
    // push backend
    case 'push-no-url':            return 'Enter your push server URL';
    case 'push-not-https':         return 'Push server must be an https:// URL';
    case 'push-unsupported':       return d.isIOS ? 'On iPhone, install to Home Screen first' : 'Push not supported in this browser';
    case 'push-no-perm':           return 'Enable notifications first';
    case 'push-connected':         return 'Background push connected';
    case 'push-connect-failed':    return 'Could not connect: ' + (d.detail || 'error');
    case 'push-test-sent':         return 'Test push sent — check your lock screen';
    case 'push-test-failed':       return 'Test failed (' + (d.status || '?') + ')';
    case 'push-test-error':        return 'Test failed — is the server reachable?';
    case 'push-disconnected':      return 'Background push disconnected';
    // price feed (rationalized to one message)
    case 'feed-unreachable':       return 'Price feed unreachable — showing last known prices';
    // backup
    case 'backup-saved':           return 'Backup saved';
    default:                       return null;
  }
}

// ─── Stable edge action wrappers ──────────────────────────────────────────────
// Given an object of (possibly-churning) action impls, return an object of
// STABLE-identity wrappers. Each wrapper always calls the latest impl and toasts
// describeOutcome(result) at the edge — impls + toast are read through refs so the
// wrapper identities never change (latest-ref / useEffectEvent pattern). Built once,
// so the wrappers are safe to hand to React.memo'd children. Async impls toast after
// they resolve and the wrapper returns the impl's own value unchanged.
function useToastEvents(impls, toast) {
  const implsRef = useRef(impls); useLayoutEffect(() => { implsRef.current = impls; });
  const toastRef = useRef(toast); useLayoutEffect(() => { toastRef.current = toast; });
  return useMemo(() => {
    const out = {};
    for (const name of Object.keys(implsRef.current)) {
      out[name] = (...args) => {
        const r = implsRef.current[name](...args);
        if (r && typeof r.then === 'function')
          return r.then(o => { const m = describeOutcome(o); if (m) toastRef.current(m); return o; });
        const m = describeOutcome(r); if (m) toastRef.current(m);
        return r;
      };
    }
    return out;
  }, []);
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
// A recoverable error boundary scoped to a single modal/overlay. If a modal
// throws while rendering, committing, or unmounting, the *whole app* must not be
// replaced by the global error screen (which, on the near-black theme, reads as
// "the screen went black" and only a reload escapes). Instead this catches the
// error, renders nothing (so the modal disappears), and hands control back to
// the parent's onError — which closes the modal and toasts. The app behind it
// stays alive and the user's data is untouched. Remounting the modal later
// creates a fresh boundary with cleared error state.
class ModalBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error('Modal crash (recovered):', error, info && info.componentStack);
    try { this.props.onError && this.props.onError(error); } catch (_e) {}
  }
  render() { return this.state.error ? null : this.props.children; }
}
// Canonical tab registry. Order here is the default layout (TFSA sits between
// Heatmap and New picks); the user can reorder/hide via Settings → Tabs, which
// persists as a key list. reconcileTabOrder() keeps a stored order valid as the
// app gains/loses tabs: known keys keep their saved order, brand-new tabs are
// appended (so an update never hides a new feature), unknown keys are dropped.
const ALL_TABS = [
  ['dashboard', 'Dashboard'], ['current', 'Holdings'], ['watchlist', 'Watchlist'],
  ['hot', 'Hot Topics'], ['heatmap', 'Heatmap'], ['rotation', 'Rotation'], ['tfsa', 'TFSA'], ['picks', 'New picks'],
  ['hedges', 'Hedges'], ['rules', 'Rules'], ['overview', 'Thesis']
];
const ALL_TAB_KEYS = ALL_TABS.map(t => t[0]);
const TAB_LABELS = Object.fromEntries(ALL_TABS);
const DEFAULT_TAB_ORDER = ALL_TAB_KEYS.slice();
// ─── Settings registry (Increment 2: migrated from per-key usePersistedState) ──
// Each entry { name, key, default } is seeded from localStorage via the injected LS
// adapter and write-through on change, so every setting keeps its own pb.* key and
// cloud backup/restore stays byte-compatible. fxRates is intentionally NOT here.
const SETTINGS_SCHEMA = [
  { name: 'theme',           key: 'pb.theme.v2',           default: 'dark' },
  { name: 'iconTheme',       key: 'pb.iconTheme.v1',       default: (typeof window !== 'undefined' && window.__pbIconTheme) || 'dark' },
  { name: 'perplexityKey',   key: 'pb.perplexityKey.v1',   default: '' },
  { name: 'pushBackend',     key: 'pb.pushBackend.v1',     default: '' },
  { name: 'displayCurrency', key: 'pb.displayCurrency.v1', default: 'USD' },
  { name: 'donutPalette',    key: 'pb.donutPalette.v1',    default: 'spectrum' },
  { name: 'donutTopN',       key: 'pb.donutTopN.v1',       default: 10 },
  { name: 'valueHidden',     key: 'pb.valueHidden.v1',     default: false },
  { name: 'previewMode',     key: 'pb.previewMode.v1',     default: false },
  { name: 'ribbonItems',     key: 'pb.ribbonItems.v1',     default: DEFAULT_RIBBON_ITEMS },
  { name: 'ribbonMode',      key: 'pb.ribbonMode.v1',      default: 'rows' },
  { name: 'tabOrder',        key: 'pb.tabOrder.v2',        default: DEFAULT_TAB_ORDER },
  { name: 'hiddenTabs',      key: 'pb.hiddenTabs.v1',      default: [] },
];
PBStore.configureSettings({ schema: SETTINGS_SCHEMA, storage: LS });
// ─── Portfolio collections registry (Increment 3a: non-money slices → PBStore) ─
// The 5 non-money usePortfolio slices, each seeded from / written through to its
// own pb.* key via the injected LS adapter (cloud backup stays byte-identical;
// pb.sectorCache.v1 is in BACKUP_SKIP so LS.set still skips its backup-notify).
// The 4 money slices + their async mutators stay in usePortfolio (Increment 3b).
const PORTFOLIO_SCHEMA = [
  { name: 'watchlist',       key: 'pb.watchlist.v2',       default: [] },
  { name: 'watchlistGroups', key: 'pb.watchlistGroups.v1', default: [] },
  { name: 'alerts',          key: 'pb.alerts.v2',          default: [] },
  { name: 'sectorCache',     key: 'pb.sectorCache.v1',     default: {} },
  { name: 'sectorWeights',   key: 'pb.sectorWeights.v1',   default: {} },
  // Money slices (Increment 3b): same mechanism, all four arrays. Mutator bodies
  // in usePortfolio are unchanged — they call the setter wrappers over setCollection.
  { name: 'positions',       key: 'pb.positions.v2',       default: [] },
  { name: 'transactions',    key: 'pb.transactions.v1',    default: [] },
  { name: 'contributions',   key: 'pb.contributions.v1',   default: [] },
  { name: 'tfsaDeposits',    key: 'pb.tfsa.deposits.v1',   default: [] },
  // TFSA contribution-planner state. User-ENTERED planning data, not view-local UI
  // state: target weights per holding and the amount being allocated. Both were
  // written through raw usePersistedState from pb-views.js, so they rode cloud backup
  // only by accident of the pb. prefix rule; schema'd here so that is deliberate.
  { name: 'tfsaTargets',     key: 'pb.tfsa.targets.v1',    default: {} },
  { name: 'tfsaContribution', key: 'pb.tfsa.contribution.v1', default: '' },
];
PBStore.configureCollections({ schema: PORTFOLIO_SCHEMA, storage: LS });
// Dashboard always stays available so the nav can never be emptied entirely.
const TAB_ALWAYS_VISIBLE = 'dashboard';
// Static recommendation lists are fetched lazily — only once their tab has been
// visited (Phase 2 inc 3) — instead of on every 45s poll. THESIS_SNAPSHOT is the
// handful of names the Thesis (overview) tab shows live; shared with OverviewView
// so the snapshot and the poll list can't drift. DATA is a data.js global,
// available at module-eval time (data.js loads before app.js).
const THESIS_SNAPSHOT = ['NVDA', 'GOOGL', 'C', 'ASML'];
const LAZY_LISTS = {
  picks:    DATA.NEW_PICKS.map(p => 'US:' + p.ticker),
  hedges:   DATA.HEDGES.map(h => 'US:' + h.ticker),
  overview: THESIS_SNAPSHOT.map(t => 'US:' + t),
};
function reconcileTabOrder(stored) {
  const arr = Array.isArray(stored) ? stored : [];
  const known = arr.filter((k, i) => ALL_TAB_KEYS.includes(k) && arr.indexOf(k) === i);
  const missing = ALL_TAB_KEYS.filter(k => !known.includes(k));
  return [...known, ...missing];
}
// Brand mark — the indigo "Ascent" rising bars, shown left of the wordmark.
// Inlined (not <img src="mark.svg">) so the muted bar recolors with the UI
// theme: #3A3A52 on dark, #C9CBDB on light (per brand/icon-light.svg).
function BrandMark({ theme }) {
  const muted = theme === 'light' ? '#C9CBDB' : '#3A3A52';
  return React.createElement("svg", {
    className: "brand-mark", width: 28, height: 28, viewBox: "0 0 120 120",
    "aria-hidden": "true", focusable: "false"
  },
    React.createElement("rect", { x: 14, y: 74, width: 18, height: 32, rx: 6, fill: muted }),
    React.createElement("rect", { x: 42, y: 46, width: 18, height: 60, rx: 6, fill: "#5A5AD0" }),
    React.createElement("rect", { x: 70, y: 20, width: 18, height: 86, rx: 6, fill: "#6E6EF0" })
  );
}
// Startup loading screen — the branded `.pb-loader` (bars + wordmark) shown over
// the app while it bootstraps. Driven by a `visible` prop: when it flips false we
// add `.pb-hiding` to fade opacity to 0 over 300ms (see styles.css), then unmount
// once the fade finishes so it doesn't pop. CSS (keyframes, light/dark via
// data-theme, reduced-motion) lives in styles.css.
function LoadingScreen({ visible }) {
  // index.html already painted this exact `.pb-loader` markup as #pb-splash before
  // React existed. When it is there we do NOT mount a second copy: a fresh element
  // restarts the pb-wave keyframes from zero, and the bars visibly jumped mid-boot.
  // Instead that one element rides the whole boot and we only tell it when to go.
  // Captured once at mount so the render path cannot change underneath us. The
  // React-rendered loader below is still the path for contexts with no splash in
  // the page - the verify-*.mjs harness shells, which embed their own HTML.
  const [ownsSplash] = useState(() =>
    typeof document !== 'undefined' && !!document.getElementById('pb-splash'));
  const splashHiddenRef = useRef(false);
  const [mounted, setMounted] = useState(visible);
  const [hiding, setHiding] = useState(false);
  // The loader is a fixed full-screen overlay rendered *over* the already-mounted
  // app, whose full-height content would otherwise let the document scroll behind
  // it — showing a stray scrollbar on the splash. Lock the body while the loader
  // is mounted (through the fade-out) so nothing scrolls underneath it.
  useBodyScrollLock(mounted);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      setHiding(false);
      return;
    }
    // Retire the pre-React splash HERE, when the dashboard is actually ready -
    // not on React's first commit. That is what keeps its animation unbroken.
    // Latched so the re-render at the end of the fade cannot fire it twice.
    if (ownsSplash && !splashHiddenRef.current) {
      splashHiddenRef.current = true;
      if (typeof window.hidePbSplash === 'function') window.hidePbSplash();
    }
    if (!mounted) return;
    setHiding(true);
    const t = setTimeout(() => setMounted(false), 320); // just past the 300ms fade
    return () => clearTimeout(t);
  }, [visible, mounted, ownsSplash]);
  if (!mounted || ownsSplash) return null;
  return React.createElement("div", {
    className: "pb-loader" + (hiding ? " pb-hiding" : ""),
    role: "status", "aria-label": "Loading Playbook"
  },
    React.createElement("div", { className: "pb-tile" },
      React.createElement("span", { className: "pb-bar" }),
      React.createElement("span", { className: "pb-bar" }),
      React.createElement("span", { className: "pb-bar" }),
      React.createElement("span", { className: "pb-sheen" })),
    React.createElement("div", { className: "pb-word" }, "Playbook"));
}
function App() {
  const theme = PBStore.useSetting('theme');
  // Demo-book flag — shows the header "Preview" pill so a demo can't be
  // mistaken for the real portfolio (usePortfolio does the data swap).
  const previewMode = PBStore.useSetting('previewMode');
  // Home-screen / favicon icon tile. Synced to the bootstrap in index.html via
  // window.applyIconTheme so the apple-touch-icon + manifest swap to match.
  const iconTheme = PBStore.useSetting('iconTheme');
  useEffect(() => {
    if (typeof window !== 'undefined' && window.applyIconTheme) window.applyIconTheme(iconTheme);
  }, [iconTheme]);
  const perplexityKey = PBStore.useSetting('perplexityKey');
  const pushBackend = PBStore.useSetting('pushBackend');
  const setPushBackend = useCallback((v) => PBStore.setSetting('pushBackend', v), []);
  const displayCurrency = PBStore.useSetting('displayCurrency');
  const setDisplayCurrency = useCallback((v) => PBStore.setSetting('displayCurrency', v), []);
  const [fxRates, setFxRates] = usePersistedState('pb.fxRates.v1', null);
  const ribbonItems = PBStore.useSetting('ribbonItems');
  const [showSettings, setShowSettings] = useState(false);
  const tabOrder = PBStore.useSetting('tabOrder');
  const hiddenTabs = PBStore.useSetting('hiddenTabs');
  const orderedKeys = useMemo(() => reconcileTabOrder(tabOrder), [tabOrder]);
  // The visible nav: ordered keys minus hidden ones. Dashboard is never hidden.
  const TAB_LIST = useMemo(
    () => orderedKeys.filter(k => k === TAB_ALWAYS_VISIBLE || !hiddenTabs.includes(k)).map(k => [k, TAB_LABELS[k]]),
    [orderedKeys, hiddenTabs]
  );
  const [view, setView] = useState('dashboard');
  // Lazy price lists (picks/hedges/thesis) the user has visited this session.
  // Once a tab is opened its list stays in the poll set until reload (kept warm).
  const [warmedLists, setWarmedLists] = useState(() => new Set());
  const visibleKeysStr = TAB_LIST.map(t => t[0]).join(',');
  // If the active tab gets hidden, fall back to the first visible tab.
  useEffect(() => {
    const vis = visibleKeysStr ? visibleKeysStr.split(',') : [];
    if (vis.length && !vis.includes(view)) setView(vis[0]);
  }, [visibleKeysStr, view]);
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
  const [hotTopicsCache, loadHotTopicsRaw] = useTtlCache(3 * 60 * 60 * 1000);
  const [selected, setSelected] = useState(null);
  const [showAlerts, setShowAlerts] = useState(false);
  const [posModalEditId, setPosModalEditId] = useState(null);
  const [posModalOpen, setPosModalOpen] = useState(false);
  const [posModalDefaultMarket, setPosModalDefaultMarket] = useState('US');
  const [showImport, setShowImport] = useState(false);
  const [importMarket, setImportMarket] = useState('US');
  const [sellModalPos, setSellModalPos] = useState(null);
  const [buyModalPos, setBuyModalPos] = useState(null);
  const [notifPerm, setNotifPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [installEvent, setInstallEvent] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [marketFilter, setMarketFilter] = useState('US');
  const toast = useToast();
  const _p = usePortfolio(fxRates);
  // Reactive reads pass straight through — they must change every render.
  const {
    positions, watchlist, watchlistGroups, alerts, contributions, transactions,
    tfsaDeposits, sectorCache, sectorWeights, previewLoadError,
  } = _p;
  // Stable-identity action wrappers (built once) so memo'd leaves skip re-render on
  // unrelated App renders. Each wrapper toasts describeOutcome at the edge and always
  // calls the latest underlying mutator. Push + backup get the same treatment below.
  const {
    setPositions, setWatchlist, setWatchlistGroups, setContributions, setTransactions,
    setTfsaDeposits, setSectorWeights, setSectorWeightsFor, setAlerts, setSectorCache,
    addPosition, updatePosition, removePosition, removePositions, sellPosition, importPositions,
    addContribution, removeContribution, importContributions, addTfsaDeposit, updateTfsaDeposit,
    removeTfsaDeposit, removeTfsaDeposits, addWatch, removeWatch, moveWatch, toggleWatchList,
    addWatchGroup, renameWatchGroup, removeWatchGroup, addAlert, removeAlert,
  } = useToastEvents({
    setPositions: _p.setPositions, setWatchlist: _p.setWatchlist,
    setWatchlistGroups: _p.setWatchlistGroups, setContributions: _p.setContributions,
    setTransactions: _p.setTransactions, setTfsaDeposits: _p.setTfsaDeposits,
    setSectorWeights: _p.setSectorWeights, setSectorWeightsFor: _p.setSectorWeightsFor,
    setAlerts: _p.setAlerts, setSectorCache: _p.setSectorCache,
    addPosition: _p.addPosition, updatePosition: _p.updatePosition,
    removePosition: _p.removePosition, removePositions: _p.removePositions,
    sellPosition: _p.sellPosition, importPositions: _p.importPositions,
    addContribution: _p.addContribution, removeContribution: _p.removeContribution,
    importContributions: _p.importContributions, addTfsaDeposit: _p.addTfsaDeposit,
    updateTfsaDeposit: _p.updateTfsaDeposit, removeTfsaDeposit: _p.removeTfsaDeposit,
    removeTfsaDeposits: _p.removeTfsaDeposits, addWatch: _p.addWatch,
    removeWatch: _p.removeWatch, moveWatch: _p.moveWatch, toggleWatchList: _p.toggleWatchList,
    addWatchGroup: _p.addWatchGroup, renameWatchGroup: _p.renameWatchGroup,
    removeWatchGroup: _p.removeWatchGroup, addAlert: _p.addAlert, removeAlert: _p.removeAlert,
  }, toast);
  useEffect(() => {
    if (previewLoadError > 0) { const m = describeOutcome({ code: 'preview-load-failed' }); if (m) toast(m); }
  }, [previewLoadError]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Keep the iOS launch images on the same theme as the loader they hand off
    // to (defined in index.html; absent in the verify-*.mjs harness shells).
    if (typeof window.applySplashTheme === 'function') window.applySplashTheme(theme);
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
      if (DATA.findSector(p.ticker, p.market).sector !== 'Other') return false;
      // The name classifier already places funds/bonds/gold/keyword names, so
      // don't spend a network lookup on those — only genuinely unknown equities.
      if (p.name && DATA.classifySectorByName(p.name) !== 'Other') return false;
      return true;
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
  // Persist any sector learned from an opened stock's fundamentals (Yahoo /
  // stockanalysis / Perplexity). This is how international holdings the static
  // map and the US-only background fill can't reach get permanently classified
  // once the user views them — the allocation chart then stops showing "Other".
  useEffect(() => {
    const updates = {};
    positions.forEach(p => {
      const key = priceKey(p.market, p.ticker);
      if (sectorCache[key] && sectorCache[key].sector) return;
      const fund = fundamentalsByTicker[key]?.data;
      if (fund && fund.sector && DATA.normalizeSector(fund.sector) !== 'Other') {
        updates[key] = { sector: fund.sector, industry: fund.industry || null, at: Date.now() };
      }
    });
    if (Object.keys(updates).length) setSectorCache(prev => ({ ...prev, ...updates }));
  }, [fundamentalsByTicker, positions, sectorCache, setSectorCache]);
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
  // Two-tier fetch plan (Phase 2 inc 3). Fast tier = the user's own universe,
  // always polled, positions first (they drive the portfolio "today" move). The
  // static recommendation lists are appended only once their tab is warmed, and
  // the ACTIVE lazy tab floats to the front so what's on screen refreshes first.
  // `order` drives the batch fetch + paint order; `fetchKey` (fast-tier membership
  // only) drives the auto-refetch-on-change so a mere tab switch never re-sweeps.
  const { order: fetchOrder, key: fetchKey } = useMemo(() => buildFetchPlan({
    fastTiers: [
      positions.map(p => priceKey(p.market, p.ticker)),
      watchlist.map(w => priceKey(w.market, w.ticker)),
      alerts.map(a => priceKey(a.market, a.ticker)),
      ribbonItems,
    ],
    lazyLists: LAZY_LISTS,
    warmed: warmedLists,
    activeView: view,
  }), [positions, watchlist, alerts, ribbonItems, warmedLists, view]);
  const { loading, lastUpdate, failStreak, refreshNow: refreshPricesNow, mergePrices } = usePriceFeed(fetchOrder, fetchKey);
  useEffect(() => {
    if (failStreak === 2) { const m = describeOutcome({ code: 'feed-unreachable' }); if (m) toast(m); }
  }, [failStreak]);
  // Entering a lazy tab: warm its list on first visit (so it joins the poll set)
  // and force an immediate, prioritized refresh so its prices are fresh within a
  // tick (the rehydrated cache paints last-known meanwhile). refreshPricesNow never
  // restarts an in-flight sweep — it lets the current one finish then runs once
  // more, and the float-to-front order is picked up via the feed's order ref. Deps
  // are [view] only: warmedLists/refreshPricesNow are read but we react solely to
  // tab changes (refreshPricesNow is stable; warmedLists only changes via this effect).
  useEffect(() => {
    if (!LAZY_LISTS[view]) return;
    if (!warmedLists.has(view)) setWarmedLists(prev => { const next = new Set(prev); next.add(view); return next; });
    refreshPricesNow();
  }, [view]);
  // ---- Refresh-confidence chip state (presentational; derived from the feed) ----
  const nowTick = useNow(5000);
  const [pendingAck, setPendingAck] = useState(false);     // a press we haven't resolved yet
  const [lastManual, setLastManual] = useState(false);     // most recent trigger was a user tap
  const [justSucceeded, setJustSucceeded] = useState(false); // brief "Updated ✓" flash
  const lastUpdateMs = lastUpdate ? lastUpdate.getTime() : null;
  // A tap acknowledges instantly (chip → Updating…) even if a sweep is mid-flight
  // and the press is queued; routes both the chip and the header refresh button.
  const onChipRefresh = () => { setPendingAck(true); setLastManual(true); refreshPricesNow(); };
  // lastUpdate only moves on SUCCESS (a failed sweep leaves it unchanged), so a
  // change here means fresh data landed: flash ✓ for 2s and clear ack/manual.
  useEffect(() => {
    if (lastUpdateMs == null) return;
    setJustSucceeded(true);
    setPendingAck(false);
    setLastManual(false);
    const t = setTimeout(() => setJustSucceeded(false), 2000);
    return () => clearTimeout(t);
  }, [lastUpdateMs]);
  // A failed sweep bumps failStreak without moving lastUpdate — clear the ack so
  // the chip doesn't sit on "Updating…" forever; the error state takes over.
  useEffect(() => {
    if (failStreak > 0) setPendingAck(false);
  }, [failStreak]);
  const chipState = refreshChipState({ loading, lastUpdateMs, failStreak, pendingAck, lastManual, justSucceeded, nowMs: nowTick });
  // Startup splash gate. Keep the branded loader up until the first quotes land
  // (lastUpdate set), the feed gives up (failStreak), or there's simply nothing
  // to fetch — so the dashboard never flashes empty/placeholder numbers on a cold
  // open. The fail-safe timeout guarantees we never trap the user behind it.
  const [booting, setBooting] = useState(true);
  // Warm-start fast path: last-known prices are rehydrated from localStorage
  // synchronously (see usePriceFeed), so if they already cover every one of the
  // user's own holdings the dashboard can paint real numbers immediately — no
  // reason to sit on the splash waiting for the network round-trip. Only a true
  // cold open (no cached prices) falls through to wait for the first fetch.
  const computePositionsCached = useCallback(() => {
    const pr = PBStore.getPrices();
    return positions.length > 0 && positions.every(p => {
      const q = pr[priceKey(p.market, p.ticker)];
      return q && typeof q.price === 'number';
    });
  }, [positions]);
  // Whether this open was warm (cached prices ready at mount) is captured once.
  // A warm start only lets us stop WAITING on the network early — it no longer
  // shortens the splash. Every genuine cold/from-scratch open (a fresh page load:
  // first launch, or relaunch after the app was swiped out of the recents list)
  // remounts <App>, so we always hold the branded loader for the full
  // MIN_COLD_MS — the user asked for at least 2.5s of intro on a from-scratch
  // open, and the animation should play through rather than flash by. A PWA
  // merely resumed from the background does NOT remount, so it stays instant.
  const bootStartRef = useRef(Date.now());
  const [warmStart] = useState(() => computePositionsCached());
  const MIN_COLD_MS = 2500;
  useEffect(() => {
    if (!booting) return;
    const ready = warmStart || lastUpdate || computePositionsCached() || failStreak >= 2 || fetchOrder.length === 0;
    if (!ready) return;
    const minMs = MIN_COLD_MS;
    const elapsed = Date.now() - bootStartRef.current;
    if (elapsed >= minMs) { setBooting(false); return; }
    const t = setTimeout(() => setBooting(false), minMs - elapsed);
    return () => clearTimeout(t);
  }, [booting, warmStart, lastUpdate, computePositionsCached, failStreak, fetchOrder.length]);
  // Absolute fail-safe so a slow/unreachable feed never traps the user behind
  // the splash, even on a cold open.
  useEffect(() => {
    const t = setTimeout(() => setBooting(false), 8000);
    return () => clearTimeout(t);
  }, []);
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
          icon: './brand/icon-192.png',
          badge: './brand/icon-192.png'
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
          icon: './brand/icon-192.png'
        });
        return;
      }
    } catch (e) {}
    try {
      if (Notification.permission === 'granted') {
        new Notification(title, {
          body,
          tag: 'alert-' + trig.id,
          icon: './brand/icon-192.png'
        });
        return;
      }
    } catch (e) {}
    toast(`${title}: ${body}`);
  }, [toast]);
  const { triggered, setTriggered, alertSeenMap, setAlertSeenMap } = useAlertEngine(alerts, fireNotification);
  // Background price-alert delivery: mirror config to the SW, register periodic
  // sync, and reconcile anything fired while the app was closed.
  useBackgroundAlerts(alerts, alertSeenMap, setAlertSeenMap, setTriggered, notifPerm);
  // Optional server-push backend for always-on, app-closed alerts (premium tier).
  const { pushStatus, connectPush: _connectPush, testPush: _testPush, disconnectPush: _disconnectPush } =
    usePushBackend(pushBackend, setPushBackend, alerts, notifPerm);
  const { connectPush, testPush, disconnectPush, saveBackup } = useToastEvents({
    connectPush: _connectPush, testPush: _testPush, disconnectPush: _disconnectPush,
    saveBackup: saveBackupFile,
  }, toast);
  const cloudBackup = useCloudBackup(pushBackend, toast);
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
              icon: './brand/icon-192.png'
            });
          } else {
            new Notification('Playbook', {
              body: 'Alerts are active',
              icon: './brand/icon-192.png'
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
  // Hot Topics: union of your holdings + watchlist with the curated mega-cap and
  // JSE universes, resolved against the AI briefing + scheduled macro calendar.
  const loadHotTopics = useCallback((force = false) => {
    const seen = new Set();
    const userSymbols = [];
    for (const p of [...positions, ...watchlist]) {
      const k = p.market + ':' + p.ticker;
      if (!seen.has(k)) { seen.add(k); userSymbols.push({ ticker: p.ticker, market: p.market }); }
    }
    for (const t of HOT_MEGACAPS) { const k = 'US:' + t; if (!seen.has(k)) { seen.add(k); userSymbols.push({ ticker: t, market: 'US' }); } }
    for (const t of HOT_JSE) { const k = 'JSE:' + t; if (!seen.has(k)) { seen.add(k); userSymbols.push({ ticker: t, market: 'JSE' }); } }
    // "Yours" reflects only stocks you actually hold (positions) — not watchlist
    // names or the curated mega-cap/JSE universe that also seed the calendar.
    const heldTickers = new Set(positions.map(p => (p.ticker || '').toUpperCase()));
    return loadHotTopicsRaw('hot', () => buildHotTopics(perplexityKey, userSymbols, fundamentalsByTicker, heldTickers), force);
  }, [loadHotTopicsRaw, positions, watchlist, perplexityKey, fundamentalsByTicker]);
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
    // Full snapshot of every durable pb.* key (not a hand-picked subset), so the
    // file captures holdings, watchlists, alerts, contributions, transactions,
    // sector weights, TFSA targets and all settings.
    saveBackup(JSON.stringify(gatherBackup(), null, 2));
  };
  const importData = file => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const n = applyBackup(JSON.parse(e.target.result));
        if (n < 0) { toast('Invalid backup file'); return; }
        // The simplest, race-free way to adopt a wholesale restore is to let every
        // usePersistedState re-initialise from the freshly written localStorage.
        toast('Backup restored — reloading…');
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        toast('Invalid backup file');
      }
    };
    reader.readAsText(file);
  };
  const getPrice = (ticker, market) => PBStore.getPrices()[priceKey(market || 'US', ticker)];
  const loadFundamentals = useCallback((ticker, market, force = false) => {
    const info = DATA.findInfo(ticker, market);
    return loadFundamentalsRaw(`${market}:${ticker}`, () => fetchFundamentals(ticker, market, info?.name, perplexityKey), force);
  }, [loadFundamentalsRaw, perplexityKey]);
  const openDetail = useCallback((ticker, market, opts) => {
    const mkt = market || 'US';
    setSelected({
      ticker,
      market: mkt,
      openAlerts: !!(opts && opts.openAlerts)
    });
    // Macro/market indicators show a chart + explanation + price triggers, but
    // no company news or fundamentals — so skip those fetches and prefetch the
    // indicator's preferred chart range instead of the stock default.
    const ind = indicatorFor(mkt, ticker);
    if (ind) {
      loadHistory(ticker, mkt, ind.defaultRange || '1y');
    } else {
      loadNews(ticker, mkt);
      loadHistory(ticker, mkt, '1y');
      loadFundamentals(ticker, mkt);
    }
  }, [loadHistory, loadNews, loadFundamentals]);
  // Stable modal-openers shared by every view's HoldingRow (close over stable setters only),
  // so HoldingRow's React.memo skips rows whose data is unchanged.
  const onEditPosition = useCallback(pos => { setPosModalEditId(pos.id); setPosModalOpen(true); }, []);
  const onBuyPosition = useCallback(pos => setBuyModalPos(pos), []);
  const onSellPosition = useCallback(pos => setSellModalPos(pos), []);
  const views = {
    dashboard: React.createElement(DashboardView, {
      positions: positions,
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
      fundamentals: fundamentalsByTicker,
      sectorWeights: sectorWeights,
      onSetSectorWeights: setSectorWeightsFor
    }),
    current: React.createElement(CurrentView, {
      positions: positions,
      marketFilter: marketFilter,
      setMarketFilter: setMarketFilter,
      fxRates: fxRates,
      onOpenDetail: openDetail,
      onAddPosition: () => {
        setPosModalEditId(null);
        // Default the new holding to whichever market tab the user is on (US / JSE
        // / TFSA / LSE / ASX / …), not just the three primary ones.
        setPosModalDefaultMarket(MARKETS.some(mk => mk.value === marketFilter) ? marketFilter : 'US');
        setPosModalOpen(true);
      },
      onEditPosition: onEditPosition,
      onImportPositions: () => { setImportMarket(marketFilter); setShowImport(true); },
      onBuyPosition: onBuyPosition,
      onSellPosition: onSellPosition
    }),
    watchlist: React.createElement(WatchlistView, {
      watchlist: watchlist,
      positions: positions,
      watchlistGroups: watchlistGroups,
      alerts: alerts,
      onAdd: addWatch,
      onRemove: removeWatch,
      onReorder: setWatchlist,
      onMoveWatch: moveWatch,
      onAddWatchGroup: addWatchGroup,
      onRenameWatchGroup: renameWatchGroup,
      onRemoveWatchGroup: removeWatchGroup,
      onOpenDetail: openDetail,
      onAddAlert: addAlert,
      onRemoveAlert: removeAlert,
      childSwipeLockRef: childSwipeLockRef
    }),
    heatmap: React.createElement(HeatmapView, {
      positions: positions,
      onOpenDetail: openDetail,
      displayCurrency: displayCurrency,
      fxRates: fxRates
    }),
    rotation: React.createElement(MarketRotationView, {
      onOpenDetail: openDetail
    }),
    picks: React.createElement(PicksView, {
      onOpenDetail: openDetail
    }),
    hedges: React.createElement(HedgesView, {
      onOpenDetail: openDetail
    }),
    tfsa: React.createElement(TFSAView, {
      positions: positions.filter(p => p.market === 'TFSA'),
      onOpenDetail: openDetail,
      onAddPosition: () => { setPosModalEditId(null); setPosModalDefaultMarket('TFSA'); setPosModalOpen(true); },
      onEditPosition: onEditPosition,
      onBuyPosition: onBuyPosition,
      onSellPosition: onSellPosition,
      tfsaDeposits: tfsaDeposits,
      onAddTfsaDeposit: addTfsaDeposit,
      onUpdateTfsaDeposit: updateTfsaDeposit,
      onRemoveTfsaDeposit: removeTfsaDeposit,
      onRemoveTfsaDeposits: removeTfsaDeposits,
      fxRates: fxRates,
      sectorCache: sectorCache,
      fundamentals: fundamentalsByTicker,
      sectorWeights: sectorWeights,
      onSetSectorWeights: setSectorWeightsFor
    }),
    hot: React.createElement(HotTopicsView, {
      hot: hotTopicsCache['hot'],
      onLoad: loadHotTopics,
      onOpenDetail: openDetail,
      perplexityKey: perplexityKey,
      onOpenAlerts: () => setShowAlerts(true),
      toast: toast
    }),
    rules: React.createElement(RulesView, null),
    overview: React.createElement(OverviewView, null)
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
  }, React.createElement(BrandMark, {
    theme: theme
  }), React.createElement("div", {
    className: "brand-title"
  }, "Playbook"), previewMode && React.createElement("span", {
    className: "preview-badge"
  }, "Preview")), React.createElement(RefreshControl, {
    chipState: chipState,
    loading: loading,
    onRefresh: onChipRefresh
  }), React.createElement("button", {
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
    onClick: () => setShowSettings(true),
    "aria-label": "Settings"
  }, React.createElement(Icon, {
    name: "settings"
  })))), React.createElement(Hero, {
    onOpenDetail: openDetail
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
    positions: positions,
    watchlist: watchlist,
    watchlistGroups: watchlistGroups,
    alerts: alerts.filter(a => a.ticker === selected.ticker && a.market === selected.market),
    news: newsByTicker[priceKey(selected.market, selected.ticker)],
    historyByTicker: historyByTicker,
    fundamentals: fundamentalsByTicker[priceKey(selected.market, selected.ticker)],
    fxRates: fxRates,
    onClose: () => setSelected(null),
    onAddWatch: addWatch,
    onRemoveWatch: removeWatch,
    onMoveWatch: moveWatch,
    onToggleWatchList: toggleWatchList,
    onAddWatchGroup: addWatchGroup,
    onAddAlert: addAlert,
    onRemoveAlert: removeAlert,
    onLoadNews: () => loadNews(selected.ticker, selected.market),
    onLoadHistory: (r) => loadHistory(selected.ticker, selected.market, r),
    onRetryFundamentals: () => loadFundamentals(selected.ticker, selected.market, true)
  }), showSettings && React.createElement(SettingsModal, {
    fxRates: fxRates,
    onRefreshFx: refreshFx,
    positions: positions,
    contributions: contributions,
    onExport: exportData,
    onImport: importData,
    cloudBackup: cloudBackup,
    onDeleteHoldings: removePositions,
    tabOrder: orderedKeys,
    hiddenTabs: hiddenTabs,
    pushStatus: pushStatus,
    onConnectPush: connectPush,
    onTestPush: testPush,
    onDisconnectPush: disconnectPush,
    onClose: () => setShowSettings(false)
  }), showAlerts && React.createElement(AlertsModal, {
    alerts: alerts,
    triggered: triggered,
    notifPerm: notifPerm,
    onClose: () => setShowAlerts(false),
    onRemoveAlert: removeAlert,
    onClearTriggered: clearTriggered,
    onRequestPerm: requestNotifPerm,
    onOpenDetail: openDetail
  }), posModalOpen && React.createElement(PositionModal, {
    editId: posModalEditId,
    existing: posModalEditId ? positions.find(p => p.id === posModalEditId) : null,
    defaultMarket: posModalDefaultMarket,
    displayCurrency: displayCurrency,
    initialSectorWeights: (() => {
      const ex = posModalEditId ? positions.find(p => p.id === posModalEditId) : null;
      return ex ? (sectorWeights[priceKey(ex.market, ex.ticker)] || null) : null;
    })(),
    onClose: () => setPosModalOpen(false),
    onSave: (data, quote) => {
      if (posModalEditId) {
        updatePosition(posModalEditId, data);
        // Re-pointed to a different listing: seed its price so the new ticker
        // shows a live value immediately instead of waiting for the next poll.
        if (quote) mergePrices({ [priceKey(data.market, data.ticker)]: quote });
        else seedQuote(data.ticker, data.market);
      } else {
        addPosition(data.ticker, data.market, data.shares, data.costBasis, data.notes, data.purchaseDate, data.costCurrency);
        if (quote) mergePrices({ [priceKey(data.market, data.ticker)]: quote });
        else seedQuote(data.ticker, data.market);
      }
      // Remember the sector the user confirmed/picked so the allocation chart uses
      // it (same learned-cache path the import flow writes to).
      if (data.sector) {
        const s = DATA.normalizeSector(data.sector);
        if (s && s !== 'Other') setSectorCache(prev => ({ ...prev, [priceKey(data.market, data.ticker)]: { sector: s, industry: data.sector, at: Date.now() } }));
      }
      // Persist the fund's sector breakdown (keyed by instrument, shared across
      // accounts holding the same fund). Empty clears it.
      setSectorWeightsFor(priceKey(data.market, data.ticker), data.sectorWeights || null);
      setPosModalOpen(false);
    }
  }), showImport && React.createElement(ModalBoundary, {
    onError: () => { setShowImport(false); toast('Import hit a snag and was closed safely — your portfolio is unchanged. Please try again.'); }
  }, React.createElement(ImportModal, {
    defaultMarket: importMarket,
    onClose: () => setShowImport(false),
    onImport: async (holdings) => {
      await importPositions(holdings);
      // Seed the imported symbols so the dashboard reflects them immediately.
      holdings.forEach(h => seedQuote(h.ticker, h.market));
    }
  })), sellModalPos && React.createElement(SellModal, {
    position: sellModalPos,
    onClose: () => setSellModalPos(null),
    onSell: (ticker, market, shares, price, date, notes) => {
      sellPosition(ticker, market, shares, price, date, notes);
      setSellModalPos(null);
    }
  }), buyModalPos && React.createElement(BuyModal, {
    position: buyModalPos,
    fxRates: fxRates,
    onClose: () => setBuyModalPos(null),
    onBuy: (ticker, market, shares, price, date, notes, costCurrency) => {
      addPosition(ticker, market, shares, price, notes, date, costCurrency);
      setBuyModalPos(null);
    }
  }), showInstallBanner && React.createElement(InstallBanner, {
    isIOS: /iphone|ipad|ipod/i.test(navigator.userAgent),
    onInstall: handleInstall,
    onDismiss: dismissInstall,
    canPrompt: !!installEvent
  }), React.createElement(LoadingScreen, { visible: booting }));
}
function Hero(_ref4) {
  let {
    onOpenDetail
  } = _ref4;
  const ribbonItems = PBStore.useSetting('ribbonItems');
  const ribbonMode = PBStore.useSetting('ribbonMode');
  const prices = PBStore.usePricesMap();
  const ribbonScrollRef = useRef(null);
  const ribbonAnimRef = useRef(null);
  const ribbonOffsetRef = useRef(0);
  const ribbonDragRef = useRef(null);
  // Tracks whether the last touch interaction was a drag (scrub) rather than a
  // tap, so dragging the marquee never accidentally opens a card on release.
  const ribbonMovedRef = useRef(false);

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
    ribbonMovedRef.current = false;
    ribbonDragRef.current = { startX: touch.clientX, startOffset: ribbonOffsetRef.current };
  };
  const onRibbonTouchMove = (e) => {
    const drag = ribbonDragRef.current;
    if (!drag) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - drag.startX;
    if (Math.abs(dx) > 6) ribbonMovedRef.current = true;
    ribbonOffsetRef.current = drag.startOffset - dx;
    const el = ribbonScrollRef.current;
    if (el) el.style.transform = `translateX(-${ribbonOffsetRef.current}px)`;
  };
  const onRibbonTouchEnd = () => { ribbonDragRef.current = null; };

  const openPill = (cat) => {
    if (ribbonMovedRef.current) return; // a drag, not a tap — don't open a card
    if (onOpenDetail) onOpenDetail(cat.ticker, cat.market);
  };
  const renderPill = (key, suffix) => {
    const cat = RIBBON_CATALOG_MAP[key];
    if (!cat) return null;
    const quote = prices[key];
    const has = !!quote;
    const up = has && quote.changePct >= 0;
    const colorUp = cat.invertColor ? !up : up;
    const valStr = !has ? '—'
      : (cat.unit ? fmtIndicator(cat, quote.price)
                  : quote.price.toLocaleString('en-US', { minimumFractionDigits: cat.decimals, maximumFractionDigits: cat.decimals }));
    return React.createElement("div", {
      key: key + (suffix || ''),
      className: "ribbon-pill ribbon-pill-tappable",
      role: "button", tabIndex: 0,
      title: cat.label + ' — tap for chart, info & alerts',
      onClick: () => openPill(cat),
      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPill(cat); } }
    },
      React.createElement("span", { className: "ribbon-pill-label" }, cat.short),
      React.createElement("span", { className: "ribbon-pill-val" }, valStr),
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
// Header refresh control: the price-feed status folded into the refresh button.
// A colored dot shows feed state at rest; a quick tap (native click, also
// keyboard Enter/Space) refreshes; press-and-hold "peeks" a pill that expands
// to the relative-time text and springs closed on release (no refresh). Refresh
// runs on click; pointer events only add the hold→peek and suppress the trailing
// click so a peek-release never refreshes.
function RefreshControl({ chipState, loading, onRefresh }) {
  const [peeking, setPeeking] = useState(false);
  const [peekW, setPeekW] = useState(0);
  const holdRef = useRef(null);
  const startRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);
  const peekingRef = useRef(false);
  const textRef = useRef(null);
  const HOLD_MS = 200, SLOP2 = 100, PAD = 54; // PAD = 14px left + 40px icon clearance

  const clearHold = () => { if (holdRef.current) { clearTimeout(holdRef.current); holdRef.current = null; } };
  const open = () => { peekingRef.current = true; suppressClickRef.current = true; setPeeking(true); };
  const close = () => { peekingRef.current = false; setPeeking(false); };

  // Measure the (always-rendered, naturally-sized) text on open and whenever the
  // live label changes while held, so the pill width tracks "Updated 6s ago" etc.
  useEffect(() => {
    if (!peeking) { setPeekW(0); return; }
    const w = textRef.current ? textRef.current.scrollWidth : 0;
    setPeekW(w + PAD);
  }, [peeking, chipState.text]);
  useEffect(() => () => clearHold(), []);

  const onPointerDown = (e) => {
    if (e.button != null && e.button > 0) return;
    suppressClickRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    clearHold();
    holdRef.current = setTimeout(() => { holdRef.current = null; open(); }, HOLD_MS);
  };
  const onPointerMove = (e) => {
    if (!holdRef.current) return;
    const dx = e.clientX - startRef.current.x, dy = e.clientY - startRef.current.y;
    if (dx * dx + dy * dy > SLOP2) clearHold(); // moved → it's a scroll, not a hold
  };
  const endPointer = () => {
    clearHold();
    if (peekingRef.current) { close(); setTimeout(() => { suppressClickRef.current = false; }, 400); }
  };
  const onClick = (e) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; e.preventDefault(); return; }
    onRefresh();
  };

  return React.createElement("div", { className: "refresh-ctl" + (peeking ? " peeking" : "") },
    React.createElement("div", { className: "refresh-peek", "aria-hidden": "true", style: { width: peeking ? peekW + 'px' : undefined } },
      React.createElement("span", { className: "refresh-peek-text", ref: textRef }, chipState.text)),
    React.createElement("button", {
      className: "icon-btn refresh-btn" + (loading ? " spin" : ""),
      onPointerDown, onPointerMove, onPointerUp: endPointer, onPointerCancel: endPointer, onClick,
      onContextMenu: (e) => e.preventDefault(),
      title: chipState.phase === 'error' ? 'Price feed failing — tap to retry' : chipState.text,
      "aria-label": chipState.text + ' — tap to refresh'
    },
      React.createElement(Icon, { name: "refresh" }),
      React.createElement("span", { className: "refresh-dot dot " + chipState.dot })));
}
// Per-symbol market-session badge. When Yahoo reports a live ext session with a
// move, quote.extKind ('pre'/'post') is authoritative; otherwise fall back to the
// clock kernel (which also catches a pre session with no move yet, and weekends/
// overnight as 'closed'). Renders nothing for CRYPTO (always open).
const SessionBadge = React.memo(function SessionBadge({ market, quote }) {
  if (market === 'CRYPTO') return null;
  // Only a LIVE ext reading may claim the pre/post phase — a FINAL (session
  // over) after-close quote must not make an overnight card read as "After-hours
  // live"; the clock kernel correctly reports those as closed.
  const ext = quote && quote.extLive && (quote.extKind === 'pre' || quote.extKind === 'post') ? quote.extKind : null;
  const { phase, nextOpen } = ext ? { phase: ext, nextOpen: null } : marketSession(market);
  const label = phase === 'pre' ? 'Pre-market'
    : phase === 'post' ? 'After-hours'
    : phase === 'open' ? 'Open'
    : (nextOpen ? `Closed · opens ${nextOpen}` : 'Closed');
  return React.createElement("div", { className: `session-badge session-${phase}` },
    React.createElement("span", { className: "session-dot" }),
    React.createElement("span", { className: "session-label" }, label));
});
const PriceBlock = React.memo(function PriceBlock(_ref5) {
  let {
    quote,
    size = 'md',
    showDailyRow = false,
    hideChange = false,
    hideExt = false,
    market
  } = _ref5;
  if (!quote) return React.createElement("span", {
    className: "mono text-dim"
  }, "\u2014");
  const up = quote.changePct >= 0;
  // Prefer the position's market for the symbol (authoritative \u2014 the user chose
  // it) so a US holding never shows \u00a3/\u20ac; only fall back to the quote's own
  // currency when no market context is available.
  const sym = market && MARKET_CURRENCY[market]
    ? MARKET_CURRENCY[market].sym
    : ({ ZAR: 'R', GBP: '\u00a3', AUD: 'A$', EUR: '\u20ac' })[quote.currency] || '$';
  const klass = size === 'xl' ? 'price price-xl' : size === 'lg' ? 'price price-lg' : 'price';
  const hasExt = quote.extPrice != null && quote.extChangePct != null;
  const extUp = hasExt && quote.extChangePct >= 0;
  // extLive false = the session ended and this is its FINAL reading (the
  // overnight "move after the close"); label it "After close" so it never
  // masquerades as a live after-hours tape.
  const extFinal = hasExt && quote.extLive === false;
  const extLabel = quote.extKind === 'pre' ? 'Pre-market' : quote.extKind === 'post' ? (extFinal ? 'After close' : 'After-hours') : '';
  // Is the day move a live figure, or the last completed session's? Drives the
  // "Today" / "At close" label below. CRYPTO never closes, so it is always live.
  const dayAtClose = !!market && market !== 'CRYPTO' && marketSession(market).phase !== 'open';
  const chgAbs = (typeof quote.change === 'number' && isFinite(quote.change)) ? quote.change : null;
  const extChgAbs = (typeof quote.extChange === 'number' && isFinite(quote.extChange)) ? quote.extChange : null;
  const prevClose = (typeof quote.prevClose === 'number' && isFinite(quote.prevClose) && quote.prevClose > 0) ? quote.prevClose : null;
  return React.createElement("div", {
    className: "price-block-wrap"
  }, React.createElement("div", {
    className: "flex items-baseline gap-2"
  }, React.createElement("span", {
    className: klass
  }, sym, fmtNum(quote.price)),
  // When the "Today" row is shown it carries the day's move (with the cash
  // amount), so omit the inline chip here to avoid showing the % twice.
  // hideChange renders the price alone (the caller shows the move elsewhere).
  !showDailyRow && !hideChange && React.createElement("span", {
    className: `chg ${up ? 'up' : 'down'}`
  }, up ? '▲' : '▼', " ", up ? '+' : '', quote.changePct.toFixed(2), "%")),
  // Detail card: lay the daily figures (Today + Prev close) in a left column,
  // then a vertical divider, then the extended-hours (pre-market) move on the
  // right so the user can read "what happened today" vs "what's happening before
  // the open" side by side.
  showDailyRow && !hideChange && React.createElement("div", { className: "daily-block" },
    React.createElement("div", { className: "daily-col" },
      React.createElement("div", { className: "daily-row" },
        // "Today" only while the market is actually in its regular session. The
        // day move is that session's open-to-close, so outside it the figure is
        // the LAST COMPLETED session's — labelling that "Today" is what made a
        // stale reading indistinguishable from a live one.
        React.createElement("span", { className: "daily-label" }, dayAtClose ? "At close" : "Today"),
        React.createElement("span", { className: `daily-val mono ${up ? 'up' : 'down'}` },
          (up ? '+' : '') + quote.changePct.toFixed(2) + '%',
          chgAbs != null ? ' · ' + (up ? '+' : '-') + sym + fmtNum(Math.abs(chgAbs)) : ''
        )
      ),
      // The previous close is the reference every daily/intraday move is measured
      // from, so surface it explicitly alongside the "Today" move.
      prevClose != null && React.createElement("div", { className: "daily-row prevclose-row" },
        React.createElement("span", { className: "daily-label" }, "Prev close"),
        React.createElement("span", { className: "daily-val mono prevclose-val" }, sym + fmtNum(prevClose))
      )
    ),
    hasExt && React.createElement("div", { className: "daily-divider" + (extFinal ? " ext-closed" : "") }),
    // Extended-hours column mirrors the "Today" column: the live pre/post price on
    // top, then its move vs the regular close as "+%  ·  +cash" — the same figures
    // Google surfaces as e.g. "After hours 1 235,00 +23,62 (1,95%)".
    hasExt && React.createElement("div", { className: "daily-col" + (extFinal ? " ext-closed" : "") },
      React.createElement("div", { className: "daily-row" },
        React.createElement("span", { className: "daily-label" }, extLabel),
        React.createElement("span", { className: "daily-val mono" }, sym + fmtNum(quote.extPrice))
      ),
      React.createElement("div", { className: "daily-row prevclose-row" },
        React.createElement("span", { className: "daily-label" }, "vs close"),
        React.createElement("span", { className: `daily-val mono ${extUp ? 'up' : 'down'}` },
          (extUp ? '+' : '') + quote.extChangePct.toFixed(2) + '%' +
          (extChgAbs != null ? ' · ' + (extUp ? '+' : '-') + sym + fmtNum(Math.abs(extChgAbs)) : '')
        )
      )
    )
  ),
  // Per-symbol session badge — fills the gap when there's no ext-price chip
  // (regular/closed hours, or a pre/post session with no move yet) so a quiet
  // quote still shows its market state. hideExt callers (watchlist) render their own.
  !hasExt && !hideExt && React.createElement(SessionBadge, { market: market, quote: quote }),
  // Outside the detail card (rows/lists): compact ext-hours chip — label, live
  // pre/post price, then the signed % (with cash move) vs the regular close.
  // hideExt lets a caller (e.g. the watchlist card) lift the chip out of the
  // price block and place it elsewhere so the header price stays right-aligned.
  !showDailyRow && hasExt && !hideExt && React.createElement("div", {
    className: "ext-hours" + (extFinal ? " ext-closed" : "")
  }, React.createElement("span", {
    className: "ext-label"
  }, extLabel), React.createElement("span", {
    className: "ext-price mono"
  }, sym, fmtNum(quote.extPrice)), React.createElement("span", {
    className: `ext-chg mono ${extUp ? 'up' : 'down'}`
  }, (extUp ? '+' : '') + quote.extChangePct.toFixed(2) + '%' +
     (extChgAbs != null ? ' · ' + (extUp ? '+' : '-') + sym + fmtNum(Math.abs(extChgAbs)) : ''))));
});
// PortfolioLineChart (+ CHART_MONTHS / chartDayLabel / buildTimeAxisTicks axis helpers) moved to
// pb-views.js (Phase 4 inc 24) as DashboardView's single-caller growth-chart subtree.
// Resolve a held position to a canonical sector. Prefers a live/cached
// classification — the persisted background fill or an opened-stock fundamentals
// fetch — over the static map, so the allocation chart reflects real GICS
// sectors and keeps "Other" to genuinely unknown symbols only.
function resolvePositionSector(ticker, market, sectorCache, fundamentals, name) {
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
  const found = DATA.findSector(ticker, market);
  if (found.sector !== 'Other') return found;
  // Final fallback: read the instrument's display name. Catches funds, bonds,
  // gold, crypto, REITs and keyword-bearing foreign equities the maps miss, so
  // the allocation chart converges to ~zero "Other".
  if (name) {
    const byName = DATA.classifySectorByName(name);
    if (byName && byName !== 'Other') return { sector: byName, industry: byName };
  }
  return found;
}
// SectorAllocationModal moved to pb-modals.js (Phase 4 inc 11).
// SectorWeightRows moved to pb-modals.js (Phase 4 inc 31) — it now lives beside its only callers
// (SectorAllocationModal + PositionModal, both in the bucket) and is off the PBApp bridge.
const SectorAllocationModal = PBModals.SectorAllocationModal;
// Donut palettes moved to pb-views.js (Phase 4 inc 30) — private colour scales for PortfolioPieChart.
// SVG donut/pie chart — supports grouping by ticker, sector, or market
const MARKET_LABELS = { US: 'USA', JSE: 'SA', TFSA: 'TFSA', LSE: 'UK', ASX: 'AUS', FRA: 'EUR', PAR: 'EUR', AMS: 'EUR', CRYPTO: 'Crypto' };
// PortfolioPieChart moved to pb-views.js (Phase 4 inc 30); it now lives beside its only callers
// (DashboardView/TFSAView, both in the bucket) and is no longer on the PBApp bridge.
// resolvePositionSector stays in app.js (it reads DATA) and is bridged for the chart.
// SectorHoldingsPopup moved to pb-views.js (Phase 4 inc 30) — a single-caller of PortfolioPieChart,
// so it is consumed only by the bucket and not bound back into app.js.
// DashboardView moved to pb-views.js (Phase 4 inc 24). fmtNum stays in app.js and is reached via
// the PBApp bridge (PortfolioPieChart moved to the bucket in inc 30); the two contribution modals
// are read from PBModals at render time. Bind the view here for the App tab switch.
const DashboardView = PBViews.DashboardView;
// A single holding row, laid out as three zones:
//  • Left  — company/instrument name (main heading), then the ticker + shares +
//            avg cost as a small subheading, plus inline Buy more / Sell.
//  • Middle — total gain/loss for the holding: the amount on top, the % below.
//  • Right — current holding value on top, the day's movement underneath.
// Subtle column header sitting above a holdings list, labelling the three
// HoldingsListHead + HoldingRow moved to pb-views.js (Phase 4 inc 28); the view bucket is their only consumer, so they are not bound back here.
// CurrentView is defined in pb-views.js (Phase 4 inc 25); bind it here.
const CurrentView = PBViews.CurrentView;
// Shorthand / index names brokers and people actually use for instruments whose
// official names don't textually resemble them — keyed by ticker. Without these,
// abbreviated ETF names ("Satrix ILBI", "Satrix Gov Bonds") score poorly against
// their formal listing name ("…Inflation-Linked Bond ETF", "…SA Bond ETF") and
// used to collapse onto the issuer's flagship Top-40 fund on import. Each alias
// is matched alongside the display name (best signal wins) during import ranking.
const INSTRUMENT_ALIASES = {
  // JSE bond / inflation-linked ETFs — quoted by their index (GOVI, ILBI) or as
  // "government bond", neither of which matches the official "…SA Bond" name.
  STXGOV: ['Satrix Government Bond ETF', 'Satrix GOVI', 'Satrix Gov Bonds', 'Satrix SA Government Bond ETF', 'GOVI'],
  STXILB: ['Satrix ILBI', 'Satrix Inflation Linked Bond ETF', 'Satrix Inflation-Linked Bond Index', 'ILBI'],
  NFGOVI: ['NewFunds GOVI ETF', 'NewFunds Government Bond ETF', 'GOVI'],
  NFILBI: ['NewFunds ILBI ETF', 'NewFunds Inflation-Linked Bond ETF', 'ILBI'],
  ETFGGB: ['1nvest Global Government Bond ETF', 'GOVI Global'],
  STXEMG: ['Satrix Emerging Markets ETF', 'Satrix MSCI EM ETF'],
  STX40: ['Satrix Top 40 ETF', 'Satrix Top40'],
  STXWDM: ['Satrix MSCI World ETF', 'Satrix World ETF'],
  STXNDQ: ['Satrix Nasdaq 100 ETF', 'Satrix Nasdaq ETF'],
  STX500: ['Satrix S&P 500 ETF', 'Satrix 500 ETF'],
  // US iShares MSCI EM listings people search by their long marketing names.
  EEM: ['iShares MSCI Emerging Markets ETF', 'iShares Emerging Markets'],
  IEMG: ['iShares Core MSCI Emerging Markets ETF', 'iShares Core Emerging Markets'],
};
const ALL_TICKERS = (() => {
  const seen = new Set();
  const result = [];
  const add = (ticker, name, market) => {
    const key = priceKey(market, ticker);
    if (!seen.has(key)) { seen.add(key); result.push({ ticker, name, market, aliases: INSTRUMENT_ALIASES[ticker] }); }
  };
  DATA.HOLDINGS.forEach(h => add(h.ticker, h.name, 'US'));
  DATA.NEW_PICKS.forEach(p => add(p.ticker, p.name, 'US'));
  DATA.HEDGES.forEach(h => add(h.ticker, h.name, 'US'));
  (DATA.US_SUGGESTIONS || []).forEach(s => add(s.ticker, s.name, 'US'));
  DATA.JSE_SUGGESTIONS.forEach(s => add(s.ticker, s.name, 'JSE'));
  (DATA.TFSA_SUGGESTIONS || []).forEach(s => add(s.ticker, s.name, 'TFSA'));
  (DATA.LSE_SUGGESTIONS || []).forEach(s => add(s.ticker, s.name, 'LSE'));
  (DATA.ASX_SUGGESTIONS || []).forEach(s => add(s.ticker, s.name, 'ASX'));
  (DATA.EU_SUGGESTIONS || []).forEach(s => add(s.ticker, s.name, s.exchange || 'FRA'));
  (DATA.CRYPTO_SUGGESTIONS || []).forEach(s => add(s.ticker, s.name, 'CRYPTO'));
  return result;
})();

// Import symbol/name matching + CSV parsing now live in pb-import.js (client-only
// pure helpers). Bound here so app.js call sites are unchanged; the DATA-derived
// ticker universe is injected since the module can't reach app.js/data.js globals.
PBImport.configure({ allTickers: ALL_TICKERS });
const parseYahooSymbol     = PBImport.parseYahooSymbol;
const normaliseCompanyName = PBImport.normaliseCompanyName;
const companyNameScore     = PBImport.companyNameScore;
const looksLikeTickerToken = PBImport.looksLikeTickerToken;
const rankImportCandidates = PBImport.rankImportCandidates;
const splitTickerMarket    = PBImport.splitTickerMarket;
const inferMarket          = PBImport.inferMarket;
const splitLine            = PBImport.splitLine;
const IMPORT_SYNONYMS      = PBImport.IMPORT_SYNONYMS;

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
      // Crypto pairs arrive as "BTC-USD"; book them on the CRYPTO market under the
      // bare base symbol (BTC) so they price via yahooSymbol's -USD re-append. Only
      // surface USD pairs — that's the unit the app holds and converts from.
      if (qt === 'CRYPTOCURRENCY') {
        const m = String(item.symbol).match(/^([A-Za-z0-9]+)-USD$/);
        if (!m) continue;
        const tk = m[1].toUpperCase();
        const nm = item.shortname || item.longname || tk;
        cacheName('CRYPTO', tk, nm);
        out.push({ ticker: tk, market: 'CRYPTO', name: nm, exchange: 'Crypto' });
        continue;
      }
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
  // SA unit trusts (Coronation, Allan Gray, …) live only on Morningstar's fund
  // feed, never on Yahoo — fold them in when importing into a ZAR account so a
  // fund name resolves to its NAV alongside JSE-listed equities/ETFs.
  if (chosenMarket === 'JSE' || chosenMarket === 'TFSA') {
    try { merged.push(...await searchUnitTrusts(q, chosenMarket)); } catch (_e) {}
  }
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

// The generic-table column mapper + Easy Equities OCR-text parsers now live in
// pb-import.js (client-only pure helpers). Bound here so app.js call sites in the
// impure file/OCR readers (parseXlsxFile/parsePdfFile/parseImportFile/ocrImageFile/
// parseCashFlowFile) are unchanged.
const rowsToHoldings             = PBImport.rowsToHoldings;
const parseHoldingsFromText      = PBImport.parseHoldingsFromText;
const stripListMarker            = PBImport.stripListMarker;
const parseEasyEquitiesScreenshot = PBImport.parseEasyEquitiesScreenshot;
const dedupeEeHoldings           = PBImport.dedupeEeHoldings;

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

// ── Easy Equities screenshot import (on-device OCR) ─────────────────────────
// The user screenshots their holdings inside the Easy Equities app (a single
// holding page, the portfolio list, an emailed trade confirmation, or a
// transaction-history row) and drops the images in. We OCR
// them entirely in-browser with Tesseract.js — loaded lazily from a CDN only
// when an image is actually scanned, so nothing is uploaded and the feature
// adds no weight to first paint. The extracted name / JSE code / share count /
// average price funnel into the same import-review flow as every other source,
// so any OCR slip is correctable before it's committed.
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
// The worker is created once and reused across a batch of screenshots — spinning
// up a fresh wasm worker per image would re-download the language data each time.
let _eeOcrWorker = null;
let _eeOcrProgress = null;
async function getOcrWorker() {
  await loadScriptOnce(TESSERACT_CDN);
  if (!window.Tesseract) throw new Error('On-device reader failed to load. Check your connection and try again.');
  if (!_eeOcrWorker) {
    _eeOcrWorker = await window.Tesseract.createWorker('eng', 1, {
      logger: m => { if (_eeOcrProgress && m && m.status === 'recognizing text') _eeOcrProgress(m.progress || 0); },
    });
  }
  return _eeOcrWorker;
}
async function _eeLoadBitmap(file) {
  if (typeof createImageBitmap === 'function') { try { return await createImageBitmap(file); } catch (_) {} }
  if (typeof Image === 'undefined') return null;
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('img decode failed')); im.src = url; });
  } finally { setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 4000); }
}
// The instrument name lives in the Easy Equities purple title bar as white text on
// a violet background — the lowest-accuracy thing on the page for OCR, and where
// names lost detail / picked up amounts. We isolate that band (by detecting the
// purple, with a fixed-slice fallback), then OCR it on its own as a 2× inverted,
// high-contrast crop so the full title reads cleanly with nothing else around it.
async function _eeHeaderCanvas(file) {
  if (typeof document === 'undefined') return null;
  const bmp = await _eeLoadBitmap(file).catch(() => null);
  if (!bmp) return null;
  const w = bmp.width || bmp.naturalWidth || 0;
  const h = bmp.height || bmp.naturalHeight || 0;
  if (!w || !h) return null;
  const probe = document.createElement('canvas');
  probe.width = w; probe.height = Math.min(h, Math.round(h * 0.30));
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(bmp, 0, 0);
  const px = pctx.getImageData(0, 0, w, probe.height).data;
  const purpleRow = (y) => {
    let hit = 0, n = 0;
    for (let xx = Math.round(w * 0.12); xx < Math.round(w * 0.88); xx += 8) {
      const i = (y * w + xx) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
      n++;
      // Saturated violet: blue dominant, green clearly the lowest channel.
      if (b > 80 && r > 45 && g + 25 < b && g + 10 < r && b - g > 35) hit++;
    }
    return n > 0 && hit / n > 0.5;
  };
  let y0 = -1, y1 = -1;
  for (let y = Math.round(h * 0.015); y < probe.height; y++) {
    if (purpleRow(y)) { if (y0 < 0) y0 = y; y1 = y; }
    else if (y0 >= 0 && y - y1 > Math.round(h * 0.012)) break;   // band ended
  }
  if (y0 < 0 || (y1 - y0) < Math.round(h * 0.018)) { y0 = Math.round(h * 0.045); y1 = Math.round(h * 0.140); }
  y0 = Math.max(0, y0 - Math.round(h * 0.004));
  y1 = Math.min(h, y1 + Math.round(h * 0.004));
  const bandH = y1 - y0;
  if (bandH <= 0) return null;
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(bandH * scale);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, 0, y0, w, bandH, 0, 0, c.width, c.height);
  const im = x.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    let g = 255 - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); // invert → dark text on light
    g = (g - 128) * 1.45 + 128;                                          // boost contrast
    d[i] = d[i + 1] = d[i + 2] = g < 0 ? 0 : g > 255 ? 255 : g;
  }
  x.putImageData(im, 0, 0);
  return c;
}
// Returns { text, headerText }: the full-page OCR (body fields, code, fallback
// name) plus a dedicated, cleaner read of just the title bar for the name.
async function ocrImageFile(file, onProgress) {
  const worker = await getOcrWorker();
  _eeOcrProgress = onProgress || null;
  try {
    const full = await worker.recognize(file);
    let headerText = '';
    try {
      const headerCanvas = await _eeHeaderCanvas(file);
      if (headerCanvas) { const hr = await worker.recognize(headerCanvas); headerText = (hr.data && hr.data.text) || ''; }
    } catch (_) {}
    return { text: (full.data && full.data.text) || '', headerText };
  } finally {
    _eeOcrProgress = null;
  }
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

// ── Search-pick history ─────────────────────────────────────────────────────
// Every symbol the user commits from the ticker search (watchlist add, holding
// add/edit, exact-symbol override) is remembered here as a durable taste
// signal; the watchlist suggestions read it ("you searched it, you probably
// want to track it"). Newest first, deduped by market:ticker, capped small.
// Deliberately NOT in BACKUP_SKIP: it is real user signal, not a re-derivable
// cache, so it rides along in the cloud backup like other pb.* state.
const SEARCH_HIST_KEY = 'pb.searchHist.v1';
const SEARCH_HIST_MAX = 40;
function readSearchHist() {
  const arr = LS.get(SEARCH_HIST_KEY, []);
  return Array.isArray(arr) ? arr : [];
}
function recordSearchPick(s) {
  if (!s || !s.ticker || !s.market) return;
  const key = priceKey(s.market, s.ticker);
  const rest = readSearchHist().filter(h => h && h.t && h.m && priceKey(h.m, h.t) !== key);
  LS.set(SEARCH_HIST_KEY, [{ t: s.ticker, m: s.market, n: s.name || null, at: Date.now() }, ...rest].slice(0, SEARCH_HIST_MAX));
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
  // Only search/open the dropdown once the user actually types. Opening the edit
  // modal seeds this field with the holding's existing ticker, and that initial
  // value must NOT be treated as a search — otherwise the live-ticker list pops
  // open and looks like the app assumes you want to re-point the holding.
  const userTyped = useRef(false);

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
    if (!userTyped.current) { setRemoteLoading(false); return; }
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
    userTyped.current = true;
    setQuery(v);
    onChange(v);
    search(v);
  };

  const selectSuggestion = (s) => {
    justSelected.current = true;
    remoteReqId.current++;
    recordSearchPick(s);
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

  // Override hook: when the typed text is a bare symbol (optionally with an
  // exchange suffix like ".L"/".JO") that isn't already an exact suggestion, offer
  // to use it verbatim. This is what lets the user force a match when live search
  // can't surface the listing — they type the symbol and commit it directly.
  const exactSym = useMemo(() => {
    const raw = String(query || '').trim();
    if (!raw || !looksLikeTickerToken(raw)) return null;
    const sp = splitTickerMarket(raw);
    const tk = (sp.ticker || raw).toUpperCase();
    const mk = sp.market || market || 'US';
    if (ordered.some(s => s.ticker.toUpperCase() === tk && sameUnderlyingExchange(s.market, mk))) return null;
    return { ticker: tk, market: mk, name: null };
  }, [query, market, ordered]);
  const commitExact = () => { if (exactSym) selectSuggestion(exactSym); };
  const maxIdx = ordered.length - 1 + (exactSym ? 1 : 0);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActiveIdx(i => Math.min(i + 1, maxIdx)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, -1)); }
    else if (e.key === 'Enter') {
      if (open && activeIdx >= 0 && activeIdx < ordered.length) { e.preventDefault(); selectSuggestion(ordered[activeIdx]); }
      else if (exactSym) { e.preventDefault(); commitExact(); }
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
    open && (ordered.length > 0 || remoteLoading || exactSym) && React.createElement('div', { className: 'ticker-dropdown' },
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
      // Force-use the typed symbol \u2014 the actual override entry point.
      exactSym && React.createElement('div', {
        className: 'ticker-suggestion ticker-suggestion-exact' + (activeIdx === ordered.length ? ' active' : ''),
        onMouseDown: (e) => { e.preventDefault(); commitExact(); }
      },
        React.createElement('span', { className: 'tkr' }, exactSym.ticker),
        React.createElement('span', { className: 'ticker-sug-name' }, 'Use this exact symbol'),
        React.createElement('span', { className: 'market-badge' }, exactSym.market)
      ),
      !remoteLoading && !exactSym && suggestions.length > 0 && React.createElement('div', { className: 'ticker-sug-hint' }, 'Don\u2019t see your stock? Type the exact symbol.')
    )
  );
}

// An ISIN (e.g. "IE00B4L5Y983") or a bare code is not a human name — some ETF
// listings report one as the quote shortName, which reads as gibberish in the UI.
function looksLikeInstrumentCode(s) {
  const t = String(s || '').replace(/\s+/g, '');
  if (!t) return true;
  if (/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(t)) return true;       // ISIN
  if (/^[A-Z0-9]{1,6}$/.test(t) && !/[a-z]/.test(s)) return true; // bare ticker-like code
  return false;
}
// ── Display-name normalisation ──────────────────────────────────────────────
// Company / instrument names reach us from many sources — live Yahoo quotes
// ("STANDARD BANK GROUP LIMITED", "NASPERS -N-"), the curated lists, and names
// typed at import. prettyName() makes them read uniformly so the Holdings tab
// and allocation list don't mix shouted, suffixed and tidy names: it strips the
// share-class noise feeds tack on ("-N-") and the redundant "Limited"/"Ltd"
// suffix, then re-cases ALL-CAPS names to Title Case while leaving genuine
// acronyms (ETF, REIT, MSCI, MTN, BHP…) and already-tidy mixed-case names
// ("iShares", "NVIDIA", "Dis-Chem") untouched.
//
// Only genuine acronyms belong here. Consonant-only tickers (FSR, SBK, NPN,
// DRD…) are left out — the "short token, no vowels" rule below already keeps
// those upper — and pronounceable tickers (Bid, Brait/BAT, Pan…) are left out
// on purpose so they title-case to real words.
const NAME_KEEP_UPPER = new Set([
  // Instrument / index / market / currency acronyms
  'ETF','ETN','ETP','REIT','REITS','MSCI','ACWI','SWIX','RAFI','FINI','INDI',
  'RESI','SRI','ESG','CPI','EM','SA','US','USA','UK','EU','USD','EUR','GBP',
  'ZAR','AI','FTSE','NYSE','NASDAQ','FANG','PGM','PGMS','REE','II','III','IV',
  'VI','VII','VIII','BP','GE','GM','HP','JM','H&M','AT&T',
  // Acronym company names that would otherwise be wrongly title-cased
  'HSBC','GSK','WPP','RELX','SSE','CSL','ANZ','NAB','REA','GMG','XRO','TLS',
  'MTN','BHP','AVI','KAP','MAS','PPC','JSE','AECI','PSG','RMB','RMH',
]);
const NAME_FORCE_LOWER = new Set(['plc','n.v.','nv','sa','ag','se','asa']);
// Short tokens that read as words, not acronyms, so they title-case normally.
const NAME_FORCE_WORD = new Set(['MR','MRS','MS','DR','ST','JR','SR','THE','AND','OF','VON','VAN','DE','LA']);
function titleCaseToken(tok) {
  if (!tok) return tok;
  if (/\d/.test(tok)) return tok;                       // brand/number tokens: "10X", "500"
  if (tok.includes('-')) return tok.split('-').map(titleCaseToken).join('-');
  if (tok.includes('&')) return tok.split('&').map(titleCaseToken).join('&');
  const upper = tok.toUpperCase();
  if (NAME_FORCE_WORD.has(upper)) return upper.charAt(0) + upper.slice(1).toLowerCase();
  if (NAME_KEEP_UPPER.has(upper)) return upper;
  if (NAME_FORCE_LOWER.has(tok.toLowerCase())) return tok.toLowerCase();
  // A short token with no vowels reads as an acronym (MTN, BHP, RCL, DRD…).
  if (tok.length >= 3 && tok.length <= 4 && !/[AEIOUY]/.test(upper)) return upper;
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}
function prettyName(raw) {
  if (raw == null) return raw;
  let s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return s;
  // 1) Strip share-class / registration markers feeds append.
  s = s.replace(/\s*[-–—]\s*[A-Za-z]\s*[-–—]\s*$/, '');      // "Naspers -N-"
  s = s.replace(/\s*\([A-Za-z]\)\s*$/, '');                   // "Foo (N)"
  s = s.replace(/[,\s]+class\s+[a-z]$/i, '');                 // "Foo Class A"
  // 2) Strip the redundant "Limited"/"Ltd" legal-form suffix that feeds append
  //    and curated names omit. "Corporation"/"Inc"/"plc" are left alone — they're
  //    often part of the recognised name ("Bid Corporation", "BP plc").
  s = s.replace(/[,\s]+(limited|ltd\.?)$/i, '').trim();
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return String(raw).trim();
  // 3) Re-case ALL-CAPS names only; a name already carrying lowercase letters is
  //    assumed intentional and left as-is apart from the suffix trim above.
  if (!/[a-z]/.test(s)) s = s.split(' ').map(titleCaseToken).join(' ');
  return s;
}
// Best display name for a held position: the name saved on the holding, then the
// resolver, all run through prettyName — falling back to the bare ticker (which
// is never re-cased, so "GOOGL" stays "GOOGL") only when no name is known.
function positionDisplayName(p, market, q) {
  const nm = p.name || resolveTickerName(p.ticker, market, q);
  return nm ? prettyName(nm) : p.ticker;
}
function resolveTickerName(ticker, market, q) {
  let raw = null;
  if (q) {
    const yahooName = q.shortName || q.longName;
    if (yahooName && yahooName !== ticker && !looksLikeInstrumentCode(yahooName)) raw = yahooName;
  }
  if (!raw) {
    const info = DATA.findInfo(ticker, market);
    if (info && info.name && info.name !== ticker) raw = info.name;
  }
  if (!raw) {
    const hit = ALL_TICKERS.find(t => t.ticker === ticker && t.market === market);
    if (hit && hit.name && hit.name !== ticker) raw = hit.name;
  }
  // Learned/curated names (heatmap mega-caps, anything we've quoted before).
  if (!raw) {
    const cached = cachedName(market, ticker);
    if (cached) raw = cached;
  }
  if (!raw) return null;
  const pretty = prettyName(raw);
  // Cache the cleaned name so future reads (and the heatmap) get the tidy form.
  if (q && raw === (q.shortName || q.longName)) cacheName(market, ticker, pretty);
  return pretty;
}

// A watch entry can belong to several lists at once. Legacy entries stored a
// single `listId`; current entries store a `listIds` array. This normalises both
// to an array, defaulting to the built-in "Watchlist" list.
function watchListIds(w) {
  if (w && Array.isArray(w.listIds) && w.listIds.length) return w.listIds;
  return [(w && w.listId) || 'default'];
}

// ── Hot stocks (suggestion strip) ───────────────────────────────────────────
// Live "what's moving right now" candidates from PBData.fetchHotStocks
// (Yahoo trending + gainers/actives screeners), cached in localStorage so tab
// flips don't refetch. The cache is volatile/re-derivable (in BACKUP_SKIP).
// Trending symbols carry no quote data, so the first few names get their
// day-move topped up with light quotes for the chips' % badge. Everything is
// best-effort: offline / proxy failures leave the last cached list in place.
const HOT_STOCKS_KEY = 'pb.hotStocks.v1';
const HOT_STOCKS_TTL_MS = 10 * 60 * 1000;
function useHotStocks() {
  const [cache, setCache] = usePersistedState(HOT_STOCKS_KEY, null);
  const cacheRef = useRef(cache);
  useEffect(() => { cacheRef.current = cache; }, [cache]);
  useEffect(() => {
    let alive = true;
    const cur = cacheRef.current;
    if (cur && Array.isArray(cur.items) && Date.now() - (cur.fetchedAt || 0) < HOT_STOCKS_TTL_MS) return;
    (async () => {
      try {
        const items = await PBData.fetchHotStocks();
        if (!alive || !items || !items.length) return;
        const missing = items.slice(0, 10).filter(it => it.changePct == null);
        if (missing.length) {
          await poolMap(missing, 4, async (it) => {
            try {
              const q = await fetchQuoteLight(it.ticker, it.market);
              if (q && typeof q.changePct === 'number' && isFinite(q.changePct)) it.changePct = q.changePct;
            } catch (_e) {}
          });
        }
        if (alive) setCache({ fetchedAt: Date.now(), items });
      } catch (_e) {}
    })();
    return () => { alive = false; };
  }, []);
  return (cache && Array.isArray(cache.items)) ? cache.items : [];
}

// Suggestion builder. Returns { hot, more }:
//  - hot: live trending/gainer names the user does NOT yet hold or track,
//    ranked by market heat + personal affinity (chips show their day-move);
//  - more: the curated per-market lists plus recently-searched symbols,
//    rescored by the same affinity model.
// Personalisation signals: markets and sectors of the stocks the user holds
// (positions) AND follows (watchlist), plus the ticker-search history — a
// recently searched symbol gets a strong, recency-decayed boost and its sector
// counts toward the taste profile. Anything already held/watched is excluded.
function buildSuggestions(watchlist, positions, hotItems) {
  const taken = new Set(watchlist.map(w => priceKey(w.market, w.ticker)));
  (positions || []).forEach(p => taken.add(priceKey(p.market, p.ticker)));
  // Canonical sector for a symbol: curated info → heatmap constituents lookup.
  const sectorOf = (ticker, market, known) => {
    let sec = known;
    if (!sec) {
      const info = DATA.findInfo(ticker, market);
      sec = info && info.sector;
    }
    if (!sec && DATA._sectorLookup) {
      const hit = DATA._sectorLookup[market + ':' + ticker];
      if (hit) sec = hit.sector;
    }
    if (!sec) return null;
    const canon = DATA.normalizeSector ? DATA.normalizeSector(sec) : sec;
    return canon && canon !== 'Other' ? canon : null;
  };
  const marketCount = {};
  const sectorCount = {};
  const learn = (ticker, market, w) => {
    marketCount[market] = (marketCount[market] || 0) + w;
    const sec = sectorOf(ticker, market, null);
    if (sec) sectorCount[sec] = (sectorCount[sec] || 0) + w;
  };
  watchlist.forEach(w => learn(w.ticker, w.market, 1));
  (positions || []).forEach(p => learn(p.ticker, p.market, 1));
  const preferredMarket = Object.entries(marketCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  // Search history: strong direct boost (half-life ~3 weeks) + sector signal.
  const hist = readSearchHist();
  const nowMs = Date.now();
  const searchBoost = {};
  hist.forEach(h => {
    if (!h || !h.t || !h.m) return;
    const sec = sectorOf(h.t, h.m, null);
    if (sec) sectorCount[sec] = (sectorCount[sec] || 0) + 0.5;
    const ageDays = Math.max(0, (nowMs - (h.at || 0)) / 86400000);
    const key = priceKey(h.m, h.t);
    searchBoost[key] = Math.max(searchBoost[key] || 0, 6 * Math.pow(0.5, ageDays / 21));
  });
  const affinity = (p) => {
    let score = 0;
    if (preferredMarket && p.market === preferredMarket) score += 4;
    const sec = sectorOf(p.ticker, p.market, p.sector);
    if (sec && sectorCount[sec]) score += 2 * Math.min(3, sectorCount[sec]);
    const sb = searchBoost[priceKey(p.market, p.ticker)];
    if (sb) score += sb;
    return score;
  };
  // Hot candidates: heat score from the feed + personal affinity on top.
  const hotScored = [];
  const hotSeen = new Set();
  (hotItems || []).forEach(h => {
    if (!h || !h.ticker || !h.market) return;
    const key = priceKey(h.market, h.ticker);
    if (taken.has(key) || hotSeen.has(key)) return;
    hotSeen.add(key);
    const name = h.name || cachedName(h.market, h.ticker) || h.ticker;
    hotScored.push({
      ticker: h.ticker, market: h.market,
      name: prettyName(name) || h.ticker,
      changePct: (typeof h.changePct === 'number' && isFinite(h.changePct)) ? h.changePct : null,
      hot: true,
      score: (h.hotScore || 0) + affinity({ ticker: h.ticker, market: h.market })
    });
  });
  hotScored.sort((a, b) => b.score - a.score);
  const hot = hotScored.slice(0, 6);
  // Curated + searched-but-never-added candidates fill the "more" row.
  const popular = [];
  DATA.HOLDINGS.forEach(h => popular.push({ ticker: h.ticker, name: h.name, market: 'US', sector: h.sector }));
  DATA.NEW_PICKS.forEach(p => popular.push({ ticker: p.ticker, name: p.name, market: 'US', sector: p.sector }));
  DATA.HEDGES.forEach(h => popular.push({ ticker: h.ticker, name: h.name, market: 'US' }));
  (DATA.US_SUGGESTIONS || []).forEach(s => popular.push({ ticker: s.ticker, name: s.name, market: 'US' }));
  (DATA.JSE_SUGGESTIONS || []).forEach(s => popular.push({ ticker: s.ticker, name: s.name, market: 'JSE' }));
  (DATA.TFSA_SUGGESTIONS || []).forEach(s => popular.push({ ticker: s.ticker, name: s.name, market: 'TFSA' }));
  (DATA.LSE_SUGGESTIONS || []).forEach(s => popular.push({ ticker: s.ticker, name: s.name, market: 'LSE' }));
  (DATA.ASX_SUGGESTIONS || []).forEach(s => popular.push({ ticker: s.ticker, name: s.name, market: 'ASX' }));
  (DATA.EU_SUGGESTIONS || []).forEach(s => popular.push({ ticker: s.ticker, name: s.name, market: s.exchange || 'FRA' }));
  hist.forEach(h => { if (h && h.t && h.m) popular.push({ ticker: h.t, name: h.n || h.t, market: h.m }); });
  const dedupe = new Set(hot.map(s => priceKey(s.market, s.ticker)));
  const scored = [];
  popular.forEach(p => {
    const key = priceKey(p.market, p.ticker);
    if (dedupe.has(key) || taken.has(key)) return;
    dedupe.add(key);
    let score = affinity(p);
    if (p.market === 'US') score += 1;
    scored.push({ ticker: p.ticker, name: p.name, market: p.market, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return { hot, more: scored.slice(0, Math.max(6, 14 - hot.length)) };
}

// WatchlistView moved to pb-views.js (Phase 4 inc 26) - window.PBViews.WatchlistView.
const WatchlistView = PBViews.WatchlistView;

// Treemap layout math (heatColor / squarify / layoutSquarify / computeWorst /
// buildSectorHierarchy / layoutTreemap) moved to pb-views.js with HeatmapTreemap
// (Phase 4 inc 32) — Heatmap-private, consumed only by the bucket Heatmap views.
// HeatmapTreemap + ZoomPanHeatmap moved to pb-views.js (Phase 4 inc 32) —
// window.PBViews.{HeatmapTreemap,ZoomPanHeatmap}. They have no root-App caller
// (entered only from the bucket Heatmap views + pb-modals SectorDetailModal, which
// now reads ZoomPanHeatmap from window.PBViews at render time). fetchSectorTrend +
// SECTOR_TREND_CACHE moved to pb-modals.js (Phase 4 inc 35) — pb-modals-only
// (SectorDetailModal); useContainerWidth moved to pb-views.js (Phase 4 inc 33).
const HeatmapView = PBViews.HeatmapView;
// PicksView is defined in pb-views.js (Phase 4 inc 8); bind it here.
const PicksView = PBViews.PicksView;
// MarketRotationView (Rotation tab) is defined in pb-views.js; bind it here.
const MarketRotationView = PBViews.MarketRotationView;
// HedgesView is defined in pb-views.js (Phase 4 inc 9); bind it here.
const HedgesView = PBViews.HedgesView;
// fmtShares + the TFSA cluster (Collapsible / TFSAContributions / TFSABalancer)
// and TFSAView moved to pb-views.js (Phase 4 inc 27); bind TFSAView here.
const TFSAView = PBViews.TFSAView;
// HotTopicsView is defined in pb-views.js (Phase 4 inc 7 spike); bind it here.
const HotTopicsView = PBViews.HotTopicsView;
// RulesView + OverviewView are defined in pb-views.js (Phase 4 inc 10); bind them here.
// ruleSection (RulesView-only helper) moved with the view.
const RulesView = PBViews.RulesView;
const OverviewView = PBViews.OverviewView;
// Detail-card subtree (PriceChart, EarningsBadge, FundamentalsBlock, WatchlistControl,
// HoldingNotesControl, IndicatorValueBlock, IndicatorAbout + private helpers) moved to pb-modals.js (Phase 4 inc-16).
// DetailModal moved to pb-modals.js (Phase 4 inc-15). Reads app.js internals via
// window.PBApp (bridge) and PBCore/PBContent/PBData globals via the bucket IIFE.
// Its detail-card sub-components moved into pb-modals.js too (Phase 4 inc-16).
const DetailModal = PBModals.DetailModal;
// AlertsModal moved to pb-modals.js (Phase 4 inc 18). Pure display/delegate — Icon, fmt,
// timeAgo, useSwipeDownToClose, useBodyScrollLock reached via the PBApp bridge; alert eval
// and money math live in pb-core, untouched.
const AlertsModal = PBModals.AlertsModal;
// ContributionModal moved to pb-modals.js (Phase 4 inc 13). sanitizeDecimalInput stays
// in app.js (shared decimal-input helper) and is reached via the PBApp bridge.
const ContributionModal = PBModals.ContributionModal;
// ContributionImportModal moved to pb-modals.js (Phase 4 inc 14). uid,
// parseCashFlowsFromText, parseCashFlowFile stay in app.js and are reached via the
// PBApp bridge; CURRENCY_SYMBOLS is read from the PBContent global inside the bucket.
const ContributionImportModal = PBModals.ContributionImportModal;
// ImportModal moved to pb-modals.js (Phase 4 inc 19). The impure readers
// parseImportFile / ocrImageFile / searchListingsMulti and the multi-caller
// TickerSearch component stay in app.js and are reached via the PBApp bridge; the
// pb-import.js matching helpers (parseHoldingsFromText, rankImportCandidates,
// companyNameScore, looksLikeTickerToken, normaliseCompanyName,
// parseEasyEquitiesScreenshot, dedupeEeHoldings) are read from the PBImport global
// inside the bucket; DATA (window.PB_DATA) is read at render time.
const ImportModal = PBModals.ImportModal;
// PositionModal moved to pb-modals.js (Phase 4 inc-22). Builds the cost-basis save
// payload (cost mode / currency / crypto total-vs-per-unit -> perUnitCost) + diffChanges
// (field-level edit diff); the add/update runs in the addPosition/updatePosition mutators
// (data layer) via onSave, not the modal. MarketPicker via the PBApp bridge; DATA
// (window.PB_DATA) read at render time; fetchQuote/parseDecimal/CURRENCY_SYMBOLS/
// MARKET_CURRENCY/marketCurrency/positionCostCcy/DISPLAY_CURRENCIES already IIFE-read in the bucket.
const PositionModal = PBModals.PositionModal;
// SellModal moved to pb-modals.js (Phase 4 inc-21). The %<->shares sync + the pnl
// preview ((price - costBasis) * shares); the realized gain/proceeds happen in the onSell
// mutator (data layer), not the modal. Icon, useSwipeDownToClose, useBodyScrollLock,
// sanitizeDecimalInput via the PBApp bridge.
const SellModal = PBModals.SellModal;
// BuyModal moved to pb-modals.js (Phase 4 inc-20). Re-blends the average cost basis
// in-body ((shares*costBasis + n*price)/newTotalShares) and hands the buy to the onBuy
// mutator (data layer). positionCostCcy is read from the PBCore global inside the bucket;
// Icon, useSwipeDownToClose, useBodyScrollLock, sanitizeDecimalInput via the PBApp bridge.
const BuyModal = PBModals.BuyModal;
function computeFxSnapshot({ positions, contributions, prices, fxRates, displayCurrency }) {
  const rates = fxRates?.rates || null;
  let combinedValue = 0;
  let combinedCostToday = 0;
  let combinedCostAtPurchase = 0;
  let anyPositionMissing = false;
  positions.forEach(p => {
    const q = prices[priceKey(p.market, p.ticker)];
    const native = marketCurrency(p.market);
    // Value is in the market's native currency; cost is in the currency the user
    // paid in (native for normal holdings, the booked fiat for crypto-in-ZAR).
    const costCcy = positionCostCcy(p);
    const valueNative = q ? p.shares * q.price : null;
    const costInCostCcy = p.shares * p.costBasis;
    const valueInDisplay = convertCcy(valueNative, native, displayCurrency, rates);
    const costNowInDisplay = convertCcy(costInCostCcy, costCcy, displayCurrency, rates);
    const fxAtCost = p.fxRateAtCost && isFinite(p.fxRateAtCost) && p.fxRateAtCost > 1e-6 ? p.fxRateAtCost : null;
    const fxCostCcy = rates && rates[costCcy] && isFinite(rates[costCcy]) && rates[costCcy] > 1e-6 ? rates[costCcy] : null;
    const fxDisplay = rates && rates[displayCurrency] && isFinite(rates[displayCurrency]) && rates[displayCurrency] > 1e-6 ? rates[displayCurrency] : null;
    const costAtPurchaseUSD = fxAtCost
      ? costInCostCcy / fxAtCost
      : (fxCostCcy ? costInCostCcy / fxCostCcy : null);
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

// Premium drag-to-reorder list for Settings → Tabs. Pointer-driven (works with
// mouse + touch via setPointerCapture). The dragged row lifts and tracks the
// finger 1:1; the others glide to their new slots with a FLIP animation. The
// working order lives in local state during a drag and is committed to the
// parent on release, so persistence only fires once.
// SettingsModal + its single-caller TabReorderList moved to pb-modals.js (Phase 4 inc-17).
const SettingsModal = PBModals.SettingsModal;

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
  componentDidCatch(error, info) {
    console.error('React crash:', error, info.componentStack);
    // The splash is no longer retired by a MutationObserver on #root, so a crash
    // during the first render would otherwise hide this error behind it for 8s.
    if (typeof window.hidePbSplash === 'function') window.hidePbSplash();
  }
  render() {
    if (this.state.error) return React.createElement("div", {
      style: { position: 'fixed', inset: 0, overflow: 'auto', padding: 24, background: '#09090b',
               color: '#fafafa', fontFamily: '-apple-system, BlinkMacSystemFont, Inter, sans-serif',
               display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, textAlign: 'center' } },
      React.createElement("div", { style: { fontSize: 40 } }, "⚠️"),
      React.createElement("h2", { style: { margin: 0, fontWeight: 700 } }, "Something went wrong"),
      React.createElement("p", { style: { margin: 0, color: '#a1a1aa', maxWidth: 360, lineHeight: 1.5 } },
        "The app hit an unexpected error. Your saved holdings are safe on this device — reloading usually fixes it."),
      React.createElement("button", {
        onClick: () => window.location.reload(),
        style: { padding: '11px 22px', borderRadius: 10, border: 'none', cursor: 'pointer',
                 background: 'linear-gradient(135deg, #3b82f6, #a855f7)', color: '#fff', fontWeight: 600, fontSize: 15 }
      }, "Reload app"),
      React.createElement("pre", { style: { marginTop: 8, color: '#52525b', fontFamily: 'monospace', fontSize: 11,
               whiteSpace: 'pre-wrap', maxWidth: '90vw', maxHeight: '30vh', overflow: 'auto', textAlign: 'left' } },
        String(this.state.error?.stack || this.state.error)));
    return this.props.children;
  }
}
// App-runtime bridge: shared primitives that extracted view/modal scripts read at render.
window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt, THESIS_SNAPSHOT, useBodyScrollLock, sanitizeDecimalInput, uid, parseCashFlowsFromText, parseCashFlowFile, fmtCcy, fmtCcySigned, fmtIndicator, resolveTickerName, indicatorFor, watchListIds, computeFxSnapshot, formatCode, normalizeCode, positionDisplayName, resolvePositionSector, DEFAULT_TAB_ORDER, MARKET_LABELS, TAB_ALWAYS_VISIBLE, TAB_LABELS, usePersistedState, TickerSearch, parseImportFile, ocrImageFile, searchListingsMulti, MarketPicker, fmtNum, SessionBadge, useHotStocks, buildSuggestions };
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(ErrorBoundary, null, React.createElement(ToastProvider, null, React.createElement(App, null))));
// SW registration handled in index.html with auto-update logic