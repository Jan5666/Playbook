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
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const isMobileLayout = () => window.matchMedia('(max-width: 639px)').matches;
    let startY = 0;
    let lastY = 0;
    let startScroll = 0;
    let dragging = false;
    const onTouchStart = (e) => {
      if (!isMobileLayout() || e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      lastY = startY;
      startScroll = panel.scrollTop;
      dragging = true;
    };
    const onTouchMove = (e) => {
      if (!dragging) return;
      lastY = e.touches[0].clientY;
      const dy = lastY - startY;
      if (dy <= 0) {
        panel.classList.remove('swiping');
        panel.style.transform = '';
        return;
      }
      if (startScroll > 0) { dragging = false; return; }
      panel.classList.add('swiping');
      panel.style.transform = `translateY(${dy}px)`;
      if (e.cancelable) e.preventDefault();
    };
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      const dy = lastY - startY;
      panel.classList.remove('swiping');
      if (dy > 110) {
        panel.classList.add('swipe-close');
        setTimeout(() => onClose(), 220);
      } else {
        panel.style.transform = '';
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
  }, [panelRef, onClose]);
}
const MARKET_CURRENCY = {
  US:  { sym: '$',   code: 'USD', label: 'USD' },
  JSE: { sym: 'R',   code: 'ZAR', label: 'ZAR' },
  LSE: { sym: '\u00a3',  code: 'GBP', label: 'GBP' },
  ASX: { sym: 'A$',  code: 'AUD', label: 'AUD' },
  FRA: { sym: '\u20ac',  code: 'EUR', label: 'EUR' },
  PAR: { sym: '\u20ac',  code: 'EUR', label: 'EUR' },
  AMS: { sym: '\u20ac',  code: 'EUR', label: 'EUR' },
};
const MARKETS = [
  { value: 'US',  label: 'US',  country: 'USA',         exchange: 'NYSE / NASDAQ' },
  { value: 'JSE', label: 'JSE', country: 'South Africa', exchange: 'JSE' },
  { value: 'LSE', label: 'LSE', country: 'UK',          exchange: 'London (LSE)' },
  { value: 'ASX', label: 'ASX', country: 'Australia',   exchange: 'ASX' },
  { value: 'FRA', label: 'FRA', country: 'Germany',     exchange: 'XETRA Frankfurt' },
  { value: 'PAR', label: 'PAR', country: 'France',      exchange: 'Euronext Paris' },
  { value: 'AMS', label: 'AMS', country: 'Netherlands', exchange: 'Euronext Amsterdam' },
];
const DISPLAY_CURRENCIES = [
  { code: 'USD', sym: '$',  label: 'US Dollar' },
  { code: 'ZAR', sym: 'R',  label: 'South African Rand' },
  { code: 'GBP', sym: '\u00a3', label: 'British Pound' },
  { code: 'AUD', sym: 'A$', label: 'Australian Dollar' },
  { code: 'EUR', sym: '\u20ac', label: 'Euro' },
];
const CURRENCY_SYMBOLS = { USD: '$', ZAR: 'R', GBP: '\u00a3', AUD: 'A$', EUR: '\u20ac' };
// CORS proxies for endpoints that don't allow direct browser fetches
// (Yahoo Finance, Stooq). Tried in order; first 200 wins. The ordering
// reflects observed reliability — corsproxy.io is the most stable.
const CORS_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
];
// FX endpoints often allow direct CORS; fall back to proxies only on failure.
const FX_PROXIES = [
  url => url,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
];
// Yahoo reports JSE in cents (ZAc) and LSE in pence (GBp / GBX) for some
// instruments. Values reported in those units must be divided by 100 to get
// the natural unit (rand, pound). Matching is case-insensitive and accepts
// the pence-suffix forms because Yahoo isn't perfectly consistent.
function priceKey(market, ticker) {
  return market + ':' + ticker;
}
function centDivisor(market, currency) {
  const raw = currency || '';
  const c = raw.toUpperCase();
  const isJseCent = market === 'JSE' && (c === 'ZAC' || c === 'ZAR' && /[cC]$/.test(raw));
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
  if (market === 'JSE') return ticker + '.JO';
  if (market === 'LSE') return ticker + '.L';
  if (market === 'ASX') return ticker + '.AX';
  if (market === 'FRA') return ticker + '.F';
  if (market === 'PAR') return ticker + '.PA';
  if (market === 'AMS') return ticker + '.AS';
  if (ticker === '^SPX') return '%5EGSPC';
  if (ticker === '^VIX') return '%5EVIX';
  if (ticker === '^GSPC') return '%5EGSPC';
  return ticker;
}
function stooqSymbol(ticker, market) {
  if (market === 'JSE') return ticker.toLowerCase() + '.jo';
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
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol(ticker, market)}?interval=1d&range=5d&includePrePost=true`;
  for (const buildProxy of CORS_PROXIES) {
    try {
      const res = await fetch(buildProxy(yahooUrl), { cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const quote = parseYahooQuote(result, market);
      if (quote) return quote;
    } catch (e) {}
  }
  // Stooq fallback only covers US and JSE; other markets just fail here.
  if (market !== 'US' && market !== 'JSE') {
    console.warn(`Price fetch failed for ${ticker} (${market})`);
    return null;
  }
  const stooqUrl = `https://stooq.com/q/d/l/?s=${stooqSymbol(ticker, market)}&i=d`;
  for (const buildProxy of CORS_PROXIES) {
    try {
      const res = await fetch(buildProxy(stooqUrl), { cache: 'no-store' });
      const text = await res.text();
      const quote = parseStooqCsv(text, market);
      if (quote) return quote;
    } catch (e) {}
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
  const batchSize = 4;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
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
  return results;
}
async function fetchHistory(ticker, market, range) {
  const sym = yahooSymbol(ticker, market);
  const r = range || '1y';
  const interval = r === '1d' ? '5m' : (r === '5d' ? '15m' : (r === '1mo' || r === '3mo' || r === '6mo' || r === '1y') ? '1d' : (r === '2y' || r === '5y') ? '1wk' : '1mo');
  const includePrePost = r === '1d' || r === '5d' ? '&includePrePost=true' : '';
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${r}${includePrePost}`;
  for (const buildProxy of CORS_PROXIES) {
    try {
      const res = await fetch(buildProxy(yahooUrl), { cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const ts = result.timestamp;
      const closes = result?.indicators?.quote?.[0]?.close;
      if (!Array.isArray(ts) || !Array.isArray(closes)) continue;
      let currency = result.meta?.currency || (MARKET_CURRENCY[market]?.code || 'USD');
      const divisor = centDivisor(market, currency);
      const points = [];
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (c == null || !isFinite(c)) continue;
        points.push({ t: ts[i] * 1000, p: c / divisor });
      }
      if (points.length < 2) continue;
      return { points, range: r, fetchedAt: Date.now() };
    } catch (e) {
      continue;
    }
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
  for (const yahooUrl of yahooUrls) for (const buildProxy of CORS_PROXIES) {
    try {
      const res = await fetch(buildProxy(yahooUrl), { cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      const r = data?.quoteSummary?.result?.[0];
      if (!r) continue;
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
        revenue: v(fd.totalRevenue),
        ebitda: v(fd.ebitda),
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
async function fetchFundamentals(ticker, market, companyName, perplexityKey) {
  const yahoo = await fetchFundamentalsYahoo(ticker, market);
  if (yahoo) return yahoo;
  if (perplexityKey) return await fetchFundamentalsPerplexity(ticker, market, companyName, perplexityKey);
  return null;
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
    size = 15
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
    }))
  };
  return React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, paths[name] || null);
};
// Owns prices/loading/lastUpdate and the 90s polling for a given ticker set.
// Returns a stable {prices, loading, lastUpdate, refresh} bundle.
// The loading guard uses a ref so the callback identity doesn't change on every
// loading toggle — this prevents the stale-closure race where two concurrent
// calls (visibility + interval) both read loading=false and double-fetch.
function usePriceFeed(tickersToFetch, toast) {
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const refresh = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const newPrices = await fetchQuoteBatch(tickersToFetch);
      setPrices(prev => ({ ...prev, ...newPrices }));
      setLastUpdate(new Date());
    } catch (e) {
      console.error('Refresh failed:', e);
      if (toast) toast('Price refresh failed');
    }
    loadingRef.current = false;
    setLoading(false);
  }, [tickersToFetch, toast]);
  usePolledRefresh(refresh, 90000, 60000, tickersToFetch);
  return { prices, loading, lastUpdate, refresh };
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
  return { triggered, setTriggered, alertSeenMap };
}
// Owns positions/watchlist/contributions/alerts + CRUD. fxRates is needed for
// purchase-date FX resolution; toast is injected for user-facing feedback.
// Raw setters are exposed so importData / cloud sync can replace state wholesale.
function usePortfolio(fxRates, toast) {
  const [positions, setPositions] = usePersistedState('pb.positions.v2', []);
  const [watchlist, setWatchlist] = usePersistedState('pb.watchlist.v2', []);
  const [alerts, setAlerts] = usePersistedState('pb.alerts.v2', []);
  const [contributions, setContributions] = usePersistedState('pb.contributions.v1', []);
  const addPosition = async (ticker, market, shares, costBasis, notes, purchaseDate) => {
    const nativeCode = marketCurrency(market);
    const today = new Date().toISOString().slice(0, 10);
    const dateKey = purchaseDate && purchaseDate !== today ? purchaseDate : null;
    let rateAtCost = fxRates?.rates?.[nativeCode] || null;
    if (dateKey) {
      const hist = await fetchHistoricalFx(dateKey, nativeCode);
      if (hist != null) rateAtCost = hist;
    }
    const p = {
      id: uid(),
      ticker: ticker.toUpperCase(),
      market,
      shares: parseFloat(shares),
      costBasis: parseFloat(costBasis),
      notes: notes || '',
      addedAt: new Date().toISOString(),
      purchaseDate: purchaseDate || today,
      fxRateAtCost: rateAtCost,
      fxBase: 'USD'
    };
    setPositions(prev => [...prev, p]);
    toast('Position added');
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
    addPosition, updatePosition, removePosition,
    addContribution, removeContribution,
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
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState('dashboard');
  const [newsByTicker, loadNewsRaw] = useTtlCache(15 * 60 * 1000);
  const [historyByTicker, loadHistoryRaw] = useTtlCache(15 * 60 * 1000);
  const [fundamentalsByTicker, loadFundamentalsRaw] = useTtlCache(6 * 60 * 60 * 1000);
  const [selected, setSelected] = useState(null);
  const [showAlerts, setShowAlerts] = useState(false);
  const [posModalEditId, setPosModalEditId] = useState(null);
  const [posModalOpen, setPosModalOpen] = useState(false);
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
    addPosition, updatePosition, removePosition,
    addContribution, removeContribution,
    addWatch, removeWatch,
    addAlert, removeAlert
  } = usePortfolio(fxRates, toast);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
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
  const tickersToFetch = useMemo(() => {
    const set = new Set();
    DATA.HOLDINGS.forEach(h => set.add('US:' + h.ticker));
    DATA.NEW_PICKS.forEach(p => set.add('US:' + p.ticker));
    DATA.HEDGES.forEach(h => set.add('US:' + h.ticker));
    set.add('US:VOO');
    set.add('US:^SPX');
    set.add('US:^VIX');
    positions.forEach(p => set.add(priceKey(p.market, p.ticker)));
    watchlist.forEach(w => set.add(priceKey(w.market, w.ticker)));
    alerts.forEach(a => set.add(priceKey(a.market, a.ticker)));
    return Array.from(set).map(k => {
      const [m, t] = k.split(':');
      return {
        market: m,
        ticker: t
      };
    });
  }, [positions, watchlist, alerts]);
  const { prices, loading, lastUpdate, refresh: refreshPrices } = usePriceFeed(tickersToFetch, toast);
  const fireNotification = useCallback(async trig => {
    const sym = trig.market === 'JSE' ? 'R' : '$';
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
  const { triggered, setTriggered } = useAlertEngine(alerts, prices, fireNotification);
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
      exportedAt: new Date().toISOString(),
      version: 2
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
  const openDetail = (ticker, market) => {
    setSelected({
      ticker,
      market: market || 'US'
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
      displayCurrency: displayCurrency,
      onSetDisplayCurrency: setDisplayCurrency,
      fxRates: fxRates
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
      }
    }),
    watchlist: React.createElement(WatchlistView, {
      watchlist: watchlist,
      prices: prices,
      onAdd: addWatch,
      onRemove: removeWatch,
      onReorder: setWatchlist,
      onOpenDetail: openDetail
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
    deployment: React.createElement(DeploymentView, { prices, onOpenDetail: openDetail }),
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
    className: "status-chip"
  }, React.createElement("span", {
    className: `dot ${loading ? 'loading' : lastUpdate ? 'live' : 'loading'}`
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
    positions: positions,
    prices: prices
  }), React.createElement("nav", {
    className: "nav"
  }, React.createElement("div", {
    className: "nav-inner"
  }, [['dashboard', 'Dashboard'], ['current', 'Holdings'], ['watchlist', 'Watchlist'], ['heatmap', 'Heatmap'], ['picks', 'New picks'], ['hedges', 'Hedges'], ['deployment', 'Deployment'], ['rules', 'Rules'], ['overview', 'Thesis']].map(_ref3 => {
    let [k, label] = _ref3;
    return React.createElement("button", {
      key: k,
      className: `nav-btn ${view === k ? 'active' : ''}`,
      onClick: () => {
        setView(k);
        window.scrollTo({
          top: 0,
          behavior: 'smooth'
        });
      }
    }, label);
  }))), React.createElement("main", null, views[view]), selected && React.createElement(DetailModal, {
    selected: selected,
    prices: prices,
    alerts: alerts.filter(a => a.ticker === selected.ticker && a.market === selected.market),
    news: newsByTicker[priceKey(selected.market, selected.ticker)],
    historyByTicker: historyByTicker,
    fundamentals: fundamentalsByTicker[priceKey(selected.market, selected.ticker)],
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
    onSave: data => {
      if (posModalEditId) updatePosition(posModalEditId, data);
      else addPosition(data.ticker, data.market, data.shares, data.costBasis, data.notes, data.purchaseDate);
      setPosModalOpen(false);
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
    positions,
    prices
  } = _ref4;
  const groups = {};
  positions.forEach(p => {
    const mc = MARKET_CURRENCY[p.market];
    if (!mc) return;
    if (!groups[mc.code]) groups[mc.code] = { ...mc, value: 0, cost: 0, count: 0, fmtMarket: p.market };
    groups[mc.code].cost += p.shares * p.costBasis;
    const q = prices[priceKey(p.market, p.ticker)];
    if (q) groups[mc.code].value += p.shares * q.price;
    groups[mc.code].count++;
  });
  const spx = prices['US:^SPX'];
  const vix = prices['US:^VIX'];
  const renderIndex = (key, label, quote, decimals, invertColor) => {
    const has = !!quote;
    const up = has && quote.changePct >= 0;
    const colorUp = invertColor ? !up : up;
    return React.createElement("div", { key: key, className: "hero-index" },
      React.createElement("span", { className: "hero-index-label" }, label),
      React.createElement("span", { className: "hero-index-value" }, has ? quote.price.toFixed(decimals) : '—'),
      React.createElement("span", { className: `hero-index-chg ${colorUp ? 'up' : 'down'}` },
        has ? (quote.changePct >= 0 ? '+' : '') + quote.changePct.toFixed(2) + '%' : '—'
      )
    );
  };
  return React.createElement("section", {
    className: "hero"
  }, React.createElement("div", {
    className: "hero-grid"
  }, Object.values(groups).map(g => {
    const gain = g.cost > 0 ? (g.value - g.cost) / g.cost * 100 : 0;
    return React.createElement("div", { key: g.code, className: "hero-stat" },
      React.createElement("div", { className: "label" }, "Your " + g.label),
      React.createElement("div", { className: "value" }, fmt(g.value, g.fmtMarket)),
      React.createElement("div", { className: `sub ${gain >= 0 ? 'up' : 'down'}` },
        gain >= 0 ? '+' : '', gain.toFixed(2), "% \xB7 ", g.count, " pos"
      )
    );
  })), React.createElement("div", {
    className: "hero-indices"
  },
    renderIndex('spx', 'S&P 500', spx, 0, false),
    renderIndex('vix', 'VIX', vix, 2, true)
  ));
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
  const [range, setRange] = useState('all');
  const ranges = [
    { key: '1d', label: '1D' }, { key: '1w', label: '1W' }, { key: '1mo', label: '1M' },
    { key: '3mo', label: '3M' }, { key: '6mo', label: '6M' },
    { key: '1y', label: '1Y' }, { key: '2y', label: '2Y' }, { key: 'all', label: 'All' }
  ];
  const rates = fxRates?.rates || null;
  const contribSorted = contributions.slice().sort((a, b) => a.date.localeCompare(b.date));
  let currentValue = 0;
  positions.forEach(p => {
    const q = prices[priceKey(p.market, p.ticker)];
    if (!q) return;
    const native = marketCurrency(p.market);
    const val = convertCcy(p.shares * q.price, native, displayCurrency, rates);
    if (val != null) currentValue += val;
  });
  const today = new Date().toISOString().slice(0, 10);
  // Compute range cutoff date
  const cutoff = (() => {
    const d = new Date();
    if (range === '1d') d.setDate(d.getDate() - 1);
    else if (range === '1w') d.setDate(d.getDate() - 7);
    else if (range === '1mo') d.setMonth(d.getMonth() - 1);
    else if (range === '3mo') d.setMonth(d.getMonth() - 3);
    else if (range === '6mo') d.setMonth(d.getMonth() - 6);
    else if (range === '1y') d.setFullYear(d.getFullYear() - 1);
    else if (range === '2y') d.setFullYear(d.getFullYear() - 2);
    else return null;
    return d.toISOString().slice(0, 10);
  })();
  const allPoints = [];
  let cumContrib = 0;
  contribSorted.forEach(c => {
    const conv = convertCcy(c.amount, c.currency, displayCurrency, rates);
    if (conv != null) cumContrib += conv;
    allPoints.push({ date: c.date, contributed: cumContrib, value: null });
  });
  if (allPoints.length > 0) {
    const totalContrib = cumContrib;
    const growthRatio = totalContrib > 0 ? currentValue / totalContrib : 1;
    allPoints.forEach((pt, i) => {
      const progress = allPoints.length > 1 ? i / (allPoints.length - 1) : 1;
      pt.value = pt.contributed * (1 + (growthRatio - 1) * progress);
    });
    allPoints.push({ date: today, contributed: cumContrib, value: currentValue });
  } else if (positions.length > 0) {
    let totalCost = 0;
    positions.forEach(p => {
      const native = marketCurrency(p.market);
      const cost = convertCcy(p.shares * p.costBasis, native, displayCurrency, rates);
      if (cost != null) totalCost += cost;
    });
    const startDate = positions.reduce((min, p) => {
      const d = p.purchaseDate || p.addedAt?.slice(0, 10) || today;
      return d < min ? d : min;
    }, today);
    allPoints.push({ date: startDate, contributed: totalCost, value: totalCost });
    allPoints.push({ date: today, contributed: totalCost, value: currentValue });
  }
  // Filter to range
  const points = cutoff ? allPoints.filter(p => p.date >= cutoff) : allPoints;
  if (points.length < 2) {
    return React.createElement("div", { className: "chart-line-wrap" },
      React.createElement("div", { className: "chart-ranges" },
        ranges.map(r => React.createElement("button", {
          key: r.key, className: `chart-range-btn ${range === r.key ? 'active' : ''}`,
          onClick: () => setRange(r.key) }, r.label))),
      React.createElement("div", { className: "chart-empty" },
        React.createElement("div", { className: "text-dim text-sm" }, "Add positions and log deposits to see portfolio growth.")));
  }
  const W = 560, H = 220, PAD_L = 54, PAD_R = 16, PAD_T = 16, PAD_B = 32;
  const chartW = W - PAD_L - PAD_R, chartH = H - PAD_T - PAD_B;
  const allVals = points.flatMap(p => [p.value, p.contributed].filter(v => v != null));
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
  const lastVal = points[points.length - 1];
  const firstVal = points[0];
  const gain = lastVal.value - firstVal.contributed;
  const gainPct = firstVal.contributed > 0 ? (gain / firstVal.contributed * 100) : 0;
  return React.createElement("div", { className: "chart-line-wrap" },
    // Range toggle + legend in one row
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
        React.createElement("span", { className: `chart-legend-gain ${gain >= 0 ? 'up' : 'down'}` },
          (gain >= 0 ? '+' : '') + gainPct.toFixed(1) + '%'))
    ),
    React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, className: "chart-line-svg", preserveAspectRatio: "none" },
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
      React.createElement("text", {
        x: PAD_L, y: H - 6, fill: "var(--text-dim)", fontSize: "10", fontFamily: "var(--mono)" },
        points[0].date.slice(5)),
      React.createElement("text", {
        x: W - PAD_R, y: H - 6, textAnchor: "end", fill: "var(--text-dim)", fontSize: "10", fontFamily: "var(--mono)" },
        points[points.length - 1].date.slice(5)),
      React.createElement("path", { d: areaPath, fill: "url(#areaGrad)" }),
      React.createElement("path", { d: contribPath, fill: "none", stroke: "var(--text-dim)", strokeWidth: "1.5", strokeDasharray: "4,3", opacity: "0.4" }),
      React.createElement("path", { d: valuePath, fill: "none", stroke: "var(--blue)", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" }),
      React.createElement("circle", { cx: x(points.length - 1), cy: y(lastVal.value), r: "4", fill: "var(--blue)", stroke: "var(--bg-raised)", strokeWidth: "2" })
    )
  );
}
// SVG donut/pie chart — supports grouping by ticker, sector, or market
const MARKET_LABELS = { US: 'USA', JSE: 'SA', LSE: 'UK', ASX: 'AUS', FRA: 'EUR', PAR: 'EUR', AMS: 'EUR' };
function PortfolioPieChart({ positions, prices, displayCurrency, fxRates, onOpenDetail }) {
  const [mode, setMode] = useState('ticker');
  const [hovered, setHovered] = useState(null);
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
      const sectorInfo = DATA.findSector(p.ticker, p.market) || {};
      posVals.push({ ticker: p.ticker, market: p.market, value: val, name: info.name || p.ticker, sector: sectorInfo.sector || 'Other' });
    }
  });
  // Group by mode
  const grouped = {};
  posVals.forEach(pv => {
    let key;
    if (mode === 'sector') key = pv.sector;
    else if (mode === 'market') key = MARKET_LABELS[pv.market] || pv.market;
    else key = pv.ticker;
    if (!grouped[key]) grouped[key] = { label: key, value: 0, market: pv.market, ticker: pv.ticker };
    grouped[key].value += pv.value;
  });
  const slices = Object.values(grouped).sort((a, b) => b.value - a.value);
  let total = slices.reduce((s, sl) => s + sl.value, 0);
  if (slices.length === 0) {
    return React.createElement("div", { className: "chart-empty" },
      React.createElement("div", { className: "text-dim text-sm" }, "Add positions to see allocation breakdown."));
  }
  const COLORS = [
    'var(--blue)', 'var(--emerald)', 'var(--rose)', 'var(--amber)',
    'var(--purple)', '#06b6d4', '#ec4899', '#84cc16',
    '#f97316', '#6366f1', '#14b8a6', '#e879f9'
  ];
  const SIZE = 154, CX = SIZE / 2, CY = SIZE / 2, R = 61, INNER_R = 39;
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
    const d = slices.length === 1
      ? `M${CX + R},${CY}A${R},${R} 0 1,1 ${CX + R - 0.01},${CY}Z` +
        `M${CX + INNER_R},${CY}A${INNER_R},${INNER_R} 0 1,0 ${CX + INNER_R - 0.01},${CY}Z`
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
          arcs.map((a, i) => React.createElement("path", {
            key: i, d: a.d, fill: a.color,
            stroke: "var(--bg-raised)", strokeWidth: "1.5",
            style: { cursor: 'pointer', opacity: hovered != null && hovered !== i ? 0.4 : 1, transition: 'opacity 0.2s' },
            onMouseEnter: () => setHovered(i),
            onMouseLeave: () => setHovered(null),
            onClick: () => mode === 'ticker' ? onOpenDetail(a.ticker, a.market) : null
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
          key: i, className: "chart-pie-legend-item",
          onMouseEnter: () => setHovered(i),
          onMouseLeave: () => setHovered(null),
          onClick: () => mode === 'ticker' ? onOpenDetail(a.ticker, a.market) : null
        },
          React.createElement("span", { className: "chart-pie-legend-dot", style: { background: a.color } }),
          React.createElement("span", { className: "chart-pie-legend-tkr" }, a.label),
          React.createElement("span", { className: "chart-pie-legend-pct" }, a.pct.toFixed(1) + '%')
        ))
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
    displayCurrency,
    onSetDisplayCurrency,
    fxRates
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
  const contributed = contributions.reduce((map, c) => { map[c.currency] = (map[c.currency] || 0) + c.amount; return map; }, {});
  const overallReturnGroups = currencyGroups.filter(g => (contributed[g.code] || 0) > 0).map(g => ({
    ...g, contrib: contributed[g.code],
    ret: g.value - contributed[g.code],
    retPct: (g.value - contributed[g.code]) / contributed[g.code] * 100
  }));
  return React.createElement("div", { className: "dashboard-page" },
    // Header
    React.createElement("div", { className: "mb-4" },
      React.createElement("h1", { className: "section-title" }, "Dashboard"),
      React.createElement("div", { className: "section-desc", style: { marginBottom: 0 } }, "Portfolio overview and growth.")),
    // Empty state
    positions.length === 0 ? React.createElement("div", { className: "empty" },
      React.createElement(Icon, { name: "briefcase", size: 40 }),
      React.createElement("h3", null, "No positions yet"),
      React.createElement("p", null, "Add your holdings in the Holdings tab to see portfolio analytics."))
    : React.createElement(React.Fragment, null,
      // Stat cards row
      React.createElement("div", { className: "stat-card total-portfolio-card mb-4" },
        React.createElement("div", { className: "stat-label" }, "Total Portfolio Value · " + displayCurrency),
        React.createElement("div", { className: "stat-value" }, fmtCcy(totalValue, displayCurrency)),
        React.createElement("div", { className: `stat-sub ${totalPnlPct >= 0 ? 'up' : 'down'}` },
          totalPnlPct >= 0 ? '+' : '', totalPnlPct.toFixed(2), "% · ",
          fmtCcySigned(totalPnl, displayCurrency))),
      marketGroups.length > 1 && React.createElement("div", { className: "market-alloc-row mb-4" },
        marketGroups.map(g => {
          const pct = totalValue > 0 ? g.value / totalValue * 100 : 0;
          return React.createElement("div", { key: g.market, className: "market-alloc-box" },
            React.createElement("div", { className: "market-alloc-label" }, g.market),
            React.createElement("div", { className: "market-alloc-value" }, fmtCcy(g.value, displayCurrency)),
            React.createElement("div", { className: `market-alloc-pct ${g.pnlPct >= 0 ? 'up' : 'down'}` },
              g.pnlPct >= 0 ? '+' : '', g.pnlPct.toFixed(1), "%"));
        })),
      // FX summary
      React.createElement(FxSummary, {
        positions, contributions, prices, fxRates, displayCurrency, onSetDisplayCurrency }),
      // Portfolio growth chart
      React.createElement("div", { className: "card mb-4" },
        React.createElement("div", { className: "eyebrow", style: { marginBottom: 12 } }, "Portfolio Growth"),
        React.createElement(PortfolioLineChart, { positions, prices, contributions, displayCurrency, fxRates })),
      // Allocation pie chart
      React.createElement("div", { className: "card mb-4" },
        React.createElement("div", { className: "eyebrow", style: { marginBottom: 12 } }, "Allocation"),
        React.createElement(PortfolioPieChart, { positions, prices, displayCurrency, fxRates, onOpenDetail })),
      // Growth tracker
      React.createElement("div", { className: "card mb-4" },
        React.createElement("div", { className: "flex justify-between items-center mb-3" },
          React.createElement("div", { className: "eyebrow", style: { marginBottom: 0 } }, "Growth Tracker"),
          React.createElement("button", { className: "btn btn-ghost btn-xs", onClick: () => setContribModalOpen(true) },
            React.createElement(Icon, { name: "plus", size: 12 }), " Log deposit")),
        React.createElement("div", { className: "growth-stats-grid" },
          React.createElement("div", { className: "growth-stat" },
            React.createElement("div", { className: "growth-stat-label" }, "Overall Return"),
            React.createElement("div", { className: "growth-stat-sub" }, "vs. total contributions"),
            overallReturnGroups.length > 0
              ? overallReturnGroups.map(g => React.createElement("div", { key: g.code, className: "growth-currency-row" },
                  React.createElement("span", { className: "market-badge" }, g.label),
                  React.createElement("span", { className: `growth-val ${g.ret >= 0 ? 'up' : 'down'}` }, g.ret >= 0 ? '+' : '\u2212', fmt(Math.abs(g.ret), g.fmtMarket)),
                  React.createElement("span", { className: `growth-pct ${g.retPct >= 0 ? 'up' : 'down'}` }, g.retPct >= 0 ? '+' : '', g.retPct.toFixed(1), "%")))
              : React.createElement("div", { className: "text-dim text-sm" }, "Log a deposit to track overall return.")),
          React.createElement("div", { className: "growth-stat" },
            React.createElement("div", { className: "growth-stat-label" }, "Position P&L"),
            React.createElement("div", { className: "growth-stat-sub" }, "vs. cost basis"),
            currencyGroups.length > 0
              ? currencyGroups.map(g => React.createElement("div", { key: g.code, className: "growth-currency-row" },
                  React.createElement("span", { className: "market-badge" }, g.label),
                  React.createElement("span", { className: `growth-val ${g.pnl >= 0 ? 'up' : 'down'}` }, g.pnl >= 0 ? '+' : '\u2212', fmt(Math.abs(g.pnl), g.fmtMarket)),
                  React.createElement("span", { className: `growth-pct ${g.pnlPct >= 0 ? 'up' : 'down'}` }, g.pnlPct >= 0 ? '+' : '', g.pnlPct.toFixed(1), "%")))
              : React.createElement("div", { className: "text-dim text-sm" }, "Add positions to see P&L.")))),
      // Contribution modal
      contribModalOpen ? React.createElement(ContributionModal, {
        onClose: () => setContribModalOpen(false),
        onSave: (amount, currency, date, note) => { onAddContribution(amount, currency, date, note); setContribModalOpen(false); }
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
    onAddPosition
  } = _ref7;
  const usdPositions = positions.filter(p => p.market === 'US');
  const zarPositions = positions.filter(p => p.market === 'JSE');
  const renderUS = () => {
    if (usdPositions.length === 0) {
      return React.createElement("div", { className: "empty" },
        React.createElement(Icon, { name: "briefcase", size: 40 }),
        React.createElement("h3", null, "No US positions yet"),
        React.createElement("p", null, "Add your US holdings using the Add button above."));
    }
    return React.createElement("div", null, React.createElement("div", {
      className: "eyebrow"
    }, "Your US positions"), React.createElement("div", {
      className: "row-list"
    }, usdPositions.map(p => {
      const q = prices['US:' + p.ticker];
      const info = DATA.findInfo(p.ticker, 'US');
      const marketValue = q ? p.shares * q.price : null;
      const cost = p.shares * p.costBasis;
      const pnlPct = marketValue != null && cost > 0 ? (marketValue - cost) / cost * 100 : null;
      return React.createElement("button", {
        key: p.id,
        className: "row",
        onClick: () => onOpenDetail(p.ticker, 'US')
      }, React.createElement("div", {
        className: "row-main"
      }, React.createElement("div", {
        className: "row-head"
      }, React.createElement("span", {
        className: "tkr"
      }, p.ticker), React.createElement("span", {
        className: "text-sm text-dim"
      }, info.name || p.ticker)), React.createElement("div", {
        className: "row-meta"
      }, p.shares, " \xD7 ", fmt(p.costBasis, 'US'), pnlPct != null && React.createElement("span", {
        className: `mono ${pnlPct >= 0 ? 'text-up' : 'text-down'}`
      }, " \xB7 ", pnlPct >= 0 ? '+' : '', pnlPct.toFixed(2), "%"))), React.createElement("div", {
        className: "row-right"
      }, React.createElement(PriceBlock, {
        quote: q
      }), marketValue != null && React.createElement("div", {
        className: "text-xs text-dim mt-1 mono"
      }, fmt(marketValue, 'US'))));
    })));
  };
  const renderJSE = () => {
    if (zarPositions.length === 0) {
      return React.createElement("div", { className: "empty" },
        React.createElement(Icon, { name: "briefcase", size: 40 }),
        React.createElement("h3", null, "No JSE positions yet"),
        React.createElement("p", null, "Add your JSE (ZAR) holdings using the Add button above."));
    }
    return React.createElement("div", null, React.createElement("div", {
      className: "eyebrow"
    }, "Your JSE positions"), React.createElement("div", {
      className: "row-list"
    }, zarPositions.map(p => {
      const q = prices['JSE:' + p.ticker];
      const info = DATA.findInfo(p.ticker, 'JSE');
      const marketValue = q ? p.shares * q.price : null;
      const cost = p.shares * p.costBasis;
      const pnlPct = marketValue != null && cost > 0 ? (marketValue - cost) / cost * 100 : null;
      return React.createElement("button", {
        key: p.id,
        className: "row",
        onClick: () => onOpenDetail(p.ticker, 'JSE')
      }, React.createElement("div", {
        className: "row-main"
      }, React.createElement("div", {
        className: "row-head"
      }, React.createElement("span", {
        className: "tkr"
      }, p.ticker), React.createElement("span", {
        className: "text-sm text-dim"
      }, info.name || p.ticker)), React.createElement("div", {
        className: "row-meta"
      }, p.shares, " \xD7 ", fmt(p.costBasis, 'JSE'), pnlPct != null && React.createElement("span", {
        className: `mono ${pnlPct >= 0 ? 'text-up' : 'text-down'}`
      }, " \xB7 ", pnlPct >= 0 ? '+' : '', pnlPct.toFixed(2), "%"))), React.createElement("div", {
        className: "row-right"
      }, React.createElement(PriceBlock, {
        quote: q
      }), marketValue != null && React.createElement("div", {
        className: "text-xs text-dim mt-1 mono"
      }, fmt(marketValue, 'JSE'))));
    })));
  };
  return React.createElement("div", null, React.createElement("div", {
    className: "flex justify-between items-start mb-3",
    style: {
      gap: 10
    }
  }, React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "Holdings"), React.createElement("div", {
    className: "section-desc",
    style: {
      marginBottom: 0
    }
  }, "Live prices for your holdings.")), React.createElement("div", { className: "flex gap-2 items-center" },
    React.createElement("div", {
    className: "toggle-group"
  }, React.createElement("button", {
    className: `toggle-opt ${marketFilter === 'US' ? 'active' : ''}`,
    onClick: () => setMarketFilter('US')
  }, "US (", usdPositions.length, ")"), React.createElement("button", {
    className: `toggle-opt ${marketFilter === 'JSE' ? 'active' : ''}`,
    onClick: () => setMarketFilter('JSE')
  }, "JSE (", zarPositions.length, ")")),
    React.createElement("button", { className: "btn btn-primary btn-sm", onClick: onAddPosition },
      React.createElement(Icon, { name: "plus", size: 13 }), " Add"))),
    marketFilter === 'US' ? renderUS() : renderJSE());
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
  const proxies = [
    url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
  ];
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0&listsCount=0`;
  for (const buildProxy of proxies) {
    try {
      const res = await fetch(buildProxy(url));
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data.quotes)) continue;
      const out = [];
      for (const q of data.quotes) {
        if (!q.symbol) continue;
        const qt = (q.quoteType || '').toUpperCase();
        if (qt && qt !== 'EQUITY' && qt !== 'ETF' && qt !== 'MUTUALFUND') continue;
        const parsed = parseYahooSymbol(q.symbol);
        if (!parsed) continue;
        out.push({
          ticker: parsed.ticker,
          market: parsed.market,
          name: q.shortname || q.longname || parsed.ticker,
          exchange: q.exchDisp || ''
        });
      }
      return out;
    } catch (e) {
      continue;
    }
  }
  return [];
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

