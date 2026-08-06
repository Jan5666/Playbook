// Characterization tests for the quote/price providers + batcher + name cache
// moved into pb-data.js. Mocks globalThis.fetch with canned Yahoo/Stooq payloads.
//   cd backend/test && node data-providers.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBData from '../../pb-data.js';
import PBCore from '../../pb-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;

// A fresh Yahoo 5d/1d chart payload (regularMarketTime ~ now → not "stale", so
// fetchQuote takes the daily-only path and makes exactly one proxied call —
// EXCEPT inside a pre/post session, see extHoursNow below).
function yahooChart(symbol, price, prev, name) {
  const nowSec = Math.floor(Date.now() / 1000);
  return JSON.stringify({ chart: { result: [{
    meta: { regularMarketPrice: price, regularMarketPreviousClose: prev, currency: 'USD',
            shortName: name, longName: name, marketState: 'REGULAR', regularMarketTime: nowSec },
    timestamp: [nowSec], indicators: { quote: [{ close: [price] }] }
  }] } });
}

// A Yahoo history payload (timestamp + close arrays) for fetchHistory.
function yahooHistory(symbol, price) {
  const nowSec = Math.floor(Date.now() / 1000);
  return JSON.stringify({ chart: { result: [{
    meta: { currency: 'USD', shortName: symbol },
    timestamp: [nowSec - 86400, nowSec],
    indicators: { quote: [{ close: [price, price + 1] }] }
  }] } });
}

// Route fetch by the upstream symbol embedded in the proxied URL. Counts calls.
let fetchCalls = [];
function installYahoo(map /* symbol -> chart json | null */) {
  fetchCalls = [];
  globalThis.fetch = async (proxiedUrl) => {
    fetchCalls.push(proxiedUrl);
    const dec = decodeURIComponent(proxiedUrl);
    for (const sym of Object.keys(map)) {
      if (dec.includes(`/chart/${sym}?`) || dec.includes(`/chart/${sym}&`) || dec.includes(`/chart/${sym}`)) {
        const body = map[sym];
        return { ok: body != null, text: async () => (body == null ? '' : body) };
      }
    }
    return { ok: false, text: async () => '' };
  };
}

PBData.configure({ indicatorCatalog: {} }); // no indicators routed in these tests

// fetchQuote happy path + name cache populated
installYahoo({ AAPL: yahooChart('AAPL', 150, 145, 'Apple') });
let q = await PBData.fetchQuote('AAPL', 'US');
ok('fetchQuote returns parsed price', q && q.price === 150);
ok('fetchQuote computes change vs prevClose', q && near(q.change, 5));
// fetchQuote also pulls the 1m intraday chart whenever the market is in a pre or
// post session — that is the only source of the extended-hours readout, and a
// fresh pre-market print makes the daily quote look current, so `looksStale`
// alone used to skip it and the pre-market chip never appeared. Outside ext hours
// the daily-only path still makes exactly one call. Derived from the clock rather
// than hard-coded so this reads the same at any hour.
const extHoursNow = ['pre', 'post'].includes(PBCore.marketSession('US').phase);
ok(`fetchQuote daily-only path = ${extHoursNow ? 2 : 1} fetch (US phase: ${PBCore.marketSession('US').phase})`,
  fetchCalls.length === (extHoursNow ? 2 : 1));
ok('fetchQuote populates name cache', PBData.cachedName('US', 'AAPL') === 'Apple');

// parseStooqCsv via the Stooq fallback is tested directly on the moved function
// only if exported; otherwise exercise it through fetchQuote with Yahoo null.
// Here: assert the indicator/unit-trust routing predicates.
ok('isUnitTrustId true for SecId shape', PBData.isUnitTrustId('F000002CRJ') === true);
ok('isUnitTrustId false for normal ticker', PBData.isUnitTrustId('AAPL') === false);

