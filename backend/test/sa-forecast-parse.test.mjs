// Tests for parseSAForecast (pb-core.js): the stockanalysis.com forecast
// page-data parser that restores the analyst consensus price target on stock
// cards after the /api/symbol tree went 404-dead (2026-07-12).
//   cd backend/test && node sa-forecast-parse.test.mjs
//
// The endpoint is the SvelteKit __data.json behind stockanalysis.com's public
// /forecast/ pages. Payloads use the "devalue" flat-array encoding: each data
// node's `data` is a flat array; objects are key->index maps into that array,
// arrays are lists of indices, -1 means undefined. Targets arrive in the
// listing's minor units (ZAc rand-cents, GBX pence) and must come out in
// natural units so the card's upside math against quote.price is correct.
//
// Source guards at the bottom pin the app.js wiring: the fetcher MUST ride the
// proxy chain (the endpoint sends no Access-Control-Allow-Origin, so a direct
// browser fetch can never read it — unlike the dead /api/symbol tree, which
// must stay direct + time-boxed, see fundamentals-parse.test.mjs) and MUST be
// outer-time-boxed so a proxy-chain crawl can never stall the stats render.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';

const { parseSAForecast, mergeFundamentals } = PBCore;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;

ok('PBCore exports parseSAForecast', typeof parseSAForecast === 'function');

// ── Synthetic devalue payload builder ───────────────────────────────────────
// Encodes a plain JS value into the flat index-referencing array SvelteKit
// ships. Mirrors the real format closely enough for the resolver: root at
// index 0, every nested value at its own index.
function devalue(root) {
  const data = [];
  const enc = (v) => {
    if (v === undefined) return -1;
    const i = data.push(null) - 1;
    if (v === null || typeof v !== 'object') data[i] = v;
    else if (Array.isArray(v)) { const a = []; data[i] = a; for (const x of v) a.push(enc(x)); }
    else { const o = {}; data[i] = o; for (const [k, x] of Object.entries(v)) o[k] = enc(x); }
    return i;
  };
  enc(root);
  return data;
}
// Real payloads carry a session node, non-data entries and an info node before
// the forecast node — the parser must skip all of them.
const saPayload = (forecastRoot) => ({
  type: 'data',
  nodes: [
    { type: 'data', data: devalue({ session: null, theme: 'light' }), uses: {} },
    null,
    { type: 'data', data: devalue({ info: { symbol: 'X', ticker: 'X' } }), uses: {} },
    { type: 'data', data: devalue(forecastRoot), uses: {} }
  ]
});

// ── US listing: curated targets in natural USD, no scaling ──────────────────
const us = parseSAForecast(saPayload({
  targets: { low: 250, high: 400, count: 26, median: 325, average: 323.07, updated: '2026-07-09', currency: 'USD', chart: [{ c: 207.57, t: '2025-07-01' }] },
  priceTargets: { source: 'spg', currency: 'USD', avg: 315.09, median: 315, low: 215, high: 400, numPriceTargets: 42 },
  currentRatings: { source: 'spg', consensus: 'Buy', score: 4.89, count: 47, strongBuy: 22, buy: 6, hold: 16, sell: 2, strongSell: 1 },
  title: 'Apple (AAPL) Stock Forecast'
}), 'US');
ok('US: parses a hit', us != null && typeof us === 'object');
if (us) {
  ok('US: prefers the curated target set (what the public page headlines)', near(us.targetMean, 323.07));
  ok('US: high/low from the same set', near(us.targetHigh, 400) && near(us.targetLow, 250));
  ok('US: analystCount from the chosen set, not the ratings pool', us.analystCount === 26);
  ok('US: consensus mapped to recommendationKey vocabulary', us.recommendation === 'buy');
  ok('US: updated date surfaced in ms', us.targetUpdated === Date.parse('2026-07-09'));
  ok('US: attribution tag for the card sub-line', us.targetSource === 'stockanalysis.com');
  ok('US: tagged sa-forecast with fetchedAt', us.source === 'sa-forecast' && typeof us.fetchedAt === 'number');
  ok('US: partial only — no ratio keys to stomp the merge', !('peTrailing' in us) && !('marketCap' in us) && !('currency' in us) && !('divisor' in us));
}