function TickerSearch({ value, onChange, market, onMarketChange, onEnter, disabled }) {
  const [query, setQuery] = useState(value || '');
  const [suggestions, setSuggestions] = useState([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const remoteReqId = useRef(0);

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
    setQuery(s.ticker);
    onChange(s.ticker);
    onMarketChange(s.market);
    setSuggestions([]);
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, -1)); }
    else if (e.key === 'Enter') {
      if (open && activeIdx >= 0) { e.preventDefault(); selectSuggestion(suggestions[activeIdx]); }
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
      placeholder: 'Search ticker\u2026',
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
    open && (suggestions.length > 0 || remoteLoading) && React.createElement('div', { className: 'ticker-dropdown' },
      suggestions.map((s, i) =>
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
    if (yahooName && yahooName !== ticker) return yahooName;
  }
  const info = DATA.findInfo(ticker, market);
  if (info && info.name && info.name !== ticker) return info.name;
  const hit = ALL_TICKERS.find(t => t.ticker === ticker && t.market === market);
  if (hit && hit.name && hit.name !== ticker) return hit.name;
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
    onAdd,
    onRemove,
    onReorder,
    onOpenDetail
  } = _ref8;
  const [newTicker, setNewTicker] = useState('');
  const [newMarket, setNewMarket] = useState('US');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showSuggestions, setShowSuggestions] = usePersistedState('pb.watchlist.showSuggestions.v1', true);

  // Freeform long-press drag-to-reorder. We use pointer events with capture so that
  // the dragged card keeps receiving move events even when the pointer leaves it.
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

  // Prevent iOS scroll while a drag is active (must be non-passive to cancel)
  useEffect(() => {
    const prevent = (e) => { if (dragRef.current && e.cancelable) e.preventDefault(); };
    document.addEventListener('touchmove', prevent, { passive: false });
    return () => document.removeEventListener('touchmove', prevent);
  }, []);

  // Clean up haptic AudioContext on unmount
  useEffect(() => {
    return () => { if (hapticCtxRef.current) try { hapticCtxRef.current.close(); } catch (_) {} };
  }, []);

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    // Restore touch-action set during pointerdown when not entering a drag
    const po = pressOriginRef.current;
    if (po && !dragRef.current) {
      const card = cardRefsRef.current.get(po.id);
      if (card) card.style.touchAction = '';
    }
  };

  const startDrag = (id, pointerId, startY) => {
    const card = cardRefsRef.current.get(id);
    if (!card) return;
    triggerHaptic();
    const originIdx = watchlist.findIndex(w => w.id === id);
    if (originIdx < 0) return;
    dragRef.current = {
      id, pointerId,
      pointerStartY: startY,
      originIdx, targetIdx: originIdx,
      moved: false,
    };
    // Initial lift: pop up to scale 1.05 with a quick transition. Disable the
    // transition right after so subsequent drag motion follows the finger 1:1.
    card.style.transition = 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1)';
    card.style.transform = 'translateY(0) scale(1.05)';
    setTimeout(() => {
      if (dragRef.current && dragRef.current.id === id) {
        card.style.transition = 'transform 0s';
      }
    }, 150);
    try { card.setPointerCapture(pointerId); } catch (_) {}
    setDraggingId(id);
  };

  const onCardPointerDown = (e, id) => {
    if (e.target.closest('button,a,input,[data-no-drag]')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (dragRef.current) return;
    clearLongPress();
    // Claim touch-action NOW so iOS doesn't start a scroll gesture.
    // (The browser evaluates touch-action at pointerdown time.)
    const card = cardRefsRef.current.get(id);
    if (card) card.style.touchAction = 'none';
    // Warm up AudioContext during this user-gesture so the haptic tick
    // can fire from the long-press setTimeout (iOS requires user-gesture init).
    if (!hapticCtxRef.current) {
      try { hapticCtxRef.current = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    }
    if (hapticCtxRef.current && hapticCtxRef.current.state === 'suspended') {
      try { hapticCtxRef.current.resume(); } catch (_) {}
    }
    pressOriginRef.current = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      const po = pressOriginRef.current;
      if (!po || po.id !== id) return;
      startDrag(id, po.pointerId, po.y);
    }, 450);
  };

  const onCardPointerMove = (e) => {
    const drag = dragRef.current;
    if (drag) {
      if (e.pointerId !== drag.pointerId) return;
      if (e.cancelable) e.preventDefault();
      const dy = e.clientY - drag.pointerStartY;
      const card = cardRefsRef.current.get(drag.id);
      if (card) card.style.transform = `translateY(${dy}px) scale(1.05)`;
      drag.moved = true;
      // Resolve target index by comparing the pointer Y against each sibling's
      // current center. Only siblings that have shifted past the pointer in the
      // appropriate direction count.
      const pointerY = e.clientY;
      let targetIdx = drag.originIdx;
      for (let i = 0; i < watchlist.length; i++) {
        if (i === drag.originIdx) continue;
        const sibEl = cardRefsRef.current.get(watchlist[i].id);
        if (!sibEl) continue;
        const r = sibEl.getBoundingClientRect();
        const center = r.top + r.height / 2;
        if (i < drag.originIdx && pointerY < center) { targetIdx = i; break; }
        if (i > drag.originIdx && pointerY > center) { targetIdx = i; }
      }
      drag.targetIdx = targetIdx;
      return;
    }
    if (longPressTimerRef.current) {
      const po = pressOriginRef.current;
      if (po) {
        const dx = e.clientX - po.x;
        const dy = e.clientY - po.y;
        if (dx * dx + dy * dy > 100) clearLongPress();
      }
    }
  };

  const finishDrag = (commit) => {
    const drag = dragRef.current;
    if (!drag) return;
    const card = cardRefsRef.current.get(drag.id);
    if (card) {
      card.style.transition = '';
      card.style.transform = '';
      card.style.touchAction = '';
      try { card.releasePointerCapture(drag.pointerId); } catch (_) {}
    }
    if (commit && drag.moved && drag.targetIdx !== drag.originIdx) {
      const arr = [...watchlist];
      const [m] = arr.splice(drag.originIdx, 1);
      arr.splice(drag.targetIdx, 0, m);
      onReorder(arr);
    }
    if (drag.moved) suppressClickRef.current = true;
    dragRef.current = null;
    setDraggingId(null);
  };

  const onCardPointerUp = () => {
    clearLongPress();
    pressOriginRef.current = null;
    if (dragRef.current) finishDrag(true);
  };

  const onCardPointerCancel = () => {
    clearLongPress();
    pressOriginRef.current = null;
    if (dragRef.current) finishDrag(false);
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
  return React.createElement("div", null,
    React.createElement("div", { className: "flex justify-between items-center mb-4" },
      React.createElement("h1", { className: "section-title", style: { marginBottom: 0 } }, "Watchlist"),
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
    : React.createElement("div", { className: "grid grid-2 mb-6 watchlist-grid" },
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
        return React.createElement("div", {
          key: w.id,
          ref: setCardRef(w.id),
          className: "pos-card" + (isDragging ? " dragging" : ""),
          onClick: () => {
            if (suppressClickRef.current) { suppressClickRef.current = false; return; }
            if (dragRef.current) return;
            onOpenDetail(w.ticker, w.market);
          },
          onPointerDown: (e) => onCardPointerDown(e, w.id),
          onPointerMove: onCardPointerMove,
          onPointerUp: onCardPointerUp,
          onPointerCancel: onCardPointerCancel,
          onContextMenu: e => e.preventDefault()
        },
          React.createElement("div", { className: "pos-head" },
            React.createElement("div", { className: "flex-1" },
              React.createElement("div", { className: "flex items-center gap-2" },
                React.createElement("span", { className: "tkr" }, w.ticker),
                React.createElement("span", { className: "market-badge" }, w.market)),
              React.createElement("div", { className: "tkr-name" }, displayName)),
            React.createElement("div", { className: "flex items-center gap-2" },
              athBadge,
              React.createElement("button", {
                className: "btn btn-ghost btn-xs",
                onClick: e => { e.stopPropagation(); onRemove(w.id); },
                'aria-label': "Remove"
              }, React.createElement(Icon, { name: "x", size: 13 })))),
          React.createElement(PriceBlock, { quote: q, size: "lg", showDailyRow: true }));
      })),
    React.createElement("div", { className: "eyebrow suggestions-head" },
      React.createElement("span", null, "Suggested for you"),
      React.createElement("button", {
        className: "btn btn-ghost btn-xs",
        onClick: () => setShowSuggestions(v => !v),
        'aria-label': showSuggestions ? "Hide suggestions" : "Show suggestions"
      }, showSuggestions ? "Hide" : "Show")),
    showSuggestions && (suggestions.length === 0
      ? React.createElement("div", { className: "text-sm text-dim" }, "No more suggestions — you're tracking the popular names already.")
      : React.createElement("div", { className: "chip-row" },
          suggestions.map(s => React.createElement("button", {
            key: priceKey(s.market, s.ticker),
            className: "chip",
            onClick: () => onAdd(s.ticker, s.market, s.name)
          }, s.ticker, React.createElement("span", { className: "chip-sub" }, s.name, " · ", s.market)))))
  );
}

