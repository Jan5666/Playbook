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
  'pb.installDismissed.v2',// per-device UI nag state
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
function useSwipeDownToClose(panelRef, onClose, enabled = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // When disabled (e.g. the import review stage), attach nothing at all so a
    // normal content scroll can never be mistaken for a swipe-to-dismiss.
    if (enabled === false) return undefined;
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
    // A close-drag may only begin from the fixed top chrome — the grab handle or
    // the header. The scrolling body never dismisses the sheet, so scrolling its
    // content up/down can no longer close the card (the previous guard checked
    // `panel.scrollTop`, but the panel itself is `overflow:hidden` and never
    // scrolls — the `.modal-body` does — so that guard was always 0 and ANY
    // downward finger anywhere started a close: the "scrolling closes it" bug).
    let grabZone = false;
    const DRAG_THRESHOLD = 6;
    const onTouchStart = (e) => {
      if (!isMobileLayout() || e.touches.length !== 1) return;
      const t = e.target;
      grabZone = !!(t && t.closest && t.closest('.modal-handle, .modal-header'));
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
        // Only the handle/header grab zone can start a close-drag, pulling down.
        if (!grabZone || y - originY <= 0) { originY = y; prevY = y; return; }
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
  }, [panelRef, enabled]);
}
// MARKET_CURRENCY (native currency + display symbol per market) and the money
// helpers below it now live in pb-core.js so they can be unit-tested outside the
// 14k-line app.js. Bound to local names; canonical source is pb-core.js.
const MARKET_CURRENCY = PBCore.MARKET_CURRENCY;
const MARKETS = PBContent.MARKETS;
// JSE and TFSA are the same underlying exchange — a TFSA account just tracks
// JSE-listed shares (.JO) tax-free — so a JSE-listed search result is valid for
// either account. Used so picking a listing never silently flips the account
// the user explicitly chose (e.g. TFSA → JSE) when both map to the same listing.
function sameUnderlyingExchange(a, b) {
  if (a === b) return true;
  const norm = m => (m === 'TFSA' ? 'JSE' : m);
  return norm(a) === norm(b);
}
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
const priceKey = PBCore.priceKey;
const buildFetchPlan = PBCore.buildFetchPlan;
// The quote/price/history providers, batchers, and ticker→name cache now live in
// pb-data.js (client-only network layer). Bound here so app.js call sites are
// unchanged; the indicator catalog (UI/content config) is injected once.
PBData.configure({ indicatorCatalog: RIBBON_CATALOG_MAP });
const fetchQuote = PBData.fetchQuote;
const fetchQuoteBatch = PBData.fetchQuoteBatch;
const fetchQuoteBatchLight = PBData.fetchQuoteBatchLight;
const fetchHistory = PBData.fetchHistory;
const searchUnitTrusts = PBData.searchUnitTrusts;
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
      // Analyst targets arrive in the quote's own units - pence/cents for
      // GBp/ZAc listings - like bookValue; scale them to natural units so the
      // card's upside math against the (already-scaled) quote price is right.
      const tgt = x => { const n = v(x); return n != null ? n / divisor : null; };
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
        targetMean: tgt(fd.targetMeanPrice),
        targetHigh: tgt(fd.targetHighPrice),
        targetLow: tgt(fd.targetLowPrice),
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
    PAR: 'Euronext Paris', AMS: 'Euronext Amsterdam', US: 'US markets',
    CRYPTO: 'cryptocurrency (USD spot market)'
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
    // and the currency follows the market, not a hardcoded USD.
    currency: (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).code, divisor: 1,
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
    const [fcast, sa, ts] = await Promise.all([
      fetchAnalystForecastSA(ticker, market),
      fetchFundamentalsStockAnalysis(ticker, market),
      fetchFundamentalsYahooTimeseries(ticker, market)
    ]);
    if (fcast) parts.push(fcast);
    if (sa) parts.push(sa);
    if (ts) parts.push(ts);
  }
  // quoteSummary usually 401s without a crumb, but it's free to try when the
  // primary sources came up empty (and it's the only non-AI crypto source).
  // The forecast part carries only analyst fields, so it doesn't count as
  // having fundamentals - the stats fallbacks still fire without it.
  const hasStats = () => parts.some(p => p.source !== 'sa-forecast');
  if (!hasStats()) {
    const yahoo = await fetchFundamentalsYahoo(ticker, market);
    if (yahoo) parts.push(yahoo);
  }
  if (!hasStats() && perplexityKey) {
    const ai = await fetchFundamentalsPerplexity(ticker, market, companyName, perplexityKey);
    if (ai) parts.push(ai);
  }
  return PBCore.mergeFundamentals(parts);
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
// Per-ticker upcoming earnings date from stockanalysis.com (CORS-open, fetched
// directly — no proxy). Cached 12h. Reliable for US names; JSE/other are left to
// the AI path, which covers exchanges stockanalysis doesn't.
const SA_EARN_CACHE = {};
async function fetchEarningsDateSA(ticker) {
  const up = (ticker || '').toUpperCase();
  if (!up) return null;
  const c = SA_EARN_CACHE[up];
  if (c && Date.now() - c.fetchedAt < 12 * 3600 * 1000) return c.date;
  try {
    const r = await fetch(`https://stockanalysis.com/api/symbol/s/${encodeURIComponent(up)}/overview`);
    if (!r.ok) { SA_EARN_CACHE[up] = { date: null, fetchedAt: Date.now() }; return null; }
    const j = await r.json();
    const ed = j?.data?.earningsDate;
    const ms = ed && !isNaN(Date.parse(ed)) ? Date.parse(ed) : null;
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
    PBStore.mergePrices(obj);
    persistPrices(PBStore.getPrices());
  }, [persistPrices]);
  // A manual tap that arrives mid-fetch sets this so the in-flight run loops
  // once more (with cache-bust) the moment it finishes — the press always ends
  // in genuinely fresh data instead of being silently dropped by the guard.
  const pendingForceRef = useRef(false);
  const runFetch = useCallback(async (cacheBust) => {
    loadingRef.current = true;
    setLoading(true);
    try {
      do {
        const force = cacheBust || pendingForceRef.current;
        pendingForceRef.current = false;
        const newPrices = await fetchQuoteBatch(orderRef.current, {
          cacheBust: force,
          // Merge each batch as it lands so holdings paint progressively.
          onBatch: (partial) => { PBStore.mergePrices(partial); persistPrices(PBStore.getPrices()); }
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
      setFailStreak(prev => prev + 1);
    }
    loadingRef.current = false;
    setLoading(false);
  }, [persistPrices]);
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
  ['hot', 'Hot Topics'], ['heatmap', 'Heatmap'], ['tfsa', 'TFSA'], ['picks', 'New picks'],
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
// prefers-color-scheme, reduced-motion) lives in styles.css.
function LoadingScreen({ visible }) {
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
    if (!mounted) return;
    setHiding(true);
    const t = setTimeout(() => setMounted(false), 320); // just past the 300ms fade
    return () => clearTimeout(t);
  }, [visible, mounted]);
  if (!mounted) return null;
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
  const ext = quote && (quote.extKind === 'pre' || quote.extKind === 'post') ? quote.extKind : null;
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
  const extLabel = quote.extKind === 'pre' ? 'Pre-market' : quote.extKind === 'post' ? 'After-hours' : '';
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
        React.createElement("span", { className: "daily-label" }, "Today"),
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
    hasExt && React.createElement("div", { className: "daily-divider" }),
    // Extended-hours column mirrors the "Today" column: the live pre/post price on
    // top, then its move vs the regular close as "+%  ·  +cash" — the same figures
    // Google surfaces as e.g. "After hours 1 235,00 +23,62 (1,95%)".
    hasExt && React.createElement("div", { className: "daily-col" },
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
    className: "ext-hours"
  }, React.createElement("span", {
    className: "ext-label"
  }, extLabel), React.createElement("span", {
    className: "ext-price mono"
  }, sym, fmtNum(quote.extPrice)), React.createElement("span", {
    className: `ext-chg mono ${extUp ? 'up' : 'down'}`
  }, (extUp ? '+' : '') + quote.extChangePct.toFixed(2) + '%' +
     (extChgAbs != null ? ' · ' + (extUp ? '+' : '-') + sym + fmtNum(Math.abs(extChgAbs)) : ''))));
});
// SVG-based line chart for portfolio growth over time
const CHART_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2 Apr" (optionally "2 Apr ’25") — how a person reads a date, vs raw MM-DD.
function chartDayLabel(dateStr, withYear) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.getDate() + ' ' + CHART_MONTHS[d.getMonth()] + (withYear ? ' ’' + String(d.getFullYear()).slice(2) : '');
}
// Time ticks for the growth chart's x axis: calendar-aligned boundaries (weeks →
// month starts → year starts, scaled to the visible span) labelled "7 Apr",
// "1 May", "Jun", "2026". Returns point indices because the x scale is
// index-based (one slot per sampled day), not time-based; a tick is dropped when
// the nearest point drifts too far from the boundary (sparse fallback data), and
// if none survive the endpoints are labelled instead so the axis never goes mute.
function buildTimeAxisTicks(points) {
  if (points.length < 2) return [];
  const parse = s => new Date(s + 'T00:00:00');
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const first = parse(points[0].date), last = parse(points[points.length - 1].date);
  const spanDays = Math.max(1, (last - first) / 864e5);
  const maxDrift = Math.max(3, spanDays / 8);
  const ticks = [];
  const push = (dateStr, label) => {
    const i = points.findIndex(p => p.date >= dateStr);
    if (i < 0) return;
    if ((parse(points[i].date) - parse(dateStr)) / 864e5 > maxDrift) return;
    if (ticks.length && ticks[ticks.length - 1].idx === i) return;
    ticks.push({ idx: i, label });
  };
  if (spanDays <= 70) {
    // Weekly, anchored to Mondays: "7 Apr"
    const d = new Date(first);
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7));
    const stepDays = spanDays <= 35 ? 7 : 14;
    while (d <= last) {
      push(iso(d), d.getDate() + ' ' + CHART_MONTHS[d.getMonth()]);
      d.setDate(d.getDate() + stepDays);
    }
  } else if (spanDays <= 140) {
    // Semi-monthly: "1 May" / "15 May" — walk to the first 1st-or-15th after
    // the window opens, then alternate boundaries.
    const d = new Date(first);
    do { d.setDate(d.getDate() + 1); } while (d.getDate() !== 1 && d.getDate() !== 15);
    while (d <= last) {
      push(iso(d), d.getDate() + ' ' + CHART_MONTHS[d.getMonth()]);
      if (d.getDate() === 1) d.setDate(15); else { d.setDate(1); d.setMonth(d.getMonth() + 1); }
    }
  } else if (spanDays <= 430) {
    // Month starts, stepped to ≤6 labels: "1 Apr" when every month shows,
    // otherwise "Apr" with January carrying the year ("Jan ’26").
    const monthStarts = [];
    const d = new Date(first.getFullYear(), first.getMonth() + 1, 1);
    while (d <= last) { monthStarts.push(new Date(d)); d.setMonth(d.getMonth() + 1); }
    const stepM = Math.max(1, Math.ceil(monthStarts.length / 6));
    monthStarts.forEach((m, i) => {
      if (i % stepM !== 0) return;
      const label = stepM === 1 ? '1 ' + CHART_MONTHS[m.getMonth()]
        : m.getMonth() === 0 ? 'Jan ’' + String(m.getFullYear()).slice(2)
        : CHART_MONTHS[m.getMonth()];
      push(iso(m), label);
    });
  } else {
    // Year starts: "2025"
    const years = [];
    for (let yy = first.getFullYear() + 1; yy <= last.getFullYear(); yy++) years.push(yy);
    const stepY = Math.max(1, Math.ceil(years.length / 6));
    years.forEach((yy, i) => { if (i % stepY === 0) push(yy + '-01-01', String(yy)); });
  }
  if (ticks.length === 0) {
    const withYear = points[0].date.slice(0, 4) !== points[points.length - 1].date.slice(0, 4);
    ticks.push({ idx: 0, label: chartDayLabel(points[0].date, withYear) });
    ticks.push({ idx: points.length - 1, label: chartDayLabel(points[points.length - 1].date, withYear) });
  }
  return ticks;
}
function PortfolioLineChart({ positions, contributions, displayCurrency, fxRates }) {
  const prices = PBStore.usePricesMap();
  const valueHidden = PBStore.useSetting('valueHidden');
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
      // Fetch in small batches instead of one big Promise.all: firing 20+ history
      // requests at once swamps the shared CORS proxies and most come back empty,
      // which left the chart blank for larger portfolios. Batching + a retry pass
      // mirrors the quote fetcher and lets the line paint in as data lands.
      const BATCH = 5;
      const fetchInto = async (list, store) => {
        for (let i = 0; i < list.length; i += BATCH) {
          if (cancelled) return;
          const slice = list.slice(i, i + BATCH);
          await Promise.all(slice.map(async p => {
            const key = priceKey(p.market, p.ticker);
            const data = await fetchHistory(p.ticker, p.market, 'max').catch(() => null);
            if (data && data.points.length > 0) store[key] = data.points;
          }));
          if (!cancelled && Object.keys(store).length) setHistoryCache(prev => ({ ...prev, ...store }));
        }
      };
      const results = {};
      await fetchInto(needed, results);
      const missing = needed.filter(p => !results[priceKey(p.market, p.ticker)]);
      if (missing.length) await fetchInto(missing, results);
      if (cancelled) return;
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
      const costVal = convertCcy(p.shares * p.costBasis, positionCostCcy(p), displayCurrency, rates) || 0;
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
      cumContrib += contribInDisplay(c, displayCurrency, rates);
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
    if (cutoff) {
      const before = all.filter(p => p.date < cutoff);
      let within = all.filter(p => p.date >= cutoff);
      // Don't let the range filter strip the series down to a single point (which
      // renders as an empty chart): if there was data before the cutoff, anchor
      // the window at the cutoff by carrying the last-known value forward. This is
      // what makes short ranges — and the cost-basis fallback before history loads
      // — still draw a line instead of collapsing.
      if (before.length && (within.length === 0 || within[0].date > cutoff)) {
        const carry = before[before.length - 1];
        within = [{ date: cutoff, value: carry.value, contributed: carry.contributed }, ...within];
      }
      all = within;
    }
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
  // Nice-number Y axis: snap the scale to a round step (1 / 2 / 2.5 / 5 × 10ⁿ)
  // so gridlines land on amounts like R250k · R300k, not raw data-min/max splits.
  const rawMinV = Math.min(...allVals), rawMaxV = Math.max(...allVals);
  const roughStep = ((rawMaxV - rawMinV) || Math.max(Math.abs(rawMaxV), 1)) / 4;
  const stepMag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const stepNorm = roughStep / stepMag;
  const yStep = (stepNorm <= 1 ? 1 : stepNorm <= 2 ? 2 : stepNorm <= 2.5 ? 2.5 : stepNorm <= 5 ? 5 : 10) * stepMag;
  let minV = Math.floor(rawMinV / yStep) * yStep;
  if (minV < 0 && rawMinV >= 0) minV = 0;
  let maxV = Math.ceil(rawMaxV / yStep) * yStep;
  if (maxV === minV) maxV += yStep;
  const rangeV = maxV - minV;
  const x = i => PAD_L + (i / (points.length - 1)) * chartW;
  const y = v => PAD_T + chartH - ((v - minV) / rangeV) * chartH;
  const valuePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const contribPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.contributed).toFixed(1)}`).join('');
  const areaPath = valuePath + `L${x(points.length - 1).toFixed(1)},${(PAD_T + chartH).toFixed(1)}L${PAD_L},${(PAD_T + chartH).toFixed(1)}Z`;
  const yLabels = [];
  for (let i = 0, n = Math.round(rangeV / yStep); i <= n; i++) {
    const val = minV + yStep * i;
    yLabels.push({ val, y: y(val) });
  }
  const xTicks = buildTimeAxisTicks(points);
  const crossesYears = points[0].date.slice(0, 4) !== points[points.length - 1].date.slice(0, 4);
  const sym = CURRENCY_SYMBOLS[displayCurrency] || '$';
  // Ticks land on round steps; the unary + trims trailing zeros so labels stay
  // compact (R250k, R2.5M, R487.5k).
  const fmtShortRaw = v => {
    if (Math.abs(v) >= 1e6) return sym + (+(v / 1e6).toFixed(2)) + 'M';
    if (Math.abs(v) >= 1e3) return sym + (+(v / 1e3).toFixed(2)) + 'k';
    return sym + Math.round(v).toLocaleString('en-US');
  };
  const fmtFullRaw = v => sym + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Hide-value: the growth chart plots the portfolio total, so its money labels
  // mask to dots while hidden (the line's shape stays visible).
  const fmtShort = valueHidden ? (() => '••••') : fmtShortRaw;
  const fmtFull = valueHidden ? (() => '••••••') : fmtFullRaw;

  const hoverPoint = hoverIdx != null ? points[hoverIdx] : null;
  const hoverElements = [];
  if (hoverPoint != null && hoverIdx != null) {
    const hx = x(hoverIdx), hy = y(hoverPoint.value);
    hoverElements.push(
      React.createElement("line", { key: "hl", x1: hx, x2: hx, y1: PAD_T, y2: PAD_T + chartH,
        stroke: "var(--text-dim)", strokeWidth: "0.8", strokeDasharray: "3,2", opacity: "0.5" }),
      React.createElement("circle", { key: "hc", cx: hx, cy: hy, r: "5",
        fill: "var(--brand)", stroke: "var(--bg)", strokeWidth: "2.5" })
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
    const dateLabel = chartDayLabel(hoverPoint.date, crossesYears);
    hoverElements.push(
      React.createElement("text", { key: "hd", x: hx, y: H - 7,
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
          React.createElement("span", { className: "chart-legend-dot", style: { background: 'var(--brand)' } }), "Value"),
        React.createElement("span", { className: "chart-legend-item" },
          React.createElement("span", { className: "chart-legend-dot chart-legend-dot--dashed" }), "Cost"),
        loading ? React.createElement("span", { className: "text-dim text-xs" }, "Loading…") : null)
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
          React.createElement("stop", { offset: "0%", stopColor: "var(--brand)", stopOpacity: "0.25" }),
          React.createElement("stop", { offset: "100%", stopColor: "var(--brand)", stopOpacity: "0.02" })),
        // Left-to-right indigo → periwinkle, echoing the logo's ascending bars.
        React.createElement("linearGradient", { id: "lineGrad", x1: "0", y1: "0", x2: "1", y2: "0" },
          React.createElement("stop", { offset: "0%", stopColor: "var(--brand-dim)" }),
          React.createElement("stop", { offset: "100%", stopColor: "var(--brand)" }))),
      yLabels.map((l, i) => React.createElement("line", {
        key: i, x1: PAD_L, x2: W - PAD_R, y1: l.y, y2: l.y,
        stroke: "var(--border)", strokeWidth: "0.5", strokeDasharray: "3,3" })),
      yLabels.map((l, i) => React.createElement("text", {
        key: 'yl' + i, x: PAD_L - 6, y: l.y + 3.5,
        textAnchor: "end", fill: "var(--text-dim)", fontSize: "10", fontFamily: "var(--mono)" },
        fmtShort(l.val))),
      // Time axis: calendar-aligned tick marks stay put; their labels step aside
      // while scrubbing so the hover date reads cleanly.
      ...xTicks.filter(t => { const tx = x(t.idx); return tx >= PAD_L + 6 && tx <= W - PAD_R - 6; }).map((t, i) =>
        React.createElement("g", { key: 'xt' + i },
          React.createElement("line", { x1: x(t.idx), x2: x(t.idx), y1: PAD_T + chartH, y2: PAD_T + chartH + 4,
            stroke: "var(--border)", strokeWidth: "1" }),
          hoverIdx == null && React.createElement("text", { x: x(t.idx), y: H - 7, textAnchor: "middle",
            fill: "var(--text-dim)", fontSize: "9.5", fontFamily: "var(--mono)", letterSpacing: "0.03em" },
            t.label))),
      React.createElement("path", { d: areaPath, fill: "url(#areaGrad)" }),
      React.createElement("path", { d: contribPath, fill: "none", stroke: "var(--text-dim)", strokeWidth: "1.5", strokeDasharray: "4,3", opacity: "0.4" }),
      React.createElement("path", { d: valuePath, fill: "none", stroke: "url(#lineGrad)", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" }),
      hoverIdx == null && React.createElement("circle", { cx: x(points.length - 1), cy: y(points[points.length - 1].value), r: "4", fill: "var(--brand)", stroke: "var(--bg-raised)", strokeWidth: "2" }),
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
// Shared editor for an instrument's sector breakdown — a controlled list of
// { sector, weight } rows with an add button and a running total. Reused by the
// position modal and the dedicated allocation modal so both entry points behave
// identically. `rows`/`setRows` hold weights as strings (raw input).
function SectorWeightRows({ rows, setRows }) {
  const addRow = () => setRows(rs => [...rs, { sector: '', weight: '' }]);
  const updateRow = (i, patch) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const removeRow = (i) => setRows(rs => rs.filter((_, idx) => idx !== i));
  const clean = rows.map(r => ({ sector: r.sector, weight: parseFloat(r.weight) })).filter(r => r.sector && isFinite(r.weight) && r.weight > 0);
  const sum = clean.reduce((s, r) => s + r.weight, 0);
  return React.createElement(React.Fragment, null,
    rows.length === 0
      ? React.createElement("div", { className: "form-help", style: { marginTop: 0, marginBottom: 8 } },
          "Optional. Split a fund or ETF across the sectors it actually holds, so your allocation chart looks through to its real sector mix instead of a single bucket.")
      : React.createElement("div", { className: "sector-split-list" },
          rows.map((r, i) => React.createElement("div", { className: "sector-split-row", key: i },
            React.createElement("select", {
              className: "import-field-select sector-split-sector",
              value: r.sector,
              onChange: e => updateRow(i, { sector: e.target.value })
            }, React.createElement("option", { value: "" }, "Select sector…"),
               (DATA.SECTOR_CANON || []).map(s => React.createElement("option", { key: s, value: s }, s))),
            React.createElement("div", { className: "input-suffix-wrap sector-split-weight" },
              React.createElement("input", {
                type: "number", inputMode: "decimal", min: "0", max: "100", step: "1",
                placeholder: "0", value: r.weight,
                onChange: e => updateRow(i, { weight: e.target.value })
              }),
              React.createElement("span", { className: "suffix" }, "%")),
            React.createElement("button", {
              className: "icon-btn sector-split-del", type: "button", "aria-label": "Remove sector",
              onClick: () => removeRow(i)
            }, React.createElement(Icon, { name: "x", size: 14 }))))),
    React.createElement("div", { className: "sector-split-foot" },
      React.createElement("button", { className: "btn btn-secondary btn-sm", type: "button", onClick: addRow },
        React.createElement(Icon, { name: "plus", size: 13 }), " Add sector"),
      clean.length ? React.createElement("span", {
        className: "sector-split-sum" + (Math.abs(sum - 100) < 0.1 ? " ok" : "")
      }, "Total ", sum.toFixed(sum % 1 === 0 ? 0 : 1), "%") : null),
    clean.length && Math.abs(sum - 100) >= 0.1 ? React.createElement("div", { className: "form-help" },
      "Weights are applied relative to one another, so they needn't add up to exactly 100%.") : null
  );
}
// Dedicated "edit just the sector allocation" modal for one instrument, opened
// from the sector-breakdown popup. Edits the shared pb.sectorWeights map (keyed
// by MARKET:TICKER) so the change applies to that fund everywhere it's held.
function SectorAllocationModal({ ticker, market, name, initialWeights, onClose, onSave }) {
  const [rows, setRows] = useState(() =>
    Array.isArray(initialWeights) && initialWeights.length
      ? initialWeights.map(w => ({ sector: w.sector || '', weight: w.weight != null ? String(w.weight) : '' }))
      : [{ sector: '', weight: '' }]);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const save = () => {
    const clean = rows.map(r => ({ sector: r.sector, weight: parseFloat(r.weight) })).filter(r => r.sector && isFinite(r.weight) && r.weight > 0);
    onSave(clean.length ? clean : null);
    onClose();
  };
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel", ref: panelRef, style: { maxWidth: 480 } },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, "Sector allocation"),
          React.createElement("div", { className: "modal-subtitle" }, ticker, name && name !== ticker ? " · " + name : "")),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" }))),
      React.createElement("div", { className: "modal-body" },
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Sector breakdown (ETFs & funds)"),
          React.createElement(SectorWeightRows, { rows: rows, setRows: setRows })),
        React.createElement("div", { className: "form-actions" },
          React.createElement("button", { className: "btn btn-secondary", onClick: onClose }, "Cancel"),
          React.createElement("button", { className: "btn btn-primary", onClick: save }, "Save allocation")))));
}
// ── Donut palettes ──────────────────────────────────────────────────────────
// The allocation donut offers two colour scales (Settings → Appearance), each
// generated to exactly N distinct stops so every holding gets its own colour at
// any portfolio size — no recycling once a list outgrows a fixed array.
function _donutHexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function _donutRgbToHex(r, g, b) {
  const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
function _donutHslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return _donutRgbToHex(f(0), f(8), f(4));
}
// "Indigo" — the logo's periwinkle → indigo → blue → cyan family, sampled
// smoothly across however many holdings are shown. Stays on-brand at any size.
const DONUT_INDIGO_ANCHORS = ['#8A7BF2', '#6E6EF0', '#5A6FE6', '#4F86DC', '#4F9BCF', '#5AAFC2'];
function donutIndigoPalette(n) {
  if (n <= 0) return [];
  if (n === 1) return [DONUT_INDIGO_ANCHORS[1]];
  const A = DONUT_INDIGO_ANCHORS, segs = A.length - 1, out = [];
  // With only a few wedges a smooth indigo ramp reads as nearly one colour, so
  // stretch its tonal range when the list is short: darken the low end and
  // brighten the high end (a lift that runs −1→+1 across the list), with an
  // amount that fades out by ~12 wedges. Each step then becomes a clearly bigger
  // jump while staying in the same family. Indigo scale only.
  const stretch = Math.max(0, (12 - n) / 10); // ~1 at n=2 → 0 at n>=12
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) * segs;
    const k = Math.min(segs - 1, Math.floor(t));
    const f = t - k;
    const a = _donutHexToRgb(A[k]), b = _donutHexToRgb(A[k + 1]);
    const lift = ((i / (n - 1)) * 2 - 1) * stretch * 34;
    out.push(_donutRgbToHex(
      a.r + (b.r - a.r) * f + lift,
      a.g + (b.g - a.g) * f + lift,
      a.b + (b.b - a.b) * f + lift
    ));
  }
  return out;
}
// "Spectrum" — a curated multi-hue set, extended with golden-angle hues (so
// neighbouring wedges never look alike) once a portfolio outgrows the base set.
const DONUT_SPECTRUM_BASE = ['#3b82f6', '#10b981', '#f43f5e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1', '#14b8a6', '#e879f9'];
function donutSpectrumPalette(n) {
  if (n <= DONUT_SPECTRUM_BASE.length) return DONUT_SPECTRUM_BASE.slice(0, n);
  const out = DONUT_SPECTRUM_BASE.slice();
  for (let i = DONUT_SPECTRUM_BASE.length; i < n; i++) {
    out.push(_donutHslToHex((210 + i * 137.508) % 360, 0.62, 0.58));
  }
  return out;
}
function donutPaletteColors(palette, n) {
  return palette === 'indigo' ? donutIndigoPalette(n) : donutSpectrumPalette(n);
}
const DONUT_OTHER_COLOR = '#2E2E3C';
// SVG donut/pie chart — supports grouping by ticker, sector, or market
const MARKET_LABELS = { US: 'USA', JSE: 'SA', TFSA: 'TFSA', LSE: 'UK', ASX: 'AUS', FRA: 'EUR', PAR: 'EUR', AMS: 'EUR', CRYPTO: 'Crypto' };
function PortfolioPieChart({ positions, displayCurrency, fxRates, onOpenDetail, sectorCache, fundamentals, sectorWeights, onSetSectorWeights, availableModes }) {
  const donutPalette = PBStore.useSetting('donutPalette');
  const donutTopN = PBStore.useSetting('donutTopN');
  const prices = PBStore.usePricesMap();
  const valueHidden = PBStore.useSetting('valueHidden');
  const [mode, setMode] = useState('ticker');
  const [hovered, setHovered] = useState(null);
  const [openSector, setOpenSector] = useState(null);
  // When set ({ ticker, market, name }), the dedicated sector-allocation editor
  // is open for that instrument — launched from the sector-breakdown popup.
  const [editWeightsFor, setEditWeightsFor] = useState(null);
  // Optional market filter (top-right of the card): narrows the donut to one
  // market's holdings. Only offered when the book spans more than one market.
  const [marketFilter, setMarketFilter] = useState('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef(null);
  const availMarkets = useMemo(() => Array.from(new Set(positions.map(p => p.market))), [positions]);
  useEffect(() => {
    if (marketFilter !== 'all' && !availMarkets.includes(marketFilter)) setMarketFilter('all');
  }, [availMarkets, marketFilter]);
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e) => { if (filterRef.current && !filterRef.current.contains(e.target)) setFilterOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, [filterOpen]);
  const allModes = [
    { key: 'ticker', label: 'Holdings' },
    { key: 'sector', label: 'Sector' },
    { key: 'market', label: 'Market' }
  ];
  // Callers can restrict the toggle set (e.g. TFSA hides "Market" — every holding
  // is the same single market, so the breakdown would be a meaningless 100%).
  const modes = availableModes ? allModes.filter(m => availableModes.includes(m.key)) : allModes;
  const rates = fxRates?.rates || null;
  // Build per-position values, honouring the market filter.
  const visiblePositions = marketFilter === 'all' ? positions : positions.filter(p => p.market === marketFilter);
  const posVals = [];
  visiblePositions.forEach(p => {
    const q = prices[priceKey(p.market, p.ticker)];
    if (!q) return;
    const native = marketCurrency(p.market);
    const val = convertCcy(p.shares * q.price, native, displayCurrency, rates);
    if (val != null && val > 0) {
      // Best available display name for ANY instrument (stock, ETF, trust): the
      // name saved at import, then the live quote's company name, then the
      // curated lists — never the bare ticker unless nothing else is known.
      const nm = positionDisplayName(p, p.market, q);
      // Pass the name so the resolver's last-resort classifier can place funds /
      // bonds / gold / foreign equities that the ticker maps don't cover.
      const sectorInfo = resolvePositionSector(p.ticker, p.market, sectorCache, fundamentals, nm) || {};
      // A look-through sector mix for this instrument (ETF/fund), if the user has
      // set one — used to split the holding across sectors below.
      const rawW = sectorWeights && sectorWeights[priceKey(p.market, p.ticker)];
      const splits = Array.isArray(rawW)
        ? rawW.map(w => ({ sector: w.sector, weight: parseFloat(w.weight) }))
              .filter(w => w.sector && isFinite(w.weight) && w.weight > 0)
        : [];
      posVals.push({ ticker: p.ticker, market: p.market, value: val, name: nm, sector: sectorInfo.sector || 'Other', sectorWeights: splits });
    }
  });
  // Group by mode, and (for the sector view) keep the member holdings per sector
  // so a tap can open a breakdown of exactly which stocks make up each wedge.
  const grouped = {};
  // Members per group key, so a tap on a sector OR a market wedge can open a
  // breakdown of exactly which holdings (and their values) make up that slice.
  const groupMembers = {};
  const addToGroup = (key, value, member) => {
    if (!grouped[key]) grouped[key] = { label: key, value: 0, market: member.market, ticker: member.ticker, name: member.name };
    grouped[key].value += value;
    (groupMembers[key] = groupMembers[key] || []).push(member);
  };
  posVals.forEach(pv => {
    if (mode === 'sector') {
      // ETF/fund with a defined sector mix: split its value across those sectors
      // (weights normalised) so it shows up proportionally in every wedge it spans.
      if (pv.sectorWeights && pv.sectorWeights.length) {
        const totalW = pv.sectorWeights.reduce((s, x) => s + x.weight, 0) || 1;
        pv.sectorWeights.forEach(sp => {
          const portion = pv.value * (sp.weight / totalW);
          if (portion > 0) addToGroup(sp.sector, portion, { ...pv, value: portion, sector: sp.sector });
        });
      } else {
        addToGroup(pv.sector, pv.value, pv);
      }
    } else if (mode === 'market') {
      addToGroup(MARKET_LABELS[pv.market] || pv.market, pv.value, pv);
    } else {
      addToGroup(pv.ticker, pv.value, pv);
    }
  });
  Object.values(groupMembers).forEach(list => list.sort((a, b) => b.value - a.value));
  // Sort by weight, but always sink "Other" to the bottom so it reads as the
  // residual it is rather than competing with real sectors near the top.
  const slices = Object.values(grouped).sort((a, b) => {
    const ao = a.label === 'Other', bo = b.label === 'Other';
    if (ao !== bo) return ao ? 1 : -1;
    return b.value - a.value;
  });
  let total = slices.reduce((s, sl) => s + sl.value, 0);
  // Header: mode toggle (left) + optional market filter (right). Built once and
  // reused in the empty state so a filter that narrows to nothing can still be
  // cleared (otherwise the control would vanish and trap the user).
  const toolbar = React.createElement("div", { className: "pie-toolbar" },
    React.createElement("div", { className: "chart-ranges" },
      modes.map(m => React.createElement("button", {
        key: m.key, className: `chart-range-btn ${mode === m.key ? 'active' : ''}`,
        onClick: () => { setMode(m.key); setHovered(null); setOpenSector(null); }
      }, m.label))),
    availMarkets.length > 1 ? React.createElement("div", { className: "pie-filter", ref: filterRef },
      React.createElement("button", {
        type: "button",
        className: "pie-filter-btn" + (marketFilter !== 'all' ? " active" : ""),
        onClick: () => setFilterOpen(o => !o),
        "aria-haspopup": "true", "aria-expanded": filterOpen,
        title: "Filter by market"
      },
        React.createElement(Icon, { name: "filter", size: 12 }),
        React.createElement("span", { className: "pie-filter-label" },
          marketFilter === 'all' ? 'All' : (MARKET_LABELS[marketFilter] || marketFilter))),
      filterOpen ? React.createElement("div", { className: "pie-filter-menu" },
        ['all', ...availMarkets].map(mk => React.createElement("button", {
          key: mk,
          type: "button",
          className: "pie-filter-opt" + (marketFilter === mk ? " active" : ""),
          onClick: () => { setMarketFilter(mk); setFilterOpen(false); }
        },
          React.createElement("span", null, mk === 'all' ? 'All markets' : (MARKET_LABELS[mk] || mk)),
          marketFilter === mk ? React.createElement(Icon, { name: "check", size: 12 }) : null))
      ) : null
    ) : null);
  if (slices.length === 0) {
    return React.createElement("div", null,
      toolbar,
      React.createElement("div", { className: "chart-empty" },
        React.createElement("div", { className: "text-dim text-sm" },
          marketFilter !== 'all' ? "No holdings in this market yet." : "Add positions to see allocation breakdown.")));
  }
  // Grouping into "Other" applies to the holdings view only — sectors and
  // markets always show in full (never absorbed). `donutTopN` (0 = show all) is
  // the user's chosen cap from Settings → Appearance.
  const groupN = (mode === 'ticker' && typeof donutTopN === 'number' && donutTopN > 0) ? donutTopN : 0;
  let displaySlices = slices;
  if (groupN > 0 && slices.length > groupN) {
    const keep = [];
    let otherVal = 0;
    // slices is already sorted desc with any pre-existing "Other" sunk last, so
    // indexing front-to-back keeps the genuine top holdings and folds the tail
    // (plus any residual "Other") into one wedge.
    slices.forEach((sl, i) => {
      if (i < groupN && sl.label !== 'Other') keep.push(sl);
      else otherVal += sl.value;
    });
    if (otherVal > 0) keep.push({ label: 'Other', value: otherVal, __other: true });
    displaySlices = keep;
  }
  // Clicking a wedge/legend row: holdings → open the stock; sector or market →
  // open a breakdown of the holdings that make up that slice. The grouped
  // "Other" wedge isn't a real instrument or group, so it's inert.
  const clickable = mode === 'ticker' || mode === 'sector' || mode === 'market';
  const handleSlice = (a) => {
    if (a.__other) return;
    if (mode === 'ticker') onOpenDetail(a.ticker, a.market);
    else setOpenSector(a.label);
  };
  // Colour each non-"Other" wedge from the chosen scale, generated to the exact
  // number shown so every holding gets a distinct colour; the grouped residual
  // is always the neutral slate.
  const paletteName = donutPalette === 'indigo' ? 'indigo' : 'spectrum';
  const nColored = displaySlices.reduce((c, s) => c + (s.__other ? 0 : 1), 0);
  const colorList = donutPaletteColors(paletteName, nColored);
  const SIZE = 154, CX = SIZE / 2, CY = SIZE / 2, R = 61, INNER_R = 39;
  const RING_R = (R + INNER_R) / 2, RING_W = R - INNER_R;
  const single = displaySlices.length === 1;
  let cumAngle = -Math.PI / 2;
  let colorIdx = 0;
  const arcs = displaySlices.map((s, i) => {
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
    const color = s.__other
      ? DONUT_OTHER_COLOR
      : (colorList[colorIdx++] || DONUT_INDIGO_ANCHORS[1]);
    return { ...s, d, color, pct: (s.value / total * 100) };
  });
  const sym = CURRENCY_SYMBOLS[displayCurrency] || '$';
  const fmtTotal = v => sym + Math.round(v).toLocaleString('en-US');
  // Touch parity for hover: dragging a finger across the legend highlights the
  // matching wedge (and updates the centre label) just like a desktop mouseover.
  // Touch events stay captured by the first-touched node, so we hit-test the
  // point under the finger to find which legend row it's currently over.
  const legendTouch = (e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const item = el && el.closest ? el.closest('[data-legend-idx]') : null;
    if (item) {
      const idx = parseInt(item.getAttribute('data-legend-idx'), 10);
      if (!isNaN(idx)) setHovered(idx);
    }
  };
  return React.createElement("div", null,
    toolbar,
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
            ? (() => {
                // Scale the font to the label so a long name wraps to ≤3 lines
                // and stays inside the donut hole; short labels stay big. Holdings
                // mode shows the company name (the ticker is dropped per design).
                const lbl = String((mode === 'ticker' ? (arcs[hovered].name || arcs[hovered].label) : arcs[hovered].label) || '');
                const n = lbl.length;
                const fs = n <= 4 ? 15 : n <= 7 ? 13 : n <= 11 ? 11.5 : n <= 16 ? 10 : n <= 21 ? 9 : 8;
                return React.createElement(React.Fragment, null,
                  React.createElement("div", { className: "chart-pie-center-tkr", style: { fontSize: fs } }, lbl),
                  React.createElement("div", { className: "chart-pie-center-pct" }, arcs[hovered].pct.toFixed(1) + '%'));
              })()
            : React.createElement(React.Fragment, null,
                React.createElement("div", { className: "chart-pie-center-label" }, "Total"),
                React.createElement("div", { className: "chart-pie-center-val" + (valueHidden ? " val-blur" : "") }, fmtTotal(total)))
        )
      ),
      React.createElement("div", {
        className: "chart-pie-legend",
        onTouchStart: legendTouch, onTouchMove: legendTouch, onTouchEnd: () => setHovered(null), onTouchCancel: () => setHovered(null)
      },
        arcs.map((a, i) => React.createElement("button", {
          key: i, className: "chart-pie-legend-item" + (clickable ? " is-clickable" : ""),
          "data-legend-idx": i,
          onMouseEnter: () => setHovered(i),
          onMouseLeave: () => setHovered(null),
          onClick: () => clickable ? handleSlice(a) : null,
          // Holdings mode lists company names only; keep the ticker reachable via
          // the row's tooltip so it stays available as secondary information.
          title: (mode === 'sector' || mode === 'market') ? 'See holdings in ' + a.label : (mode === 'ticker' ? a.ticker : undefined)
        },
          React.createElement("span", { className: "chart-pie-legend-dot", style: { background: a.color } }),
          // Holdings view shows the company / instrument name; sector & market
          // views show their group label.
          React.createElement("span", { className: "chart-pie-legend-tkr" + (mode === 'ticker' ? " is-name" : "") },
            mode === 'ticker' ? (a.name || a.label) : a.label),
          React.createElement("span", { className: "chart-pie-legend-pct" }, a.pct.toFixed(1) + '%'),
          (mode === 'sector' || mode === 'market') ? React.createElement(Icon, { name: "chevron", size: 11, className: "chart-pie-legend-go" }) : null
        ))
      )
    ),
    // Sector / market → "which of my holdings make up this" floating breakdown.
    openSector && (mode === 'sector' || mode === 'market') ? React.createElement(SectorHoldingsPopup, {
      sectorName: openSector,
      kind: mode,
      members: groupMembers[openSector] || [],
      sectorValue: (grouped[openSector] && grouped[openSector].value) || 0,
      portfolioTotal: total,
      displayCurrency: displayCurrency,
      onOpenDetail: onOpenDetail,
      // Only the sector view offers per-holding allocation editing (a market
      // wedge isn't an instrument). Needs a setter from the parent to persist.
      onEditWeights: (onSetSectorWeights && mode === 'sector')
        ? (m => setEditWeightsFor({ ticker: m.ticker, market: m.market, name: m.name }))
        : null,
      onClose: () => setOpenSector(null)
    }) : null,
    // Dedicated allocation editor for the holding tapped in the popup. Stacks
    // above it (.modal z-index 95 > .sector-modal 90).
    editWeightsFor ? React.createElement(SectorAllocationModal, {
      ticker: editWeightsFor.ticker,
      market: editWeightsFor.market,
      name: editWeightsFor.name,
      initialWeights: (sectorWeights && sectorWeights[priceKey(editWeightsFor.market, editWeightsFor.ticker)]) || null,
      onClose: () => setEditWeightsFor(null),
      onSave: (weights) => onSetSectorWeights(priceKey(editWeightsFor.market, editWeightsFor.ticker), weights)
    }) : null
  );
}
// Floating breakdown of exactly which holdings make up a sector wedge — opened
// by tapping a sector in the allocation chart. Lists each position with its
// value, share of the sector, and a proportional bar; tapping a row dives into
// that stock. Mirrors the heatmap's SectorDetailModal pop-in animation.
function SectorHoldingsPopup({ sectorName, members, sectorValue, portfolioTotal, displayCurrency, onOpenDetail, onEditWeights, onClose, kind }) {
  const isMarket = kind === 'market';
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
            React.createElement("div", { className: "sh-summary-label" }, isMarket ? "Market value" : "Sector value"),
            React.createElement("div", { className: "sh-summary-val" }, fmtMoney(sectorValue))),
          React.createElement("div", { className: "sh-summary-cell" },
            React.createElement("div", { className: "sh-summary-label" }, "Holdings"),
            React.createElement("div", { className: "sh-summary-val" }, members.length)),
          React.createElement("div", { className: "sh-summary-cell" },
            React.createElement("div", { className: "sh-summary-label" }, "Largest"),
            React.createElement("div", { className: "sh-summary-val" }, top ? top.ticker : "—"))),
        React.createElement("div", { className: "sh-list" },
          members.length === 0
            ? React.createElement("div", { className: "text-dim text-sm", style: { padding: 16, textAlign: 'center' } }, isMarket ? "No holdings in this market." : "No holdings in this sector.")
            : members.map((m, i) => {
                const wSector = sectorValue > 0 ? (m.value / sectorValue * 100) : 0;
                const hasName = m.name && m.name !== m.ticker;
                const main = React.createElement("button", {
                  className: "sh-row-main",
                  onClick: () => { if (onOpenDetail) onOpenDetail(m.ticker, m.market); close(); }
                },
                  React.createElement("div", { className: "sh-row-top" },
                    // Ticker — Company / instrument name. Ticker sits in a fixed
                    // column so every name lines up at the same x down the list.
                    React.createElement("div", { className: "sh-row-id" },
                      React.createElement("span", { className: "sh-row-tkr" }, m.ticker),
                      hasName ? React.createElement("span", { className: "sh-row-name" }, m.name) : null),
                    React.createElement("div", { className: "sh-row-figs" },
                      React.createElement("span", { className: "sh-row-val" }, fmtMoney(m.value)),
                      React.createElement("span", { className: "sh-row-wt" }, wSector.toFixed(1), "%"))),
                  React.createElement("div", { className: "sh-bar" },
                    React.createElement("div", { className: "sh-bar-fill", style: { width: Math.max(2, Math.min(100, wSector)) + '%' } })));
                return React.createElement("div", {
                  key: m.market + ':' + m.ticker + ':' + i,
                  className: "sh-row" + (onEditWeights ? " has-edit" : "")
                },
                  main,
                  // Dedicated "edit this fund's sector allocation" entry point —
                  // opens the allocation editor for the instrument. Funds are the
                  // intended use, but it's offered on every holding in the sector.
                  onEditWeights ? React.createElement("button", {
                    className: "sh-row-edit", type: "button",
                    title: "Edit sector allocation", "aria-label": "Edit sector allocation",
                    onClick: (e) => { e.stopPropagation(); onEditWeights(m); close(); }
                  }, React.createElement(Icon, { name: "edit", size: 15 })) : null);
              }))
      )
    )
  );
}
function DashboardView(_ref6) {
  let {
    positions,
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
    fundamentals,
    sectorWeights,
    onSetSectorWeights
  } = _ref6;
  const prices = PBStore.usePricesMap();
  const computeStats = list => {
    let cost = 0, value = 0, hasAllPrices = true;
    list.forEach(p => {
      const q = prices[priceKey(p.market, p.ticker)];
      const native = marketCurrency(p.market);
      const qCcy = q?.currency?.toUpperCase();
      const nativeUpper = native.toUpperCase();
      const sameCcy = !qCcy || qCcy === nativeUpper || qCcy === 'ZAC' && nativeUpper === 'ZAR' || qCcy === 'GBX' && nativeUpper === 'GBP';
      // This view groups by trading currency and sums in that currency. When a
      // holding's cost is booked in a different currency (crypto bought in ZAR),
      // convert it into the group's currency so cost and value stay comparable.
      const costCcy = positionCostCcy(p);
      const rawCost = p.shares * p.costBasis;
      cost += costCcy === native ? rawCost : (convertCcy(rawCost, costCcy, native, fxRates?.rates || null) ?? rawCost);
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
      // Value is in the market's native currency; cost may be booked in another
      // (crypto bought in ZAR), so convert each from its own currency to display.
      const c = convertCcy(p.shares * p.costBasis, positionCostCcy(p), displayCurrency, rates);
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
  // Today's movement across the whole book, in the display currency. Each
  // holding's day change (price − previous close) is valued in its market's
  // native currency then converted; yesterday's value anchors the percentage.
  // Only markets that have actually TRADED during the user's current local
  // calendar day count — a pre-open US book otherwise reports yesterday's US
  // session as part of today's move.
  let todayChange = 0, todayPrevValue = 0, todayHasData = false;
  positions.forEach(p => {
    const q = prices[priceKey(p.market, p.ticker)];
    if (!q || !isFinite(q.price) || typeof q.prevClose !== 'number' || !(q.prevClose > 0)) return;
    if (!quoteTradedToday(q, p.market)) return;
    const native = marketCurrency(p.market);
    const valNow = convertCcy(p.shares * q.price, native, displayCurrency, rates);
    const valPrev = convertCcy(p.shares * q.prevClose, native, displayCurrency, rates);
    if (valNow != null && valPrev != null) {
      todayChange += valNow - valPrev; todayPrevValue += valPrev; todayHasData = true;
    }
  });
  const todayPct = (todayHasData && todayPrevValue > 0) ? todayChange / todayPrevValue * 100 : null;
  const todayUp = todayChange >= 0;
  const [contribModalOpen, setContribModalOpen] = useState(false);
  const [contribImportOpen, setContribImportOpen] = useState(false);
  const [showContribHistory, setShowContribHistory] = useState(false);
  const [showTxHistory, setShowTxHistory] = useState(false);
  const [txFilter, setTxFilter] = useState('all');
  // App-wide hide-value flag (also read by the donut, Holdings summaries, TFSA
  // totals and the growth chart) — the eye button here is the single toggle.
  const valueHidden = PBStore.useSetting('valueHidden');
  // "Money put in" = each deposit valued at the rate locked when it was made
  // (the real rate when USD-landed was recorded), not today's market rate — so
  // overall return compares what you contributed to what you now hold.
  const totalContribDisplay = contributions.reduce((sum, c) => {
    return sum + contribInDisplay(c, displayCurrency, rates);
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
            onClick: () => PBStore.setSetting('valueHidden', !valueHidden),
            'aria-label': valueHidden ? "Show value" : "Hide value",
            style: { marginTop: -4, marginBottom: -4 }
          }, React.createElement(Icon, { name: valueHidden ? 'eye-off' : 'eye', size: 14 }))),
        React.createElement("div", { className: "stat-value" + (valueHidden ? " val-blur" : "") },
          fmtCcy(totalValue, displayCurrency)),
        // Today's move — a clearly-labelled pill so it reads as the day's change
        // and isn't mistaken for the all-time P/L line beneath it.
        todayPct != null ? React.createElement("div", { className: "dash-today" + (valueHidden ? " val-blur" : "") },
          React.createElement("span", { className: "dash-today-label" }, "Today"),
          React.createElement("span", { className: `dash-today-val ${todayUp ? 'up' : 'down'}` },
            React.createElement("span", { className: "dash-today-arrow" }, todayUp ? '▲' : '▼'),
            fmtCcySigned(todayChange, displayCurrency), " \xB7 ", (todayUp ? '+' : '') + todayPct.toFixed(2) + '%')) : null,
        React.createElement("div", { className: `stat-sub ${totalPnlPct >= 0 ? 'up' : 'down'}` + (valueHidden ? " val-blur" : "") },
          "Unrealised ", totalPnlPct >= 0 ? '+' : '', totalPnlPct.toFixed(2), "% \xB7 ",
          fmtCcySigned(totalPnl, displayCurrency)),
        (() => {
          const snap = computeFxSnapshot({ positions, contributions, prices, fxRates, displayCurrency });
          const hasRates = !!fxRates?.rates;
          const totalContrib = contributions.reduce((s, c) => {
            return s + contribInDisplay(c, displayCurrency, fxRates?.rates || null);
          }, 0);
          const overallProfit = totalValue - totalContrib;
          const fxGain = snap.fxGainOnCost;
          const hasFx = hasRates && Math.abs(fxGain) > 0.01;
          const hasContrib = totalContrib > 0;
          return (hasFx || hasContrib) ? React.createElement("div", {
            className: "portfolio-summary-row" + (valueHidden ? " val-blur" : "")
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
        React.createElement(PortfolioLineChart, { positions, contributions, displayCurrency, fxRates })),
      // Allocation pie chart
      React.createElement("div", { className: "card mb-4" },
        React.createElement("div", { className: "eyebrow", style: { marginBottom: 12 } }, "Allocation"),
        React.createElement(PortfolioPieChart, { positions, displayCurrency, fxRates, onOpenDetail, sectorCache, fundamentals, sectorWeights, onSetSectorWeights })),
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
                  React.createElement("span", { className: `growth-val ${overallReturn >= 0 ? 'up' : 'down'}` + (valueHidden ? " val-blur" : "") },
                    overallReturn >= 0 ? '+' : '\u2212',
                    fmtCcy(Math.abs(overallReturn), displayCurrency)),
                  React.createElement("span", { className: `growth-pct ${overallReturnPct >= 0 ? 'up' : 'down'}` },
                    overallReturnPct >= 0 ? '+' : '', overallReturnPct.toFixed(1), "%"))
              : React.createElement("div", { className: "text-dim text-sm", style: { padding: '10px 14px', background: 'var(--bg-elev)', borderRadius: 10 } }, "Log a deposit to track overall return."),
            totalContribDisplay > 0 && React.createElement("button", {
              className: "growth-contrib-total",
              onClick: () => setShowContribHistory(true)
            }, React.createElement("span", { className: "text-dim" }, "Total contributions"),
              React.createElement("span", { className: "mono" + (valueHidden ? " hsum-blur-inline" : "") }, fmtCcy(totalContribDisplay, displayCurrency)),
              React.createElement(Icon, { name: "chevron", size: 12 }))),
          React.createElement("div", { className: "growth-stat" },
            React.createElement("div", { className: "growth-stat-header" },
              React.createElement("div", { className: "growth-stat-label" }, "Position P/L"),
              React.createElement("div", { className: "growth-stat-sub" }, "vs. cost basis")),
            currencyGroups.length > 0
              ? currencyGroups.map(g => React.createElement("div", { key: g.code, className: "growth-currency-row" },
                  React.createElement("span", { className: "market-badge" }, g.label),
                  React.createElement("span", { className: `growth-val ${g.pnl >= 0 ? 'up' : 'down'}` + (valueHidden ? " val-blur" : "") }, g.pnl >= 0 ? '+' : '\u2212', fmt(Math.abs(g.pnl), g.fmtMarket)),
                  React.createElement("span", { className: `growth-pct ${g.pnlPct >= 0 ? 'up' : 'down'}` }, g.pnlPct >= 0 ? '+' : '', g.pnlPct.toFixed(1), "%")))
              : React.createElement("div", { className: "text-dim text-sm", style: { padding: '10px 14px', background: 'var(--bg-elev)', borderRadius: 10 } }, "Add positions to see P/L."),
            (positions.length > 0 || transactions.length > 0) && React.createElement("button", {
              className: "growth-contrib-total",
              onClick: () => setShowTxHistory(true)
            }, React.createElement("span", { className: "text-dim" }, "Transaction history"),
              React.createElement(Icon, { name: "chevron", size: 12 }))))),
      // Contribution history modal
      showContribHistory && React.createElement("div", { className: "modal", onClick: e => { if (e.target.classList.contains('modal-backdrop')) setShowContribHistory(false); } },
        React.createElement("div", { className: "modal-backdrop", onClick: () => setShowContribHistory(false) }),
        React.createElement("div", { className: "modal-panel", style: { maxWidth: 520 } },
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
                    c.usdLanded ? React.createElement("div", { className: "transaction-note" },
                      "→ $" + c.usdLanded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " landed"
                      + (c.fxRateAtContrib ? " · " + (CURRENCY_SYMBOLS[c.currency] || '') + c.fxRateAtContrib.toFixed(2) + "/$" : "")) : null,
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
                        tx.shares, " shares @ ", ccy, fmtNum(tx.price),
                        tx.notes ? ' \xB7 ' + tx.notes : '')),
                    React.createElement("div", { style: { textAlign: 'right' } },
                      React.createElement("div", { className: `transaction-amount ${isBuy ? '' : 'up'}` },
                        (isBuy ? '-' : '+') + ccy + fmtNum(total)),
                      React.createElement("div", { className: "text-xs text-dim" },
                        new Date(tx.date + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }))));
                }))));
      })(),
      // Contribution modal
      contribModalOpen ? React.createElement(ContributionModal, {
        onClose: () => setContribModalOpen(false),
        onOpenImport: onImportContributions ? () => setContribImportOpen(true) : null,
        onSave: (amount, currency, date, note, usdLanded) => { onAddContribution(amount, currency, date, note, usdLanded); setContribModalOpen(false); }
      }) : null,
      // Deposit / withdrawal bulk import
      contribImportOpen ? React.createElement(ContributionImportModal, {
        onClose: () => setContribImportOpen(false),
        onImport: (entries) => { if (onImportContributions) onImportContributions(entries); setContribImportOpen(false); }
      }) : null,
      ));
}
// A single holding row, laid out as three zones:
//  • Left  — company/instrument name (main heading), then the ticker + shares +
//            avg cost as a small subheading, plus inline Buy more / Sell.
//  • Middle — total gain/loss for the holding: the amount on top, the % below.
//  • Right — current holding value on top, the day's movement underneath.
// Subtle column header sitting above a holdings list, labelling the three
// row zones: Holding (stock name) · P/L · Current value. Shared by the
// Holdings (per-market) and TFSA lists so both read identically.
function HoldingsListHead() {
  return React.createElement("div", { className: "holding-list-head" },
    React.createElement("span", { className: "hlh-name" }, "Holding"),
    React.createElement("span", { className: "hlh-gl" }, "P/L"),
    React.createElement("span", { className: "hlh-val" }, "Current value"));
}
const HoldingRow = React.memo(function HoldingRow(_refHR) {
  let { position: p, market, quote: q, rates, onOpenDetail, onBuyPosition, onSellPosition, onEditPosition } = _refHR;
  // Heading is the company/instrument name. Resolve it from every source — the
  // name saved on the holding, the live quote's company name, the curated lists,
  // then the learned name cache — and only fall back to the bare ticker when
  // nothing else knows it.
  const name = positionDisplayName(p, market, q);
  const hasName = name !== p.ticker;
  // A unit trust has no ticker symbol, so its name takes the primary slot (where
  // a ticker normally sits) and the sub-line is dropped — the opaque Morningstar
  // id is never shown.
  const isUT = isUnitTrustId(p.ticker);
  const mainLabel = isUT && hasName ? name : p.ticker;
  // Value the position in the currency the cost basis is in. For ordinary
  // holdings that's the market's native currency (a no-op); for crypto bought in
  // ZAR it converts the live USD price into ZAR so cost and value line up and the
  // rand they paid is preserved instead of being silently re-based to dollars.
  const val = valuePositionInCostCcy(p, q, rates);
  const rowCcy = val.ccy;
  const marketValue = val.value;
  const cost = val.cost;
  const gain = val.gain;
  const gainUp = gain != null && gain >= 0;
  const growthPct = val.gainPct;
  const dayPct = q && typeof q.changePct === 'number' && isFinite(q.changePct) ? q.changePct : null;
  const dayUp = dayPct != null && dayPct >= 0;
  return React.createElement("button", {
    key: p.id, className: "row holding-row", onClick: () => onOpenDetail(p.ticker, market)
  },
    // LEFT — ticker + market badge (main), company name (sub). Avg cost lives on
    // the bottom action strip beside Edit (see ACTIONS below).
    React.createElement("div", { className: "row-main" },
      React.createElement("div", { className: "hold-id" },
        React.createElement("span", { className: "hold-tkr-main" }, mainLabel),
        React.createElement("span", { className: "mkt-badge" }, isUT ? "fund" : market)),
      React.createElement("div", { className: "row-meta" },
        (hasName && !isUT) ? React.createElement("span", { className: "hold-co-name" }, name) : null)),
    // MIDDLE — total gain/loss: amount on top, % below
    React.createElement("div", { className: "holding-gl" },
      gain != null
        ? React.createElement(React.Fragment, null,
            React.createElement("div", { className: `holding-gl-amt mono ${gainUp ? 'text-up' : 'text-down'}` },
              (gainUp ? '+' : '−') + fmtCcy(gain, rowCcy)),
            growthPct != null ? React.createElement("div", { className: `holding-gl-pct mono ${gainUp ? 'text-up' : 'text-down'}` },
              (gainUp ? '+' : '') + growthPct.toFixed(2) + '%') : null)
        : React.createElement("div", { className: "holding-gl-amt mono text-dim" }, "—")),
    // RIGHT — current value, with the day's movement underneath
    React.createElement("div", { className: "row-right" },
      React.createElement("div", { className: "holding-value mono" }, marketValue != null ? fmtCcy(marketValue, rowCcy) : "—"),
      dayPct != null ? React.createElement("div", {
        className: `holding-day mono ${dayUp ? 'text-up' : 'text-down'}`
      }, (dayUp ? '+' : '') + dayPct.toFixed(2) + '%') : null),
    // ACTIONS — full-width strip beneath the three zones: the Buy/Sell/Edit cluster
    // on the left (identically sized on every card), with Avg cost on the right.
    React.createElement("div", { className: "row-actions" },
      React.createElement("div", { className: "row-actions-btns" },
        onBuyPosition ? React.createElement("button", {
          className: "btn-buy-inline",
          onClick: e => { e.stopPropagation(); onBuyPosition(p); }
        }, "Buy") : null,
        onSellPosition ? React.createElement("button", {
          className: "btn-sell-inline",
          onClick: e => { e.stopPropagation(); onSellPosition(p); }
        }, "Sell") : null,
        onEditPosition ? React.createElement("button", {
          className: "btn-edit-inline",
          onClick: e => { e.stopPropagation(); onEditPosition(p); }
        }, "Edit") : null),
      React.createElement("span", { className: "hold-avg" }, "Avg cost ", fmtCcy(p.costBasis, rowCcy))));
});
function CurrentView(_ref7) {
  let {
    positions,
    marketFilter,
    setMarketFilter,
    fxRates,
    onOpenDetail,
    onAddPosition,
    onEditPosition,
    onImportPositions,
    onBuyPosition,
    onSellPosition
  } = _ref7;
  const prices = PBStore.usePricesMap();
  const valueHidden = PBStore.useSetting('valueHidden');
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
  const rates = fxRates?.rates || null;

  // Holdings sort — collapsed icon button + popover, sharing the watchlist's
  // wl-iconbtn / wl-sortmenu styling so the two tabs read identically. Defaults to
  // value (largest holding first) so each market tab opens biggest → smallest;
  // "Default order" (manual/insertion) is still available from the menu.
  const [sortMode, setSortMode] = useState('value');
  const [sortOpen, setSortOpen] = useState(false);
  const sortOptions = [
    { id: 'manual', label: 'Default order' },
    { id: 'value', label: 'Value: high → low' },
    { id: 'plPct', label: 'Gain %: high → low' },
    { id: 'plAmt', label: 'Gain amount' },
    { id: 'today', label: "Today's move" },
    { id: 'name', label: 'Name A–Z' }
  ];
  const sortRows = (rows, market) => {
    if (sortMode === 'manual') return rows;
    const arr = rows.slice();
    arr.sort((a, b) => {
      const qa = prices[priceKey(market, a.ticker)], qb = prices[priceKey(market, b.ticker)];
      if (sortMode === 'today') {
        const ca = qa && isFinite(qa.changePct) ? qa.changePct : -Infinity;
        const cb = qb && isFinite(qb.changePct) ? qb.changePct : -Infinity;
        return cb - ca;
      }
      if (sortMode === 'name') {
        const na = positionDisplayName(a, market, qa) || a.ticker;
        const nb = positionDisplayName(b, market, qb) || b.ticker;
        return na.localeCompare(nb);
      }
      const va = valuePositionInCostCcy(a, qa, rates), vb = valuePositionInCostCcy(b, qb, rates);
      if (sortMode === 'value') return (vb.value ?? -Infinity) - (va.value ?? -Infinity);
      if (sortMode === 'plPct') return (vb.gainPct ?? -Infinity) - (va.gainPct ?? -Infinity);
      if (sortMode === 'plAmt') return (vb.gain ?? -Infinity) - (va.gain ?? -Infinity);
      return 0;
    });
    return arr;
  };

  // Aggregate the active market's holdings into one summary (in the market's
  // native currency): total value, profit, and today's move. Cost booked in a
  // different currency (crypto in ZAR) is converted into native first.
  const computeMarketSummary = (rows, market) => {
    const native = marketCurrency(market);
    let value = 0, cost = 0, prevValue = 0, dayChange = 0, anyPrice = false, anyDay = false;
    rows.forEach(p => {
      const q = prices[priceKey(market, p.ticker)];
      const c = convertCcy(p.shares * p.costBasis, positionCostCcy(p), native, rates);
      cost += (c != null ? c : p.shares * p.costBasis);
      if (q && isFinite(q.price)) {
        value += p.shares * q.price; anyPrice = true;
        // Day line only counts once this market has traded today.
        if (typeof q.prevClose === 'number' && q.prevClose > 0 && quoteTradedToday(q, market)) {
          prevValue += p.shares * q.prevClose;
          dayChange += p.shares * (q.price - q.prevClose);
          anyDay = true;
        } else { prevValue += p.shares * q.price; }
      }
    });
    return {
      native, value, cost, anyPrice,
      gain: anyPrice ? value - cost : null,
      gainPct: (anyPrice && cost > 0) ? (value - cost) / cost * 100 : null,
      dayChange: anyDay ? dayChange : null,
      dayPct: (anyDay && prevValue > 0) ? dayChange / prevValue * 100 : null
    };
  };

  const renderSummary = (rows, market) => {
    const s = computeMarketSummary(rows, market);
    if (!s.anyPrice) return null;
    const up = (s.gain ?? 0) >= 0;
    const ccy = s.native;
    // Stacked progress bar. Profit: [invested | profit] spans the current value.
    // Loss: [value | shortfall] spans the original cost, so the red tail is the
    // slice of cost that's been given back.
    const total = up ? (s.value || 1) : (s.cost || 1);
    const investedPct = Math.max(0, Math.min(100, (up ? s.cost : s.value) / total * 100));
    const deltaPct = Math.max(0, 100 - investedPct);
    const dayUp = (s.dayChange ?? 0) >= 0;
    return React.createElement("div", { className: "holdings-summary" },
      React.createElement("div", { className: "hsum-top" },
        React.createElement("div", { className: "hsum-main" },
          React.createElement("div", { className: "hsum-label" }, "Market value · " + ccy),
          React.createElement("div", { className: "hsum-value mono" + (valueHidden ? " val-blur" : "") }, fmtCcy(s.value, ccy))),
        React.createElement("div", { className: `hsum-pl ${up ? 'up' : 'down'}` },
          React.createElement("div", { className: "hsum-pl-amt mono" + (valueHidden ? " val-blur" : "") }, fmtCcySigned(s.gain, ccy)),
          s.gainPct != null ? React.createElement("div", { className: "hsum-pl-pct mono" },
            (up ? '+' : '') + s.gainPct.toFixed(2) + '%') : null)),
      React.createElement("div", { className: "hsum-bar" },
        React.createElement("div", { className: "hsum-bar-invested", style: { width: investedPct + '%' } }),
        React.createElement("div", { className: `hsum-bar-delta ${up ? 'up' : 'down'}`, style: { width: deltaPct + '%' } })),
      React.createElement("div", { className: "hsum-foot" },
        React.createElement("div", { className: "hsum-foot-legend" },
          React.createElement("span", { className: "hsum-dot invested" }),
          React.createElement("span", null, "Invested ",
            React.createElement("span", { className: valueHidden ? "hsum-blur-inline" : "" }, fmtCcy(s.cost, ccy)))),
        s.dayPct != null ? React.createElement("div", { className: `hsum-today ${dayUp ? 'up' : 'down'}` },
          React.createElement("span", { className: "hsum-today-arrow" }, dayUp ? '▲' : '▼'),
          React.createElement("span", { className: "mono" }, "Today ",
            React.createElement("span", { className: valueHidden ? "hsum-blur-inline" : "" }, fmtCcySigned(s.dayChange, ccy)),
            " · ", (dayUp ? '+' : '') + s.dayPct.toFixed(2) + '%')) : null));
  };

  // Sort + Import + Add cluster. Lives directly beneath the market summary (or
  // above the empty state) rather than up in the tab row, and uses the compact
  // button sizing shared with the watchlist toolbar.
  const renderActions = (market, count) => React.createElement("div", {
    className: "holdings-actions holdings-actions-bar", style: { position: 'relative' }
  },
    count > 1 ? React.createElement("button", {
      className: "wl-iconbtn" + (sortOpen ? " active" : "") + (sortMode !== 'manual' ? " on" : ""),
      "aria-label": "Sort holdings", "aria-expanded": sortOpen,
      onClick: () => setSortOpen(o => !o)
    }, React.createElement(Icon, { name: "sort", size: 13 }),
       sortMode !== 'manual' ? React.createElement("span", { className: "wl-iconbtn-dot" }) : null) : null,
    onImportPositions ? React.createElement("button", { className: "btn btn-secondary btn-xs", onClick: onImportPositions },
      React.createElement(Icon, { name: "download", size: 11 }), " Import") : null,
    React.createElement("button", { className: "btn btn-primary btn-xs", onClick: onAddPosition },
      React.createElement(Icon, { name: "plus", size: 11 }), " Add"),
    // Sort popover anchored to the cluster's right edge so it stays on-screen.
    sortOpen ? React.createElement(React.Fragment, null,
      React.createElement("button", { className: "wl-pop-backdrop", "aria-label": "Close", onClick: () => setSortOpen(false) }),
      React.createElement("div", { className: "wl-sortmenu", style: { left: 'auto', right: 0, transformOrigin: 'top right' } },
        React.createElement("div", { className: "wl-sortmenu-head" }, "Sort by"),
        sortOptions.map(o => React.createElement("button", {
          key: o.id, className: "wl-sortmenu-row" + (sortMode === o.id ? " active" : ""),
          onClick: () => { setSortMode(o.id); setSortOpen(false); }
        }, React.createElement("span", { className: "wl-sortmenu-label" }, o.label),
           sortMode === o.id ? React.createElement(Icon, { name: "check", size: 14 }) : null)))
    ) : null);

  const renderMarket = (market) => {
    const rows = positions.filter(p => p.market === market);
    if (rows.length === 0) {
      return React.createElement("div", null,
        renderActions(market, 0),
        React.createElement("div", { className: "empty" },
          React.createElement(Icon, { name: "briefcase", size: 40 }),
          React.createElement("h3", null, "No ", tabLabel(market), " positions yet"),
          React.createElement("p", null, "Add your ", tabLabel(market), " holdings using the Add button above.")));
    }
    const sorted = sortRows(rows, market);
    return React.createElement("div", null,
      renderSummary(rows, market),
      renderActions(market, rows.length),
      React.createElement("div", {
      className: "eyebrow"
    }, "Your ", tabLabel(market), " positions"), React.createElement(HoldingsListHead, null), React.createElement("div", {
      className: "row-list"
    }, sorted.map(p => React.createElement(HoldingRow, {
      key: p.id,
      position: p,
      market: market,
      quote: prices[priceKey(market, p.ticker)],
      rates: fxRates?.rates || null,
      onOpenDetail: onOpenDetail,
      onBuyPosition: onBuyPosition,
      onSellPosition: onSellPosition,
      onEditPosition: onEditPosition
    }))));
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
    className: `toggle-opt toggle-opt-market ${activeMarket === m ? 'active' : ''}`,
    onClick: () => setMarketFilter(m)
  },
    React.createElement("span", { className: "toggle-opt-label" }, tabLabel(m)),
    React.createElement("span", { className: "toggle-opt-count" }, countFor(m))
  )))),
    renderMarket(activeMarket));
}
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
    watchlistGroups,
    alerts,
    onAdd,
    onRemove,
    onReorder,
    onMoveWatch,
    onAddWatchGroup,
    onRenameWatchGroup,
    onRemoveWatchGroup,
    onOpenDetail,
    onAddAlert,
    onRemoveAlert,
    childSwipeLockRef
  } = _ref8;
  const prices = PBStore.usePricesMap();
  const [newTicker, setNewTicker] = useState('');
  const [newMarket, setNewMarket] = useState('US');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showSuggestions, setShowSuggestions] = usePersistedState('pb.watchlist.showSuggestions.v1', true);
  // Multiple named watchlists + per-list filtering. activeList 'all' shows every
  // tracked stock; 'default' is the built-in list; anything else is a custom list
  // id. The full-list, unsorted, unfiltered "All" view is the only one where the
  // long-press drag-reorder runs (it reorders the whole array by index, so it
  // can't operate on a filtered subset).
  const groups = watchlistGroups || [];
  const [activeList, setActiveList] = usePersistedState('pb.watchlist.activeList.v1', 'all');
  const [search, setSearch] = useState('');
  const [filterMarket, setFilterMarket] = useState('all');
  // Smart filter tag — an extra axis beyond market: movers, near-high, alerts.
  // Combines with the market filter (AND) so you can narrow on both at once.
  const [filterTag, setFilterTag] = useState('all');
  const [sortMode, setSortMode] = useState('manual');
  // Search/sort live as collapsed icon buttons in the action row; these drive
  // the iOS-style expand of the search field and the sort popover respectively.
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const searchInputRef = useRef(null);
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [managingList, setManagingList] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // If a stored active list was deleted elsewhere, fall back to All.
  useEffect(() => {
    if (activeList !== 'all' && activeList !== 'default' && !groups.some(g => g.id === activeList)) setActiveList('all');
  }, [activeList, groups]);
  // A stock can sit in several lists at once, so membership is a set test rather
  // than a single id compare. customListsOf drives the per-card list badges.
  const inList = (w, id) => watchListIds(w).includes(id);
  const customListsOf = (w) => watchListIds(w).filter(id => id !== 'default');
  const reorderEnabled = activeList === 'all' && !search.trim() && filterMarket === 'all' && filterTag === 'all' && sortMode === 'manual';
  const targetListId = activeList === 'all' ? 'default' : activeList;
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
    // Drag-reorder only in the plain "All" view — a filtered/sorted/specific-list
    // view renders a subset, which the index-based reorder can't handle. Swipe and
    // tap stay active regardless.
    if (reorderEnabled) {
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        const po = pressOriginRef.current;
        if (!po || po.id !== id) return;
        startDrag(id, po.pointerId, po.y);
      }, 450);
    }
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

  const suggestions = useMemo(() => buildSuggestions(watchlist), [watchlist]);
  const addSuggestion = (s) => {
    const key = priceKey(s.market, s.ticker);
    if (watchlist.some(w => priceKey(w.market, w.ticker) === key)) return;
    onAdd(s.ticker, s.market, s.name, targetListId);
    triggerHaptic();
    setJustAdded(prev => prev.some(x => priceKey(x.market, x.ticker) === key) ? prev : [...prev, s]);
    setTimeout(() => setJustAdded(prev => prev.filter(x => priceKey(x.market, x.ticker) !== key)), 1700);
  };
  const tabLists = [{ id: 'all', name: 'All' }, { id: 'default', name: 'Watchlist' }, ...groups];
  const isCustomActive = activeList !== 'all' && activeList !== 'default';
  const listNameById = (id) => (id === 'default' ? 'Watchlist' : ((groups.find(g => g.id === id) || {}).name || 'Watchlist'));
  const countFor = (id) => id === 'all' ? watchlist.length : watchlist.filter(w => inList(w, id)).length;
  const activeCount = activeList === 'all' ? watchlist.length : countFor(activeList);
  const marketsPresent = useMemo(() => {
    const set = new Set();
    watchlist.forEach(w => { if (activeList === 'all' || inList(w, activeList)) set.add(w.market); });
    return Array.from(set).sort();
  }, [watchlist, activeList]);
  const visible = useMemo(() => {
    let arr = watchlist.filter(w => activeList === 'all' ? true : inList(w, activeList));
    const s = search.trim().toLowerCase();
    if (s) {
      // Smarter search: every space-separated term must hit somewhere in the
      // ticker or name, so "app tech" narrows instead of needing one substring.
      const terms = s.split(/\s+/).filter(Boolean);
      arr = arr.filter(w => {
        const hay = (w.ticker + ' ' + (w.name || '')).toLowerCase();
        return terms.every(t => hay.includes(t));
      });
    }
    if (filterMarket !== 'all') arr = arr.filter(w => w.market === filterMarket);
    if (filterTag !== 'all') arr = arr.filter(w => {
      const q = prices[priceKey(w.market, w.ticker)];
      const ch = q && typeof q.changePct === 'number' && isFinite(q.changePct) ? q.changePct : null;
      if (filterTag === 'up') return ch != null && ch > 0;
      if (filterTag === 'down') return ch != null && ch < 0;
      if (filterTag === 'nearhigh') return !!q && q.yearHigh > 0 && q.price >= q.yearHigh * 0.95;
      if (filterTag === 'alerts') return alerts.some(a => a.ticker === w.ticker && a.market === w.market);
      return true;
    });
    if (sortMode === 'name') arr = [...arr].sort((a, b) => (prettyName(a.name) || a.ticker).localeCompare(prettyName(b.name) || b.ticker));
    else if (sortMode === 'recent') arr = [...arr].sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
    else if (sortMode === 'today') arr = [...arr].sort((a, b) => {
      const qa = prices[priceKey(a.market, a.ticker)], qb = prices[priceKey(b.market, b.ticker)];
      const ca = qa && typeof qa.changePct === 'number' && isFinite(qa.changePct) ? qa.changePct : -Infinity;
      const cb = qb && typeof qb.changePct === 'number' && isFinite(qb.changePct) ? qb.changePct : -Infinity;
      return cb - ca;
    });
    // Pre-market move: rank by the live pre-session % (q.extKind === 'pre').
    // Only counts a genuine pre-market quote — symbols with no pre move (post /
    // regular / closed / no data) sink to the bottom, so outside pre-market hours
    // the option just degrades gracefully rather than scrambling the list.
    else if (sortMode === 'premarket') arr = [...arr].sort((a, b) => {
      const qa = prices[priceKey(a.market, a.ticker)], qb = prices[priceKey(b.market, b.ticker)];
      const pa = qa && qa.extKind === 'pre' && typeof qa.extChangePct === 'number' && isFinite(qa.extChangePct) ? qa.extChangePct : -Infinity;
      const pb = qb && qb.extKind === 'pre' && typeof qb.extChangePct === 'number' && isFinite(qb.extChangePct) ? qb.extChangePct : -Infinity;
      return pb - pa;
    });
    return arr;
  }, [watchlist, activeList, search, filterMarket, filterTag, sortMode, prices, alerts]);
  // Switching lists clears the in-list filters so you never land on a list that
  // looks empty because of a stale search / market filter.
  useEffect(() => { setSearch(''); setFilterMarket('all'); setFilterTag('all'); setManagingList(false); setSearchOpen(false); setSortOpen(false); setManageOpen(false); setFilterOpen(false); }, [activeList]);
  const sortOptions = [
    { id: 'manual', label: reorderEnabled ? 'Manual order' : 'Default order' },
    { id: 'today', label: "Today's move" },
    { id: 'premarket', label: 'Pre-market move' },
    { id: 'name', label: 'Name A–Z' },
    { id: 'recent', label: 'Recently added' }
  ];
  const filterTagOptions = [
    { id: 'all', label: 'All stocks' },
    { id: 'up', label: 'Gainers today' },
    { id: 'down', label: 'Losers today' },
    { id: 'nearhigh', label: 'Near 52W high' },
    { id: 'alerts', label: 'Has alerts' }
  ];
  const createList = () => {
    const _r = onAddWatchGroup && onAddWatchGroup(newListName);
    const id = _r && _r.id;
    if (id) setActiveList(id);
    setNewListName(''); setCreatingList(false);
  };
  const saveRename = () => {
    if (onRenameWatchGroup && renameValue.trim()) onRenameWatchGroup(activeList, renameValue);
    setManagingList(false); setManageOpen(false);
  };
  const deleteList = () => {
    if (onRemoveWatchGroup) onRemoveWatchGroup(activeList);
    setManagingList(false); setManageOpen(false); setActiveList('all');
  };
  return React.createElement("div", null,
    // Topline — the watchlists only. Search, sort and Add live on the row below.
    React.createElement("div", { className: "wl-tabbar" },
      React.createElement("div", { className: "wl-tabs" },
        tabLists.map(l => React.createElement("button", {
          key: l.id,
          className: "wl-tab" + (activeList === l.id ? " active" : ""),
          onClick: () => setActiveList(l.id)
        }, l.name, React.createElement("span", { className: "wl-tab-count" }, countFor(l.id)))),
        onAddWatchGroup ? React.createElement("button", {
          key: '__new', className: "wl-tab wl-tab-new",
          onClick: () => { setCreatingList(true); setManagingList(false); }, "aria-label": "New list", title: "New list"
        }, React.createElement(Icon, { name: "plus", size: 13 })) : null
      )
    ),
    // Action row — interactive search/sort icons (iOS-style expand) + Add. Search
    // and sort only appear when there's something to act on; Add is always here.
    React.createElement("div", { className: "wl-toolbar" + (searchOpen ? " searching" : "") },
      activeCount > 0 ? React.createElement("div", { className: "wl-search2" + (searchOpen ? " open" : "") },
        React.createElement("button", {
          className: "wl-iconbtn wl-search2-btn" + (searchOpen ? " active" : ""),
          "aria-label": searchOpen ? "Close search" : "Search",
          onClick: () => {
            if (searchOpen) { setSearch(''); setSearchOpen(false); }
            else { setSortOpen(false); setManageOpen(false); setFilterOpen(false); setSearchOpen(true); requestAnimationFrame(() => { try { searchInputRef.current && searchInputRef.current.focus(); } catch (_) {} }); }
          }
        }, React.createElement(Icon, { name: searchOpen ? "x" : "search", size: 14 })),
        React.createElement("input", {
          ref: searchInputRef,
          className: "wl-search2-input", type: "text", placeholder: "Filter by ticker or name",
          value: search, onChange: e => setSearch(e.target.value), tabIndex: searchOpen ? 0 : -1,
          autoComplete: "off", autoCorrect: "off", spellCheck: false,
          onKeyDown: e => { if (e.key === 'Escape') { setSearch(''); setSearchOpen(false); } }
        })
      ) : null,
      activeCount > 0 ? React.createElement("div", { className: "wl-sortwrap" },
        React.createElement("button", {
          className: "wl-iconbtn" + (sortOpen ? " active" : "") + (sortMode !== 'manual' ? " on" : ""),
          "aria-label": "Sort", "aria-expanded": sortOpen,
          onClick: () => { setSearchOpen(false); setManageOpen(false); setFilterOpen(false); setSortOpen(o => !o); }
        }, React.createElement(Icon, { name: "sort", size: 14 }),
           sortMode !== 'manual' ? React.createElement("span", { className: "wl-iconbtn-dot" }) : null),
        sortOpen ? React.createElement(React.Fragment, null,
          React.createElement("button", { className: "wl-pop-backdrop", "aria-label": "Close", onClick: () => setSortOpen(false) }),
          React.createElement("div", { className: "wl-sortmenu" },
            React.createElement("div", { className: "wl-sortmenu-head" }, "Sort by"),
            sortOptions.map(o => React.createElement("button", {
              key: o.id, className: "wl-sortmenu-row" + (sortMode === o.id ? " active" : ""),
              onClick: () => { setSortMode(o.id); setSortOpen(false); }
            }, React.createElement("span", { className: "wl-sortmenu-label" }, o.label),
               sortMode === o.id ? React.createElement(Icon, { name: "check", size: 14 }) : null)))
        ) : null
      ) : null,
      // Filter popover — a smart filter holding the market picker plus quick
      // tags (movers, near-high, alerts). Replaces the always-on market chip row.
      activeCount > 0 ? React.createElement("div", { className: "wl-sortwrap" },
        React.createElement("button", {
          className: "wl-iconbtn" + (filterOpen ? " active" : "") + ((filterMarket !== 'all' || filterTag !== 'all') ? " on" : ""),
          "aria-label": "Filter", "aria-expanded": filterOpen,
          onClick: () => { setSearchOpen(false); setSortOpen(false); setManageOpen(false); setFilterOpen(o => !o); }
        }, React.createElement(Icon, { name: "filter", size: 14 }),
           (filterMarket !== 'all' || filterTag !== 'all') ? React.createElement("span", { className: "wl-iconbtn-dot" }) : null),
        filterOpen ? React.createElement(React.Fragment, null,
          React.createElement("button", { className: "wl-pop-backdrop", "aria-label": "Close", onClick: () => setFilterOpen(false) }),
          React.createElement("div", { className: "wl-sortmenu wl-filtermenu" },
            marketsPresent.length > 1 ? React.createElement(React.Fragment, null,
              React.createElement("div", { className: "wl-sortmenu-head" }, "Market"),
              React.createElement("div", { className: "wl-fchips" },
                ['all', ...marketsPresent].map(m => React.createElement("button", {
                  key: m, className: "wl-fchip" + (filterMarket === m ? " active" : ""),
                  onClick: () => setFilterMarket(m)
                }, m === 'all' ? 'All' : m)))
            ) : null,
            React.createElement("div", { className: "wl-sortmenu-head" }, "Show"),
            filterTagOptions.map(o => React.createElement("button", {
              key: o.id, className: "wl-sortmenu-row" + (filterTag === o.id ? " active" : ""),
              onClick: () => setFilterTag(o.id)
            }, React.createElement("span", { className: "wl-sortmenu-label" }, o.label),
               filterTag === o.id ? React.createElement(Icon, { name: "check", size: 14 }) : null)),
            (filterMarket !== 'all' || filterTag !== 'all') ? React.createElement("button", {
              className: "wl-sortmenu-row wl-filter-clear",
              onClick: () => { setFilterMarket('all'); setFilterTag('all'); }
            }, React.createElement(Icon, { name: "x", size: 14 }), React.createElement("span", { className: "wl-sortmenu-label" }, "Clear filters")) : null)
        ) : null
      ) : null,
      // Manage the active custom list — an edit icon that opens the same animated
      // popover as sort, holding the rename/delete actions for this list.
      isCustomActive ? React.createElement("div", { className: "wl-sortwrap" },
        React.createElement("button", {
          className: "wl-iconbtn" + (manageOpen ? " active" : ""),
          "aria-label": "Edit list", "aria-expanded": manageOpen,
          onClick: () => { setSearchOpen(false); setSortOpen(false); setFilterOpen(false); setManagingList(false); setManageOpen(o => !o); }
        }, React.createElement(Icon, { name: "edit", size: 13 })),
        manageOpen ? React.createElement(React.Fragment, null,
          React.createElement("button", { className: "wl-pop-backdrop", "aria-label": "Close", onClick: () => { setManageOpen(false); setManagingList(false); } }),
          React.createElement("div", { className: "wl-sortmenu" },
            React.createElement("div", { className: "wl-sortmenu-head" }, listNameById(activeList), " \xB7 ", activeCount, activeCount === 1 ? " stock" : " stocks"),
            managingList
              ? React.createElement("div", { className: "wl-rename-row" },
                  React.createElement("input", {
                    className: "wl-inline-input", type: "text", value: renameValue, maxLength: 28, autoFocus: true, placeholder: "List name",
                    onChange: e => setRenameValue(e.target.value),
                    onKeyDown: e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setManagingList(false); }
                  }),
                  React.createElement("div", { className: "wl-rename-actions" },
                    React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => setManagingList(false), style: { flex: '1 1 auto' } }, "Cancel"),
                    React.createElement("button", { className: "btn btn-primary btn-sm", onClick: saveRename, disabled: !renameValue.trim(), style: { flex: '1 1 auto' } }, "Save")))
              : React.createElement(React.Fragment, null,
                  React.createElement("button", {
                    className: "wl-sortmenu-row",
                    onClick: () => { setRenameValue(listNameById(activeList)); setManagingList(true); }
                  }, React.createElement(Icon, { name: "edit", size: 14 }), React.createElement("span", { className: "wl-sortmenu-label" }, "Rename list")),
                  React.createElement("button", {
                    className: "wl-sortmenu-row wl-danger", onClick: deleteList
                  }, React.createElement(Icon, { name: "trash", size: 14 }), React.createElement("span", { className: "wl-sortmenu-label" }, "Delete list"))))
        ) : null
      ) : null,
      React.createElement("button", { className: "btn btn-primary btn-sm wl-add-btn", onClick: () => setShowAddForm(true) },
        React.createElement(Icon, { name: "plus", size: 12 }), " Add")
    ),
    creatingList ? React.createElement("div", { className: "wl-inline-form mb-4" },
      React.createElement("input", {
        className: "wl-inline-input", type: "text", placeholder: "New list name (e.g. Tech, To buy)",
        value: newListName, maxLength: 28, autoFocus: true,
        onChange: e => setNewListName(e.target.value),
        onKeyDown: e => { if (e.key === 'Enter') createList(); if (e.key === 'Escape') { setCreatingList(false); setNewListName(''); } }
      }),
      React.createElement("button", { className: "btn btn-primary btn-sm", onClick: createList, disabled: !newListName.trim(), style: { flex: '0 0 auto' } }, "Create"),
      React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => { setCreatingList(false); setNewListName(''); }, style: { flex: '0 0 auto' } }, "Cancel")
    ) : null,
    showAddForm && React.createElement("div", { className: "card mb-4 watchlist-add" },
      React.createElement("div", { className: "wl-add-hint" },
        React.createElement(Icon, { name: "search", size: 13 }),
        React.createElement("span", null, " Search a stock and tap a result to open its card — add it to a watchlist from there.")),
      React.createElement("div", { className: "form-label" }, "Market"),
      React.createElement(MarketPicker, {
        value: newMarket,
        onChange: v => setNewMarket(v),
        style: { width: '100%', marginBottom: 10 }
      }),
      React.createElement("div", { className: "form-label" }, "Search"),
      React.createElement(TickerSearch, {
        value: newTicker,
        onChange: v => setNewTicker(v),
        market: newMarket,
        onMarketChange: v => setNewMarket(v),
        onSelect: (s) => { setShowAddForm(false); setNewTicker(''); onOpenDetail(s.ticker, s.market); },
        onEnter: () => { const t = newTicker.trim(); if (!t) return; setShowAddForm(false); setNewTicker(''); onOpenDetail(t.toUpperCase(), newMarket); }
      }),
      React.createElement("button", {
        className: "btn btn-ghost btn-sm",
        style: { marginTop: 12, width: '100%' },
        onClick: () => { setShowAddForm(false); setNewTicker(''); }
      }, "Close")
    ),
    watchlist.length === 0 ? React.createElement("div", { className: "empty" },
      React.createElement(Icon, { name: "eye", size: 40 }),
      React.createElement("h3", null, "Empty watchlist"),
      React.createElement("p", null, "Tap Add to track your first ticker, or open any stock and tap “Add to watchlist”."))
    : visible.length === 0 ? React.createElement("div", { className: "empty wl-empty-sm" },
      React.createElement(Icon, { name: "eye", size: 32 }),
      React.createElement("p", null,
        (search.trim() || filterMarket !== 'all' || filterTag !== 'all')
          ? "No stocks match this filter."
          : (activeList === 'all' ? "Your watchlist is empty." : "This list is empty. Add a stock here, or open a stock and move it into this list.")))
    : React.createElement("div", { className: "watchlist-list mb-6" },
      visible.map((w) => {
        const q = prices[priceKey(w.market, w.ticker)];
        // No bare-ticker fallback: the ticker is already the card heading, so a
        // missing name should leave the subheading empty rather than repeat it.
        const displayName = w.name ? prettyName(w.name) : resolveTickerName(w.ticker, w.market, q);
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
        const hasDay = q && typeof q.changePct === 'number' && isFinite(q.changePct);
        const dayUp = hasDay && q.changePct >= 0;
        // Extended-hours chip lives in the card body (bottom-middle), lifted out
        // of the header price block so the price stays pinned to the right edge.
        const hasExt = q && q.extPrice != null && q.extChangePct != null;
        const extUp = hasExt && q.extChangePct >= 0;
        const extLabel = q && q.extKind === 'pre' ? 'Pre-market' : q && q.extKind === 'post' ? 'After-hours' : '';
        const extSym = (MARKET_CURRENCY[w.market] || MARKET_CURRENCY.US).sym;
        const extChgAbs = hasExt && typeof q.extChange === 'number' && isFinite(q.extChange) ? q.extChange : null;
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
                  React.createElement("span", { className: "market-badge" }, w.market),
                  activeList === 'all'
                    ? customListsOf(w).map(id => React.createElement("span", { key: id, className: "wl-card-list" }, listNameById(id))) : null),
                displayName ? React.createElement("div", { className: "tkr-name" }, displayName) : null),
              // Stock price now sits top-right (swapped with the 52W high below).
              // The ext-hours chip is lifted out (hideExt) and shown in the body.
              React.createElement(PriceBlock, { quote: q, size: "lg", hideChange: true, hideExt: true, market: w.market })),
            React.createElement("div", { className: "watch-body" },
              // 52W high now sits bottom-left (swapped with the price), with the
              // alert bell directly beside it.
              athBadge,
              React.createElement("button", {
                className: "card-alert-bell",
                "data-no-drag": true,
                onClick: e => { e.stopPropagation(); openAlertPopup(w.ticker, w.market); },
                "aria-label": "Alerts"
              }, React.createElement(Icon, { name: "bell", size: 13 }),
                ac > 0 && React.createElement("span", { className: "card-alert-count" }, ac)),
              // Day's move (% only) anchored to the right of the card.
              hasDay
                ? React.createElement("div", { className: `watch-today ${dayUp ? 'up' : 'down'}` },
                    React.createElement("div", { className: "watch-today-pct mono" },
                      (dayUp ? '+' : '') + q.changePct.toFixed(2) + '%'))
                : React.createElement("div", { className: "watch-today" })),
            // Session badge (Open/Closed/Pre/After) so a quiet card reads as
            // market state, not blank. Shown only when the ext-price chip isn't.
            !hasExt && React.createElement("div", { className: "watch-ext" },
              React.createElement(SessionBadge, { market: w.market, quote: q })),
            // Pre/after-hours readout on its own centered line at the foot of the
            // card so it reads as a secondary detail without crowding the name.
            hasExt && React.createElement("div", { className: "watch-ext ext-hours" },
              React.createElement("span", { className: "ext-label" }, extLabel),
              React.createElement("span", { className: "ext-price mono" }, extSym, fmtNum(q.extPrice)),
              React.createElement("span", { className: `ext-chg mono ${extUp ? 'up' : 'down'}` },
                (extUp ? '+' : '') + q.extChangePct.toFixed(2) + '%' +
                (extChgAbs != null ? ' · ' + (extUp ? '+' : '-') + extSym + fmtNum(Math.abs(extChgAbs)) : '')))));
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
            alertTarget && isFinite(parseDecimal(alertTarget)) ? (popupCcy === 'ZAR' ? 'R' : '$') + fmtNum(parseDecimal(alertTarget)) : 'target')))),

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
    if (innerH < 20 || sr.w < 26) continue;
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
    // clientWidth and contentRect.width are both the inner content box (exclude
    // the border), so the treemap layout matches where absolutely-positioned
    // cells actually live — no off-by-border clipping at the right edge.
    setWidth(el.clientWidth);
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
const SECTOR_ETF = PBContent.SECTOR_ETF;
const SECTOR_TREND_WINDOWS = PBContent.SECTOR_TREND_WINDOWS;
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
  // The in-page treemap has a 1px border (fullscreen/zoom set border:none), so its
  // content box is 2px shorter than the styled box-sizing:border-box height. Lay
  // out cells to the content box so the bottom row isn't clipped by the border.
  const BORDER = fixedWidth ? 0 : 2;
  const layoutH = Math.max(0, height - BORDER);
  const cells = useMemo(() => width > 0 ? layoutTreemap(sectors, width, layoutH) : [], [sectors, width, layoutH]);
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
        // Until the finger clears the threshold, treat it as a tap, not a pan:
        // panning here calls preventDefault + re-pans mid-gesture, which swallows
        // the cell button's click when zoomed in. Only commit once it's a drag.
        if (!movedRef.current && Math.abs(dx) + Math.abs(dy) <= 5) return;
        movedRef.current = true;
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
  let { positions, onOpenDetail, displayCurrency, fxRates } = _ref8b;
  const prices = PBStore.usePricesMap();
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
    const rates = fxRates?.rates || null;
    return positions.filter(p => portfolioFilter === 'all' || p.market === portfolioFilter).map(p => {
      const q = prices[priceKey(p.market, p.ticker)];
      // Size every holding by its market value in the display currency, so US,
      // JSE and TFSA positions are comparable in one treemap (the raw native
      // price would let a rand-quoted position dwarf a dollar one). Falls back
      // to cost basis when no live quote has arrived yet, so the holding still
      // appears — coloured grey, exactly like a market-heatmap constituent whose
      // quote is still streaming in — instead of vanishing from the grid.
      const native = marketCurrency(p.market);
      // Live value is in the market's native currency; the cost-basis fallback is
      // in the currency the holding was booked in (crypto-in-ZAR keeps its rand).
      const value = (q && q.price > 0)
        ? convertCcy(p.shares * q.price, native, displayCurrency, rates)
        : convertCcy(p.shares * p.costBasis, positionCostCcy(p), displayCurrency, rates);
      if (value == null || value <= 0) return null;
      const changePct = q && typeof q.changePct === 'number' && isFinite(q.changePct) ? q.changePct : null;
      let sec = DATA.findSector(p.ticker, p.market);
      if (sec.sector === 'Other') {
        const nm = p.name || resolveTickerName(p.ticker, p.market, q) || '';
        const byName = DATA.classifySectorByName(nm);
        if (byName !== 'Other') sec = { sector: byName, industry: byName };
      }
      return { ticker: p.ticker, market: p.market, sector: sec.sector, industry: sec.industry, value, price: q ? q.price : null, changePct };
    }).filter(Boolean);
  }, [mode, positions, prices, portfolioFilter, displayCurrency, fxRates]);
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
  const aspectRatio = mode === 'market' ? 0.62 : 0.82;
  // Market mode is an at-a-glance overview, so the grid is sized to the space
  // left in the viewport (under the toggles/stats, above the bottom safe-area)
  // rather than a fixed canvas that ran off the bottom of the screen. We measure
  // the grid's own top offset so it adapts to whatever chrome sits above it, then
  // reserve room below for the "tap a sector" hint, page padding and safe-area.
  const treemapWrapRef = useRef(null);
  const [marketFitH, setMarketFitH] = useState(500);
  useLayoutEffect(() => {
    if (mode !== 'market') return;
    const measure = () => {
      const el = treemapWrapRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      // On phones the chrome above (mode + exchange toggles + meta) is taller and
      // the viewport shorter, so the old fixed 400px floor pushed the grid's bottom
      // rows (and the "tap a sector" hint) below the fold. Size the grid to the
      // space actually left under the toggles and above the bottom hint / safe-area,
      // with a much lower floor on narrow screens so the whole map fits the screen
      // instead of overflowing — the desktop look, scaled down for mobile.
      const isNarrow = window.innerWidth <= 680;
      const BOTTOM_RESERVE = isNarrow ? 100 : 110; // sector hint + page padding + safe-area
      const avail = Math.round(window.innerHeight - top - BOTTOM_RESERVE);
      // Clamp keeps tiles a sensible size on very short / very tall screens; the
      // upper bound stops the grid getting "too long" on big displays.
      const floor = isNarrow ? 240 : 400;
      const ceil = isNarrow ? 600 : 580;
      const clamped = Math.max(floor, Math.min(ceil, avail));
      setMarketFitH(prev => Math.abs(prev - clamped) > 2 ? clamped : prev);
    };
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [mode, selectedId, portfolioFilter, loading, !!error, !!progress, activeRows.length, portfolioMarkets.length]);
  // Portfolio: scale the canvas with holding count so sectors (and the bottom
  // rows) always have room to render their tiles instead of being clipped to a
  // header strip.
  const minHeight = mode === 'market'
    ? marketFitH
    : Math.max(480, Math.min(1200, (activeRows.length || 0) * 40 + 140));
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
    activeRows.length > 0 ? React.createElement("div", { ref: treemapWrapRef }, React.createElement(HeatmapTreemap, {
      rows: activeRows,
      height: mode === 'market' ? marketFitH : undefined,
      aspectRatio: aspectRatio,
      minHeight: minHeight,
      onOpenDetail: onOpenDetail,
      onOpenSector: (name) => setSectorDetail(name),
      loading: loading
    })) : (mode === 'portfolio' && !loading ? React.createElement("div", { className: "heatmap-loading" }, positions.length === 0 ? "You don't have any positions yet." : (portfolioRows.length === 0 && portfolioFilter !== 'all' ? "No " + portfolioFilter + " positions with live data." : "Waiting for live quotes…")) : null),
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
// PicksView is defined in pb-views.js (Phase 4 inc 8); bind it here.
const PicksView = PBViews.PicksView;
// HedgesView is defined in pb-views.js (Phase 4 inc 9); bind it here.
const HedgesView = PBViews.HedgesView;
function fmtShares(n) {
  if (n == null || !isFinite(n)) return '';
  if (n >= 100) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
// ─── TFSA limits + South-African tax-year helpers ───────────────────────────
// A TFSA's contribution room is governed by the SA tax year (1 March – end Feb),
// not the calendar year, so "this year's" R46k bar must bucket deposits by tax
// year. Dates are stored as local YYYY-MM-DD strings and parsed by splitting the
// string (never Date→toISOString, which would shift a day for SAST users).
const TFSA_ANNUAL_LIMIT = 46000;
const TFSA_LIFETIME_LIMIT = 500000;
function tfsaTaxYearStart(dateStr) {
  if (!dateStr) return null;
  const parts = String(dateStr).split('-');
  const y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (!isFinite(y) || !isFinite(m)) return null;
  return m < 3 ? y - 1 : y; // Jan/Feb fall in the tax year that began the prior March
}
function currentTfsaTaxYearStart() {
  const d = new Date();
  return (d.getMonth() + 1) < 3 ? d.getFullYear() - 1 : d.getFullYear();
}
function tfsaTaxYearLabel(startYear) {
  return startYear + '/' + String(startYear + 1).slice(2); // e.g. 2026/27
}
function tfsaTodayStr() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function fmtRand(n, dec) {
  const d = dec == null ? 0 : dec;
  return 'R' + Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: d, maximumFractionDigits: d });
}
// Generic collapsible "dropdown" card — a tap-to-expand header over hidden body.
// Used for the contribution planner and the TFSA-information panel.
function Collapsible({ title, subtitle, icon, defaultOpen, badge, children, className }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return React.createElement("div", { className: "card collapse-card mb-4" + (className ? " " + className : "") },
    React.createElement("button", {
      className: "collapse-head", onClick: () => setOpen(o => !o), "aria-expanded": open, type: "button"
    },
      React.createElement("div", { className: "collapse-head-main" },
        icon ? React.createElement(Icon, { name: icon, size: 15 }) : null,
        React.createElement("div", { className: "collapse-head-text" },
          React.createElement("div", { className: "collapse-title" }, title),
          subtitle ? React.createElement("div", { className: "collapse-sub" }, subtitle) : null
        )
      ),
      React.createElement("div", { className: "collapse-head-right" },
        badge != null ? React.createElement("span", { className: "collapse-badge" }, badge) : null,
        React.createElement(Icon, { name: "chevron", size: 16, className: "collapse-chevron" + (open ? " open" : "") })
      )
    ),
    open ? React.createElement("div", { className: "collapse-body" }, children) : null
  );
}
// Annual (R46k) + lifetime (R500k) contribution bars over an editable deposit log.
// The log mixes manual deposits (cash the user reports putting in) with purchase
// entries auto-appended on every in-app TFSA buy; both count toward the limits and
// both can be edited or removed to fix mistakes/double-counts.
function TFSAContributions({ deposits, onAdd, onUpdate, onRemove, onRemoveMany }) {
  const [adding, setAdding] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(() => ({ amount: '', date: tfsaTodayStr(), note: '' }));
  const [editForm, setEditForm] = useState({ amount: '', date: '', note: '' });
  // Multi-select mode for the deposit log: lets the user tick several entries
  // (e.g. "everything from this tax year") and delete them in one go, which
  // recomputes both the annual and lifetime counters.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);

  const list = deposits || [];
  const curStart = currentTfsaTaxYearStart();
  const annualUsed = list.reduce((s, d) => s + (tfsaTaxYearStart(d.date) === curStart ? (d.amount || 0) : 0), 0);
  const lifetimeUsed = list.reduce((s, d) => s + (d.amount || 0), 0);
  const annualPct = annualUsed / TFSA_ANNUAL_LIMIT * 100;
  const lifePct = lifetimeUsed / TFSA_LIFETIME_LIMIT * 100;
  const annualLeft = TFSA_ANNUAL_LIMIT - annualUsed;
  const lifeLeft = TFSA_LIFETIME_LIMIT - lifetimeUsed;
  const yearsLeft = lifeLeft > 0 ? Math.ceil(lifeLeft / TFSA_ANNUAL_LIMIT) : 0;

  const submitAdd = () => {
    const amt = parseFloat(form.amount);
    if (!isFinite(amt) || amt === 0 || !form.date) return;
    onAdd(amt, form.date, form.note);
    setForm({ amount: '', date: tfsaTodayStr(), note: '' });
    setAdding(false);
    setLogOpen(true);
  };
  const startEdit = (d) => {
    setEditId(d.id);
    setEditForm({ amount: String(d.amount), date: d.date, note: d.note || '' });
  };
  const submitEdit = () => {
    const amt = parseFloat(editForm.amount);
    if (!isFinite(amt) || amt === 0 || !editForm.date) return;
    onUpdate(editId, { amount: amt, date: editForm.date, note: editForm.note });
    setEditId(null);
  };

  // ── Multi-select helpers ──
  const sorted = list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const selectedSet = new Set(selectedIds);
  const selectedTotal = list.reduce((s, d) => s + (selectedSet.has(d.id) ? (d.amount || 0) : 0), 0);
  const toggleSel = (id) => setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const selectThisYear = () => setSelectedIds(list.filter(d => tfsaTaxYearStart(d.date) === curStart).map(d => d.id));
  const selectAll = () => setSelectedIds(list.map(d => d.id));
  const clearSel = () => setSelectedIds([]);
  const enterSelect = () => { setSelectMode(true); setLogOpen(true); setAdding(false); setEditId(null); setSelectedIds([]); };
  const exitSelect = () => { setSelectMode(false); setSelectedIds([]); };
  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    const n = selectedIds.length;
    if (window.confirm(`Remove ${n} deposit${n === 1 ? '' : 's'} (${fmtRand(selectedTotal, 2)}) from your tax-year and lifetime totals?`)) {
      if (onRemoveMany) onRemoveMany(selectedIds);
      else selectedIds.forEach(id => onRemove(id));
      exitSelect();
    }
  };

  const bar = (label, yr, used, limit, pct, leftEl) => React.createElement("div", { className: "tfsa-limit" },
    React.createElement("div", { className: "tfsa-limit-top" },
      React.createElement("div", { className: "tfsa-limit-label" },
        React.createElement("span", null, label),
        yr ? React.createElement("span", { className: "tfsa-limit-yr" }, yr) : null),
      React.createElement("div", { className: "tfsa-limit-fig" },
        React.createElement("span", { className: "tfsa-limit-used" }, fmtRand(used)),
        React.createElement("span", { className: "tfsa-limit-of" }, " / ", fmtRand(limit)))),
    React.createElement("div", { className: "tfsa-limit-bar" },
      React.createElement("div", {
        className: "tfsa-limit-fill" + (used > limit ? " over" : (pct >= 90 ? " near" : "")),
        style: { width: Math.min(100, Math.max(used > 0 ? 1.5 : 0, pct)) + "%" }
      })),
    leftEl);

  const addForm = adding ? React.createElement("div", { className: "tfsa-dep-form" },
    React.createElement("div", { className: "tfsa-dep-fields" },
      React.createElement("div", { className: "tfsa-dep-field" },
        React.createElement("label", null, "Amount"),
        React.createElement("div", { className: "tfsa-dep-amt" },
          React.createElement("span", null, "R"),
          React.createElement("input", {
            type: "number", inputMode: "decimal", min: "0", step: "100", autoFocus: true,
            value: form.amount, placeholder: "0",
            onChange: e => setForm(f => ({ ...f, amount: e.target.value })),
            onKeyDown: e => { if (e.key === 'Enter') submitAdd(); }
          }))),
      React.createElement("div", { className: "tfsa-dep-field" },
        React.createElement("label", null, "Date"),
        React.createElement("input", { type: "date", value: form.date, onChange: e => setForm(f => ({ ...f, date: e.target.value })) }))),
    React.createElement("div", { className: "tfsa-dep-field" },
      React.createElement("label", null, "Note (optional)"),
      React.createElement("input", { type: "text", value: form.note, placeholder: "e.g. EFT from Capitec", onChange: e => setForm(f => ({ ...f, note: e.target.value })) })),
    React.createElement("div", { className: "tfsa-dep-form-actions" },
      React.createElement("button", { className: "btn btn-ghost btn-sm", type: "button", onClick: () => { setAdding(false); setForm({ amount: '', date: tfsaTodayStr(), note: '' }); } }, "Cancel"),
      React.createElement("button", { className: "btn btn-primary btn-sm", type: "button", onClick: submitAdd }, "Save deposit"))
  ) : null;

  // Toolbar atop the open log: in normal mode a "Select" entry point; in select
  // mode the running count/total plus quick selectors for this tax year / all.
  const logToolbar = list.length === 0 ? null : React.createElement("div", { className: "tfsa-dep-log-bar" },
    selectMode
      ? React.createElement(React.Fragment, null,
          React.createElement("div", { className: "tfsa-dep-sel-info" },
            React.createElement("span", { className: "tfsa-dep-sel-count" }, selectedIds.length, " selected"),
            selectedIds.length > 0 ? React.createElement("span", { className: "tfsa-dep-sel-sum" }, fmtRand(selectedTotal, 2)) : null),
          React.createElement("div", { className: "tfsa-dep-sel-quick" },
            React.createElement("button", { className: "tfsa-dep-sel-link", type: "button", onClick: selectThisYear }, "This tax year"),
            React.createElement("button", { className: "tfsa-dep-sel-link", type: "button", onClick: selectAll }, "All"),
            selectedIds.length > 0 ? React.createElement("button", { className: "tfsa-dep-sel-link", type: "button", onClick: clearSel }, "Clear") : null))
      : React.createElement(React.Fragment, null,
          React.createElement("span", { className: "tfsa-dep-log-title" }, "Logged deposits"),
          React.createElement("button", { className: "tfsa-dep-sel-link", type: "button", onClick: enterSelect },
            React.createElement(Icon, { name: "check", size: 12 }), " Select")));

  const logBody = logOpen ? React.createElement("div", { className: "tfsa-dep-log" },
    list.length === 0
      ? React.createElement("div", { className: "tfsa-dep-empty" }, "No deposits logged yet.")
      : React.createElement(React.Fragment, null,
        logToolbar,
        sorted.map(d => {
          if (!selectMode && editId === d.id) {
            return React.createElement("div", { className: "tfsa-dep-row editing", key: d.id },
              React.createElement("div", { className: "tfsa-dep-edit-fields" },
                React.createElement("div", { className: "tfsa-dep-amt" },
                  React.createElement("span", null, "R"),
                  React.createElement("input", { type: "number", inputMode: "decimal", step: "100", value: editForm.amount, onChange: e => setEditForm(f => ({ ...f, amount: e.target.value })) })),
                React.createElement("input", { type: "date", value: editForm.date, onChange: e => setEditForm(f => ({ ...f, date: e.target.value })) })),
              React.createElement("input", { className: "tfsa-dep-edit-note", type: "text", value: editForm.note, placeholder: "Note", onChange: e => setEditForm(f => ({ ...f, note: e.target.value })) }),
              React.createElement("div", { className: "tfsa-dep-form-actions" },
                React.createElement("button", { className: "btn btn-ghost btn-sm", type: "button", onClick: () => setEditId(null) }, "Cancel"),
                React.createElement("button", { className: "btn btn-primary btn-sm", type: "button", onClick: submitEdit }, "Save")));
          }
          const inYear = tfsaTaxYearStart(d.date) === curStart;
          const checked = selectedSet.has(d.id);
          const main = React.createElement("div", { className: "tfsa-dep-main" },
            React.createElement("div", { className: "tfsa-dep-line1" },
              React.createElement("span", { className: "tfsa-dep-amount" }, "+", fmtRand(d.amount, 2)),
              React.createElement("span", { className: "tfsa-dep-tag " + (d.source === 'purchase' ? "buy" : "manual") }, d.source === 'purchase' ? "Buy" : "Deposit"),
              inYear ? null : React.createElement("span", { className: "tfsa-dep-tag past" }, tfsaTaxYearLabel(tfsaTaxYearStart(d.date)))),
            React.createElement("div", { className: "tfsa-dep-line2" },
              React.createElement("span", null, d.date ? new Date(d.date + 'T00:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : ''),
              d.note ? React.createElement("span", { className: "tfsa-dep-note" }, " · ", d.note) : null));
          if (selectMode) {
            return React.createElement("div", {
              className: "tfsa-dep-row selectable" + (checked ? " selected" : ""), key: d.id,
              role: "button", "aria-pressed": checked, onClick: () => toggleSel(d.id)
            },
              React.createElement("span", { className: "tfsa-dep-check" + (checked ? " on" : "") },
                checked ? React.createElement(Icon, { name: "check", size: 13 }) : null),
              main);
          }
          return React.createElement("div", { className: "tfsa-dep-row", key: d.id },
            main,
            React.createElement("div", { className: "tfsa-dep-row-actions" },
              React.createElement("button", { className: "icon-btn", type: "button", "aria-label": "Edit", onClick: () => startEdit(d) }, React.createElement(Icon, { name: "edit", size: 13 })),
              React.createElement("button", { className: "icon-btn", type: "button", "aria-label": "Remove", onClick: () => { if (window.confirm('Remove this deposit from your contribution total?')) onRemove(d.id); } }, React.createElement(Icon, { name: "trash", size: 13 }))));
        }),
        selectMode ? React.createElement("div", { className: "tfsa-dep-sel-actions" },
          React.createElement("button", { className: "btn btn-ghost btn-sm", type: "button", onClick: exitSelect }, "Cancel"),
          React.createElement("button", { className: "btn btn-danger btn-sm", type: "button", disabled: selectedIds.length === 0, onClick: deleteSelected },
            React.createElement(Icon, { name: "trash", size: 13 }), " Delete", selectedIds.length ? " (" + selectedIds.length + ")" : "")) : null)
  ) : null;

  return React.createElement("div", { className: "tfsa-room-inner" },
    bar("This tax year", tfsaTaxYearLabel(curStart), annualUsed, TFSA_ANNUAL_LIMIT, annualPct,
      React.createElement("div", { className: "tfsa-limit-sub" + (annualLeft < 0 ? " warn" : "") },
        annualLeft >= 0 ? fmtRand(annualLeft) + " left this tax year" : fmtRand(-annualLeft) + " over the annual limit (40% penalty applies)")),
    bar("Lifetime", null, lifetimeUsed, TFSA_LIFETIME_LIMIT, lifePct,
      React.createElement("div", { className: "tfsa-limit-sub" + (lifeLeft <= 0 ? " ok" : "") },
        lifeLeft > 0
          ? fmtRand(lifeLeft) + " left · ≈ " + yearsLeft + (yearsLeft === 1 ? " year" : " years") + " at the max to fill it"
          : "Lifetime limit reached")),
    React.createElement("div", { className: "tfsa-room-actions" },
      React.createElement("button", { className: "btn btn-primary btn-sm", type: "button", onClick: () => { setAdding(a => !a); setEditId(null); } },
        React.createElement(Icon, { name: "plus", size: 13 }), " Log deposit"),
      React.createElement("button", { className: "btn btn-secondary btn-sm", type: "button", onClick: () => setLogOpen(o => !o) },
        React.createElement(Icon, { name: "list", size: 13 }), " Deposit log (", list.length, ")")),
    addForm,
    logBody,
    React.createElement("div", { className: "tfsa-room-hint" },
      "Buys you make in the app are added here automatically. Log a deposit only for cash added before or outside the app.")
  );
}
// TFSA contribution planner / portfolio balancer.
// The user defines a target structure (a % per holding); each month they enter
// how much they'll contribute and the planner says exactly how many rand (and
// ≈shares) to put into each holding to steer the portfolio toward that structure
// — using only the new contribution, never selling. The split fills the most
// underweight holdings first; any surplus beyond what's needed to reach target
// is spread across holdings by target weight so the structure keeps holding.
function TFSABalancer({ positions, onBuyPosition }) {
  const prices = PBStore.usePricesMap();
  const [targets, setTargets] = usePersistedState('pb.tfsa.targets.v1', {});
  const [contribution, setContribution] = usePersistedState('pb.tfsa.contribution.v1', '');
  const [editing, setEditing] = useState(false);

  const rows = positions.map(p => {
    const q = prices['TFSA:' + p.ticker];
    const price = q && q.price > 0 ? q.price : p.costBasis;
    return { id: p.id, ticker: p.ticker, name: p.name, shares: p.shares, price, value: p.shares * price, pos: p };
  });
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const targetSum = rows.reduce((s, r) => s + (parseFloat(targets[r.ticker]) || 0), 0);
  const hasTargets = targetSum > 0;
  const showEditor = editing || !hasTargets;

  // Keep the editor open through edits — once targets exist it would otherwise
  // collapse mid-typing (showEditor depends on hasTargets). It only closes on Done.
  const setTarget = (tk, v) => { setEditing(true); setTargets(prev => ({ ...prev, [tk]: v })); };
  const useCurrentWeights = () => {
    if (totalValue <= 0) return;
    const next = {}; rows.forEach(r => { next[r.ticker] = (r.value / totalValue * 100).toFixed(1); });
    setEditing(true); setTargets(next);
  };
  const useEqualWeight = () => {
    const each = (100 / (rows.length || 1)).toFixed(1);
    const next = {}; rows.forEach(r => { next[r.ticker] = each; });
    setEditing(true); setTargets(next);
  };

  // ── Allocate the contribution: fill underweight holdings first, spread any
  //    surplus by target weight. Pure new-cash rebalancing (no sells). ──
  const C = Math.max(0, parseFloat(contribution) || 0);
  const newTotal = totalValue + C;
  const plan = rows.map(r => {
    const w = hasTargets ? (parseFloat(targets[r.ticker]) || 0) / targetSum : 0;
    const desired = w * newTotal;
    return { ...r, w, targetPct: w * 100, curPct: totalValue > 0 ? r.value / totalValue * 100 : 0, desired, gap: Math.max(0, desired - r.value) };
  });
  const totalGap = plan.reduce((s, r) => s + r.gap, 0);
  const allocMap = {};
  if (C > 0 && hasTargets) {
    if (totalGap >= C && totalGap > 0) plan.forEach(r => { allocMap[r.ticker] = C * (r.gap / totalGap); });
    else { const leftover = C - totalGap; plan.forEach(r => { allocMap[r.ticker] = r.gap + r.w * leftover; }); }
  }
  plan.forEach(r => {
    r.alloc = allocMap[r.ticker] || 0;
    r.afterValue = r.value + r.alloc;
    r.afterPct = newTotal > 0 ? r.afterValue / newTotal * 100 : 0;
    r.sharesBuy = r.price > 0 ? r.alloc / r.price : null;
  });
  const scaleMax = Math.max(1, ...plan.map(r => Math.max(r.targetPct, r.afterPct, r.curPct)));
  const planSorted = plan.slice().sort((a, b) => b.alloc - a.alloc || b.targetPct - a.targetPct);
  const totalAlloc = plan.reduce((s, r) => s + r.alloc, 0);

  // The Collapsible wrapper supplies the "Contribution planner" title, so the
  // balancer only needs an inline Edit/Done toggle for the target weights.
  const header = hasTargets ? React.createElement("div", { className: "tfsa-bal-toolbar" },
    React.createElement("div", { className: "tfsa-bal-toolbar-label" }, "Target weights"),
    React.createElement("button", { className: "btn btn-secondary btn-sm", type: "button", onClick: () => setEditing(e => !e) },
      React.createElement(Icon, { name: editing ? "check" : "edit", size: 13 }), " ", editing ? "Done" : "Edit")
  ) : null;

  const sumClass = Math.abs(targetSum - 100) < 0.1 ? 'ok' : 'warn';
  const editor = showEditor ? React.createElement("div", { className: "tfsa-target-editor" },
    React.createElement("div", { className: "tfsa-target-list" },
      rows.map(r => React.createElement("div", { className: "tfsa-target-row", key: r.id },
        React.createElement("div", { className: "tfsa-target-id" },
          React.createElement("span", { className: "tkr" }, r.ticker),
          r.name ? React.createElement("span", { className: "tfsa-target-name text-dim" }, prettyName(r.name)) : null
        ),
        React.createElement("div", { className: "tfsa-target-input" },
          React.createElement("input", {
            type: "number", inputMode: "decimal", min: "0", max: "100", step: "0.5",
            value: targets[r.ticker] != null ? targets[r.ticker] : '',
            placeholder: "0",
            onChange: e => setTarget(r.ticker, e.target.value)
          }),
          React.createElement("span", { className: "tfsa-target-pct" }, "%")
        )
      ))
    ),
    React.createElement("div", { className: "tfsa-bal-quick" },
      React.createElement("button", { className: "tfsa-preset-btn", type: "button", onClick: useCurrentWeights },
        React.createElement(Icon, { name: "activity", size: 13 }), " Use current %"),
      React.createElement("button", { className: "tfsa-preset-btn", type: "button", onClick: useEqualWeight },
        React.createElement(Icon, { name: "gauge", size: 13 }), " Equal weight"),
      React.createElement("span", { className: `tfsa-sum ${sumClass}` }, "Total ", targetSum.toFixed(1), "%")
    ),
    targetSum > 0 && Math.abs(targetSum - 100) >= 0.1 ? React.createElement("div", { className: "tfsa-bal-note" },
      "Targets total ", targetSum.toFixed(1), "% — used as relative weights. Set them to 100% for clarity.") : null
  ) : null;

  const contribInput = React.createElement("div", { className: "tfsa-contrib" },
    React.createElement("label", { className: "tfsa-contrib-label" }, "This month's contribution"),
    React.createElement("div", { className: "tfsa-contrib-field" },
      React.createElement("span", { className: "tfsa-contrib-sym" }, "R"),
      React.createElement("input", {
        type: "number", inputMode: "decimal", min: "0", step: "100",
        value: contribution, placeholder: "0",
        onChange: e => setContribution(e.target.value)
      })
    )
  );

  let planBody;
  if (!hasTargets) {
    planBody = React.createElement("div", { className: "tfsa-bal-empty" }, "Set a target % for your holdings above to get a monthly plan.");
  } else {
    planBody = React.createElement(React.Fragment, null,
      C > 0 ? React.createElement("div", { className: "tfsa-plan-head" },
        React.createElement("span", null, "Buy this month"),
        React.createElement("span", { className: "mono" }, fmt(totalAlloc, 'TFSA'))
      ) : React.createElement("div", { className: "tfsa-bal-empty" }, "Enter a contribution to see exactly what to buy — current vs target is shown below."),
      React.createElement("div", { className: "tfsa-plan-list" },
        planSorted.map(r => {
          const buying = r.alloc > 0.005;
          const over = !buying && r.curPct > r.targetPct + 0.1;
          const curW = Math.max(0, Math.min(100, r.curPct / scaleMax * 100));
          const addW = Math.max(0, Math.min(100 - curW, (r.afterPct - r.curPct) / scaleMax * 100));
          const tgtW = Math.max(0, Math.min(100, r.targetPct / scaleMax * 100));
          return React.createElement("div", { className: "tfsa-plan-row", key: r.id },
            React.createElement("div", { className: "tfsa-plan-top" },
              React.createElement("div", { className: "tfsa-plan-id" },
                React.createElement("span", { className: "tkr" }, r.ticker),
                r.name ? React.createElement("span", { className: "tfsa-plan-name text-dim" }, prettyName(r.name)) : null
              ),
              buying
                ? React.createElement("div", { className: "tfsa-plan-action" },
                    React.createElement("span", { className: "tfsa-buy-amt" }, fmt(r.alloc, 'TFSA')),
                    r.sharesBuy != null ? React.createElement("span", { className: "tfsa-buy-sh" }, "≈ ", fmtShares(r.sharesBuy), " sh") : null
                  )
                : React.createElement("span", { className: `tfsa-plan-tag ${over ? 'over' : 'ok'}` }, over ? "Overweight" : "On target")
            ),
            React.createElement("div", { className: "tfsa-plan-bar" },
              React.createElement("div", { className: "tfsa-plan-fill", style: { width: curW + '%' } }),
              addW > 0 ? React.createElement("div", { className: "tfsa-plan-add", style: { left: curW + '%', width: addW + '%' } }) : null,
              React.createElement("div", { className: "tfsa-plan-target", style: { left: tgtW + '%' } })
            ),
            React.createElement("div", { className: "tfsa-plan-meta" },
              React.createElement("span", null, "Target ", r.targetPct.toFixed(1), "% · now ", r.curPct.toFixed(1), "%",
                C > 0 ? React.createElement(React.Fragment, null, " → ",
                  React.createElement("span", { className: buying ? "text-up" : "" }, r.afterPct.toFixed(1), "%")) : null),
              onBuyPosition && buying ? React.createElement("button", { className: "tfsa-plan-buy", onClick: () => onBuyPosition(r.pos) }, "Buy") : null
            )
          );
        })
      )
    );
  }

  return React.createElement("div", { className: "tfsa-bal-inner" }, header, editor, contribInput, planBody);
}
function TFSAView({ positions, onOpenDetail, onAddPosition, onEditPosition, onBuyPosition, onSellPosition,
                   tfsaDeposits, onAddTfsaDeposit, onUpdateTfsaDeposit, onRemoveTfsaDeposit, onRemoveTfsaDeposits,
                   fxRates, sectorCache, fundamentals, sectorWeights, onSetSectorWeights }) {
  const prices = PBStore.usePricesMap();
  const valueHidden = PBStore.useSetting('valueHidden');
  const totalValue = positions.reduce((s, p) => {
    const q = prices['TFSA:' + p.ticker];
    return s + (q ? p.shares * q.price : p.shares * p.costBasis);
  }, 0);
  const totalCost = positions.reduce((s, p) => s + p.shares * p.costBasis, 0);
  const pnl = totalValue - totalCost;
  const pnlPct = totalCost > 0 ? pnl / totalCost * 100 : 0;
  const hasPositions = positions.length > 0;
  const deposits = tfsaDeposits || [];
  const curStart = currentTfsaTaxYearStart();
  const annualUsed = deposits.reduce((s, d) => s + (tfsaTaxYearStart(d.date) === curStart ? (d.amount || 0) : 0), 0);
  // Holdings listed largest position first (mirrors the Holdings tab's default
  // value sort), falling back to cost when there's no live quote yet.
  const tfsaHoldingValue = (p) => {
    const q = prices['TFSA:' + p.ticker];
    return q ? p.shares * q.price : p.shares * p.costBasis;
  };
  const sortedPositions = [...positions].sort((a, b) => tfsaHoldingValue(b) - tfsaHoldingValue(a));

  // ── 1. TFSA holdings — graph + account value/cost/P/L, first in the tab ──
  const holdingsCard = hasPositions ? React.createElement("div", { className: "card mb-4" },
    React.createElement("div", { className: "eyebrow", style: { marginBottom: 12 } }, "TFSA holdings"),
    React.createElement(PortfolioPieChart, {
      positions, displayCurrency: 'ZAR', fxRates,
      onOpenDetail, sectorCache, fundamentals, sectorWeights, onSetSectorWeights, availableModes: ['ticker', 'sector']
    }),
    React.createElement("div", { className: "kv-row tfsa-holdings-stats" },
      React.createElement("div", { className: "kv" },
        React.createElement("div", { className: "kv-label" }, "Value"),
        React.createElement("div", { className: "kv-val mono" + (valueHidden ? " val-blur" : "") }, fmtRand(totalValue, 2))),
      React.createElement("div", { className: "kv" },
        React.createElement("div", { className: "kv-label" }, "Cost"),
        React.createElement("div", { className: "kv-val mono" + (valueHidden ? " val-blur" : "") }, fmtRand(totalCost, 2))),
      React.createElement("div", { className: "kv" },
        React.createElement("div", { className: "kv-label" }, "P/L"),
        // Currency amount stays the prominent figure; the % rides below it as a
        // smaller tinted pill, mirroring the dashboard's green return boxes.
        React.createElement("div", { className: "tfsa-pnl-val" },
          React.createElement("span", { className: `kv-val mono ${pnl >= 0 ? 'text-up' : 'text-down'}` + (valueHidden ? " val-blur" : "") },
            (pnl >= 0 ? '+' : '−') + fmtRand(pnl, 2)),
          React.createElement("span", { className: `tfsa-pnl-pct ${pnlPct >= 0 ? 'up' : 'down'}` },
            (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + "%"))))
  ) : null;

  // ── TFSA information — collapsible, the rules only (value/cost/P/L now live in
  //    the holdings card) ──
  const infoPanel = React.createElement(Collapsible, {
    title: "TFSA information", subtitle: "How the tax-free account works", icon: "list"
  },
    React.createElement("ul", { className: "bullet-list" },
      React.createElement("li", null, React.createElement("span", null, fmtRand(TFSA_ANNUAL_LIMIT), " annual contribution limit (per tax year, 1 Mar – end Feb)")),
      React.createElement("li", null, React.createElement("span", null, fmtRand(TFSA_LIFETIME_LIMIT), " lifetime contribution limit")),
      React.createElement("li", null, React.createElement("span", null, "All gains, dividends, and interest are ", React.createElement("strong", null, "tax-free"))),
      React.createElement("li", null, React.createElement("span", null, "Only JSE-listed equities, ETFs, and unit trusts are eligible")),
      React.createElement("li", null, React.createElement("span", null, "Withdrawals reduce available contribution room permanently")),
      React.createElement("li", null, React.createElement("span", null, "40% penalty on contributions exceeding the annual limit")))
  );

  return React.createElement("div", null,
    holdingsCard,
    // ── 2. Holdings list — collapsed into a dropdown so the tab stays compact ──
    !hasPositions
      ? React.createElement(React.Fragment, null,
          React.createElement("div", { className: "flex justify-between items-center mb-3" },
            React.createElement("div", { className: "eyebrow", style: { marginBottom: 0 } }, "Your holdings"),
            React.createElement("button", { className: "btn btn-primary btn-xs", onClick: onAddPosition },
              React.createElement(Icon, { name: "plus", size: 12 }), " Add")),
          React.createElement("div", { className: "empty empty-tfsa mb-4" },
            React.createElement(Icon, { name: "briefcase", size: 40 }),
            React.createElement("h3", null, "No TFSA holdings"),
            React.createElement("p", null, "Add JSE-listed ETFs and equities for your Tax-Free Savings Account (or use Import on the Holdings tab).")))
      : React.createElement(Collapsible, {
          title: "Your holdings", icon: "briefcase", defaultOpen: true, badge: positions.length
        },
          React.createElement("div", { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 10 } },
            React.createElement("button", { className: "btn btn-primary btn-xs", onClick: onAddPosition },
              React.createElement(Icon, { name: "plus", size: 12 }), " Add holding")),
          React.createElement(HoldingsListHead, null),
          React.createElement("div", { className: "row-list" },
          sortedPositions.map(p => React.createElement(HoldingRow, {
            key: p.id,
            position: p,
            market: 'TFSA',
            quote: prices['TFSA:' + p.ticker],
            onOpenDetail: onOpenDetail,
            onBuyPosition: onBuyPosition,
            onSellPosition: onSellPosition,
            onEditPosition: onEditPosition
          })))),
    // ── 3. Contribution planner — collapsible dropdown ──
    hasPositions ? React.createElement("div", { style: { marginTop: 16 } },
      React.createElement(Collapsible, {
        title: "Contribution planner", subtitle: "What to buy each month to hold your structure", icon: "gauge"
      }, React.createElement(TFSABalancer, { positions: positions, onBuyPosition: onBuyPosition }))
    ) : null,
    // ── 4. Contribution room — annual + lifetime bars + deposit log, now a
    //    collapsible dropdown sitting under the planner ──
    React.createElement(Collapsible, {
      title: "Contribution room", icon: "activity",
      subtitle: fmtRand(annualUsed) + " of " + fmtRand(TFSA_ANNUAL_LIMIT) + " used this tax year"
    }, React.createElement(TFSAContributions, {
      deposits: deposits,
      onAdd: onAddTfsaDeposit, onUpdate: onUpdateTfsaDeposit, onRemove: onRemoveTfsaDeposit,
      onRemoveMany: onRemoveTfsaDeposits
    })),
    // ── 5. TFSA information — collapsible at the bottom ──
    infoPanel
  );
}
// HotTopicsView is defined in pb-views.js (Phase 4 inc 7 spike); bind it here.
const HotTopicsView = PBViews.HotTopicsView;
function ruleSection(section, cardClass) {
  return [React.createElement("div", {
    key: section.id + '-eyebrow',
    className: "eyebrow"
  }, section.heading), React.createElement("div", {
    key: section.id + '-card',
    className: cardClass
  }, React.createElement("ul", {
    className: "bullet-list"
  }, section.bullets.map((b, i) => React.createElement("li", {
    key: i
  }, React.createElement("span", null, b.strong ? React.createElement("strong", null, b.strong) : null, b.text)))))];
}
function RulesView() {
  const byId = id => RULES.find(s => s.id === id);
  return React.createElement("div", null, ...ruleSection(byId('trim'), "card mb-4"), ...ruleSection(byId('thesisBreak'), "card mb-4"), React.createElement("div", {
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
  }, r.impact)))), ...ruleSection(byId('saTax'), "card"));
}
function OverviewView(_ref1) {
  const prices = PBStore.usePricesMap();
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
  }, THESIS_SNAPSHOT.map(t => {
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
      quote: q,
      market: 'US'
    }));
  }))));
}
function PriceChart(_refChart) {
  let { history, loading, range, onRangeChange, currency, quote, indicator, rangeKeys, onRetry } = _refChart;
  const [hover, setHover] = useState(null);
  const [sel, setSel] = useState(null);
  const svgRef = useRef(null);
  const geomRef = useRef({ len: 0, W: 600, PL: 2, PR: 2, chartW: 596 });
  const sym = ({ ZAR: 'R', GBP: '\u00a3', AUD: 'A$', EUR: '\u20ac' })[currency] || '$';
  // Axis/scrub value formatter: indicators print in their own unit (e.g.
  // "4.45%", "$18.05T", "20"); ordinary prices keep the currency symbol.
  const vfmt = indicator ? (v => fmtIndicator(indicator, v)) : (v => sym + v.toFixed(2));
  const allRanges = [
    { key: '1d', label: '1D' },
    { key: '5d', label: '1W' },
    { key: '1mo', label: '1M' },
    { key: '3mo', label: '3M' },
    { key: '6mo', label: '6M' },
    { key: 'ytd', label: 'YTD' },
    { key: '1y', label: '1Y' },
    { key: '5y', label: '5Y' },
    { key: 'max', label: 'Max' }
  ];
  // Indicators with sparse (monthly/weekly) data restrict the range bar to the
  // windows that actually have enough points to chart.
  const ranges = (rangeKeys && rangeKeys.length)
    ? allRanges.filter(r => rangeKeys.includes(r.key))
    : allRanges;
  const rangeBar = React.createElement("div", { className: "chart-ranges" },
    ranges.map(r => React.createElement("button", {
      key: r.key,
      className: `chart-range-btn ${range === r.key ? 'active' : ''}`,
      onClick: () => onRangeChange(r.key)
    }, r.label))
  );
  const rawPoints = history && history.data && history.data.points ? history.data.points : null;
  const ready = !!(rawPoints && rawPoints.length >= 2);
  // Touch interaction (iOS-Stocks style): one finger scrubs a single point; two
  // fingers select a range and read out the % move + time span between them.
  // Native non-passive listeners let us preventDefault so the gesture stays
  // smooth and never scrolls the sheet; rAF-coalesced so rapid moves don't thrash.
  useEffect(() => {
    if (!ready) return;
    const el = svgRef.current;
    if (!el) return;
    let raf = 0, pendingV = null;
    const flush = () => {
      raf = 0;
      const p = pendingV; pendingV = null;
      if (!p) return;
      if (p.k === 'sel') { setSel({ a: p.a, b: p.b }); setHover(null); }
      else if (p.k === 'hover') { setHover({ idx: p.idx }); setSel(null); }
      else { setHover(null); setSel(null); }
    };
    const schedule = v => { pendingV = v; if (!raf) raf = requestAnimationFrame(flush); };
    const idxFromX = clientX => {
      const g = geomRef.current;
      const rect = el.getBoundingClientRect();
      if (!rect.width || g.len < 2) return 0;
      const x = (clientX - rect.left) / rect.width * g.W;
      const cx = Math.max(g.PL, Math.min(g.W - g.PR, x));
      const idx = Math.round((cx - g.PL) / g.chartW * (g.len - 1));
      return Math.max(0, Math.min(g.len - 1, idx));
    };
    const read = e => {
      const t = e.touches;
      if (!t || t.length === 0) { schedule({ k: 'clear' }); return; }
      if (t.length >= 2) schedule({ k: 'sel', a: idxFromX(t[0].clientX), b: idxFromX(t[1].clientX) });
      else schedule({ k: 'hover', idx: idxFromX(t[0].clientX) });
    };
    const onStart = e => { read(e); e.preventDefault(); };
    const onMoveT = e => { read(e); e.preventDefault(); };
    const onEnd = e => { read(e); };
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMoveT, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMoveT);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [ready]);
  // Clear any active scrub/selection when the range changes so stale indices
  // never point past the freshly-loaded series.
  useEffect(() => { setHover(null); setSel(null); }, [range]);
  if (!ready) {
    const dataMissing = history && history.data === null && !loading;
    if (dataMissing) {
      // Both fetch sweeps came back empty (a flaky-proxy moment). Offer a one-tap
      // retry so the user isn't stuck toggling ranges to force a refetch.
      return React.createElement("div", { className: "chart-block" }, rangeBar,
        React.createElement("div", { className: "chart-empty chart-empty-fail" },
          React.createElement("span", null, 'Chart data unavailable'),
          onRetry ? React.createElement("button", {
            className: "chart-retry-btn", onClick: onRetry
          }, "Retry") : null));
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
    // During extended hours the live tick is the pre/post price, not the regular
    // close — append THAT (tagged with its session) so the line ends where the
    // after-hours / pre-market readout sits instead of snapping back down to the
    // regular close and drawing a phantom drop at the end.
    const liveP = (quote.extPrice != null && quote.extKind) ? quote.extPrice : quote.price;
    const liveSession = quote.extKind === 'post' ? 'post'
      : quote.extKind === 'pre' ? 'pre'
      : (rawPoints[rawPoints.length - 1].session || 'regular');
    const lastP = rawPoints[rawPoints.length - 1].p;
    if (Math.abs(lastP - liveP) / liveP > 0.0005) {
      points = [...rawPoints, { t: Date.now(), p: liveP, session: liveSession }];
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
  // Latest geometry for the native touch handlers (they read this ref so the
  // listeners can stay attached across range/data changes).
  geomRef.current = { len: points.length, W, PL, PR, chartW };
  // What a single-point scrub measures its % move "from": the prev-close baseline
  // on the intraday chart (so it matches the header), else the first point shown.
  const refP = (is1d && baseline != null) ? baseline : first;
  const refLabel = (is1d && baseline != null) ? 'from prev close' : 'from start';
  // Desktop: hovering scrubs a single point (no press needed). Touch (1- and
  // 2-finger) is handled by the native listeners set up above.
  const onMouseMove = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * W;
    if (x < PL || x > W - PR) { setHover(null); return; }
    const idx = Math.max(0, Math.min(points.length - 1, Math.round((x - PL) / chartW * (points.length - 1))));
    setSel(null);
    setHover({ idx });
  };
  const label = ranges.find(r => r.key === range)?.label || range;
  // Single-point scrub geometry.
  const hoverIdx = hover ? Math.max(0, Math.min(points.length - 1, hover.idx)) : null;
  const hoverP = hoverIdx != null ? points[hoverIdx].p : 0;
  const hoverX = hoverIdx != null ? xFor(hoverIdx) : 0;
  const hoverY = hoverIdx != null ? yFor(hoverP) : 0;
  const hoverChg = (hoverIdx != null && refP > 0) ? (hoverP - refP) / refP * 100 : 0;
  // Two-finger range selection: % move and elapsed time between the two held
  // points. Only active once they resolve to distinct points.
  let selData = null;
  if (sel) {
    const len = points.length;
    const a = Math.max(0, Math.min(len - 1, sel.a));
    const b = Math.max(0, Math.min(len - 1, sel.b));
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (hi > lo) {
      const pLo = points[lo].p, pHi = points[hi].p;
      const pct = pLo > 0 ? (pHi - pLo) / pLo * 100 : 0;
      selData = {
        pct, up: pct >= 0,
        xLo: xFor(lo), xHi: xFor(hi), yLo: yFor(pLo), yHi: yFor(pHi),
        tLo: points[lo].t, tHi: points[hi].t
      };
    }
  }
  const selColor = selData && selData.up ? '#10b981' : '#f43f5e';
  const fmtSpan = (t0, t1) => {
    const d0 = new Date(t0), d1 = new Date(t1);
    const ms = Math.max(0, t1 - t0);
    let dur;
    if (is1d) {
      const mins = Math.max(1, Math.round(ms / 60000));
      const h = Math.floor(mins / 60);
      dur = h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
      const opt = { hour: 'numeric', minute: '2-digit', hour12: true };
      return d0.toLocaleTimeString(undefined, opt) + ' – ' + d1.toLocaleTimeString(undefined, opt) + ' · ' + dur;
    }
    const days = Math.round(ms / 86400000);
    if (days <= 1) dur = '1 day';
    else if (days < 45) dur = days + ' days';
    else { const months = Math.round(days / 30.44); dur = months < 24 ? months + ' mo' : (days / 365).toFixed(1) + ' yr'; }
    const opt = { month: 'short', day: 'numeric' };
    return d0.toLocaleDateString(undefined, opt) + ' – ' + d1.toLocaleDateString(undefined, opt) + ' · ' + dur;
  };
  return React.createElement("div", { className: "chart-block" },
    rangeBar,
    React.createElement("div", { className: "chart-wrap" },
      React.createElement("svg", {
        ref: svgRef,
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: "none",
        className: "chart-svg",
        onMouseMove: onMouseMove,
        onMouseLeave: () => setHover(null)
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
        selData && React.createElement("g", null,
          React.createElement("rect", { x: selData.xLo, y: PT, width: Math.max(0, selData.xHi - selData.xLo), height: chartH, fill: selColor, fillOpacity: 0.12 }),
          React.createElement("line", { x1: selData.xLo, y1: PT, x2: selData.xLo, y2: H - PB, stroke: "#cbd5e1", strokeWidth: 0.6, strokeDasharray: "2,2", strokeOpacity: 0.9, vectorEffect: "non-scaling-stroke" }),
          React.createElement("line", { x1: selData.xHi, y1: PT, x2: selData.xHi, y2: H - PB, stroke: "#cbd5e1", strokeWidth: 0.6, strokeDasharray: "2,2", strokeOpacity: 0.9, vectorEffect: "non-scaling-stroke" }),
          React.createElement("circle", { cx: selData.xLo, cy: selData.yLo, r: 3.6, fill: selColor, style: { stroke: 'var(--bg)' }, strokeWidth: 1.2 }),
          React.createElement("circle", { cx: selData.xHi, cy: selData.yHi, r: 3.6, fill: selColor, style: { stroke: 'var(--bg)' }, strokeWidth: 1.2 })
        ),
        !selData && hoverIdx != null && React.createElement("g", null,
          React.createElement("line", { x1: hoverX, y1: PT, x2: hoverX, y2: H - PB, stroke: "#a1a1aa", strokeWidth: 1, strokeDasharray: "3,2", strokeOpacity: 0.9, vectorEffect: "non-scaling-stroke" }),
          React.createElement("circle", { cx: hoverX, cy: hoverY, r: 5, fill: color, fillOpacity: 0.18, style: { stroke: 'none' } }),
          React.createElement("circle", { cx: hoverX, cy: hoverY, r: 3.5, fill: color, style: { stroke: 'var(--bg)' }, strokeWidth: 1.2 })
        )
      ),
      !selData && hoverIdx != null && React.createElement("div", {
        className: "chart-tooltip",
        // Anchor the readout at the scrub point, but slide it dynamically so it
        // never spills past the chart edges: translateX goes 0% → -100% as the
        // point moves left → right (−50% / centred in the middle). This keeps the
        // whole price/date box on-screen no matter where you touch. Vertically we
        // flip it to the opposite half from the dot (drop to the bottom when the
        // point sits high, sit at the top when it's low) so it never covers the
        // very point it's describing.
        style: (() => {
          const fx = hoverX / W;
          const dropToBottom = hoverY < H / 2;
          return {
            left: `${fx * 100}%`, transform: `translateX(${-fx * 100}%)`,
            ...(dropToBottom ? { top: 'auto', bottom: 0 } : { top: 0, bottom: 'auto' })
          };
        })()
      },
        React.createElement("div", { className: "mono" }, vfmt(hoverP)),
        React.createElement("div", { className: "chart-tooltip-date" }, (() => {
          const d = new Date(points[hoverIdx].t);
          if (range === '1d') {
            return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
          }
          if (range === '5d') {
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' +
              d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
          }
          return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        })()),
        React.createElement("div", { className: `chart-tooltip-chg mono ${hoverChg >= 0 ? 'text-up' : 'text-down'}` },
          (hoverChg >= 0 ? '+' : '') + hoverChg.toFixed(2) + '% ',
          React.createElement("span", { className: "chart-tooltip-ref" }, refLabel))
      ),
      selData && React.createElement("div", {
        className: "chart-tooltip chart-sel-readout",
        style: (() => {
          const fx = (selData.xLo + selData.xHi) / 2 / W;
          // Flip below the points when either marker sits in the top half.
          const dropToBottom = Math.min(selData.yLo, selData.yHi) < H / 2;
          return {
            left: `${fx * 100}%`, transform: `translateX(${-fx * 100}%)`,
            ...(dropToBottom ? { top: 'auto', bottom: 0 } : { top: 0, bottom: 'auto' })
          };
        })()
      },
        React.createElement("div", { className: `chart-sel-pct mono ${selData.up ? 'text-up' : 'text-down'}` },
          (selData.up ? '+' : '') + selData.pct.toFixed(2) + '%'),
        React.createElement("div", { className: "chart-tooltip-date" }, fmtSpan(selData.tLo, selData.tHi))
      ),
      // The market-open divider tag yields to the scrub/compare readout: while a
      // finger is down (single-point hover or two-finger selection) the price/date
      // popup is what the user is reading, so the "OPEN" label is suppressed rather
      // than left to paint over the top of it.
      hasPre && hoverIdx == null && !selData && React.createElement("div", {
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
    React.createElement("div", { className: "chart-hint" },
      "Drag to scrub · hold two fingers to compare two points"),
    React.createElement("div", { className: "chart-summary" },
      React.createElement("div", null,
        React.createElement("span", { className: "chart-sum-label" }, label + ' return'),
        React.createElement("span", { className: `chart-sum-val mono ${up ? 'text-up' : 'text-down'}` },
          (up ? '+' : '') + retPct.toFixed(2) + '%'
        )
      ),
      React.createElement("div", { className: "chart-range-stats" },
        baseline != null ? React.createElement(React.Fragment, null,
          React.createElement("span", { className: "chart-sum-label" }, 'Prev close'),
          React.createElement("span", { className: "mono" }, vfmt(baseline)),
          React.createElement("span", { className: "chart-sum-label", style: { marginLeft: 10 } }, 'High')
        ) : React.createElement("span", { className: "chart-sum-label" }, 'High'),
        React.createElement("span", { className: "mono" }, vfmt(max)),
        React.createElement("span", { className: "chart-sum-label", style: { marginLeft: 10 } }, 'Low'),
        React.createElement("span", { className: "mono" }, vfmt(min))
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
const SECTOR_FWD_PE = PBContent.SECTOR_FWD_PE;
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
  let { fundamentals, quote, market, fxRates, onRetry } = _refFB;
  const loading = fundamentals && fundamentals.loading && !fundamentals.data;
  const f = fundamentals?.data || {};
  const cur = quote?.price && quote.price > 0 ? quote.price : null;
  // Currency symbol follows the position's market (same source as fmt() used for
  // the analyst targets below) so every figure on the card reads in one currency.
  const ccySym = (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).sym;
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
    ),
    f.targetSource && React.createElement("div", { className: "analyst-attrib" },
      (f.targetUpdated
        ? 'Updated ' + new Date(f.targetUpdated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' via '
        : 'via ') + f.targetSource
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
      React.createElement("div", null,
        "Couldn't load fundamentals right now. The free data sources sometimes rate-limit or block the shared proxies; a Perplexity API key (Alerts panel) adds an AI-sourced fallback."
      ),
      onRetry && React.createElement("button", {
        className: "btn btn-ghost btn-xs",
        style: { marginTop: 8 },
        onClick: onRetry
      }, "Retry")
    )
  );
}
// Inline "add to watchlist(s)" control shown inside the stock card. A stock can
// live in several lists at once, so the panel is multi-select: each list row is a
// toggle (checkbox) the user can tick on/off independently. The common case stays
// one tap — no custom lists and not yet tracked → tapping just adds to the
// built-in list — while power users file a stock into any combination of lists
// from the card they already have open.
function WatchlistControl(_refWL) {
  let { ticker, market, name, watchlist, watchlistGroups, onAddWatch, onRemoveWatch, onMoveWatch, onToggleWatchList, onAddWatchGroup } = _refWL;
  const item = (watchlist || []).find(w => w.ticker === ticker && w.market === market) || null;
  const watching = !!item;
  const memberIds = item ? watchListIds(item) : [];
  const groups = watchlistGroups || [];
  const lists = [{ id: 'default', name: 'Watchlist' }, ...groups];
  const hasCustom = groups.length > 0;
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  // Custom lists this stock sits in — drives the subtitle on the toggle so the
  // user can see at a glance where it's filed without opening the panel.
  const customMemberNames = memberIds
    .filter(id => id !== 'default')
    .map(id => (lists.find(l => l.id === id) || {}).name)
    .filter(Boolean);
  const closePanel = () => { setOpen(false); setCreating(false); setNewName(''); };
  // Toggle membership in one list. onToggleWatchList handles create-on-first-add
  // and drop-when-last-removed; the panel stays open so several can be ticked.
  const toggle = (listId) => {
    if (onToggleWatchList) onToggleWatchList(ticker, market, name || null, listId);
    else if (!memberIds.includes(listId)) onAddWatch(ticker, market, name || null, listId);
  };
  const handleMainClick = () => {
    // Nothing to choose between (no custom lists, not yet tracked) → one-tap add.
    if (!watching && !hasCustom) { toggle('default'); return; }
    setOpen(o => !o); setCreating(false);
  };
  const submitNew = () => {
    const nm = newName.trim();
    if (!nm) return;
    const _r = onAddWatchGroup(nm);
    const id = _r && _r.id;
    if (id) toggle(id);
    setCreating(false); setNewName('');
  };
  const removeAll = () => { if (item) onRemoveWatch(item.id); closePanel(); };
  return React.createElement("div", { className: "wl-control" },
    React.createElement("button", {
      className: "wl-toggle" + (watching ? " watching" : ""),
      onClick: handleMainClick, "aria-expanded": open
    },
      React.createElement(Icon, { name: watching ? "checkCircle" : "plus", size: 15 }),
      React.createElement("span", { className: "wl-toggle-label" },
        watching ? "On watchlist" : "Add to watchlist",
        watching && customMemberNames.length ? React.createElement("span", { className: "wl-toggle-list" }, " \xB7 " + customMemberNames.join(', ')) : null),
      (hasCustom || watching) ? React.createElement(Icon, { name: "chevron", size: 14, className: "wl-toggle-caret" + (open ? " open" : "") }) : null),
    open ? React.createElement("div", { className: "wl-panel" },
      React.createElement("div", { className: "wl-panel-head" }, "In which lists"),
      lists.map(l => {
        const inList = memberIds.includes(l.id);
        return React.createElement("button", {
          key: l.id, className: "wl-list-row" + (inList ? " current" : ""),
          onClick: () => toggle(l.id)
        },
          React.createElement("span", { className: "wl-check" + (inList ? " on" : "") },
            inList ? React.createElement(Icon, { name: "check", size: 12 }) : null),
          React.createElement("span", { className: "wl-list-name" }, l.name),
          inList ? React.createElement("span", { className: "wl-list-tag" }, "Added") : null);
      }),
      creating
        ? React.createElement("div", { className: "wl-new-row" },
            React.createElement("input", {
              className: "wl-new-input", type: "text", placeholder: "New list name", value: newName, maxLength: 28,
              autoFocus: true, onChange: e => setNewName(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter') submitNew(); }
            }),
            React.createElement("button", { className: "btn btn-primary btn-sm", onClick: submitNew, disabled: !newName.trim(), style: { flex: '0 0 auto' } }, "Create"))
        : React.createElement("button", { className: "wl-list-row wl-new-trigger", onClick: () => setCreating(true) },
            React.createElement(Icon, { name: "plus", size: 14 }),
            React.createElement("span", { className: "wl-list-name" }, "New list…")),
      watching ? React.createElement("button", { className: "wl-list-row wl-remove", onClick: removeAll },
        React.createElement(Icon, { name: "trash", size: 14 }),
        React.createElement("span", { className: "wl-list-name" }, "Remove from all")) : null) : null
  );
}
// The notes you saved on a holding, shown in the stock card as a collapsible
// dropdown directly beneath the watchlist control — so the context you wrote
// when you bought (thesis, account, "held since…") is one tap away on the card,
// not buried in the edit form.
function HoldingNotesControl(_refHN) {
  let { notes } = _refHN;
  const [open, setOpen] = useState(false);
  const text = (notes || '').trim();
  if (!text) return null;
  return React.createElement("div", { className: "hn-control" },
    React.createElement("button", {
      className: "wl-toggle hn-toggle", onClick: () => setOpen(o => !o), "aria-expanded": open
    },
      React.createElement(Icon, { name: "edit", size: 15 }),
      React.createElement("span", { className: "wl-toggle-label" }, "Your notes"),
      React.createElement(Icon, { name: "chevron", size: 14, className: "wl-toggle-caret" + (open ? " open" : "") })),
    open ? React.createElement("div", { className: "wl-panel hn-panel" },
      React.createElement("div", { className: "hn-note-text" }, text)) : null
  );
}
// Friendly "as of" date for an indicator reading. FRED monthly series anchor to
// the 1st of the month, so those read as "May 2026"; daily/weekly read in full.
function fmtIndicatorAsOf(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  return d.getUTCDate() === 1
    ? d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
// The big value + change readout for an indicator card (unit-aware; no currency
// symbol). Shows the previous reading and, for released data (FRED/liquidity),
// the "as of" date so it's clear how fresh the number is.
function IndicatorValueBlock(_refIVB) {
  let { indicator, quote } = _refIVB;
  if (!quote) return React.createElement("div", { className: "price-block-wrap" },
    React.createElement("span", { className: "price price-xl mono text-dim" }, "—"));
  const up = quote.change >= 0;
  const flat = !quote.change;
  const hasAsOf = !!quote.asOf;
  const hasPrev = typeof quote.prevClose === 'number' && isFinite(quote.prevClose);
  return React.createElement("div", { className: "price-block-wrap" },
    React.createElement("div", { className: "flex items-baseline gap-2" },
      React.createElement("span", { className: "price price-xl" }, fmtIndicator(indicator, quote.price)),
      !flat && React.createElement("span", { className: `chg ${up ? 'up' : 'down'}` },
        up ? "▲" : "▼", " ", fmtIndicator(indicator, quote.change, { signed: true }))
    ),
    (hasPrev || hasAsOf) && React.createElement("div", { className: "daily-block" },
      React.createElement("div", { className: "daily-col" },
        hasPrev && React.createElement("div", { className: "daily-row prevclose-row" },
          React.createElement("span", { className: "daily-label" }, hasAsOf ? "Previous" : "Prev close"),
          React.createElement("span", { className: "daily-val mono prevclose-val" }, fmtIndicator(indicator, quote.prevClose))),
        hasAsOf && React.createElement("div", { className: "daily-row prevclose-row" },
          React.createElement("span", { className: "daily-label" }, "As of"),
          React.createElement("span", { className: "daily-val mono prevclose-val" }, fmtIndicatorAsOf(quote.asOf)))
      ))
  );
}
// The plain-English "deep dive" for an indicator: what it is, how to read it,
// and a small quick-reference of typical levels.
function IndicatorAbout(_refIA) {
  let { indicator, info } = _refIA;
  if (!info) return null;
  return React.createElement("div", { className: "indicator-about" },
    React.createElement("div", { className: "indicator-about-head" },
      React.createElement(Icon, { name: "gauge", size: 14 }),
      React.createElement("span", null, "What is ", indicator.label, "?")),
    React.createElement("p", { className: "indicator-about-what" }, info.what),
    React.createElement("div", { className: "indicator-about-sub" }, "How to read it"),
    React.createElement("p", { className: "indicator-about-interpret" }, info.interpret),
    info.levels && info.levels.length > 0 && React.createElement("div", { className: "indicator-levels" },
      info.levels.map((lv, i) => React.createElement("div", { key: i, className: "indicator-level" },
        React.createElement("span", { className: "indicator-level-label" }, lv.label),
        React.createElement("span", { className: "indicator-level-range" }, lv.range)))),
    React.createElement("div", { className: "indicator-about-note" },
      "Educational only — not investment advice."));
}
function DetailModal(_ref10) {
  let {
    selected,
    positions,
    watchlist,
    watchlistGroups,
    alerts,
    news,
    historyByTicker,
    fundamentals,
    fxRates,
    onClose,
    onAddWatch,
    onRemoveWatch,
    onMoveWatch,
    onToggleWatchList,
    onAddWatchGroup,
    onAddAlert,
    onRemoveAlert,
    onLoadNews,
    onLoadHistory,
    onRetryFundamentals
  } = _ref10;
  const prices = PBStore.usePricesMap();
  const {
    ticker,
    market
  } = selected;
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
  const pos = positions ? positions.find(p => p.ticker === ticker && p.market === market) : null;
  // Macro/market indicators (10Y yield, DXY, CPI, Fear & Greed, …) reuse this
  // card but in "indicator mode": unit-aware value, a plain-English explanation,
  // and price triggers — no position, watchlist, fundamentals or news.
  const indicator = indicatorFor(market, ticker);
  const isIndicator = !!indicator;
  const info = isIndicator ? INDICATOR_INFO[indicator.key] : null;
  // The number a fresh price-trigger pre-fills to (indicator unit precision for
  // indicators, 2dp for ordinary prices).
  const defaultTarget = (q) => q ? q.price.toFixed(isIndicator ? indicator.decimals : 2) : '';
  // Name resolution prefers the name saved on the holding, then the live quote /
  // curated lists. Null (never the bare ticker) so the subtitle doesn't echo the
  // ticker that's already the card's heading.
  const displayName = isIndicator ? indicator.label
    : ((pos && pos.name) ? prettyName(pos.name) : (resolveTickerName(ticker, market, quote) || null));
  // A unit trust has no ticker symbol — its "ticker" is an opaque Morningstar id,
  // so the fund name (not the id) is the card's heading and the subtitle drops
  // the duplicate name, leaving just the market badge.
  const isUnitTrust = !isIndicator && isUnitTrustId(ticker);
  const headTitle = isIndicator ? indicator.short : (isUnitTrust && displayName ? displayName : ticker);
  const subName = isUnitTrust ? null : displayName;
  const ccy = marketCurrency(market);
  // Price-trigger formatting: indicators show their own unit (e.g. "4.45%",
  // "F&G 20", "$18.05T") instead of a currency symbol.
  const alertPrefix = isIndicator ? (indicator.unit === 'usd_t' ? '$' : '') : (CURRENCY_SYMBOLS[ccy] || '$');
  const fmtAlertTarget = (v) => isIndicator ? fmtIndicator(indicator, v) : ((CURRENCY_SYMBOLS[ccy] || '$') + v.toFixed(2));
  const [dir, setDir] = useState('above');
  const [target, setTarget] = useState(defaultTarget(quote));
  const [note, setNote] = useState('');
  const [range, setRange] = useState(isIndicator ? (indicator.defaultRange || '1y') : '1y');
  const [showAlertForm, setShowAlertForm] = useState(!!selected.openAlerts);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const history = historyByTicker ? historyByTicker[priceKey(market, ticker) + ':' + range] : null;
  useEffect(() => {
    if (quote && !target) setTarget(defaultTarget(quote));
  }, [quote]);
  useEffect(() => {
    if (onLoadHistory) onLoadHistory(range);
  }, [range]);
  const submitAlert = () => {
    const t = parseDecimal(target);
    if (!isFinite(t)) return;
    if (!isIndicator && t <= 0) return; // prices are positive; indicator targets can be 0+
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
    className: "modal-panel stock-detail-panel",
    ref: panelRef
  }, React.createElement("div", {
    className: "modal-handle"
  }), React.createElement("div", {
    className: "modal-header"
  }, React.createElement("div", { style: { minWidth: 0 } }, React.createElement("div", {
    className: "modal-title"
  }, headTitle), React.createElement("div", {
    className: "modal-subtitle"
  }, subName ? React.createElement(React.Fragment, null, subName, " \xB7 ") : null, React.createElement("span", {
    className: "market-badge"
  }, isIndicator ? "Indicator" : (isUnitTrust ? "Unit trust" : market)))), React.createElement("button", {
    className: "modal-close",
    onClick: onClose,
    "aria-label": "Close"
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "modal-body"
  }, 
    React.createElement("div", { style: { position: 'relative' } },
      isIndicator
        ? React.createElement(IndicatorValueBlock, { indicator: indicator, quote: quote })
        : React.createElement(PriceBlock, { quote: quote, size: "xl", showDailyRow: true, market: market }),
      React.createElement("button", {
        className: "detail-alert-bell",
        onClick: () => {
          // Open the alert popup fresh each time — same behaviour as the
          // watchlist bell (openAlertPopup): default to "above" and pre-fill
          // the current price so it's consistent across the app.
          setDir('above');
          setTarget(defaultTarget(quote));
          setNote('');
          setShowAlertForm(true);
        },
        "aria-label": "Price alerts"
      }, React.createElement(Icon, { name: "bell", size: 16 }),
        alerts.length > 0 && React.createElement("span", { className: "detail-alert-count" }, alerts.length))
    ),

    // Plain-English explanation — the "deep dive" that helps a retail investor
    // understand what this indicator means and how to read it.
    info && React.createElement(IndicatorAbout, { indicator: indicator, info: info }),

    !isIndicator && onAddWatch ? React.createElement(WatchlistControl, {
      ticker: ticker, market: market, name: displayName,
      watchlist: watchlist, watchlistGroups: watchlistGroups,
      onAddWatch: onAddWatch, onRemoveWatch: onRemoveWatch,
      onMoveWatch: onMoveWatch, onToggleWatchList: onToggleWatchList, onAddWatchGroup: onAddWatchGroup
    }) : null,

    // Notes you left on this holding — collapsible, just below the watchlist box.
    !isIndicator && pos && pos.notes ? React.createElement(HoldingNotesControl, { notes: pos.notes }) : null,

    !isIndicator && pos && quote && (() => {
      // A plain top-to-bottom list reads far more clearly than a 3×2 grid:
      // label on the left, value on the right, one fact per line. The two
      // figures users care about most — what they paid vs. what it's worth now —
      // sit together under a divider with the clearer "Purchase value" /
      // "Current value" wording, with Profit / Loss as the bottom line.
      // Value the position in its cost currency (native for normal holdings, the
      // fiat the user paid for crypto bought in ZAR), so every line reads in one
      // coherent currency and the price-vs-cost % is meaningful.
      const rates = fxRates?.rates || null;
      const val = valuePositionInCostCcy(pos, quote, rates);
      const posCcy = val.ccy;
      const curPriceInCcy = posCcy === val.native
        ? quote.price
        : convertCcy(quote.price, val.native, posCcy, rates);
      const purchaseValue = val.cost;
      const currentValue = val.value;
      const pl = val.gain;
      const plPct = val.gainPct != null ? val.gainPct : 0;
      const isCryptoPos = pos.market === 'CRYPTO';
      const posLine = (label, value, opts) => React.createElement("div", {
        className: "pos-line" + ((opts && opts.sep) ? " pos-line-sep" : "") + ((opts && opts.strong) ? " pos-line-strong" : "")
      },
        React.createElement("span", { className: "pos-line-label" }, label),
        React.createElement("span", { className: "pos-line-val mono" + ((opts && opts.cls) ? " " + opts.cls : "") }, value));
      return React.createElement("div", { className: "holding-card" },
        React.createElement("div", { className: "eyebrow" }, "Your position"),
        React.createElement("div", { className: "pos-list" },
          posLine(isCryptoPos ? "Amount" : "Shares", pos.shares),
          posLine(isCryptoPos ? "Avg cost" : "Avg price", fmtCcy(pos.costBasis, posCcy)),
          posLine("Current price", curPriceInCcy != null ? fmtCcy(curPriceInCcy, posCcy) : fmt(quote.price, market)),
          posLine("Purchase value", currentValue != null ? fmtCcy(purchaseValue, posCcy) : "—", { sep: true }),
          posLine("Current value", currentValue != null ? fmtCcy(currentValue, posCcy) : "—"),
          posLine("Profit / Loss",
            React.createElement(React.Fragment, null,
              fmtCcySigned(pl, posCcy), " (", plPct >= 0 ? '+' : '', plPct.toFixed(1), "%)"),
            { strong: true, cls: (pl != null && pl >= 0) ? 'text-up' : 'text-down' })
        )
      );
    })(),

    !isIndicator && quote && quote.yearHigh ? React.createElement("div", {
      className: "ath-strip"
    }, React.createElement("span", { className: "eyebrow" }, "52W High"),
      React.createElement("span", { className: "mono" }, fmt(quote.yearHigh, market)),
      React.createElement("span", {
        className: `mono ${quote.price >= quote.yearHigh * 0.995 ? 'text-up' : 'text-muted'}`
      }, quote.price >= quote.yearHigh * 0.995 ? 'At high' : ((quote.price - quote.yearHigh) / quote.yearHigh * 100).toFixed(2) + '%')) : null,
    !isIndicator && React.createElement(EarningsBadge, { fundamentals: fundamentals }),
    React.createElement(PriceChart, {
      history: history, loading: history?.loading,
      range: range, onRangeChange: setRange,
      currency: quote?.currency || ccy,
      quote: quote,
      indicator: indicator,
      rangeKeys: isIndicator ? indicator.chartRanges : null,
      onRetry: () => { if (onLoadHistory) onLoadHistory(range); }
    }),
    !isIndicator && React.createElement(FundamentalsBlock, { fundamentals: fundamentals, quote: quote, market: market, fxRates: fxRates, onRetry: onRetryFundamentals }),

    // Price alerts open as a centered popup — the same dialog the watchlist
    // bell shows — for a consistent experience across the app. Rendered through
    // a portal to document.body so it isn't trapped inside the detail panel's
    // transformed (will-change) scroll container, and elevated above the modal.
    showAlertForm && ReactDOM.createPortal(
      React.createElement("div", { className: "alert-popup-overlay alert-popup-elevated" },
        React.createElement("div", { className: "alert-popup-backdrop", onClick: () => setShowAlertForm(false) }),
        React.createElement("div", { className: "alert-popup-panel" },
          React.createElement("div", { className: "alert-popup-header" },
            React.createElement("div", null,
              React.createElement("div", { className: "modal-title" }, headTitle),
              React.createElement("div", { className: "modal-subtitle" }, "Price alerts \xB7 ", React.createElement("span", { className: "market-badge" }, isIndicator ? "Indicator" : market))),
            React.createElement("button", { className: "modal-close", onClick: () => setShowAlertForm(false), "aria-label": "Close" },
              React.createElement(Icon, { name: "x" }))),
          alerts.length > 0 && React.createElement("div", {
            style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }
          }, alerts.map(a => React.createElement("div", {
            key: a.id, className: "alert-item"
          }, React.createElement("div", null,
            React.createElement("div", { className: "mono text-sm" },
              a.direction === 'above' ? '↑ above ' : '↓ below ', isIndicator ? fmtAlertTarget(a.targetPrice) : fmt(a.targetPrice, market)),
            a.note && React.createElement("div", { className: "text-xs text-dim mt-1" }, a.note)),
            React.createElement("button", {
              className: "btn btn-ghost btn-xs",
              onClick: () => onRemoveAlert(a.id), "aria-label": "Remove"
            }, React.createElement(Icon, { name: "x", size: 12 }))))),
          React.createElement("div", { className: "alert-form" },
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
                React.createElement("span", { className: "prefix" }, alertPrefix),
                React.createElement("input", {
                  type: "text", inputMode: "decimal",
                  autoComplete: "off", autoCorrect: "off", spellCheck: false,
                  placeholder: isIndicator ? "Target value" : "Target price", value: target,
                  onChange: e => setTarget(sanitizeDecimalInput(e.target.value)),
                  className: "alert-target-input"
                }))),
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
              target && isFinite(parseDecimal(target)) ? fmtAlertTarget(parseDecimal(target)) : 'target')))),
      document.body
    ),

    !isIndicator && React.createElement("div", null, React.createElement("div", {
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
    onClose,
    onRemoveAlert,
    onClearTriggered,
    onRequestPerm,
    onOpenDetail
  } = _ref11;
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  // Tapping a trigger or alert jumps straight to that company's chart. Close the
  // sheet first so the detail card opens cleanly on top of the dashboard.
  const openChart = (ticker, market) => {
    if (!onOpenDetail) return;
    onClose();
    onOpenDetail(ticker, market);
  };
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
    className: "alert-item alert-item-tap",
    role: "button",
    tabIndex: 0,
    "aria-label": `Open ${t.ticker} chart`,
    onClick: () => openChart(t.ticker, t.market),
    onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChart(t.ticker, t.market); } }
  }, React.createElement("div", null, React.createElement("div", null, React.createElement("span", {
    className: "tkr-sm"
  }, t.ticker), " ", React.createElement("span", {
    className: "market-badge"
  }, t.market), " ", React.createElement("span", {
    className: "mono text-sm"
  }, t.direction === 'above' ? '↑ ' : '↓ ', fmt(t.targetPrice, t.market))), React.createElement("div", {
    className: "text-xs text-dim mt-1"
  }, timeAgo(t.triggeredAt), " \xB7 hit at ", fmt(t.triggerPrice, t.market))), React.createElement(Icon, {
    name: "chevron", size: 15, className: "alert-item-go"
  }))))), React.createElement("div", null, React.createElement("div", {
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
    className: "alert-item alert-item-tap",
    role: "button",
    tabIndex: 0,
    "aria-label": `Open ${a.ticker} chart`,
    onClick: () => openChart(a.ticker, a.market),
    onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChart(a.ticker, a.market); } }
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
    onClick: e => { e.stopPropagation(); onRemoveAlert(a.id); },
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
  const [usdLanded, setUsdLanded] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const isWithdraw = flow === 'withdraw';
  // The "USD landed" field only makes sense for a non-USD deposit funding a USD
  // account (e.g. ZAR → USD). Hidden otherwise.
  const showLanded = !isWithdraw && currency !== 'USD';
  const submit = () => {
    const a = parseDecimal(amount);
    if (!isFinite(a) || a <= 0) return;
    // Withdrawals are stored as negative cash flows so the contribution history
    // and overall-return maths net them out automatically.
    onSave(isWithdraw ? -a : a, currency, date, note, showLanded ? usdLanded : '');
  };
  const ccy = currency === 'ZAR' ? 'R' : '$';
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel", style: { maxWidth: 520 }, ref: panelRef },
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
          React.createElement("label", { className: "form-label" }, isWithdraw ? "Amount" : "Amount transferred"),
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
        showLanded ? React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "USD landed in account"),
          React.createElement("div", { className: "input-prefix-wrap" },
            React.createElement("span", { className: "prefix" }, "$"),
            React.createElement("input", {
              type: "text", inputMode: "decimal",
              autoComplete: "off", autoCorrect: "off", spellCheck: false,
              placeholder: "0.00", value: usdLanded,
              onChange: e => setUsdLanded(sanitizeDecimalInput(e.target.value)),
              onKeyDown: e => { if (e.key === 'Enter') submit(); }
            })
          ),
          React.createElement("div", { className: "text-dim", style: { fontSize: 12, marginTop: 6, lineHeight: 1.4 } },
            "Optional — the dollars that actually arrived after conversion & fees. Locks in the real rate so overall profit compares what you put in to what you hold now.")
        ) : null,
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
    React.createElement("div", { className: "import-market-pick" },
      React.createElement("div", { className: "form-label" }, "Default currency"),
      React.createElement("div", { className: "import-bulk-chips" },
        CCYS.map(c => React.createElement("button", {
          key: c, type: "button",
          className: "import-bulk-chip" + (defaultCurrency === c ? " active" : ""),
          onClick: () => setDefaultCurrency(c)
        }, c, React.createElement("span", { className: "import-chip-sym" }, CURRENCY_SYMBOLS[c] || '')))),
      React.createElement("div", { className: "form-help" }, "Applied to any pasted row that doesn't name its own currency — you can change any row in the next step.")),
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
    React.createElement("div", { className: "form-actions", style: { marginTop: 4 } },
      React.createElement("button", { className: "btn btn-secondary", onClick: onClose }, "Cancel"),
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
      React.createElement("button", { className: "btn btn-secondary", onClick: () => setStage('input') }, "Back"),
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
function ImportModal({ onClose, onImport, defaultMarket }) {
  const todayISO = new Date().toISOString().slice(0, 10);
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
  const [chosenMarket, setChosenMarket] = useState(defaultMarket || 'US');
  // Sector the user picks for a row the classifier can't place ("Other"). Saved
  // to the persistent sector cache on import so it's remembered next time.
  const [sectorByRow, setSectorByRow] = useState({});
  // On-device OCR of Easy Equities screenshots: progress + status while reading.
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStep, setOcrStep] = useState('');
  const [ocrError, setOcrError] = useState('');
  // Confirm before discarding a review in progress (only the X button can close
  // the review stage — swipe and backdrop are disabled there).
  const [confirmClose, setConfirmClose] = useState(false);
  const fileRef = useRef(null);
  const imgRef = useRef(null);
  const panelRef = useRef(null);
  // Swipe-to-dismiss only on the input stage; the review stage is locked so
  // scrolling the matches can never flick the sheet closed.
  useSwipeDownToClose(panelRef, onClose, stage === 'input');
  useBodyScrollLock();
  // The X (and any close intent) prompts when there's a review in flight.
  const requestClose = () => {
    if (stage === 'review' && rows.length > 0 && !importing) setConfirmClose(true);
    else onClose();
  };

  const toRows = (holdings, market) => holdings.map(h => ({
    id: uid(),
    query: h.query || '',
    tickerHint: h.tickerHint || null,
    market: h.marketHint || market,
    // The import row explicitly named its market (a ticker exchange suffix or an
    // exchange/market column) — so the matcher must stay on it and never drift to
    // a foreign cross-listing.
    marketExplicit: !!h.marketHint,
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

  const isImageFile = (f) => !!f && (/^image\//.test(f.type) || /\.(png|jpe?g|webp|heic|heif|bmp|gif)$/i.test(f.name || ''));

  const handleFiles = async (files) => {
    const file = files && files[0];
    if (!file) return;
    // Screenshots (Easy Equities holdings) route to the on-device OCR path; every
    // other file type (CSV / XLSX / PDF / text) goes through the native parsers.
    if (isImageFile(file)) return handleScreenshots(files);
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

  // OCR one or more Easy Equities screenshots in-browser, then hand the extracted
  // holdings to the same review flow as a pasted list. Each detail screenshot
  // yields one holding; a portfolio-list screenshot can yield several.
  const handleScreenshots = async (files) => {
    const imgs = Array.from(files || []).filter(isImageFile);
    if (!imgs.length) return;
    setOcrBusy(true); setOcrError(''); setParseError(''); setOcrProgress(0);
    try {
      const all = [];
      for (let k = 0; k < imgs.length; k++) {
        setOcrStep(imgs.length > 1 ? `Reading screenshot ${k + 1} of ${imgs.length}…` : 'Reading screenshot…');
        setOcrProgress(0);
        const { text, headerText } = await ocrImageFile(imgs[k], p => setOcrProgress(p));
        // Each holding's market comes from the screenshot's own EXCHANGE field,
        // falling back to the market the user started from (defaultMarket). The
        // dedicated title-bar read (headerText) gives the cleanest full name.
        all.push(...parseEasyEquitiesScreenshot(text, defaultMarket, { headerText }));
      }
      if (!all.length) {
        setOcrError("Couldn't read any holdings from those images. Use an Easy Equities holding page (“# Shares” + “Avg. Purchase Price”), a trade confirmation, a transaction-history row, or your portfolio list — and crop out anything else.");
        return;
      }
      // The same trade can arrive twice — its emailed broker note and its
      // transaction-history row — so collapse duplicates before review, otherwise
      // the per-ticker merge on commit would double the position.
      const deduped = dedupeEeHoldings(all);
      // Highlight the market most rows landed on (their detected exchange, else
      // the tab the user started from) so the review chips match.
      const mk = deduped.find(h => h.marketHint)?.marketHint;
      if (mk) setChosenMarket(mk);
      handleParsed(deduped);
    } catch (e) {
      setOcrError(e?.message || 'Could not read those screenshots. Try again, or paste your holdings instead.');
    } finally {
      setOcrBusy(false); setOcrStep(''); setOcrProgress(0);
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
    // A symbol-like query / hint is the user's intended ticker on the chosen
    // market. Try the chosen market first and only drift off-market as a last
    // resort, so a US ticker is never booked as its European cross-listing (EUR).
    const symHint = (r.tickerHint && looksLikeTickerToken(r.tickerHint)) ? String(r.tickerHint).toUpperCase()
                  : (looksLikeTickerToken(r.query) ? String(r.query).toUpperCase() : null);
    // A candidate whose ticker still carries an exchange suffix (".VI", ":MI") is a
    // foreign listing that slipped through — never let it pass as an on-market pick,
    // even if its market field happens to equal the chosen one.
    const onMarket = ranked.filter(c => c.market === market && !/[.:]/.test(c.ticker));
    let offMarketRanked = ranked.filter(c => c.market !== market);
    // Never auto-book a holding onto a different-currency cross-listing — European
    // brokers quote US shares in EUR, and dual-listed names (iShares ETFs, etc.)
    // surface London/pence listings, which used to silently land under the user's
    // import at the wrong-currency "live rate". Restrict the off-market fallback to
    // markets that settle in the same currency as the chosen one; everything else
    // stays in `candidates` so it can still be chosen by hand if genuinely meant.
    const chosenCcy = (MARKET_CURRENCY[market] || {}).code;
    if (chosenCcy) offMarketRanked = offMarketRanked.filter(c => (MARKET_CURRENCY[c.market] || {}).code === chosenCcy);
    // When the row explicitly named its market, don't drift off it at all — a miss
    // becomes "not matched" (overridable) rather than a wrong foreign listing.
    if (r.marketExplicit) offMarketRanked = [];
    const attempts = [];
    const pushAttempt = (c) => { if (c && c.ticker && !attempts.some(a => a.ticker === c.ticker && a.market === c.market)) attempts.push(c); };
    if (onMarket[0]) pushAttempt(onMarket[0]);                                   // best name match on the chosen market
    if (symHint) pushAttempt({ ticker: symHint, market, name: null, nameScore: null }); // the bare symbol on the chosen market
    onMarket.slice(1).forEach(pushAttempt);                                     // other chosen-market candidates
    offMarketRanked.forEach(pushAttempt);                                       // finally, anything elsewhere
    let pick = null, q = null;
    for (const c of attempts.slice(0, 6)) {
      const cq = await fetchQuote(c.ticker, c.market).catch(() => null);
      if (cq) { pick = c; q = cq; break; }
    }
    // Confidence = how well the matched listing's name fits the query. Low
    // confidence (or a pick that landed off the chosen market) is surfaced so
    // the user can sanity-check or pick an alternative.
    // Name priority: the candidate's own name → the search result for that exact
    // listing (clean "Vanguard S&P 500 ETF"-style names) → the live quote's name →
    // the query. The middle step matters for ticker/symbol imports where `pick` is
    // a bare-symbol attempt with no name, so ETFs don't show a cryptic quote name.
    const matchedCand = pick ? ranked.find(c => c.ticker === pick.ticker && c.market === pick.market) : null;
    const resolvedName = q && pick
      ? (pick.name || (matchedCand && matchedCand.name) || resolveTickerName(pick.ticker, pick.market, q) || r.query)
      : r.resolvedName;
    const conf = q && pick ? (pick.nameScore != null ? pick.nameScore : companyNameScore(r.query, resolvedName)) : 0;
    const offMarket = !!(q && pick && pick.market !== market);
    return {
      ticker: q && pick ? pick.ticker : (r.tickerHint || ''),
      market: q && pick ? pick.market : market,
      resolvedName,
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
  // The sector this row will be allocated to in the dashboard — the same static
  // resolution the allocation chart uses (listing map first, then the name), so
  // what the user sees here is exactly where it'll land.
  const sectorForRow = (r) => {
    if (!(r.status === 'ok' && r.ticker)) return 'Other';
    const f = DATA.findSector(r.ticker, r.market);
    if (f.sector !== 'Other') return f.sector;
    const byName = r.resolvedName ? DATA.classifySectorByName(r.resolvedName) : 'Other';
    return (byName && byName !== 'Other') ? byName : 'Other';
  };
  // The effective sector to commit: an explicit user pick wins, else the detected
  // one (null only when genuinely unknown, so we never persist "Other").
  const effectiveSector = (r) => {
    if (sectorByRow[r.id]) return sectorByRow[r.id];
    const det = sectorForRow(r);
    return det !== 'Other' ? det : null;
  };
  // Importable only once matched to a confirmed live listing with valid qty/cost.
  const validRows = rows.filter(r => r.include && r.ticker.trim() && r.status === 'ok' && hasShares(r) && hasCost(r));
  const notFoundCount = rows.filter(r => r.include && r.status === 'notfound').length;
  const needQtyCount = rows.filter(r => r.include && r.status === 'ok' && (!hasShares(r) || !hasCost(r))).length;
  // Guard against silent collapse: when two *differently-named* included rows
  // resolve to the same live listing, importing merges them (sums the shares) —
  // the exact failure where several distinct ETFs land on one ticker and the
  // committed value is the sum of unrelated holdings. Flag those rows so the user
  // re-checks the match before committing. (Same name twice is a real averaged
  // buy and is left alone.)
  const collisionKeys = (() => {
    const byKey = {};
    rows.forEach(r => {
      if (!r.include || r.status !== 'ok' || !r.ticker.trim()) return;
      const k = priceKey(r.market, r.ticker.trim().toUpperCase());
      (byKey[k] = byKey[k] || []).push(r);
    });
    const out = new Set();
    Object.keys(byKey).forEach(k => {
      const list = byKey[k];
      if (list.length > 1 && new Set(list.map(r => normaliseCompanyName(r.query || ''))).size > 1) out.add(k);
    });
    return out;
  })();
  const isCollisionRow = (r) => r.include && r.status === 'ok' && !!r.ticker.trim() &&
    collisionKeys.has(priceKey(r.market, r.ticker.trim().toUpperCase()));
  const collisionCount = rows.filter(isCollisionRow).length;

  const doImport = async () => {
    if (validRows.length === 0) return;
    setImporting(true);
    try {
      await onImport(validRows.map(r => ({
        ticker: r.ticker.trim().toUpperCase(),
        market: r.market,
        name: r.resolvedName || null,
        shares: parseDecimal(r.shares),
        costBasis: parseDecimal(r.costBasis),
        purchaseDate: r.purchaseDate || null,
        notes: '',
        sector: effectiveSector(r),
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
    React.createElement("div", { className: "ee-scan" },
      React.createElement("div", { className: "ee-scan-head" },
        React.createElement("div", { className: "ee-scan-badge" }, React.createElement(Icon, { name: "image", size: 18 })),
        React.createElement("div", null,
          React.createElement("div", { className: "ee-scan-title" }, "Scan Easy Equities screenshots"),
          React.createElement("div", { className: "ee-scan-sub" }, "Add holdings from screenshots — read on your device, nothing uploaded."))),
      React.createElement("div", {
        className: "ee-scan-drop" + (ocrBusy ? " busy" : ""),
        onDragOver: e => { e.preventDefault(); },
        onDrop: e => { e.preventDefault(); if (!ocrBusy) handleScreenshots(e.dataTransfer.files); },
        onClick: () => { if (!ocrBusy) imgRef.current?.click(); }
      },
        ocrBusy
          ? React.createElement(React.Fragment, null,
              React.createElement(Icon, { name: "refresh", size: 22, className: "spin" }),
              React.createElement("div", { className: "ee-scan-status" }, ocrStep || "Reading…"),
              React.createElement("div", { className: "ee-scan-bar" },
                React.createElement("div", { className: "ee-scan-bar-fill", style: { width: Math.round(ocrProgress * 100) + "%" } })),
              React.createElement("div", { className: "ee-scan-hint" }, "First scan downloads the on-device reader — a few seconds."))
          : React.createElement(React.Fragment, null,
              React.createElement(Icon, { name: "image", size: 24 }),
              React.createElement("div", { className: "ee-scan-cta" }, "Tap to choose screenshots"),
              React.createElement("div", { className: "ee-scan-hint" }, "Holding pages, trade confirmations, transaction-history rows, or your portfolio list — add several at once.")),
        React.createElement("input", {
          ref: imgRef, type: "file", accept: "image/*", multiple: true,
          style: { display: 'none' },
          onChange: e => { handleScreenshots(e.target.files); e.target.value = ''; }
        })
      ),
      ocrError ? React.createElement("div", { className: "verify-error", style: { marginTop: 8 } }, ocrError) : null
    ),
    React.createElement("div", { className: "import-or" }, React.createElement("span", null, "or import a file")),
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
    React.createElement("div", { className: "import-or" }, React.createElement("span", null, "or paste your holdings")),
    React.createElement("div", { className: "form-help", style: { marginBottom: 8 } },
      "One holding per line: ", React.createElement("strong", null, "date, company or ticker, shares, cost per share"),
      ". Order is flexible, and a name on its own works too — you can fill in the rest in the next step."),
    React.createElement("textarea", {
      className: "import-paste",
      placeholder: "2024-10-01, Apple, 10, 150.25\n2025-02-14, Naspers, 5, 3200\nAnglo American, 100, 480\nBroadcom",
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
    // Holding amount = shares × cost/share — shown so the user can confirm the
    // app derived the position size correctly from the four imported fields.
    const amt = (!sharesBad && !costBad) ? parseDecimal(r.shares) * parseDecimal(r.costBasis) : null;
    const alts = (r.candidates || []).filter(c => !(c.ticker === r.ticker && c.market === r.market)).slice(0, 6);
    const lowConf = r.status === 'ok' && r.lowConfidence;
    const collide = isCollisionRow(r);
    // The sector this holding will land in (same resolution as the chart). Shown
    // for every matched row; when it can't be classified we flag it and the user's
    // pick is learned (persisted) so the allocation chart stops saying "Other".
    const matched = r.status === 'ok' && !!r.ticker;
    const detectedSector = matched ? sectorForRow(r) : null;
    const sectorValue = sectorByRow[r.id] || (detectedSector && detectedSector !== 'Other' ? detectedSector : '');
    const sectorUnknown = matched && detectedSector === 'Other' && !sectorByRow[r.id];
    return React.createElement("div", { key: r.id, className: "import-card" + (r.include ? "" : " excluded") + (r.status === 'notfound' ? " is-bad" : "") + (lowConf ? " is-low" : "") + (collide ? " is-dup" : "") },
      React.createElement("div", { className: "import-card-top" },
        React.createElement("label", {
          className: "import-include" + (r.include ? " on" : ""),
          title: r.include ? "This holding will be imported — toggle off to skip it" : "Skipped — toggle on to import this holding"
        },
          React.createElement("input", { type: "checkbox", className: "import-include-input", checked: r.include, onChange: e => updateRow(r.id, { include: e.target.checked }) }),
          React.createElement("span", { className: "import-include-track" }, React.createElement("span", { className: "import-include-thumb" })),
          React.createElement("span", { className: "import-include-label" }, r.include ? "Include" : "Skipped")),
        React.createElement("button", { className: "import-del", onClick: () => removeRow(r.id), "aria-label": "Remove row" },
          React.createElement(Icon, { name: "x", size: 13 }))
      ),
      React.createElement("input", {
        className: "import-query-input",
        value: r.query, placeholder: "Company name",
        autoComplete: "off", spellCheck: false,
        onChange: e => updateRow(r.id, { query: e.target.value }),
        onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); reResolveRow(r.id); } },
        onBlur: () => { if (r.query.trim() && r.status !== 'resolving') reResolveRow(r.id); }
      }),
      React.createElement("div", { className: "import-card-match" },
        statusDot(r),
        r.ticker
          ? React.createElement(React.Fragment, null,
              isUnitTrustId(r.ticker)
                ? React.createElement("span", { className: "market-badge" }, "Unit trust")
                : React.createElement("span", { className: "import-match-tkr" }, r.ticker),
              React.createElement("span", { className: "import-match-name" }, r.resolvedName || ''),
              lowConf ? React.createElement("span", { className: "import-conf-low", title: "Loose match — please confirm or pick an alternative" }, "check?") : null)
          : React.createElement("span", { className: "import-match-name text-dim" },
              r.status === 'resolving' ? "Searching live listings…" : (r.status === 'notfound' ? "No match — try the exact name or another market" : "Not matched yet")),
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
      collide ? React.createElement("div", { className: "import-dup-warn" },
        React.createElement(Icon, { name: "alert", size: 12 }),
        React.createElement("span", null, "Same listing as another row — importing will merge them into one position. Use ", React.createElement("b", null, "Search"), " to pick the correct listing for this holding.")) : null,
      r.showAlts && alts.length > 0 ? React.createElement("div", { className: "import-alts" },
        alts.map(c => React.createElement("button", {
          key: priceKey(c.market, c.ticker), className: "import-alt",
          onClick: () => chooseCandidate(r.id, c)
        },
          isUnitTrustId(c.ticker) ? null : React.createElement("span", { className: "import-alt-tkr" }, c.ticker),
          React.createElement("span", { className: "market-badge" }, isUnitTrustId(c.ticker) ? "Unit trust" : c.market),
          React.createElement("span", { className: "import-alt-name" }, c.name)))
      ) : null,
      // Manual matcher: search every live exchange by name or symbol and pick the
      // exact listing when auto-matching missed or the user wants a different one.
      r.manualSearch ? React.createElement("div", { className: "import-manual-search" },
        React.createElement("div", { className: "import-manual-hint" },
          "Search by company name, or type the exact symbol (e.g. ", React.createElement("code", null, "AAPL"),
          " or ", React.createElement("code", null, "AGL.JO"), ") and pick “Use this exact symbol” to force the match. Set the market with the dropdown above first if needed."),
        React.createElement(TickerSearch, {
          value: r.query,
          market: r.market,
          onChange: () => {},
          onMarketChange: () => {},
          onSelect: (sel) => { updateRow(r.id, { manualSearch: false }); chooseCandidate(r.id, { ticker: sel.ticker, market: sel.market, name: sel.name }); }
        })
      ) : null,
      React.createElement("div", { className: "import-card-meta" },
        React.createElement("div", { className: "import-qty-field import-exch-field" },
          React.createElement("span", { className: "import-qty-label" }, "Exchange"),
          React.createElement("select", {
            className: "import-input import-field-select", value: r.market,
            onChange: e => { updateRow(r.id, { market: e.target.value, status: 'resolving', ticker: '' }); reResolveRow(r.id); }
          }, MARKETS.map(m => React.createElement("option", { key: m.value, value: m.value },
              m.label + " — " + m.country)))),
        React.createElement("div", { className: "import-qty-field import-date-field" },
          React.createElement("span", { className: "import-qty-label" }, "Date"),
          React.createElement("input", {
            className: "import-input", type: "date", max: todayISO,
            value: r.purchaseDate || '',
            onChange: e => updateRow(r.id, { purchaseDate: e.target.value })
          }))),
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
          }))),
      amt != null ? React.createElement("div", { className: "import-amount-line" },
        React.createElement("span", null, "Holding amount"),
        React.createElement("span", { className: "mono" }, fmt(amt, r.market))) : null,
      matched ? React.createElement("div", { className: "import-qty-field import-sector-field" + (sectorUnknown ? " is-unknown" : "") },
        React.createElement("span", { className: "import-qty-label" },
          "Sector",
          React.createElement("span", { className: "import-sector-hint" },
            sectorUnknown
              ? React.createElement(React.Fragment, null, React.createElement(Icon, { name: "alert", size: 11 }), " pick one — we'll remember it")
              : " · where it lands in your allocation")),
        React.createElement("select", {
          className: "import-input import-field-select" + (sectorUnknown ? " bad" : ""),
          value: sectorValue,
          onChange: e => setSectorByRow(prev => ({ ...prev, [r.id]: e.target.value }))
        },
          React.createElement("option", { value: "" }, sectorUnknown ? "Choose sector…" : "Other (uncategorised)"),
          (DATA.SECTOR_CANON || []).map(s => React.createElement("option", { key: s, value: s }, s)))
      ) : null
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
    collisionCount > 0 && !resolving ? React.createElement("div", { className: "import-gate-note import-dup-note" },
      React.createElement(Icon, { name: "alert", size: 13 }),
      React.createElement("span", null, `${collisionCount} rows matched a listing that another row also uses — importing as-is will combine them into a single position with summed shares. Re-check the flagged rows so each holding lands on its own listing.`)
    ) : null,
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
    React.createElement("div", { className: "modal-panel", ref: panelRef, style: { maxWidth: 520 } },
      stage === 'input' ? React.createElement("div", { className: "modal-handle" }) : null,
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, defaultMarket === 'TFSA' ? "Import TFSA holdings" : "Import holdings"),
          React.createElement("div", { className: "modal-subtitle" }, stage === 'input' ? "Match company names to live listings" : "Review matches before importing")
        ),
        React.createElement("button", { className: "modal-close", onClick: requestClose, "aria-label": "Close" }, React.createElement(Icon, { name: "x" }))
      ),
      stage === 'input' ? renderInput() : renderReview()
    ),
    confirmClose ? React.createElement("div", { className: "import-confirm" },
      React.createElement("div", { className: "import-confirm-card" },
        React.createElement("div", { className: "import-confirm-title" }, "Discard this import?"),
        React.createElement("div", { className: "import-confirm-body" },
          "You're reviewing ", React.createElement("strong", null, rows.length, " holding", rows.length !== 1 ? "s" : ""),
          ". Closing now discards these matches — nothing will be added to your portfolio."),
        React.createElement("div", { className: "import-confirm-actions" },
          React.createElement("button", { className: "btn btn-secondary", onClick: () => setConfirmClose(false) }, "Keep editing"),
          React.createElement("button", { className: "btn btn-danger", onClick: () => { setConfirmClose(false); onClose(); } }, "Discard import"))
      )
    ) : null
  );
}
function PositionModal(_ref12) {
  let {
    editId,
    existing,
    defaultMarket,
    displayCurrency,
    initialSectorWeights,
    onClose,
    onSave
  } = _ref12;
  const isEdit = !!editId;
  const [ticker, setTicker] = useState(existing?.ticker || '');
  const [market, setMarket] = useState(existing?.market || defaultMarket || 'US');
  const [shares, setShares] = useState(existing?.shares?.toString() || '');
  const [costBasis, setCostBasis] = useState(existing?.costBasis?.toString() || '');
  const isCrypto = market === 'CRYPTO';
  // Crypto trades globally in USD but people buy it in fiat (often ZAR here). Let
  // the holder record what they actually paid: choose the cost currency and enter
  // either a price per coin or the total they spent. costCurrency defaults to the
  // user's display currency so a ZAR user gets ZAR without extra taps; absent /
  // USD it behaves exactly like a normal USD-priced holding.
  const [costCurrency, setCostCurrency] = useState(existing?.costCurrency || displayCurrency || 'USD');
  const [costMode, setCostMode] = useState(isEdit ? 'perUnit' : 'total'); // crypto only
  const [totalSpent, setTotalSpent] = useState(
    existing && existing.costCurrency && existing.shares
      ? String(parseFloat((existing.shares * existing.costBasis).toFixed(2)))
      : '');
  const [notes, setNotes] = useState(existing?.notes || '');
  const todayISO = new Date().toISOString().slice(0, 10);
  const [purchaseDate, setPurchaseDate] = useState(existing?.purchaseDate || todayISO);
  const [verifying, setVerifying] = useState(false);
  const [tickerError, setTickerError] = useState('');
  // Sector this holding will be allocated to — auto-detected from the ticker,
  // overridable, and learned so the allocation chart reflects it.
  const [sectorOverride, setSectorOverride] = useState(existing?.sector || '');
  // Optional look-through sector breakdown for ETFs / funds: rows of
  // { sector, weight } (weight as a % string). When set, the allocation chart
  // splits this holding across these sectors instead of one bucket.
  const [sectorRows, setSectorRows] = useState(() =>
    Array.isArray(initialSectorWeights)
      ? initialSectorWeights.map(w => ({ sector: w.sector || '', weight: w.weight != null ? String(w.weight) : '' }))
      : []);
  const cleanSectorRows = sectorRows
    .map(r => ({ sector: r.sector, weight: parseFloat(r.weight) }))
    .filter(r => r.sector && isFinite(r.weight) && r.weight > 0);
  // Holds the pending edit while the user confirms it: { changes, payload,
  // verifiedQuote }. null when no confirmation is in flight.
  const [confirmEdit, setConfirmEdit] = useState(null);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const detectedSector = ticker.trim() ? DATA.findSector(ticker.trim().toUpperCase(), market).sector : 'Other';
  const sectorValue = sectorOverride || (detectedSector !== 'Other' ? detectedSector : '');
  const sectorUnknown = !!ticker.trim() && detectedSector === 'Other' && !sectorOverride;
  // Trim float noise off a share count so "10" doesn't read back as "10.0000".
  const fmtShares = v => String(parseFloat(Number(v || 0).toFixed(6)));
  // For an edit, list exactly which fields changed (old → new) so the user can
  // see and confirm what they're about to save.
  const diffChanges = (payload) => {
    if (!existing) return [];
    const ex = existing;
    const out = [];
    const exTicker = String(ex.ticker || '').toUpperCase();
    if (payload.ticker !== exTicker) out.push({ label: 'Ticker', from: exTicker || '—', to: payload.ticker });
    if (payload.market !== ex.market) out.push({ label: 'Market', from: ex.market || '—', to: payload.market });
    if (Number(payload.shares) !== Number(ex.shares)) out.push({ label: 'Shares', from: fmtShares(ex.shares), to: fmtShares(payload.shares) });
    const exCcySym = CURRENCY_SYMBOLS[positionCostCcy(ex)] || ccy;
    if (Number(payload.costBasis) !== Number(ex.costBasis)) out.push({ label: 'Avg price', from: exCcySym + Number(ex.costBasis || 0).toFixed(2), to: ccy + Number(payload.costBasis).toFixed(2) });
    if ((payload.costCurrency || null) !== (ex.costCurrency || null)) out.push({ label: 'Cost currency', from: positionCostCcy(ex), to: payload.costCurrency || marketCurrency(payload.market) });
    if ((payload.purchaseDate || '') !== (ex.purchaseDate || '')) out.push({ label: 'Purchase date', from: ex.purchaseDate || '—', to: payload.purchaseDate || '—' });
    if ((payload.sector || '') !== (ex.sector || '')) out.push({ label: 'Sector', from: ex.sector || 'Other', to: payload.sector || 'Other' });
    const wStr = (ws) => Array.isArray(ws) && ws.length ? ws.map(w => `${w.sector} ${w.weight}%`).join(', ') : '—';
    const initW = Array.isArray(initialSectorWeights)
      ? initialSectorWeights.map(w => ({ sector: w.sector, weight: parseFloat(w.weight) })).filter(w => w.sector && isFinite(w.weight) && w.weight > 0)
      : [];
    if (wStr(initW) !== wStr(payload.sectorWeights)) out.push({ label: 'Sector split', from: wStr(initW), to: wStr(payload.sectorWeights) });
    if ((payload.notes || '') !== (ex.notes || '')) out.push({ label: 'Notes', from: ex.notes || '—', to: payload.notes || '—' });
    return out;
  };
  // The currency the cost basis is entered/stored in: the chosen fiat for crypto,
  // otherwise the market's native currency. Drives the input prefix and storage.
  const costCcyCode = isCrypto ? costCurrency : marketCurrency(market);
  // Per-unit cost: crypto in "total" mode derives it from total ÷ amount, so the
  // user can just type what they spent. Everything else is a direct per-share price.
  const perUnitCost = (isCrypto && costMode === 'total')
    ? ((parseDecimal(shares) > 0) ? parseDecimal(totalSpent) / parseDecimal(shares) : NaN)
    : parseDecimal(costBasis);
  const submit = async () => {
    if (!ticker.trim()) return;
    const s = parseDecimal(shares);
    const c = perUnitCost;
    if (!isFinite(s) || s <= 0) return;
    if (!isFinite(c) || c <= 0) return;
    if (purchaseDate && purchaseDate > todayISO) {
      setTickerError('Purchase date cannot be in the future.');
      return;
    }
    // Verify against the live feed for a new position, and for an edit whenever
    // the ticker or market changed — so re-pointing a holding to a corrected
    // listing is validated, while a pure shares/cost/date edit stays offline.
    const listingChanged = isEdit && existing &&
      (ticker.trim().toUpperCase() !== String(existing.ticker || '').toUpperCase() || market !== existing.market);
    let verifiedQuote = null;
    if (!isEdit || listingChanged) {
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
    const payload = {
      ticker: ticker.trim().toUpperCase(),
      market, shares: s, costBasis: c, notes,
      purchaseDate: purchaseDate || null,
      sector: sectorValue || null,
      sectorWeights: cleanSectorRows.length ? cleanSectorRows : null,
      // Only persist a cost currency when it genuinely differs from the market's
      // native one (crypto bought in ZAR) — keeps every normal holding untouched.
      costCurrency: (isCrypto && costCcyCode !== marketCurrency(market)) ? costCcyCode : undefined
    };
    // Editing an existing holding: confirm the change first and show exactly
    // what's changing (field: old → new) so an accidental edit can't slip
    // through. A brand-new position saves straight away.
    if (isEdit) {
      const changes = diffChanges(payload);
      if (changes.length === 0) { onClose(); return; }
      setConfirmEdit({ changes, payload, verifiedQuote });
      return;
    }
    onSave(payload, verifiedQuote);
  };
  const ccy = isCrypto ? (CURRENCY_SYMBOLS[costCurrency] || '$') : (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).sym;
  return React.createElement(React.Fragment, null, React.createElement("div", {
    className: "modal"
  }, React.createElement("div", {
    className: "modal-backdrop",
    onClick: onClose
  }), React.createElement("div", {
    className: "modal-panel",
    ref: panelRef,
    style: {
      maxWidth: 520
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
    onChange: v => { setMarket(v); setTickerError(''); }
  })), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Ticker"), React.createElement(TickerSearch, {
    value: ticker,
    onChange: v => { setTicker(v); setTickerError(''); },
    market: market,
    onMarketChange: m2 => { setMarket(m2); setTickerError(''); }
  }), tickerError ? React.createElement("div", { className: "verify-error" }, tickerError) : null,
    isEdit ? React.createElement("div", { className: "form-help" },
      "Change the ticker or market to re-point this holding to the correct live listing (e.g. if it was imported or added incorrectly). Your shares, cost and date stay as below.") : null), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Sector"), React.createElement("select", {
    className: "import-field-select" + (sectorUnknown ? " bad" : ""),
    value: sectorValue,
    onChange: e => setSectorOverride(e.target.value)
  }, React.createElement("option", { value: "" }, "Other (uncategorised)"),
     (DATA.SECTOR_CANON || []).map(s => React.createElement("option", { key: s, value: s }, s))),
    React.createElement("div", { className: "form-help" },
      !ticker.trim() ? "Pick a ticker first — we'll auto-detect the sector."
        : sectorUnknown ? "Couldn't auto-detect this one — choose where it lands in your allocation chart."
        : "Where this lands in your allocation chart (auto-detected — change if needed).")
  ), (!isCrypto && React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Sector breakdown (ETFs & funds)"),
    React.createElement(SectorWeightRows, { rows: sectorRows, setRows: setSectorRows })
  )), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, isCrypto ? "Amount" : "Shares"), React.createElement("input", {
    type: "text",
    inputMode: "decimal",
    autoComplete: "off",
    autoCorrect: "off",
    spellCheck: false,
    placeholder: isCrypto ? "0.5" : "10",
    value: shares,
    onChange: e => setShares(sanitizeDecimalInput(e.target.value))
  }), isCrypto ? React.createElement("div", { className: "form-help" },
      "Number of coins or tokens you hold — fractional amounts are fine.") : null),
  isCrypto ? React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", { className: "form-label" }, "Cost"),
    React.createElement("div", { className: "crypto-cost-controls" },
      React.createElement("select", {
        className: "import-field-select crypto-cost-ccy",
        value: costCurrency,
        onChange: e => setCostCurrency(e.target.value),
        "aria-label": "Cost currency"
      }, DISPLAY_CURRENCIES.map(d => React.createElement("option", { key: d.code, value: d.code }, d.code + " (" + d.sym + ")"))),
      React.createElement("div", { className: "seg-toggle crypto-cost-mode" },
        React.createElement("button", {
          type: "button", className: "seg-opt" + (costMode === 'total' ? " active" : ""),
          onClick: () => setCostMode('total')
        }, "Total spent"),
        React.createElement("button", {
          type: "button", className: "seg-opt" + (costMode === 'perUnit' ? " active" : ""),
          onClick: () => setCostMode('perUnit')
        }, "Price per coin"))),
    React.createElement("div", { className: "input-prefix-wrap" },
      React.createElement("span", { className: "prefix" }, ccy),
      React.createElement("input", {
        type: "text", inputMode: "decimal", autoComplete: "off", autoCorrect: "off", spellCheck: false,
        placeholder: "0.00",
        value: costMode === 'total' ? totalSpent : costBasis,
        onChange: e => (costMode === 'total' ? setTotalSpent : setCostBasis)(sanitizeDecimalInput(e.target.value))
      })),
    React.createElement("div", { className: "form-help" },
      costMode === 'total'
        ? (isFinite(perUnitCost) && perUnitCost > 0
            ? "≈ " + ccy + perUnitCost.toLocaleString('en-US', { maximumFractionDigits: 8 }) + " per coin"
            : "Total you paid in " + costCurrency + " — we'll work out the per-coin cost.")
        : (parseDecimal(shares) > 0 && isFinite(perUnitCost) && perUnitCost > 0
            ? "Total ≈ " + ccy + (perUnitCost * parseDecimal(shares)).toLocaleString('en-US', { maximumFractionDigits: 2 })
            : "Price per coin you paid, in " + costCurrency + ".")),
    costCurrency !== 'USD' ? React.createElement("div", { className: "form-help" },
      "Priced live in USD and converted to " + costCurrency + " — your " + costCurrency + " cost is kept as-is.") : null)
  : React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Purchase price per share"), React.createElement("div", {
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
  }, verifying ? 'Verifying…' : isEdit ? 'Save changes' : 'Add position'))))),
    confirmEdit ? ReactDOM.createPortal(
      React.createElement("div", { className: "import-confirm import-confirm-elevated" },
        React.createElement("div", { className: "import-confirm-card", style: { maxWidth: 400 } },
          React.createElement("div", { className: "import-confirm-title" }, "Save these changes?"),
          React.createElement("div", { className: "import-confirm-body" },
            "You're editing ",
            React.createElement("strong", null, existing && existing.ticker ? String(existing.ticker).toUpperCase() : "this holding"),
            ". Confirm what's changing:"),
          React.createElement("div", { className: "edit-confirm-diff" },
            confirmEdit.changes.map((ch, i) => React.createElement("div", { key: i, className: "edit-diff-row" },
              React.createElement("div", { className: "edit-diff-label" }, ch.label),
              React.createElement("div", { className: "edit-diff-vals" },
                React.createElement("span", { className: "edit-diff-from" }, ch.from),
                React.createElement(Icon, { name: "chevron", size: 13, className: "edit-diff-arrow" }),
                React.createElement("span", { className: "edit-diff-to" }, ch.to))))),
          React.createElement("div", { className: "import-confirm-actions" },
            React.createElement("button", { className: "btn btn-secondary", onClick: () => setConfirmEdit(null) }, "Keep editing"),
            React.createElement("button", {
              className: "btn btn-primary",
              onClick: () => { const ce = confirmEdit; setConfirmEdit(null); onSave(ce.payload, ce.verifiedQuote); }
            }, "Save changes")))),
      document.body) : null);
}
function SellModal({ position, onClose, onSell }) {
  const prices = PBStore.usePricesMap();
  const [shares, setShares] = useState('');
  const [pctStr, setPctStr] = useState('');
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
  // Sell by % of holding: typing a % (or clicking a chip) fills the share count,
  // and the app works out the rest. 100% sells the whole position cleanly. The %
  // box and the shares box stay in sync — editing either updates the other.
  const sharesFromPct = (pct) => {
    if (!isFinite(pct)) return;
    const c = Math.max(0, Math.min(100, pct));
    if (c >= 100) { setShares(position.shares.toString()); return; }
    const raw = position.shares * c / 100;
    // Round to 4 dp to avoid float noise, then trim trailing zeros.
    setShares(parseFloat(raw.toFixed(4)).toString());
  };
  // Drive everything from the % box: set the displayed % and the matching shares.
  const applyPctInput = (v) => {
    setPctStr(v);
    sharesFromPct(parseDecimal(v));
  };
  // Quick chip: fill both boxes from a round percentage.
  const applyPctChip = (pct) => {
    setPctStr(String(pct));
    sharesFromPct(pct);
  };
  // Editing the shares box directly keeps the % box in step.
  const applySharesInput = (v) => {
    setShares(v);
    const n = parseDecimal(v);
    setPctStr(isFinite(n) && position.shares > 0
      ? String(parseFloat((n / position.shares * 100).toFixed(2)))
      : '');
  };
  const pctOfHolding = isFinite(numShares) && position.shares > 0 ? numShares / position.shares * 100 : null;
  const valid = isFinite(numShares) && numShares > 0 && numShares <= position.shares && isFinite(numPrice) && numPrice > 0;
  const pnl = valid ? (numPrice - position.costBasis) * numShares : null;
  const submit = () => {
    if (!valid) return;
    onSell(position.ticker, position.market, numShares, numPrice, sellDate, notes);
    onClose();
  };
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel", ref: panelRef, style: { maxWidth: 520 } },
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
          React.createElement("label", { className: "form-label" }, "Portion to sell"),
          React.createElement("div", { className: "sell-pct-row" },
            React.createElement("div", { className: "sell-pct-chips" },
              [25, 50, 75, 100].map(pct => {
                const active = pctOfHolding != null && Math.abs(pctOfHolding - pct) < 0.05;
                return React.createElement("button", {
                  key: pct, type: "button",
                  className: `sell-pct-chip ${active ? 'active' : ''}`,
                  onClick: () => applyPctChip(pct)
                }, pct === 100 ? "All" : pct + "%");
              })),
            React.createElement("div", { className: "input-suffix-wrap sell-pct-input" },
              React.createElement("input", {
                type: "text", inputMode: "decimal",
                autoComplete: "off", autoCorrect: "off", spellCheck: false,
                "aria-label": "Percent to sell",
                placeholder: "0",
                value: pctStr, onChange: e => applyPctInput(sanitizeDecimalInput(e.target.value))
              }),
              React.createElement("span", { className: "suffix" }, "%"))),
          React.createElement("div", { className: "form-help" }, "Type a percentage (or tap a chip) and we'll work out the shares — or enter an exact share count below.")),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Shares to sell"),
          React.createElement("input", {
            type: "text", inputMode: "decimal",
            autoComplete: "off", autoCorrect: "off", spellCheck: false,
            placeholder: position.shares.toString(),
            value: shares, onChange: e => applySharesInput(sanitizeDecimalInput(e.target.value))
          }),
          React.createElement("div", { className: "form-help" },
            "Max: ", position.shares,
            pctOfHolding != null && numShares > 0 && numShares <= position.shares
              ? React.createElement("span", { className: "text-dim" }, " · ", pctOfHolding.toFixed(pctOfHolding % 1 === 0 ? 0 : 1), "% of holding")
              : null,
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
          React.createElement("div", { className: "text-xs text-dim" }, "Estimated P/L"),
          React.createElement("div", { className: `mono font-semibold ${pnl >= 0 ? 'text-up' : 'text-down'}`, style: { fontSize: 18 } },
            (pnl >= 0 ? '+' : '') + ccy + Math.abs(pnl).toFixed(2))),
        React.createElement("div", { className: "form-actions" },
          React.createElement("button", { className: "btn btn-secondary", onClick: onClose }, "Cancel"),
          React.createElement("button", {
            className: "btn btn-danger", onClick: submit, disabled: !valid
          }, "Record sale")))));
}
// Buy more of an existing holding. Adds shares at a new cost/share and lets the
// shared addPosition merge + re-average the position. Previews the resulting
// share count and blended average cost before committing.
function BuyModal({ position, fxRates, onClose, onBuy }) {
  const prices = PBStore.usePricesMap();
  const [shares, setShares] = useState('');
  const [buyPrice, setBuyPrice] = useState('');
  const todayISO = new Date().toISOString().slice(0, 10);
  const [buyDate, setBuyDate] = useState(todayISO);
  const [notes, setNotes] = useState('');
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const q = prices[priceKey(position.market, position.ticker)];
  // Top up in the same currency the holding's cost is booked in: native for a
  // normal holding, the chosen fiat for crypto bought in ZAR. The live quote is
  // in the market's native currency, so seed it converted into the cost currency.
  const isCryptoPos = position.market === 'CRYPTO';
  const nativeCode = marketCurrency(position.market);
  const costCcy = positionCostCcy(position);
  const rates = fxRates?.rates || null;
  const seededPrice = q ? (costCcy === nativeCode ? q.price : convertCcy(q.price, nativeCode, costCcy, rates)) : null;
  useEffect(() => {
    if (seededPrice != null && isFinite(seededPrice) && !buyPrice) setBuyPrice(seededPrice.toFixed(2));
  }, [seededPrice]);
  const ccy = isCryptoPos ? (CURRENCY_SYMBOLS[costCcy] || '$') : (MARKET_CURRENCY[position.market] || MARKET_CURRENCY.US).sym;
  const numShares = parseDecimal(shares);
  const numPrice = parseDecimal(buyPrice);
  const dateOk = !buyDate || buyDate <= todayISO;
  const valid = isFinite(numShares) && numShares > 0 && isFinite(numPrice) && numPrice > 0 && dateOk;
  const addAmount = valid ? numShares * numPrice : null;
  const newTotalShares = valid ? position.shares + numShares : position.shares;
  const newAvg = valid ? (position.shares * position.costBasis + numShares * numPrice) / newTotalShares : null;
  const submit = () => {
    if (!valid) return;
    onBuy(position.ticker, position.market, numShares, numPrice, buyDate, notes, costCcy);
    onClose();
  };
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel", ref: panelRef, style: { maxWidth: 520 } },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, "Buy more ", position.ticker),
          React.createElement("div", { className: "modal-subtitle" },
            position.shares, isCryptoPos ? " held \xB7 avg " : (position.shares === 1 ? " share held \xB7 avg " : " shares held \xB7 avg "), ccy, position.costBasis.toFixed(2))),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" }))),
      React.createElement("div", { className: "modal-body" },
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, isCryptoPos ? "Amount to buy" : "Shares to buy"),
          React.createElement("input", {
            type: "text", inputMode: "decimal",
            autoComplete: "off", autoCorrect: "off", spellCheck: false,
            placeholder: isCryptoPos ? "0.5" : "10",
            value: shares, onChange: e => setShares(sanitizeDecimalInput(e.target.value))
          })),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, isCryptoPos ? ("Cost per coin (" + costCcy + ")") : "Cost per share"),
          React.createElement("div", { className: "input-prefix-wrap" },
            React.createElement("span", { className: "prefix" }, ccy),
            React.createElement("input", {
              type: "text", inputMode: "decimal",
              autoComplete: "off", autoCorrect: "off", spellCheck: false,
              placeholder: seededPrice != null && isFinite(seededPrice) ? seededPrice.toFixed(2) : '0.00',
              value: buyPrice, onChange: e => setBuyPrice(sanitizeDecimalInput(e.target.value))
            }))),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Purchase date"),
          React.createElement("input", {
            type: "date", value: buyDate, max: todayISO,
            onChange: e => setBuyDate(e.target.value)
          })),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Notes (optional)"),
          React.createElement("input", {
            type: "text", maxLength: "200", placeholder: "e.g. Added on the dip",
            value: notes, onChange: e => setNotes(e.target.value)
          })),
        addAmount != null && React.createElement("div", {
          className: "card buy-preview", style: { padding: '10px 14px' }
        },
          React.createElement("div", { className: "buy-preview-row" },
            React.createElement("span", { className: "text-xs text-dim" }, "Amount"),
            React.createElement("span", { className: "mono font-semibold" }, ccy + addAmount.toFixed(2))),
          React.createElement("div", { className: "buy-preview-row" },
            React.createElement("span", { className: "text-xs text-dim" }, "New position"),
            React.createElement("span", { className: "mono font-semibold" },
              newTotalShares, " sh \xB7 avg ", ccy, newAvg.toFixed(2)))),
        React.createElement("div", { className: "form-actions" },
          React.createElement("button", { className: "btn btn-secondary", onClick: onClose }, "Cancel"),
          React.createElement("button", {
            className: "btn btn-primary", onClick: submit, disabled: !valid
          }, "Add shares")))));
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

function FxSummary({ positions, contributions, fxRates, displayCurrency, onSetDisplayCurrency }) {
  const prices = PBStore.usePricesMap();
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
        React.createElement("span", { className: "lbl" }, "Price P/L (native moves)"),
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

// Premium drag-to-reorder list for Settings → Tabs. Pointer-driven (works with
// mouse + touch via setPointerCapture). The dragged row lifts and tracks the
// finger 1:1; the others glide to their new slots with a FLIP animation. The
// working order lives in local state during a drag and is committed to the
// parent on release, so persistence only fires once.
function TabReorderList({ tabOrder, hiddenTabs, onToggleHidden }) {
  const [order, setOrder] = useState(tabOrder);
  const [dragKey, setDragKey] = useState(null);
  const orderRef = useRef(order);
  orderRef.current = order;
  const draggingRef = useRef(false);
  const dragRef = useRef(null);
  const rowEls = useRef(new Map());
  const prevTops = useRef(new Map());

  // Re-sync when the parent order changes and we're not mid-drag.
  useEffect(() => { if (!draggingRef.current) setOrder(tabOrder); }, [tabOrder]);

  // The lifted row's transform: stay glued to the finger and keep a subtle lift
  // scale (matching the .is-dragging CSS, which the inline transform overrides).
  const liftTransform = (y) => `translateY(${y}px) scale(1.02)`;

  // FLIP after each reorder commit. Non-dragged rows animate from their captured
  // positions to the new layout; the dragged row is silently re-glued to the
  // finger from its NEW slot (pre-paint, so there's no one-frame back-jump).
  useLayoutEffect(() => {
    const prev = prevTops.current;
    if (!prev.size) return;
    const d = dragRef.current;
    rowEls.current.forEach((el, key) => {
      if (!el) return;
      if (key === dragKey) {
        if (!d) return;
        el.style.transition = 'none';
        el.style.transform = '';
        const top = el.getBoundingClientRect().top;
        d.naturalTop = top;
        el.style.transform = liftTransform(d.pointerY - d.grabOffset - top);
        return;
      }
      const before = prev.get(key);
      if (before == null) return;
      const after = el.getBoundingClientRect().top;
      const dy = before - after;
      if (!dy) return;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      void el.offsetHeight; // force reflow so the next change animates
      el.style.transition = 'transform 0.24s cubic-bezier(0.22,1,0.36,1)';
      el.style.transform = '';
    });
    prev.clear();
  }, [order, dragKey]);

  const captureTops = () => {
    const m = prevTops.current; m.clear();
    rowEls.current.forEach((el, key) => { if (el) m.set(key, el.getBoundingClientRect().top); });
  };

  const onHandleDown = (e, key) => {
    if (e.button != null && e.button !== 0) return;
    const el = rowEls.current.get(key);
    if (!el) return;
    e.preventDefault();
    draggingRef.current = true;
    const rect = el.getBoundingClientRect();
    const stride = el.offsetHeight + 8; // row height + list gap
    // Track a synchronous working copy + index so the gesture stays correct even
    // before React commits the reorder (setState is batched/async). grabOffset is
    // where the finger sits within the row; naturalTop is the top of its current
    // slot — together they keep the lifted row pinned to the finger.
    const work = orderRef.current.slice();
    dragRef.current = {
      key, stride, idx: work.indexOf(key), work,
      grabOffset: e.clientY - rect.top, naturalTop: rect.top, pointerY: e.clientY
    };
    el.style.transition = 'none';
    setDragKey(key);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_e) {}
  };
  const onHandleMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    d.pointerY = e.clientY;
    const el = rowEls.current.get(d.key);
    // Glue the lifted row to the finger relative to its current slot.
    if (el) el.style.transform = liftTransform(d.pointerY - d.grabOffset - d.naturalTop);
    // Slots crossed from the current natural slot. The layout effect re-measures
    // naturalTop after the commit, so multi-slot fast drags settle correctly.
    const displacement = (d.pointerY - d.grabOffset) - d.naturalTop;
    const steps = Math.round(displacement / d.stride);
    if (steps !== 0) {
      const target = Math.max(0, Math.min(d.work.length - 1, d.idx + steps));
      if (target !== d.idx) {
        captureTops();
        d.work.splice(target, 0, d.work.splice(d.idx, 1)[0]);
        d.idx = target;
        setOrder(d.work.slice());
      }
    }
  };
  const endDrag = () => {
    const d = dragRef.current;
    if (!d) { draggingRef.current = false; setDragKey(null); return; }
    const el = rowEls.current.get(d.key);
    if (el) {
      el.style.transition = 'transform 0.26s cubic-bezier(0.22,1,0.36,1)';
      el.style.transform = '';
      const clear = () => { el.style.transition = ''; };
      el.addEventListener('transitionend', clear, { once: true });
      setTimeout(clear, 340);
    }
    const finalOrder = d.work;
    dragRef.current = null;
    draggingRef.current = false;
    setDragKey(null);
    PBStore.setSetting('tabOrder', finalOrder);
  };

  return React.createElement("div", { className: "tab-config-list" + (dragKey ? " dragging" : "") },
    order.map((key) => {
      const hidden = (hiddenTabs || []).includes(key) && key !== TAB_ALWAYS_VISIBLE;
      const pinned = key === TAB_ALWAYS_VISIBLE;
      return React.createElement("div", {
        key: key,
        ref: el => { if (el) rowEls.current.set(key, el); else rowEls.current.delete(key); },
        className: "tab-config-row" + (hidden ? " is-hidden" : "") + (dragKey === key ? " is-dragging" : "")
      },
        React.createElement("button", {
          className: "tab-config-grip", type: "button", "aria-label": "Drag to reorder",
          onPointerDown: e => onHandleDown(e, key),
          onPointerMove: onHandleMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag
        }, React.createElement(Icon, { name: "grip", size: 18 })),
        React.createElement("span", { className: "tab-config-name" }, TAB_LABELS[key] || key),
        pinned
          ? React.createElement("span", { className: "tab-config-pin" }, "Always on")
          : React.createElement("button", {
              className: "tab-config-toggle" + (hidden ? "" : " on"), type: "button",
              "aria-label": hidden ? "Show tab" : "Hide tab", onClick: () => onToggleHidden(key)
            }, React.createElement(Icon, { name: hidden ? "eye-off" : "eye", size: 15 })));
    })
  );
}

function SettingsModal({ fxRates, onRefreshFx,
                        positions, contributions, onExport, onImport, cloudBackup, onDeleteHoldings,
                        tabOrder, hiddenTabs,
                        pushStatus, onConnectPush, onTestPush, onDisconnectPush, onClose }) {
  const prices = PBStore.usePricesMap();
  // Settings edited here are read/written directly on the store (no prop-drilling).
  const displayCurrency = PBStore.useSetting('displayCurrency');
  const ribbonItems = PBStore.useSetting('ribbonItems');
  const ribbonMode = PBStore.useSetting('ribbonMode');
  const perplexityKey = PBStore.useSetting('perplexityKey');
  const pushBackend = PBStore.useSetting('pushBackend');
  const iconTheme = PBStore.useSetting('iconTheme');
  const theme = PBStore.useSetting('theme');
  const donutPalette = PBStore.useSetting('donutPalette');
  const donutTopN = PBStore.useSetting('donutTopN');
  const previewMode = PBStore.useSetting('previewMode');
  const [refreshing, setRefreshing] = useState(false);
  const [activeSection, setActiveSection] = useState('display');
  const [selectedDel, setSelectedDel] = useState(() => new Set());
  const [confirmDel, setConfirmDel] = useState(false);
  const [pkDraft, setPkDraft] = useState(perplexityKey || '');
  const [pkReveal, setPkReveal] = useState(false);
  const [pushDraft, setPushDraft] = useState(pushBackend || '');
  const [restoreCode, setRestoreCode] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreErr, setRestoreErr] = useState('');
  const [codeCopied, setCodeCopied] = useState(false);
  const [codeReveal, setCodeReveal] = useState(false);
  const fileInputRef = useRef(null);
  const panelRef = useRef(null);
  // Settings is a centered dialog (premium app feel), not a swipe-down sheet,
  // so it doesn't use useSwipeDownToClose — close via the X or backdrop.
  useBodyScrollLock();
  useEffect(() => { setPkDraft(perplexityKey || ''); }, [perplexityKey]);
  useEffect(() => { setPushDraft(pushBackend || ''); }, [pushBackend]);
  const snap = useMemo(
    () => computeFxSnapshot({ positions, contributions, prices, fxRates, displayCurrency }),
    [positions, contributions, prices, fxRates, displayCurrency]
  );
  const refresh = async () => {
    setRefreshing(true);
    try { await onRefreshFx(); } finally { setRefreshing(false); }
  };
  const rates = fxRates?.rates || {};
  // Connections (AI news + push) handlers
  const pkConfigured = !!perplexityKey;
  const savePk = () => PBStore.setSetting('perplexityKey', pkDraft.trim());
  const clearPk = () => { setPkDraft(''); PBStore.setSetting('perplexityKey', ''); };
  // Cloud backup handlers
  const cb = cloudBackup || {};
  const cbStatusLabel = {
    syncing: 'Syncing…', synced: 'Backed up', idle: 'Connected', error: 'Backend URL needed', off: 'Off'
  }[cb.status] || 'Off';
  const copyCode = async () => {
    try { await navigator.clipboard.writeText(formatCode(cb.code || '')); setCodeCopied(true); setTimeout(() => setCodeCopied(false), 1500); }
    catch (_e) { setCodeReveal(true); } // clipboard blocked — at least reveal it to copy by hand
  };
  const doRestore = async () => {
    setRestoreErr(''); setRestoreBusy(true);
    try { await cb.restore(restoreCode); /* reloads on success */ }
    catch (e) { setRestoreErr(e.message || 'Restore failed'); setRestoreBusy(false); }
  };
  // iOS-Settings-style sidebar: each section carries a colored icon tile and
  // lives in a labelled cluster. Tints stay inside the app palette so the rail
  // reads branded, not candy.
  const sections = [
    { key: 'display', label: 'Currency', icon: 'globe', tint: 'var(--blue)', group: 'General' },
    { key: 'appearance', label: 'Appearance', icon: 'image', tint: 'var(--purple)', group: 'General' },
    { key: 'tabs', label: 'Tabs', icon: 'list', tint: '#64748b', group: 'General' },
    { key: 'ribbon', label: 'Ribbon', icon: 'activity', tint: 'var(--amber)', group: 'General' },
    { key: 'fx', label: 'FX Rates', icon: 'refresh', tint: 'var(--emerald)', group: 'Portfolio' },
    { key: 'holdings', label: 'Holdings', icon: 'briefcase', tint: 'var(--brand)', group: 'Portfolio' },
    { key: 'preview', label: 'Preview', icon: 'eye', tint: '#0ea5e9', group: 'Portfolio' },
    { key: 'connections', label: 'Connections', icon: 'link', tint: 'var(--rose)', group: 'Data & sync' },
    { key: 'data', label: 'Data', icon: 'download', tint: '#71717a', group: 'Data & sync' },
  ];
  const navGroups = [];
  sections.forEach(s => {
    const last = navGroups[navGroups.length - 1];
    if (!last || last.title !== s.group) navGroups.push({ title: s.group, items: [s] });
    else last.items.push(s);
  });
  const toggleTabHidden = (key) => {
    if (key === TAB_ALWAYS_VISIBLE) return;
    const hidden = (hiddenTabs || []);
    PBStore.setSetting('hiddenTabs', hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key]);
  };
  // Group positions by market for the delete tool, ordered like the Holdings tabs.
  const marketOrder = MARKETS.map(m => m.value);
  const delGroups = Array.from(new Set(positions.map(p => p.market)))
    .sort((a, b) => marketOrder.indexOf(a) - marketOrder.indexOf(b))
    .map(mkt => ({
      market: mkt,
      label: MARKET_LABELS[mkt] || mkt,
      rows: positions.filter(p => p.market === mkt),
    }));
  const toggleDel = (id) => setSelectedDel(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleDelMarket = (rows) => setSelectedDel(prev => {
    const next = new Set(prev);
    const allSel = rows.every(r => next.has(r.id));
    rows.forEach(r => allSel ? next.delete(r.id) : next.add(r.id));
    return next;
  });
  const selectedRows = positions.filter(p => selectedDel.has(p.id));
  // Delete is a two-step in-dialog confirm (premium feel — no jarring browser
  // confirm()). The trash button arms `confirmDel`, which swaps the list for a
  // confirmation panel; only its red "Delete" commits.
  const doDeleteHoldings = () => {
    const ids = Array.from(selectedDel);
    if (ids.length === 0 || !onDeleteHoldings) { setConfirmDel(false); return; }
    onDeleteHoldings(ids);
    setSelectedDel(new Set());
    setConfirmDel(false);
  };
  const holdingValue = (p) => {
    const q = prices[priceKey(p.market, p.ticker)];
    const px = q && isFinite(q.price) ? q.price : (isFinite(p.costBasis) ? p.costBasis : null);
    return px == null ? null : px * p.shares;
  };
  const activeLabel = (sections.find(s => s.key === activeSection) || {}).label || '';
  return React.createElement("div", { className: "settings-overlay" },
    React.createElement("div", { className: "settings-backdrop", onClick: onClose }),
    React.createElement("div", { className: "settings-dialog", ref: panelRef },
      React.createElement("div", { className: "settings-dialog-header" },
        React.createElement("div", { className: "settings-logo" }, React.createElement(Icon, { name: "settings", size: 18 })),
        React.createElement("div", { className: "settings-dialog-titles" },
          React.createElement("div", { className: "settings-dialog-title" }, "Settings"),
          React.createElement("div", { className: "settings-dialog-sub" }, "Preferences \xB7 portfolio \xB7 data")),
        React.createElement("button", { className: "modal-close", onClick: onClose, 'aria-label': "Close" },
          React.createElement(Icon, { name: "x" })
        )
      ),
      React.createElement("div", { className: "settings-dialog-body" },
        React.createElement("nav", { className: "settings-nav", "aria-label": "Settings sections" },
          navGroups.map(g => React.createElement("div", { className: "settings-nav-group", key: g.title },
            React.createElement("div", { className: "settings-nav-group-title" }, g.title),
            g.items.map(s => React.createElement("button", {
              key: s.key,
              className: `settings-nav-item ${activeSection === s.key ? 'active' : ''}`,
              "aria-current": activeSection === s.key ? 'page' : undefined,
              onClick: () => setActiveSection(s.key)
            },
              React.createElement("span", { className: "settings-nav-ico", style: { background: s.tint } },
                React.createElement(Icon, { name: s.icon, size: 13 })),
              React.createElement("span", { className: "settings-nav-label" }, s.label)))))
        ),
        React.createElement("div", { className: "settings-content" + (activeSection === 'holdings' && positions.length > 0 && !confirmDel ? " has-sticky-bar" : "") },
        React.createElement("div", { className: "settings-content-title" }, activeLabel),
        activeSection === 'display' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Display currency"),
              React.createElement("div", { className: "settings-row-desc" }, "Portfolio totals and FX shown in this currency")
            ),
            React.createElement("select", {
              value: displayCurrency,
              onChange: e => PBStore.setSetting('displayCurrency', e.target.value),
              style: { width: 'auto', minWidth: 110 }
            }, DISPLAY_CURRENCIES.map(c => React.createElement("option", {
              key: c.code, value: c.code
            }, c.sym + " " + c.code)))
          ),
          React.createElement("div", { className: "settings-info-box" },
            React.createElement("div", { className: "settings-info-title" },
              React.createElement(Icon, { name: "globe", size: 12 }), " How FX gain/loss is calculated"),
            React.createElement("div", { className: "settings-info-body" },
              "When you add a position, the live exchange rate is stored. Price P/L tracks native-currency changes. FX impact shows how much your ", displayCurrency, " value has shifted purely from currency moves.")
          )
        ),
        activeSection === 'preview' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-row mb-3" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Preview mode"),
              React.createElement("div", { className: "settings-row-desc" },
                "Show the app with a realistic demo portfolio — trendy stocks across every market and sector, live prices, invented sizes. Your real holdings stay untouched and hidden while it's on; editing is disabled.")
            ),
            React.createElement("div", { className: "seg-toggle", style: { flex: '0 0 auto', minWidth: 168 } },
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (!previewMode ? " active" : ""),
                onClick: () => PBStore.setSetting('previewMode', false),
                "aria-pressed": !previewMode
              }, "Off"),
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (previewMode ? " active" : ""),
                onClick: () => PBStore.setSetting('previewMode', true),
                "aria-pressed": previewMode
              }, "On")
            )
          ),
          previewMode && React.createElement("div", { className: "settings-row-desc" },
            "Preview is on — a \"Preview\" pill shows in the header. Alerts pause while it's on.")
        ),
        activeSection === 'appearance' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-row mb-3" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Theme"),
              React.createElement("div", { className: "settings-row-desc" }, "Light or dark appearance for the app")
            ),
            React.createElement("div", { className: "seg-toggle", style: { flex: '0 0 auto', minWidth: 168 } },
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (theme === 'light' ? " active" : ""),
                style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
                onClick: () => PBStore.setSetting('theme', 'light'),
                "aria-pressed": theme === 'light'
              }, React.createElement(Icon, { name: "sun", size: 14 }), "Light"),
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (theme !== 'light' ? " active" : ""),
                style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
                onClick: () => PBStore.setSetting('theme', 'dark'),
                "aria-pressed": theme !== 'light'
              }, React.createElement(Icon, { name: "moon", size: 14 }), "Dark")
            )
          ),
          React.createElement("div", { className: "settings-section-title mb-1" }, "Home-screen icon"),
          React.createElement("div", { className: "settings-row-desc mb-3" },
            "Pick the app icon for your phone's home screen, the browser tab, and PWA install. On iPhone, remove and re-add Playbook to the Home Screen after switching to refresh the icon."),
          React.createElement("div", { className: "icon-choice-grid" },
            [
              { key: 'dark',  label: 'Dark',  tile: '#0B0B10', muted: '#3A3A52' },
              { key: 'light', label: 'Light', tile: '#FFFFFF', muted: '#C9CBDB' }
            ].map(opt => {
              const active = (iconTheme || 'dark') === opt.key;
              return React.createElement("button", {
                key: opt.key,
                type: "button",
                className: `icon-choice ${active ? 'active' : ''}`,
                onClick: () => PBStore.setSetting('iconTheme', opt.key),
                "aria-pressed": active
              },
                React.createElement("svg", { className: "icon-choice-tile", viewBox: "0 0 512 512", width: 76, height: 76, "aria-hidden": "true" },
                  React.createElement("rect", { width: 512, height: 512, rx: 114, fill: opt.tile }),
                  React.createElement("rect", { x: 142, y: 260, width: 56, height: 120, rx: 18, fill: opt.muted }),
                  React.createElement("rect", { x: 228, y: 180, width: 56, height: 200, rx: 18, fill: "#5A5AD0" }),
                  React.createElement("rect", { x: 314, y: 90, width: 56, height: 290, rx: 18, fill: "#6E6EF0" })
                ),
                React.createElement("span", { className: "icon-choice-label" }, opt.label),
                active && React.createElement("span", { className: "icon-choice-check" },
                  React.createElement(Icon, { name: "check", size: 13 }))
              );
            })
          ),
          React.createElement("div", { className: "settings-section-title mb-1", style: { marginTop: 20 } }, "Allocation chart"),
          React.createElement("div", { className: "settings-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Colour scale"),
              React.createElement("div", { className: "settings-row-desc" },
                (donutPalette === 'indigo')
                  ? "Indigo — the brand's periwinkle→blue gradient, a distinct shade per holding."
                  : "Spectrum — a distinct colour per holding across the full palette.")
            ),
            React.createElement("div", { className: "seg-toggle", style: { flex: '0 0 auto', minWidth: 168 } },
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (donutPalette !== 'indigo' ? " active" : ""),
                onClick: () => PBStore.setSetting('donutPalette', 'spectrum'),
                "aria-pressed": donutPalette !== 'indigo'
              }, "Spectrum"),
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (donutPalette === 'indigo' ? " active" : ""),
                onClick: () => PBStore.setSetting('donutPalette', 'indigo'),
                "aria-pressed": donutPalette === 'indigo'
              }, "Indigo")
            )
          ),
          React.createElement("div", { className: "settings-row", style: { marginTop: 14 } },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Holdings shown"),
              React.createElement("div", { className: "settings-row-desc" },
                "Show your largest holdings individually; the rest combine into “Other”. Sectors and markets are never grouped.")
            ),
            React.createElement("select", {
              value: String(donutTopN),
              onChange: e => PBStore.setSetting('donutTopN', parseInt(e.target.value, 10)),
              style: { width: 'auto', minWidth: 110 }
            },
              React.createElement("option", { value: "0" }, "All"),
              [5, 8, 10, 12, 15, 20, 30].map(nn => React.createElement("option", { key: nn, value: String(nn) }, "Top " + nn)))
          )
        ),
        activeSection === 'tabs' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-section-title mb-1" }, "Navigation tabs"),
          React.createElement("div", { className: "settings-row-desc mb-3" },
            "Drag the handle to reorder, and tap the eye to hide tabs you don't use. Dashboard is always shown."),
          React.createElement(TabReorderList, {
            tabOrder: (tabOrder || DEFAULT_TAB_ORDER),
            hiddenTabs: hiddenTabs,
            onToggleHidden: toggleTabHidden
          })
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
              onChange: e => PBStore.setSetting('ribbonMode', e.target.value),
              style: { width: 'auto', minWidth: 110 }
            },
              React.createElement("option", { value: "rows" }, "Rows of 3"),
              React.createElement("option", { value: "marquee" }, "Scrolling ticker"))
          ),
          React.createElement("div", { className: "settings-section-title mb-2" }, "Select items"),
          React.createElement("div", { className: "settings-row-desc mb-3" }, "Tap to toggle. Open any item from the ribbon for its chart, a plain-English explanation, and price alerts."),
          [
            { id: 'markets', label: 'Indices, commodities & crypto' },
            { id: 'macro',   label: 'Macro & rates' }
          ].map(grp => {
            const items = RIBBON_CATALOG.filter(i => (i.group || 'markets') === grp.id);
            if (!items.length) return null;
            return React.createElement(React.Fragment, { key: grp.id },
              React.createElement("div", { className: "ribbon-catalog-subhead" }, grp.label),
              React.createElement("div", { className: "ribbon-catalog-grid" },
                items.map(item => {
                  const active = ribbonItems.includes(item.key);
                  return React.createElement("button", {
                    key: item.key,
                    className: `ribbon-catalog-item ${active ? 'active' : ''}`,
                    onClick: () => {
                      if (active) PBStore.setSetting('ribbonItems', ribbonItems.filter(k => k !== item.key));
                      else PBStore.setSetting('ribbonItems', [...ribbonItems, item.key]);
                    }
                  },
                    React.createElement("span", { className: "ribbon-catalog-short" }, item.short),
                    React.createElement("span", { className: "ribbon-catalog-name" }, item.label)
                  );
                })
              )
            );
          })
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
        activeSection === 'holdings' && React.createElement("div", { className: "settings-section" },
          positions.length === 0
            ? React.createElement("div", { className: "settings-empty" },
                React.createElement(Icon, { name: "briefcase", size: 24 }),
                React.createElement("p", null, "No holdings to manage yet."))
          : confirmDel
            // ── Step 2: confirmation panel (replaces the list while armed) ──
            ? React.createElement("div", { className: "hm-confirm" },
                React.createElement("div", { className: "hm-confirm-icon" },
                  React.createElement(Icon, { name: "trash", size: 22 })),
                React.createElement("div", { className: "hm-confirm-title" },
                  "Delete ", selectedRows.length, " holding", selectedRows.length === 1 ? "" : "s", "?"),
                React.createElement("div", { className: "hm-confirm-body" },
                  "This permanently removes the position", selectedRows.length === 1 ? "" : "s",
                  " without recording a sale and can't be undone."),
                React.createElement("div", { className: "hm-confirm-list" },
                  selectedRows.map(p => {
                    const nm = positionDisplayName(p, p.market);
                    return React.createElement("div", { key: p.id, className: "hm-confirm-chip" },
                      React.createElement("span", { className: "hm-chip-tkr" }, p.ticker),
                      nm && nm !== p.ticker ? React.createElement("span", { className: "hm-chip-name" }, nm) : null,
                      React.createElement("span", { className: "hm-chip-mkt" }, MARKET_LABELS[p.market] || p.market));
                  })),
                React.createElement("div", { className: "hm-confirm-actions" },
                  React.createElement("button", { className: "btn btn-ghost", onClick: () => setConfirmDel(false) }, "Cancel"),
                  React.createElement("button", { className: "btn btn-danger", onClick: doDeleteHoldings },
                    React.createElement(Icon, { name: "trash", size: 14 }),
                    " Delete ", selectedRows.length, " holding", selectedRows.length === 1 ? "" : "s"))
              )
            // ── Step 1: premium selectable list ──
            : React.createElement(React.Fragment, null,
                React.createElement("div", { className: "settings-row-desc mb-3" },
                  "Select holdings to permanently delete. This removes positions without recording a sale — use ", React.createElement("b", null, "Sell"), " on the Holdings screen if you actually sold one."),
                React.createElement("div", { className: "hm-list" },
                  delGroups.map(g => {
                    const allSel = g.rows.every(r => selectedDel.has(r.id));
                    return React.createElement("div", { key: g.market, className: "hm-group" },
                      React.createElement("div", { className: "hm-group-head" },
                        React.createElement("span", { className: "hm-group-title" }, g.label),
                        React.createElement("span", { className: "hm-group-count" }, g.rows.length),
                        React.createElement("button", {
                          className: "hm-selectall", type: "button",
                          onClick: () => toggleDelMarket(g.rows)
                        }, allSel ? "Deselect all" : "Select all")),
                      React.createElement("div", { className: "hm-rows" },
                        g.rows.map(p => {
                          const nm = positionDisplayName(p, p.market);
                          const sel = selectedDel.has(p.id);
                          const val = holdingValue(p);
                          return React.createElement("button", {
                            key: p.id, type: "button",
                            className: "hm-row" + (sel ? " sel" : ""),
                            "aria-pressed": sel,
                            onClick: () => toggleDel(p.id)
                          },
                            React.createElement("span", { className: "hm-check" + (sel ? " on" : "") },
                              sel ? React.createElement(Icon, { name: "check", size: 13 }) : null),
                            React.createElement("span", { className: "hm-row-main" },
                              React.createElement("span", { className: "hm-row-tkr" }, p.ticker),
                              nm && nm !== p.ticker ? React.createElement("span", { className: "hm-row-name" }, nm) : null),
                            React.createElement("span", { className: "hm-row-meta" },
                              React.createElement("span", { className: "hm-row-val" }, val == null ? "—" : fmt(val, p.market)),
                              React.createElement("span", { className: "hm-row-qty" }, p.shares, " sh")));
                        })));
                  })),
                React.createElement("div", { className: "hm-bar" },
                  React.createElement("span", { className: "hm-bar-count" },
                    selectedDel.size > 0 ? selectedDel.size + " selected" : "None selected"),
                  React.createElement("div", { className: "hm-bar-actions" },
                    React.createElement("button", {
                      className: "btn btn-ghost btn-sm",
                      disabled: selectedDel.size === 0,
                      onClick: () => setSelectedDel(new Set())
                    }, "Clear"),
                    React.createElement("button", {
                      className: "btn btn-danger btn-sm",
                      disabled: selectedDel.size === 0,
                      onClick: () => setConfirmDel(true)
                    }, React.createElement(Icon, { name: "trash", size: 13 }),
                       selectedDel.size > 0 ? " Delete (" + selectedDel.size + ")" : " Delete")))
              )
        ),
        activeSection === 'connections' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-row-desc mb-3" },
            "Optional integrations that power AI news and always-on alerts. Keys and URLs are stored locally in this browser only."),
          // ── AI news (Perplexity) ──
          React.createElement("div", { className: "conn-card" + (pkConfigured ? " ok" : "") },
            React.createElement("div", { className: "conn-card-head" },
              React.createElement("div", { className: "conn-card-icon" }, React.createElement(Icon, { name: "activity", size: 16 })),
              React.createElement("div", { className: "conn-card-titles" },
                React.createElement("div", { className: "conn-card-title" }, "AI news"),
                React.createElement("div", { className: "conn-card-sub" }, "Perplexity")),
              React.createElement("span", { className: "conn-status" + (pkConfigured ? " on" : "") },
                pkConfigured ? "Configured" : "Off")),
            React.createElement("div", { className: "conn-card-body" },
              pkConfigured
                ? "Perplexity is pulling AI-curated headlines alongside Yahoo Finance RSS. Paste a new key to replace it, or remove to disable."
                : "Paste a Perplexity API key to pull AI-curated headlines alongside Yahoo Finance RSS."),
            React.createElement("div", { className: "pk-row" },
              React.createElement("input", {
                type: pkReveal ? "text" : "password",
                autoComplete: "off", spellCheck: false,
                placeholder: "pplx-…", value: pkDraft,
                onChange: e => setPkDraft(e.target.value),
                className: "pk-input"
              }),
              React.createElement("button", {
                className: "btn btn-ghost btn-xs", type: "button",
                onClick: () => setPkReveal(v => !v),
                "aria-label": pkReveal ? "Hide key" : "Reveal key"
              }, pkReveal ? "Hide" : "Show")),
            React.createElement("div", { className: "pk-actions" },
              React.createElement("button", {
                className: "btn btn-primary btn-xs", type: "button",
                disabled: pkDraft.trim() === (perplexityKey || ''),
                onClick: savePk
              }, pkConfigured ? "Update key" : "Save key"),
              pkConfigured && React.createElement("button", {
                className: "btn btn-ghost btn-xs", type: "button", onClick: clearPk
              }, "Remove"))
          ),
          // ── Background push server ──
          (() => {
            const meta = ({
              connected:   { cls: 'ok',   label: 'Connected' },
              connecting:  { cls: '',     label: 'Connecting…' },
              error:       { cls: 'err',  label: 'Not connected' },
              unsupported: { cls: 'warn', label: 'Unavailable' }
            })[pushStatus] || { cls: '', label: 'Off' };
            const body = pushStatus === 'connected'
              ? 'Connected. Your alerts are checked on the server every minute during market hours and pushed instantly — even with Playbook fully closed, on iPhone and Android.'
              : pushStatus === 'connecting'
              ? 'Connecting to your push server…'
              : pushStatus === 'unsupported'
              ? "Push isn't available in this browser. On iPhone, install to the Home Screen and reopen from the icon (iOS 16.4+)."
              : pushStatus === 'error'
              ? "Couldn't reach the server. Check the URL, make sure notifications are enabled, and that the worker is deployed."
              : 'The path to always-on, app-closed alerts. Deploy the free worker in the backend/ folder, then paste its URL here.';
            return React.createElement("div", { className: "conn-card " + meta.cls },
              React.createElement("div", { className: "conn-card-head" },
                React.createElement("div", { className: "conn-card-icon" }, React.createElement(Icon, { name: "bell", size: 16 })),
                React.createElement("div", { className: "conn-card-titles" },
                  React.createElement("div", { className: "conn-card-title" }, "Background push server"),
                  React.createElement("div", { className: "conn-card-sub" }, "Always-on alerts")),
                React.createElement("span", { className: "conn-status" + (pushStatus === 'connected' ? " on" : "") }, meta.label)),
              React.createElement("div", { className: "conn-card-body" }, body),
              React.createElement("div", { className: "pk-row" },
                React.createElement("input", {
                  type: "url", inputMode: "url", autoComplete: "off",
                  autoCapitalize: "none", spellCheck: false,
                  placeholder: "https://playbook-push.<you>.workers.dev",
                  value: pushDraft,
                  onChange: e => setPushDraft(e.target.value),
                  className: "pk-input"
                }),
                pushStatus === 'connected'
                  ? React.createElement("button", { className: "btn btn-ghost btn-xs", type: "button", onClick: onDisconnectPush }, "Disconnect")
                  : React.createElement("button", {
                      className: "btn btn-primary btn-xs", type: "button",
                      disabled: pushStatus === 'connecting',
                      onClick: () => onConnectPush(pushDraft)
                    }, pushStatus === 'connecting' ? "…" : "Connect")),
              pushStatus === 'connected' && React.createElement("div", { className: "pk-actions" },
                React.createElement("button", {
                  className: "btn btn-ghost btn-xs", type: "button", onClick: onTestPush
                }, React.createElement(Icon, { name: "bell", size: 13 }), " Send test push")));
          })()
        ),
        activeSection === 'data' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-data-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Save backup file"),
              React.createElement("div", { className: "settings-row-desc" }, "All data + settings as JSON. On iPhone, save it to Files / iCloud.")
            ),
            React.createElement("button", { className: "btn btn-secondary btn-sm", onClick: onExport },
              React.createElement(Icon, { name: "download", size: 13 }), " Export")
          ),
          React.createElement("div", { className: "settings-data-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Restore from file"),
              React.createElement("div", { className: "settings-row-desc" }, "Import a previously exported JSON backup (replaces current data)")
            ),
            React.createElement("button", { className: "btn btn-secondary btn-sm", onClick: () => fileInputRef.current?.click() },
              React.createElement(Icon, { name: "share", size: 13 }), " Import")
          ),
          React.createElement("input", {
            ref: fileInputRef, type: "file", accept: "application/json",
            style: { display: 'none' },
            onChange: e => { if (e.target.files[0]) onImport(e.target.files[0]); e.target.value = ''; }
          }),

          // ─── Cloud backup ─────────────────────────────────────────────────
          React.createElement("div", { className: "settings-content-title mt-4" }, "Cloud backup"),
          React.createElement("div", { className: "settings-data-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, cb.enabled ? "Auto-backup is on" : "Encrypted auto-backup"),
              React.createElement("div", { className: "settings-row-desc" },
                cb.enabled
                  ? ("Saved to your backend on every change. Status: " + cbStatusLabel + (cb.lastSync ? " \xB7 " + new Date(cb.lastSync).toLocaleString() : ""))
                  : "Keep an encrypted copy on your backend so data survives deleting + re-adding the app icon.")
            ),
            cb.enabled
              ? React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: cb.disable }, "Turn off")
              : React.createElement("button", { className: "btn btn-primary btn-sm", onClick: cb.enable, disabled: !cb.base },
                  React.createElement(Icon, { name: "refresh", size: 13 }), " Turn on")
          ),
          !cb.base && React.createElement("div", { className: "settings-info-box mt-2" },
            React.createElement("div", { className: "settings-info-body" },
              "Set your backend URL under Connections first — cloud backup uses the same server (redeploy the Worker so it has the /backup route).")
          ),
          cb.enabled && cb.code && React.createElement("div", { className: "settings-info-box mt-2" },
            React.createElement("div", { className: "settings-row-title" }, "Recovery code"),
            React.createElement("div", { className: "settings-row-desc" },
              "Write this down. You enter it to restore after re-adding the icon — it's the only key and can't be recovered for you."),
            React.createElement("div", { className: "pk-row mt-2" },
              React.createElement("code", { className: "pk-input", style: { letterSpacing: '0.12em', fontFamily: 'ui-monospace, monospace' } },
                codeReveal ? formatCode(cb.code) : "••••-••••-••••"),
              React.createElement("button", { className: "btn btn-ghost btn-xs", onClick: () => setCodeReveal(v => !v) }, codeReveal ? "Hide" : "Show"),
              React.createElement("button", { className: "btn btn-primary btn-xs", onClick: copyCode }, codeCopied ? "Copied!" : "Copy")
            ),
            React.createElement("div", { className: "pk-actions mt-2" },
              React.createElement("button", { className: "btn btn-ghost btn-xs", onClick: cb.pushNow, disabled: cb.status === 'syncing' },
                React.createElement(Icon, { name: "refresh", size: 13 }), cb.status === 'syncing' ? " Syncing…" : " Sync now"))
          ),

          // Restore-from-cloud — works on a fresh device too (enter the code).
          React.createElement("div", { className: "settings-data-row mt-3" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Restore from cloud"),
              React.createElement("div", { className: "settings-row-desc" }, "Re-added the icon? Enter your recovery code to pull your data back.")
            )
          ),
          React.createElement("div", { className: "pk-row" },
            React.createElement("input", {
              type: "text", inputMode: "text", autoComplete: "off", autoCapitalize: "characters", spellCheck: false,
              placeholder: "XXXX-XXXX-XXXX", value: restoreCode, className: "pk-input",
              onChange: e => setRestoreCode(e.target.value)
            }),
            React.createElement("button", {
              className: "btn btn-primary btn-xs", disabled: restoreBusy || !cb.base || normalizeCode(restoreCode).length < 8,
              onClick: doRestore
            }, restoreBusy ? "…" : "Restore")
          ),
          restoreErr && React.createElement("div", { className: "settings-row-desc", style: { color: 'var(--negative, #f87171)', marginTop: 6 } }, restoreErr),

          React.createElement("div", { className: "settings-info-box mt-3" },
            React.createElement("div", { className: "settings-info-body" },
              "Backups cover everything: holdings, watchlists & groups, alerts, contributions, transactions, sector weights, TFSA targets and all settings. Cloud copies are end-to-end encrypted — the server only stores unreadable ciphertext."
            )
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
window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt };
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(ErrorBoundary, null, React.createElement(ToastProvider, null, React.createElement(App, null))));
// SW registration handled in index.html with auto-update logic