// ── LSE listing: GBX pence scale to pounds (÷100) ───────────────────────────
const lse = parseSAForecast(saPayload({
  targets: { low: 185, high: 353, count: 11, median: 251, average: 264.42, updated: '2026-06-22', currency: 'GBX', chart: [] },
  priceTargets: { source: 'spg', currency: 'GBX', avg: 266.97, median: 258.5, low: 185, high: 353, numPriceTargets: 14 },
  currentRatings: { source: 'spg', consensus: 'Hold', score: 0, count: 14, strongBuy: 2, buy: 2, hold: 6, sell: 2, strongSell: 2 }
}), 'LSE');
ok('LSE: GBX pence scaled to pounds', lse != null && near(lse.targetMean, 2.6442) && near(lse.targetHigh, 3.53) && near(lse.targetLow, 1.85));
ok('LSE: Hold consensus', lse != null && lse.recommendation === 'hold');

// ── JSE listing: curated set empty → S&P Global priceTargets, ZAc ÷100 ──────
const jse = parseSAForecast(saPayload({
  targets: { low: null, high: null, average: null, median: null, count: 0, updated: '', currency: 'ZAc', chart: [] },
  priceTargets: { source: 'spg', currency: 'ZAc', avg: 126159.31, median: 127049.33, low: 82819.15, high: 160841.42, numPriceTargets: 10 },
  currentRatings: { source: 'spg', consensus: 'Strong Buy', score: 7.5, count: 10, strongBuy: 6, buy: 3, hold: 1, sell: 0, strongSell: 0 }
}), 'JSE');
ok('JSE: falls back to the spg set when the curated one is empty', jse != null && near(jse.targetMean, 1261.5931));
ok('JSE: spg high/low scaled from rand-cents', jse != null && near(jse.targetHigh, 1608.4142) && near(jse.targetLow, 828.1915));
ok('JSE: analystCount from numPriceTargets', jse != null && jse.analystCount === 10);
ok('JSE: multi-word consensus mapped', jse != null && jse.recommendation === 'strong_buy');
ok('JSE: no updated date on the spg set → null', jse != null && jse.targetUpdated === null);

// ── Which currency the targets are IN ───────────────────────────────────────
// The scale (÷100) and the currency are two different questions. The card needs
// the second one too: the S&P Global pool quotes some non-US listings in
// dollars, and a dollar target held up against a rand price renders as a ~-95%
// "upside" - a number the user would read as a crash forecast.
ok('US: targetCurrency USD', us != null && us.targetCurrency === 'USD');
ok('LSE: GBX targets are tagged GBP (major units, post-divisor)', lse != null && lse.targetCurrency === 'GBP');
ok('JSE: ZAc targets are tagged ZAR', jse != null && jse.targetCurrency === 'ZAR');
const jseUsdTargets = parseSAForecast(saPayload({
  targets: { low: null, high: null, average: null, median: null, count: 0, updated: '', currency: 'USD', chart: [] },
  priceTargets: { source: 'spg', currency: 'USD', avg: 70, median: 70, low: 55, high: 90, numPriceTargets: 6 },
  currentRatings: { source: 'spg', consensus: 'Buy', score: 5, count: 6, strongBuy: 3, buy: 3, hold: 0, sell: 0, strongSell: 0 }
}), 'JSE');
ok('a JSE listing with dollar-quoted targets says so', jseUsdTargets != null && jseUsdTargets.targetCurrency === 'USD');
ok('dollar targets on a JSE listing are NOT divided by 100', jseUsdTargets != null && near(jseUsdTargets.targetMean, 70));