function heatColor(pct) {
  if (pct == null || !isFinite(pct)) return { bg: 'rgb(60, 60, 66)', fg: '#a1a1aa' };
  const clamped = Math.max(-3, Math.min(3, pct));
  const t = Math.abs(clamped) / 3;
  const lo = clamped >= 0 ? [38, 73, 56] : [73, 38, 45];
  const hi = clamped >= 0 ? [22, 163, 74] : [220, 38, 38];
  const r = Math.round(lo[0] + (hi[0] - lo[0]) * t);
  const g = Math.round(lo[1] + (hi[1] - lo[1]) * t);
  const b = Math.round(lo[2] + (hi[2] - lo[2]) * t);
  return { bg: `rgb(${r}, ${g}, ${b})`, fg: '#ffffff' };
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
    if (!sectors[r.sector]) sectors[r.sector] = { name: r.sector, value: 0, weightedChg: 0, industries: {} };
    if (!sectors[r.sector].industries[r.industry]) sectors[r.sector].industries[r.industry] = { name: r.industry, value: 0, weightedChg: 0, tickers: [] };
    sectors[r.sector].value += r.value;
    sectors[r.sector].weightedChg += r.changePct * r.value;
    sectors[r.sector].industries[r.industry].value += r.value;
    sectors[r.sector].industries[r.industry].weightedChg += r.changePct * r.value;
    sectors[r.sector].industries[r.industry].tickers.push(r);
  }
  const sectorList = Object.values(sectors).map(s => {
    const industries = Object.values(s.industries).map(ind => ({
      name: ind.name, value: ind.value, tickers: ind.tickers,
      avgChange: ind.value > 0 ? ind.weightedChg / ind.value : 0
    }));
    return { name: s.name, value: s.value, industries, avgChange: s.value > 0 ? s.weightedChg / s.value : 0 };
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
function HeatmapTreemap(_ref8c) {
  let { rows, aspectRatio, minHeight, onOpenDetail } = _ref8c;
  const [containerRef, width] = useContainerWidth();
  const sectors = useMemo(() => buildSectorHierarchy(rows), [rows]);
  const height = width > 0 ? Math.max(minHeight || 360, width * (aspectRatio || 0.7)) : (minHeight || 360);
  const cells = useMemo(() => width > 0 ? layoutTreemap(sectors, width, height) : [], [sectors, width, height]);
  return React.createElement("div", { ref: containerRef, className: "treemap", style: { height: height + 'px' } },
    cells.map((cell, idx) => {
      if (cell.kind === 'sector' || cell.kind === 'industry') {
        const isSec = cell.kind === 'sector';
        return React.createElement("div", {
          key: cell.kind + ':' + cell.name + ':' + idx,
          className: isSec ? 'tm-sector-label' : 'tm-industry-label',
          style: { left: cell.x + 'px', top: cell.y + 'px', width: cell.w + 'px' }
        },
          React.createElement("span", { className: "tm-label-name" }, cell.name),
          React.createElement("span", { className: `tm-label-chg ${cell.avgChange >= 0 ? 'up' : 'down'}` },
            ' ', (cell.avgChange >= 0 ? '+' : '') + cell.avgChange.toFixed(2) + '%'
          )
        );
      }
      const t = cell.ref;
      const c = heatColor(t.changePct);
      const showPct = cell.w >= 38 && cell.h >= 28;
      const showTkr = cell.w >= 22 && cell.h >= 16;
      const tkrSize = Math.max(9, Math.min(20, Math.sqrt(cell.w * cell.h) / 6));
      const pctSize = Math.max(8, tkrSize - 4);
      return React.createElement("button", {
        key: 't:' + priceKey(t.market, t.ticker),
        className: 'tm-cell',
        style: {
          left: cell.x + 'px', top: cell.y + 'px',
          width: cell.w + 'px', height: cell.h + 'px',
          background: c.bg, color: c.fg
        },
        onClick: () => onOpenDetail && onOpenDetail(t.ticker, t.market),
        title: `${t.ticker} ${t.changePct >= 0 ? '+' : ''}${t.changePct.toFixed(2)}%`
      },
        showTkr ? React.createElement("span", { className: 'tm-cell-tkr', style: { fontSize: tkrSize + 'px' } }, t.ticker) : null,
        showPct ? React.createElement("span", { className: 'tm-cell-pct', style: { fontSize: pctSize + 'px' } },
          (t.changePct >= 0 ? '+' : '') + t.changePct.toFixed(2) + '%'
        ) : null
      );
    })
  );
}
function HeatmapView(_ref8b) {
  let { positions, prices, onOpenDetail } = _ref8b;
  const exchanges = DATA.HEATMAPS;
  const [mode, setMode] = usePersistedState('pb.heatmap.mode.v1', 'market');
  const [selectedId, setSelectedId] = usePersistedState('pb.heatmap.exchange.v1', exchanges[0].id);
  const exchange = exchanges.find(e => e.id === selectedId) || exchanges[0];
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const cacheKey = exchange.id;
  const cached = cache[cacheKey];
  const load = useCallback(async (force) => {
    if (loading) return;
    if (!force && cache[cacheKey] && Date.now() - cache[cacheKey].fetchedAt < 60_000) return;
    setLoading(true);
    setError(null);
    try {
      const items = exchange.constituents.map(c => ({ ticker: c.t, market: exchange.market }));
      const quotes = await fetchQuoteBatch(items);
      const rows = exchange.constituents.map(c => {
        const q = quotes[priceKey(exchange.market, c.t)];
        return q ? { ticker: c.t, market: exchange.market, sector: c.s, industry: c.i, value: c.m, price: q.price, changePct: q.changePct } : null;
      }).filter(r => r && r.changePct != null);
      if (rows.length === 0) {
        setError('No live data returned. Try again shortly.');
      } else {
        setCache(prev => ({ ...prev, [cacheKey]: { rows, fetchedAt: Date.now() } }));
        setLastUpdate(new Date());
      }
    } catch (e) {
      setError('Failed to load heatmap. Check your connection.');
    } finally {
      setLoading(false);
    }
  }, [cacheKey, exchange, loading, cache]);
  useEffect(() => {
    if (mode === 'market') load(false);
  }, [cacheKey, mode]);
  const portfolioRows = useMemo(() => {
    if (mode !== 'portfolio') return [];
    return positions.map(p => {
      const q = prices[priceKey(p.market, p.ticker)];
      if (!q || q.changePct == null) return null;
      const sec = DATA.findSector(p.ticker, p.market);
      const positionValue = p.shares * q.price;
      if (positionValue <= 0) return null;
      return { ticker: p.ticker, market: p.market, sector: sec.sector, industry: sec.industry, value: positionValue, price: q.price, changePct: q.changePct };
    }).filter(Boolean);
  }, [mode, positions, prices]);
  const activeRows = mode === 'market' ? (cached ? cached.rows : []) : portfolioRows;
  const stats = useMemo(() => {
    if (!activeRows || activeRows.length === 0) return null;
    const up = activeRows.filter(r => r.changePct > 0).length;
    const down = activeRows.filter(r => r.changePct < 0).length;
    const flat = activeRows.length - up - down;
    const totalVal = activeRows.reduce((s, r) => s + r.value, 0);
    const wAvg = totalVal > 0 ? activeRows.reduce((s, r) => s + r.changePct * r.value, 0) / totalVal : 0;
    return { up, down, flat, avg: wAvg, total: activeRows.length };
  }, [activeRows]);
  const aspectRatio = mode === 'market' ? 0.62 : 0.5;
  const minHeight = mode === 'market' ? 480 : 360;
  return React.createElement("div", null,
    React.createElement("h1", { className: "section-title" }, "Heatmap"),
    React.createElement("div", { className: "section-desc" },
      "Live daily performance, sized by ", mode === 'market' ? 'market cap' : 'position value', ". Tap a ticker for details."
    ),
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
    React.createElement("div", { className: "heatmap-meta" },
      React.createElement("div", { className: "heatmap-meta-left" },
        stats ? React.createElement(React.Fragment, null,
          React.createElement("span", { className: "stat-up" }, "▲ ", stats.up),
          React.createElement("span", { className: "stat-down" }, "▼ ", stats.down),
          stats.flat > 0 ? React.createElement("span", { className: "stat-flat" }, "● ", stats.flat) : null,
          React.createElement("span", { className: `stat-avg ${stats.avg >= 0 ? 'up' : 'down'}` },
            (mode === 'market' ? "weighted " : "weighted "), stats.avg >= 0 ? '+' : '', stats.avg.toFixed(2), '%'
          )
        ) : React.createElement("span", { className: "text-dim text-sm" }, loading ? "Fetching live quotes…" : (mode === 'portfolio' && positions.length === 0 ? "Add positions to see your portfolio heatmap." : ""))
      ),
      React.createElement("div", { className: "heatmap-meta-right" },
        mode === 'market' && lastUpdate ? React.createElement("span", { className: "text-dim text-sm" },
          "Updated ", lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        ) : null,
        mode === 'market' ? React.createElement("button", {
          className: `btn btn-ghost btn-xs ${loading ? 'spin' : ''}`,
          onClick: () => load(true),
          disabled: loading,
          "aria-label": "Refresh heatmap"
        }, React.createElement(Icon, { name: "refresh", size: 13 }), " ", loading ? "Loading" : "Refresh") : null
      )
    ),
    error && mode === 'market' ? React.createElement("div", { className: "verify-error" }, error) : null,
    mode === 'market' && !cached && loading ? React.createElement("div", { className: "heatmap-loading" }, "Loading ", exchange.label, "…") : null,
    activeRows.length > 0 ? React.createElement(HeatmapTreemap, {
      rows: activeRows,
      aspectRatio: aspectRatio,
      minHeight: minHeight,
      onOpenDetail: onOpenDetail
    }) : (mode === 'portfolio' && !loading ? React.createElement("div", { className: "heatmap-loading" }, positions.length === 0 ? "You don't have any positions yet." : "Waiting for live quotes…") : null)
  );
}
function PicksView(_ref9) {
  let {
    prices,
    onOpenDetail
  } = _ref9;
  return React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "New Picks"), React.createElement("div", {
    className: "section-desc"
  }, "Nine positions targeting weighted 27-31% return. Diversified across healthcare, nuclear, defense, cyber, and semi-ADRs."), React.createElement("div", {
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
  return React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "Hedges"), React.createElement("div", {
    className: "section-desc"
  }, "18% allocation to gold, duration, defensive equity, and low-vol. True diversification beats false signal."), React.createElement("div", {
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
function DeploymentView({ prices, onOpenDetail }) {
  return React.createElement("div", null,
    React.createElement("h1", { className: "section-title" }, "Deployment"),
    React.createElement("div", { className: "section-desc" }, "Four-phase plan through July 2027. Monthly DCA anchored on VOO buy-zone signals."),
    React.createElement("div", { className: "timeline" },
      DATA.DEPLOYMENT_PHASES.map(p => React.createElement("div", {
        key: p.order, className: "timeline-item"
      },
        React.createElement("div", { className: "timeline-dot" }, p.order),
        React.createElement("div", { className: "timeline-content" },
          React.createElement("div", { className: "phase-label" }, p.phase),
          React.createElement("div", { className: "phase-title" }, p.title),
          React.createElement("div", { className: "card" },
            React.createElement("ul", { className: "bullet-list" },
              p.actions.map((a, i) => React.createElement("li", { key: i },
                React.createElement("span", null, a))))))))),
    React.createElement("div", { className: "eyebrow", style: { marginTop: 28 } }, "Playbook Reference"),
    React.createElement("div", { className: "row-list" },
      DATA.HOLDINGS.map(h => {
        const q = prices ? prices['US:' + h.ticker] : null;
        return React.createElement("button", {
          key: h.ticker, className: "row",
          onClick: () => onOpenDetail && onOpenDetail(h.ticker, 'US')
        },
          React.createElement("div", { className: "row-main" },
            React.createElement("div", { className: "row-head" },
              React.createElement("span", { className: "tkr" }, h.ticker),
              React.createElement("span", { className: "text-sm text-dim" }, h.name)),
            React.createElement("div", { className: "row-meta" }, h.sector)),
          React.createElement("div", { className: "row-right" },
            React.createElement(PriceBlock, { quote: q }),
            React.createElement("div", { className: "mt-1" },
              React.createElement("span", { className: `pill pill-${h.actionType}` }, h.action))));
      }))
  );
}
function RulesView() {
  return React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "Rules & Risks"), React.createElement("div", {
    className: "section-desc"
  }, "Pre-written discipline beats in-the-moment emotion."), React.createElement("div", {
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
  return React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "Thesis"), React.createElement("p", {
    className: "section-desc",
    style: {
      fontSize: 16,
      lineHeight: 1.5
    }
  }, "The next 12-16 months are not about finding the next NVDA. They are about ", React.createElement("strong", null, "defending existing gains"), " while redeploying into under-owned, fundamentally-strong sectors."), React.createElement("div", {
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
  let { history, loading, range, onRangeChange, currency } = _refChart;
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
  const points = history && history.data && history.data.points ? history.data.points : null;
  if (!points || points.length < 2) {
    return React.createElement("div", { className: "chart-block" }, rangeBar,
      React.createElement("div", { className: "chart-empty" },
        loading ? 'Loading chart\u2026' : (history && !loading ? 'Chart data unavailable' : 'Loading chart\u2026')
      )
    );
  }
  const W = 600, H = 180;
  const PL = 2, PR = 2, PT = 6, PB = 6;
  const prs = points.map(p => p.p);
  const min = Math.min(...prs);
  const max = Math.max(...prs);
  const span = max - min || 1;
  const chartW = W - PL - PR;
  const chartH = H - PT - PB;
  const xFor = i => PL + (i / (points.length - 1)) * chartW;
  const yFor = p => PT + (1 - (p - min) / span) * chartH;
  const d = points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(2)},${yFor(pt.p).toFixed(2)}`).join(' ');
  const areaD = d + ` L${xFor(points.length - 1).toFixed(2)},${H - PB} L${PL},${H - PB} Z`;
  const first = points[0].p;
  const last = points[points.length - 1].p;
  const up = last >= first;
  const color = up ? '#10b981' : '#f43f5e';
  const gradId = `grad-${up ? 'up' : 'down'}`;
  const retPct = first > 0 ? (last - first) / first * 100 : 0;
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
        React.createElement("path", { d, fill: "none", stroke: color, strokeWidth: 1.5, vectorEffect: "non-scaling-stroke" }),
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
      )
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
function FundamentalsBlock(_refFB) {
  let { fundamentals, quote, market } = _refFB;
  const loading = fundamentals && fundamentals.loading && !fundamentals.data;
  const f = fundamentals?.data || {};
  const cur = quote?.price && quote.price > 0 ? quote.price : null;
  const ccySym = ({ ZAR: 'R', GBP: '\u00a3', AUD: 'A$', EUR: '\u20ac' })[quote?.currency] || '$';
  const stats = [];
  const push = (label, value, sub) => {
    if (value == null || value === '' || (typeof value === 'number' && !isFinite(value))) return;
    stats.push({ label, value, sub });
  };
  const yearHigh = f.yearHigh || quote?.yearHigh;
  const yearLow = f.yearLow || quote?.yearLow;
  if (f.peTrailing != null) push('P/E ratio', f.peTrailing.toFixed(2));
  if (f.peForward != null) push('Earnings multiple (fwd)', f.peForward.toFixed(2));
  if (f.eps != null) push('EPS (TTM)', ccySym + f.eps.toFixed(2));
  if (f.dividendYield != null) push('Dividend yield', f.dividendYield.toFixed(2) + '%');
  if (f.debtToEquity != null) push('Debt/Equity', (f.debtToEquity / 100).toFixed(2));
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
  const mcap = fmtLarge(f.marketCap);
  if (mcap) push('Market cap', mcap);
  if (f.pegRatio != null) push('PEG', f.pegRatio.toFixed(2));
  if (f.priceToBook != null) push('P/B', f.priceToBook.toFixed(2));
  if (f.priceToSales != null) push('P/S', f.priceToSales.toFixed(2));
  if (f.beta != null) push('Beta', f.beta.toFixed(2));
  if (f.profitMargin != null) push('Profit margin', f.profitMargin.toFixed(1) + '%');
  if (f.operatingMargin != null) push('Op margin', f.operatingMargin.toFixed(1) + '%');
  if (f.roe != null) push('ROE', f.roe.toFixed(1) + '%');
  if (f.revenueGrowth != null) push('Rev growth', f.revenueGrowth.toFixed(1) + '%');
  if (f.earningsGrowth != null) push('EPS growth', f.earningsGrowth.toFixed(1) + '%');
  if (f.currentRatio != null) push('Current ratio', f.currentRatio.toFixed(2));
  if (f.revenue != null) { const r = fmtLarge(f.revenue); if (r) push('Revenue', r); }
  if (f.ebitda != null) { const e = fmtLarge(f.ebitda); if (e) push('EBITDA', e); }
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
  const hasFundamentals = Object.keys(f).length > 0;
  const empty = !loading && stats.length === 0 && !targetSection && !sectorRow;
  return React.createElement("div", { className: "fundamentals-block" },
    React.createElement("div", { className: "eyebrow", style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      React.createElement("span", null, "Key stats & ratios"),
      ai && React.createElement("span", { className: "news-ai-badge" }, "AI"),
      loading && React.createElement("span", { className: "text-xs" }, "Loading\u2026")
    ),
    sectorRow,
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
    alerts,
    news,
    historyByTicker,
    fundamentals,
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
  const quote = prices[priceKey(market, ticker)];
  const ccy = market === 'JSE' ? 'ZAR' : 'USD';
  const [dir, setDir] = useState('above');
  const [target, setTarget] = useState(quote ? quote.price.toFixed(2) : '');
  const [note, setNote] = useState('');
  const [range, setRange] = useState('1y');
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  const history = historyByTicker ? historyByTicker[priceKey(market, ticker) + ':' + range] : null;
  useEffect(() => {
    if (quote && !target) setTarget(quote.price.toFixed(2));
  }, [quote]);
  useEffect(() => {
    if (onLoadHistory) onLoadHistory(range);
  }, [range]);
  const submitAlert = () => {
    const t = parseFloat(target);
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
  }, React.createElement("div", null, React.createElement("div", {
    className: "modal-title"
  }, ticker), React.createElement("div", {
    className: "modal-subtitle"
  }, (info.name && info.name !== ticker ? info.name : null) || quote?.shortName || quote?.longName || ticker, " \xB7 ", React.createElement("span", {
    className: "market-badge"
  }, market))), React.createElement("button", {
    className: "modal-close",
    onClick: onClose,
    "aria-label": "Close"
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "modal-body"
  }, React.createElement(PriceBlock, {
    quote: quote,
    size: "xl",
    showDailyRow: true
  }), quote && quote.yearHigh ? React.createElement("div", {
    className: "ath-strip"
  }, React.createElement("span", {
    className: "eyebrow"
  }, "52W High"), React.createElement("span", {
    className: "mono"
  }, fmt(quote.yearHigh, market)), React.createElement("span", {
    className: `mono ${quote.price >= quote.yearHigh * 0.995 ? 'text-up' : 'text-muted'}`
  }, quote.price >= quote.yearHigh * 0.995 ? 'At high' : ((quote.price - quote.yearHigh) / quote.yearHigh * 100).toFixed(2) + '%')) : null,
    React.createElement(EarningsBadge, { fundamentals: fundamentals }),
    React.createElement(PriceChart, {
    history: history,
    loading: history?.loading,
    range: range,
    onRangeChange: setRange,
    currency: quote?.currency || ccy
  }),
    React.createElement(FundamentalsBlock, { fundamentals: fundamentals, quote: quote, market: market }),
    info.entryPrice && React.createElement("div", {
    className: "kv-row"
  }, React.createElement("div", {
    className: "kv"
  }, React.createElement("div", {
    className: "kv-label"
  }, "Entry"), React.createElement("div", {
    className: "kv-val"
  }, fmt(info.entryPrice, market))), info.targetPrice && React.createElement("div", {
    className: "kv"
  }, React.createElement("div", {
    className: "kv-label"
  }, "Target"), React.createElement("div", {
    className: "kv-val"
  }, fmt(info.targetPrice, market))), info.upside != null && React.createElement("div", {
    className: "kv"
  }, React.createElement("div", {
    className: "kv-label"
  }, "Upside"), React.createElement("div", {
    className: "kv-val up"
  }, "+", info.upside, "%"))), info.action && React.createElement("div", null, React.createElement("span", {
    className: `pill pill-lg pill-${info.actionType || 'hold'}`
  }, info.action)), info.thesis && React.createElement("div", null, React.createElement("div", {
    className: "eyebrow"
  }, "Thesis"), React.createElement("div", {
    className: "thesis-text text-sm text-muted",
    style: {
      lineHeight: 1.6
    }
  }, info.thesis)), info.catalysts && info.catalysts.length > 0 && React.createElement("div", null, React.createElement("div", {
    className: "eyebrow"
  }, "Catalysts"), React.createElement("ul", {
    className: "bullet-list"
  }, info.catalysts.map((c, i) => React.createElement("li", {
    key: i
  }, React.createElement("span", null, c))))), info.risks && info.risks.length > 0 && React.createElement("div", null, React.createElement("div", {
    className: "eyebrow"
  }, "Risks"), React.createElement("ul", {
    className: "bullet-list"
  }, info.risks.map((r, i) => React.createElement("li", {
    key: i
  }, React.createElement("span", null, r))))), info.trimLevels && info.trimLevels.length > 0 && React.createElement("div", null, React.createElement("div", {
    className: "eyebrow"
  }, "Trim ladder"), React.createElement("ul", {
    className: "bullet-list"
  }, info.trimLevels.map((t, i) => React.createElement("li", {
    key: i
  }, React.createElement("span", null, t))))), React.createElement("div", null, React.createElement("div", {
    className: "eyebrow",
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, React.createElement("span", null, "Price alerts"), React.createElement("span", {
    className: "text-xs"
  }, alerts.length, " active")), alerts.length > 0 && React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      marginBottom: 12
    }
  }, alerts.map(a => React.createElement("div", {
    key: a.id,
    className: "alert-item"
  }, React.createElement("div", null, React.createElement("div", {
    className: "mono text-sm"
  }, a.direction === 'above' ? '↑ above ' : '↓ below ', fmt(a.targetPrice, market)), a.note && React.createElement("div", {
    className: "text-xs text-dim mt-1"
  }, a.note)), React.createElement("button", {
    className: "btn btn-ghost btn-xs",
    onClick: () => onRemoveAlert(a.id),
    "aria-label": "Remove"
  }, React.createElement(Icon, {
    name: "x",
    size: 12
  }))))),
    React.createElement("div", { className: "card alert-form" },
      React.createElement("div", { className: "alert-dir-group", role: "radiogroup", "aria-label": "Trigger direction" },
        React.createElement("button", {
          type: "button",
          role: "radio",
          "aria-checked": dir === 'above',
          className: `alert-dir-btn up ${dir === 'above' ? 'active' : ''}`,
          onClick: () => setDir('above')
        }, React.createElement("span", { className: "alert-dir-arrow" }, "\u2191"),
           React.createElement("span", { className: "alert-dir-label" }, "Above")),
        React.createElement("button", {
          type: "button",
          role: "radio",
          "aria-checked": dir === 'below',
          className: `alert-dir-btn down ${dir === 'below' ? 'active' : ''}`,
          onClick: () => setDir('below')
        }, React.createElement("span", { className: "alert-dir-arrow" }, "\u2193"),
           React.createElement("span", { className: "alert-dir-label" }, "Below"))
      ),
      React.createElement("div", { className: "alert-target-row" },
        React.createElement("div", { className: "input-prefix-wrap alert-target-wrap" },
          React.createElement("span", { className: "prefix" }, ccy === 'ZAR' ? 'R' : '$'),
          React.createElement("input", {
            type: "number",
            inputMode: "decimal",
            step: "0.01",
            placeholder: "Target price",
            value: target,
            onChange: e => setTarget(e.target.value),
            className: "alert-target-input"
          })
        )
      ),
      React.createElement("input", {
        type: "text",
        placeholder: "Note (optional)",
        value: note,
        onChange: e => setNote(e.target.value),
        maxLength: "80",
        className: "alert-note-input"
      }),
      React.createElement("button", {
        className: `btn btn-block mt-3 alert-submit ${dir === 'above' ? 'up' : 'down'}`,
        onClick: submitAlert
      }, React.createElement(Icon, { name: "plus" }),
         " Alert when ", dir === 'above' ? 'above ' : 'below ',
         target && isFinite(parseFloat(target)) ? (ccy === 'ZAR' ? 'R' : '$') + parseFloat(target).toFixed(2) : 'target')
    )), React.createElement("div", null, React.createElement("div", {
    className: "eyebrow",
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, React.createElement("span", null, "News"), news?.loading && React.createElement("span", {
    className: "text-xs"
  }, "Loading\u2026")), news && news.data && news.data.length > 0 ? React.createElement("div", null, news.data.map((n, i) => React.createElement("a", {
    key: i,
    href: n.link && n.link !== '#' ? n.link : undefined,
    target: "_blank",
    rel: "noopener",
    className: `news-item${n.ai ? ' news-item-ai' : ''}`
  }, React.createElement("div", {
    className: "news-title"
  }, n.ai && React.createElement("span", { className: "news-ai-badge" }, "AI"), n.title), n.summary && React.createElement("div", {
    className: "news-summary"
  }, n.summary), React.createElement("div", {
    className: "news-meta"
  }, React.createElement("span", null, n.source), n.pubDate && React.createElement(React.Fragment, null, React.createElement("span", null, "\xB7"), React.createElement("span", null, timeAgo(n.pubDate))), React.createElement(Icon, {
    name: "external",
    size: 11
  }))))) : React.createElement("div", {
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
  }, "Alerts fire when the app is open or recently backgrounded. For reliable lock-screen delivery, keep the app open or recently used.")) : notifPerm === 'denied' ? React.createElement("div", {
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
function ContributionModal({ onClose, onSave }) {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  const submit = () => {
    const a = parseFloat(amount);
    if (!isFinite(a) || a <= 0) return;
    onSave(a, currency, date, note);
  };
  const ccy = currency === 'ZAR' ? 'R' : '$';
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel", style: { maxWidth: 420 }, ref: panelRef },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, "Log contribution"),
          React.createElement("div", { className: "modal-subtitle" }, "Record cash deposited from outside your portfolio")
        ),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" })
        )
      ),
      React.createElement("div", { className: "modal-body" },
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
              type: "number", inputMode: "decimal", step: "0.01", min: "0",
              placeholder: "0.00", value: amount,
              onChange: e => setAmount(e.target.value),
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
          React.createElement("button", { className: "btn btn-primary", onClick: submit }, "Save")
        )
      )
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
  const submit = async () => {
    if (!ticker.trim()) return;
    const s = parseFloat(shares);
    const c = parseFloat(costBasis);
    if (!isFinite(s) || s <= 0) return;
    if (!isFinite(c) || c <= 0) return;
    if (purchaseDate && purchaseDate > todayISO) {
      setTickerError('Purchase date cannot be in the future.');
      return;
    }
    if (!isEdit) {
      setVerifying(true);
      setTickerError('');
      const q = await fetchQuote(ticker.trim(), market);
      setVerifying(false);
      if (!q) {
        setTickerError(`"${ticker.trim()}" not found on ${market}. Check the symbol.`);
        return;
      }
    }
    onSave({
      ticker: ticker.trim().toUpperCase(),
      market, shares: s, costBasis: c, notes,
      purchaseDate: purchaseDate || null
    });
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
    type: "number",
    inputMode: "decimal",
    step: "0.0001",
    min: "0",
    placeholder: "10",
    value: shares,
    onChange: e => setShares(e.target.value)
  })), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Cost basis per share"), React.createElement("div", {
    className: "input-prefix-wrap"
  }, React.createElement("span", {
    className: "prefix"
  }, ccy), React.createElement("input", {
    type: "number",
    inputMode: "decimal",
    step: "0.01",
    min: "0",
    placeholder: "0.00",
    value: costBasis,
    onChange: e => setCostBasis(e.target.value)
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
                        positions, contributions, prices, onExport, onImport, onClose }) {
  const [refreshing, setRefreshing] = useState(false);
  const [activeSection, setActiveSection] = useState('display');
  const fileInputRef = useRef(null);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
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
          fxRates && snap.combinedValue > 0 && React.createElement("div", { className: "settings-stat-card" },
            React.createElement("div", { className: "settings-stat-label" }, "Combined portfolio (" + displayCurrency + ")"),
            React.createElement("div", { className: "settings-stat-value" }, fmtCcy(snap.combinedValue, displayCurrency)),
            snap.combinedCostAtPurchase > 0 && React.createElement("div", { className: "settings-stat-sub" },
              "Cost at purchase: " + fmtCcy(snap.combinedCostAtPurchase, displayCurrency))
          ),
          React.createElement("div", { className: "settings-info-box" },
            React.createElement("div", { className: "settings-info-title" },
              React.createElement(Icon, { name: "globe", size: 12 }), " How FX gain/loss is calculated"),
            React.createElement("div", { className: "settings-info-body" },
              "When you add a position, the live exchange rate is stored. Price P&L tracks native-currency changes. FX impact shows how much your ", displayCurrency, " value has shifted purely from currency moves.")
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
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      console.log('SW registered:', reg.scope);
    }).catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}