// ── Stooq fallback units: TFSA is the same .JO listing as JSE ────────────────
// Stooq quotes SA listings in cents, so the fallback divides by 100 and labels the
// quote ZAR. That test read `market === 'JSE'` only, so a TFSA holding whose Yahoo
// fetch failed came back 100x too high AND labelled USD — which the display layer
// then FX-converted a second time. stooqSymbol already treats the two as one
// listing (both → ticker.jo), so the units must agree with it.
const stooqCsv = 'Date,Open,High,Low,Close,Volume\n2026-07-30,9000,9100,8900,9000,1000\n2026-07-31,9100,9300,9050,9250,1200\n';
const stooqJse  = PBData.parseStooqCsv(stooqCsv, 'JSE');
const stooqTfsa = PBData.parseStooqCsv(stooqCsv, 'TFSA');
const stooqUs   = PBData.parseStooqCsv(stooqCsv, 'US');
ok('stooq JSE: cents → rand', near(stooqJse.price, 92.5) && near(stooqJse.prevClose, 90));
ok('stooq JSE: labelled ZAR', stooqJse.currency === 'ZAR');
ok('stooq TFSA: cents → rand (was 100x too high)', near(stooqTfsa.price, 92.5) && near(stooqTfsa.prevClose, 90));
ok('stooq TFSA: labelled ZAR (was USD)', stooqTfsa.currency === 'ZAR');
ok('stooq TFSA matches JSE exactly', stooqTfsa.price === stooqJse.price && stooqTfsa.currency === stooqJse.currency);
ok('stooq TFSA change % survives the divisor', near(stooqTfsa.changePct, stooqJse.changePct));
ok('stooq US untouched: no divisor, USD', near(stooqUs.price, 9250) && stooqUs.currency === 'USD');
ok('stooqSymbol maps TFSA to the .jo listing', PBData.stooqSymbol('AIETF', 'TFSA') === PBData.stooqSymbol('AIETF', 'JSE'));
// Column 0 is the row's own session date. Stooq's .jo file is END OF DAY and its
// latest row is routinely the previous session; the quote carries no
// regularMarketTime, so without sessionDay quoteTradedToday fell through to the
// market clock and counted yesterday's close as today's move at the JSE open.
ok('stooq carries the session date it actually came from', stooqJse.sessionDay === '2026-07-31');
ok('stooq sessionDay is market-agnostic', stooqUs.sessionDay === '2026-07-31' && stooqTfsa.sessionDay === '2026-07-31');
ok('stooq sessionDay null when the date column is not a date',
  PBData.parseStooqCsv('Date,Open,High,Low,Close,Volume\nx,1,1,1,90,1\ny,1,1,1,92.5,1\n', 'US').sessionDay === null);
ok('a stale stooq row is refused by the Today gate',
  PBCore.quoteTradedToday(stooqJse, 'JSE', Date.parse('2026-08-04T12:00:00Z')) === false);

// fetchQuoteBatch: keys by priceKey, fires onBatch, second pass retries missing.
installYahoo({ AAPL: yahooChart('AAPL', 150, 145, 'Apple'), MSFT: yahooChart('MSFT', 400, 390, 'Microsoft') });
const seen = [];
let res = await PBData.fetchQuoteBatch(
  [{ ticker: 'AAPL', market: 'US' }, { ticker: 'MSFT', market: 'US' }],
  { onBatch: (fresh) => seen.push(Object.keys(fresh)) }
);
ok('fetchQuoteBatch keys results by priceKey', res['US:AAPL'] && res['US:MSFT'] && res['US:AAPL'].price === 150);
ok('fetchQuoteBatch fired onBatch with fresh keys', seen.length >= 1 && seen.flat().includes('US:AAPL'));

// second pass: MSFT null on first sweep, present on retry
let msftCalls = 0;
globalThis.fetch = async (proxiedUrl) => {
  const dec = decodeURIComponent(proxiedUrl);
  if (dec.includes('/chart/AAPL')) return { ok: true, text: async () => yahooChart('AAPL', 150, 145, 'Apple') };
  if (dec.includes('/chart/MSFT')) { msftCalls++; return { ok: true, text: async () => (msftCalls === 1 ? '' : yahooChart('MSFT', 400, 390, 'Microsoft')) }; }
  return { ok: false, text: async () => '' };
};
res = await PBData.fetchQuoteBatch([{ ticker: 'AAPL', market: 'US' }, { ticker: 'MSFT', market: 'US' }]);
ok('fetchQuoteBatch second pass recovers a missing symbol', res['US:MSFT'] && res['US:MSFT'].price === 400 && msftCalls >= 2);

// ── fetchHistory reliability: parallel hosts + second-pass retry ─────────────
// The chart used to fetch once and give up — a transient proxy miss left the card
// blank until the user toggled ranges. It must self-heal like the quote batchers.

// A whole first sweep fails (both hosts, every proxy), a retry sweep recovers.
// Keying by the full proxied URL fails each on first sight and succeeds only on a
// repeat — a repeat can happen ONLY if fetchHistory re-sweeps, so this isolates the
// sweep-level retry from fetchViaProxies' own per-call proxy ladder.
PBData._setLastGoodProxy(null);
let histCalls = 0;
const seenHist = new Set();
globalThis.fetch = async (proxiedUrl) => {
  const dec = decodeURIComponent(proxiedUrl);
  if (dec.includes('/chart/RETRY')) {
    histCalls++;
    if (seenHist.has(proxiedUrl)) return { ok: true, text: async () => yahooHistory('RETRY', 100) };
    seenHist.add(proxiedUrl);
    return { ok: false, text: async () => '' };
  }
  return { ok: false, text: async () => '' };
};
let hist = await PBData.fetchHistory('RETRY', 'US', '1y');
ok('fetchHistory retries after a failed first sweep', hist && Array.isArray(hist.points) && hist.points.length >= 2);