// ── Degenerate set values ───────────────────────────────────────────────────
// Curated set present but with a count and no usable average → spg wins.
const half = parseSAForecast(saPayload({
  targets: { low: null, high: null, average: null, median: null, count: 5, updated: '2026-07-01', currency: 'USD', chart: [] },
  priceTargets: { source: 'spg', currency: 'USD', avg: 50, median: 50, low: 40, high: 60, numPriceTargets: 7 }
}), 'US');
ok('curated set without a usable average falls through to spg', half != null && near(half.targetMean, 50) && half.analystCount === 7);
// Ratings block absent → targets still usable, recommendation null.
const noRating = parseSAForecast(saPayload({
  targets: { low: 10, high: 20, count: 3, median: 15, average: 15.5, updated: '2026-07-01', currency: 'USD', chart: [] },
  priceTargets: { source: 'spg', currency: 'USD', avg: null, median: null, low: null, high: null, numPriceTargets: 0 }
}), 'US');
ok('missing ratings → targets without recommendation', noRating != null && near(noRating.targetMean, 15.5) && noRating.recommendation === null);
// A ratings pool of zero analysts is noise, not a consensus.
const zeroPool = parseSAForecast(saPayload({
  targets: { low: 10, high: 20, count: 3, median: 15, average: 15.5, updated: '', currency: 'USD', chart: [] },
  currentRatings: { source: 'spg', consensus: 'Buy', score: 0, count: 0, strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 }
}), 'US');
ok('zero-analyst ratings pool → recommendation null', zeroPool != null && zeroPool.recommendation === null);

// ── Misses ──────────────────────────────────────────────────────────────────
ok('both target sets empty → null', parseSAForecast(saPayload({
  targets: { low: null, high: null, average: null, median: null, count: 0, updated: '', currency: 'ZAc', chart: [] },
  priceTargets: { source: 'spg', currency: 'ZAc', avg: null, median: null, low: null, high: null, numPriceTargets: 0 },
  currentRatings: { source: 'spg', consensus: 'Buy', count: 4 }
}), 'JSE') === null);
ok('payload without a forecast node → null', parseSAForecast(saPayload({ estimates: { some: 'thing' } }), 'US') === null);
ok('empty nodes → null', parseSAForecast({ type: 'data', nodes: [] }, 'US') === null);
ok('malformed → null', parseSAForecast({}, 'US') === null && parseSAForecast(null, 'US') === null);
ok('non-devalue node data → null, no crash', parseSAForecast({ type: 'data', nodes: [{ type: 'data', data: 'oops' }] }, 'US') === null);

// ── Merge: the forecast partial rides first, timeseries fills the rest ──────
const tsPart = { peTrailing: 24.5, marketCap: 3.1e12, targetMean: null, recommendation: null, currency: 'USD', divisor: 1, source: 'yahoo-ts' };
const merged = mergeFundamentals([us, tsPart]);
ok('merge: analyst fields from the forecast partial', merged != null && near(merged.targetMean, 323.07) && merged.recommendation === 'buy');
ok('merge: ratios filled from timeseries', merged != null && near(merged.peTrailing, 24.5) && near(merged.marketCap, 3.1e12));
ok('merge: source tags joined', merged != null && merged.source === 'sa-forecast+yahoo-ts');

// ── Source guards: app.js wiring (anti-drift) ───────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
const fnBody = (name) => {
  const start = appSrc.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const rest = appSrc.slice(start + 1);
  const next = rest.search(/\r?\n(?:async )?function /);
  return next < 0 ? rest : rest.slice(0, next);
};
ok('app.js delegates parsing to PBCore.parseSAForecast', appSrc.includes('PBCore.parseSAForecast('));
const fetcher = fnBody('fetchAnalystForecastSA');
ok('fetchAnalystForecastSA exists', !!fetcher);
ok('fetcher hits the forecast __data.json endpoint', !!fetcher && fetcher.includes('/forecast/__data.json'));
ok('fetcher rides the proxy chain (endpoint has no ACAO — direct cannot work)', !!fetcher && fetcher.includes('fetchViaProxies'));
ok('fetcher is outer-time-boxed so it can never stall the stats render', !!fetcher && fetcher.includes('Promise.race'));
const orch = fnBody('fetchFundamentals');
ok('fetchFundamentals fetches the forecast in its parallel batch', !!orch && orch.includes('fetchAnalystForecastSA('));
ok('forecast part is pushed first so its analyst fields win the merge',
  !!orch && /parts\.push\(fcast\)[\s\S]*parts\.push\(sa\)/.test(orch));
// quoteSummary's targets arrive in the listing's minor units (GBp/ZAc) like
// bookValue — they must be divided by the same divisor, not passed raw.
const qs = fnBody('fetchFundamentalsYahoo');
ok('quoteSummary targets go through the divisor helper', !!qs && qs.includes('targetMean: tgt(fd.targetMeanPrice)') && qs.includes('targetHigh: tgt(fd.targetHighPrice)') && qs.includes('targetLow: tgt(fd.targetLowPrice)'));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
