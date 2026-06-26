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