// One Yahoo host is down for the whole call; the other serves it → no blank chart.
PBData._setLastGoodProxy(null);
globalThis.fetch = async (proxiedUrl) => {
  const dec = decodeURIComponent(proxiedUrl);
  if (dec.includes('/chart/HOSTFB')) {
    if (dec.includes('query1.finance')) return { ok: false, text: async () => '' };
    return { ok: true, text: async () => yahooHistory('HOSTFB', 50) };
  }
  return { ok: false, text: async () => '' };
};
hist = await PBData.fetchHistory('HOSTFB', 'US', '1y');
ok('fetchHistory falls back to the live Yahoo host', hist && Array.isArray(hist.points) && hist.points.length >= 2);

// Every attempt across both passes fails → null (contract preserved, no hang).
PBData._setLastGoodProxy(null);
globalThis.fetch = async () => ({ ok: false, text: async () => '' });
hist = await PBData.fetchHistory('NOPE', 'US', '1y');
ok('fetchHistory returns null when every attempt fails', hist === null);

// Anti-drift guard: app.js binds these from PBData and has no local definitions.
for (const fn of ['fetchQuote', 'fetchQuoteBatch', 'fetchQuoteBatchLight', 'fetchHistory', 'searchUnitTrusts', 'isUnitTrustId', 'cacheName', 'cachedName', 'parseStooqCsv']) {
  ok(`app.js has no local function ${fn}`, !new RegExp(`function\\s+${fn}\\s*\\(`).test(appSrc));
}
for (const fn of ['fetchQuote', 'fetchQuoteBatch', 'fetchHistory', 'searchUnitTrusts', 'isUnitTrustId', 'cachedName']) {
  ok(`app.js binds ${fn} from PBData`, new RegExp(`const\\s+${fn}\\s*=\\s*PBData\\.${fn}`).test(appSrc));
}
ok('app.js injects the indicator catalog', /PBData\.configure\(\s*\{[^}]*indicatorCatalog/.test(appSrc));

// ── Unit-trust NAV must declare its own session ─────────────────────────────
// A unit trust strikes ONE NAV per day and Morningstar publishes it in arrears,
// so ClosePriceDate is routinely the previous business day and ReturnD1 is that
// day's move. The quote used to carry no sessionDay at all — skipping
// quoteTradedToday's strongest gate — and, when ClosePriceDate was missing,
// stamped regularMarketTime with Date.now(), inventing a tick for a NAV of
// unknown age. Between them the gate returned true unconditionally and a
// PREVIOUS-day move was summed into the Dashboard's "Today" pill every morning.
const utRows = (row) => JSON.stringify({ rows: [row] }) + ' '.repeat(40);
globalThis.fetch = async () => ({ ok: true, text: async () => utRows({
  SecId: 'F000002CRJ', Name: 'Allan Gray Balanced', ClosePrice: 152.4,
  PriceCurrency: 'ZAR', ReturnD1: 0.85, ClosePriceDate: '2026-08-04T00:00:00.000'
}) });
let ut = await PBData.fetchUnitTrustQuote('F000002CRJ');
ok('unit trust quote carries sessionDay from its NAV date', ut && ut.sessionDay === '2026-08-04', ut && ut.sessionDay);
ok('unit trust tick is the NAV date, not now', ut && ut.regularMarketTime === Date.parse('2026-08-04T00:00:00.000'));
// The whole point: a T-1 NAV must not count toward a session it never saw.
ok("a T-1 NAV does not count toward the next day's Today",
  PBCore.quoteTradedToday(ut, 'JSE', Date.UTC(2026, 7, 5, 9, 0)) === false);
ok('the same NAV does count on its own session day',
  PBCore.quoteTradedToday(ut, 'JSE', Date.UTC(2026, 7, 4, 9, 0)) === true);

globalThis.fetch = async () => ({ ok: true, text: async () => utRows({
  SecId: 'F000002CRJ', Name: 'Allan Gray Balanced', ClosePrice: 152.4, PriceCurrency: 'ZAR', ReturnD1: 0.85
}) });
ut = await PBData.fetchUnitTrustQuote('F000002CRJ');
ok('missing ClosePriceDate → null tick, never a fabricated Date.now()',
  ut && ut.regularMarketTime === null && ut.sessionDay === null);
// An undated NAV keeps its PRICE (valuation is unaffected) but withholds the
// move: ReturnD1 is a completed-session figure and we cannot say which session.
// A null prevClose is what keeps it out of both "Today" sums.
ok('undated NAV keeps its price', ut && ut.price === 152.4);
ok('undated NAV withholds the day move rather than guessing it',
  ut && ut.prevClose === null && ut.changePct === null && ut.change === null);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll data-providers tests passed');
process.exit(failures ? 1 : 0);
