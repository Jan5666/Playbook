// Characterization tests for the quote/price providers + batcher + name cache
// moved into pb-data.js. Mocks globalThis.fetch with canned Yahoo/Stooq payloads.
//   cd backend/test && node data-providers.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBData from '../../pb-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;

// A fresh Yahoo 5d/1d chart payload (regularMarketTime ~ now → not "stale", so
// fetchQuote takes the daily-only path and makes exactly one proxied call).
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
ok('fetchQuote daily-only path = 1 fetch', fetchCalls.length === 1);
ok('fetchQuote populates name cache', PBData.cachedName('US', 'AAPL') === 'Apple');

// parseStooqCsv via the Stooq fallback is tested directly on the moved function
// only if exported; otherwise exercise it through fetchQuote with Yahoo null.
// Here: assert the indicator/unit-trust routing predicates.
ok('isUnitTrustId true for SecId shape', PBData.isUnitTrustId('F000002CRJ') === true);
ok('isUnitTrustId false for normal ticker', PBData.isUnitTrustId('AAPL') === false);

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

console.log(failures ? `\n${failures} test(s) failed` : '\nAll data-providers tests passed');
process.exit(failures ? 1 : 0);
