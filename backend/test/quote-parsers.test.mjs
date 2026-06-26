// Characterization tests for the Yahoo quote parsers now in the shared core
// (pb-core.js): buildDailyBars, marketDayKey, derivePrevClose, deriveIntradayExt,
// parseYahooQuote.
//   cd backend/test && node quote-parsers.test.mjs
//
// These were buried in app.js with no exports. They're pure given the core helpers
// they already depend on (MARKET_CURRENCY, centDivisor, SESSIONS — all in pb-core),
// so Phase 1 lifts them into pb-core.js where they can be tested over synthetic
// Yahoo chart payloads. The one time-dependence — deriveIntradayExt classifying
// "now" against the day's pre/post windows — is made testable by an optional `now`
// (ms) argument that defaults to Date.now(), so the app call site is unchanged.
//
// Expected values are hand-computed from the same logic the app shipped, so this
// pins behavior. A source guard at the end confirms app.js delegates to the core.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';

const { buildDailyBars, marketDayKey, derivePrevClose, deriveIntradayExt, parseYahooQuote } = PBCore;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;
const sec = iso => Math.floor(Date.parse(iso) / 1000); // Yahoo timestamps are seconds

for (const [n, f] of [['buildDailyBars', buildDailyBars], ['marketDayKey', marketDayKey],
  ['derivePrevClose', derivePrevClose], ['deriveIntradayExt', deriveIntradayExt],
  ['parseYahooQuote', parseYahooQuote]]) ok(`PBCore exports ${n}`, typeof f === 'function');

if (typeof parseYahooQuote === 'function') {
  // ── buildDailyBars: ms timestamps, cent divisor, skips bad closes ───────────
  const bdbRes = { timestamp: [1000, 2000, 3000], indicators: { quote: [{ close: [10, -5, 12] }] } };
  let bars = buildDailyBars(bdbRes, 1);
  ok('buildDailyBars skips non-positive closes', bars.length === 2 && bars[0].p === 10 && bars[1].p === 12);
  ok('buildDailyBars converts ts sec→ms', bars[0].t === 1000000 && bars[1].t === 3000000);
  bars = buildDailyBars(bdbRes, 100);
  ok('buildDailyBars applies cent divisor', near(bars[0].p, 0.1) && near(bars[1].p, 0.12));
  ok('buildDailyBars empty result → []', buildDailyBars({}, 1).length === 0);
  const nanTs = buildDailyBars({ timestamp: ['x'], indicators: { quote: [{ close: [9] }] } }, 1);
  ok('buildDailyBars non-number ts → t null', nanTs.length === 1 && nanTs[0].t === null && nanTs[0].p === 9);

  // ── marketDayKey: market-local calendar day (DST-correct via Intl) ──────────
  ok('marketDayKey US daytime → same UTC day', marketDayKey(Date.parse('2026-06-17T14:00:00Z'), 'US') === '2026-06-17');
  ok('marketDayKey US late-evening UTC → prev NY day', marketDayKey(Date.parse('2026-06-17T02:00:00Z'), 'US') === '2026-06-16');
  ok('marketDayKey JSE morning (UTC+2)', marketDayKey(Date.parse('2026-06-17T06:00:00Z'), 'JSE') === '2026-06-17');

  // ── derivePrevClose: most recent bar on an EARLIER market-local day ─────────
  const d1 = Date.parse('2026-06-16T18:00:00Z'); // 14:00 EDT
  const d2a = Date.parse('2026-06-17T14:00:00Z');
  const d2b = Date.parse('2026-06-17T18:00:00Z'); // current session bar
  const twoDay = [{ t: d1, p: 100 }, { t: d2a, p: 105 }, { t: d2b, p: 110 }];
  ok('derivePrevClose picks earlier-day bar, skips same-day', derivePrevClose(twoDay, 110, 999, 'US') === 100);
  ok('derivePrevClose <2 bars → fallback', derivePrevClose([{ t: d2b, p: 110 }], 110, 999, 'US') === 999);
  ok('derivePrevClose livePrice<=0 → fallback', derivePrevClose(twoDay, 0, 999, 'US') === 999);
  // Unit-mismatch ratio guard: candidate 100 vs live 0.5 → ratio 200 → reject.
  ok('derivePrevClose ratio out of 0.01–100 → fallback', derivePrevClose(twoDay, 0.5, 999, 'US') === 999);

  // ── deriveIntradayExt: classify now against pre/post, measure vs regular ─────
  const ctp = { regular: { start: 1000, end: 2000 }, pre: { start: 500, end: 1000 }, post: { start: 2000, end: 3000 } };
  const extRes = {
    meta: { regularMarketPrice: 100, currency: 'USD', currentTradingPeriod: ctp },
    timestamp: [2100, 2200, 2300], indicators: { quote: [{ close: [101, 102, 103] }] }
  };
  let ext = deriveIntradayExt(extRes, 'US', 2250 * 1000); // now in post window
  ok('deriveIntradayExt post: latest in-session close', ext && near(ext.extPrice, 103) && ext.extKind === 'post' && ext.marketState === 'POST');
  ok('deriveIntradayExt post: change vs regular close', ext && near(ext.extChange, 3) && near(ext.extChangePct, 3));
  ok('deriveIntradayExt during regular session → null', deriveIntradayExt(extRes, 'US', 1500 * 1000) === null);
  // No meaningful move (ext == regular) → null.
  const flat = { meta: { regularMarketPrice: 103, currency: 'USD', currentTradingPeriod: ctp }, timestamp: [2300], indicators: { quote: [{ close: [103] }] } };
  ok('deriveIntradayExt no move → null', deriveIntradayExt(flat, 'US', 2250 * 1000) === null);
  ok('deriveIntradayExt missing meta → null', deriveIntradayExt({}, 'US', 2250 * 1000) === null);

  // ── parseYahooQuote: normalized quote shape ─────────────────────────────────
  const oneBar = ts => ({ timestamp: [ts], indicators: { quote: [{ close: [1] }] } });
  const usRes = {
    meta: {
      regularMarketPrice: 150, regularMarketPreviousClose: 145, currency: 'USD',
      fiftyTwoWeekHigh: 200, fiftyTwoWeekLow: 100, regularMarketDayHigh: 152, regularMarketDayLow: 148,
      regularMarketVolume: 1000000, marketState: 'REGULAR', shortName: 'Apple', longName: 'Apple Inc',
      regularMarketTime: 1700000000
    },
    ...oneBar(1700000000)
  };
  let q = parseYahooQuote(usRes, 'US');
  ok('parseYahooQuote US price/prevClose (1 bar → meta fallback)', q.price === 150 && q.prevClose === 145);
  ok('parseYahooQuote change/changePct', near(q.change, 5) && near(q.changePct, 5 / 145 * 100));
  ok('parseYahooQuote passes through 52w / day hi-lo / volume', q.yearHigh === 200 && q.yearLow === 100 && q.dayHigh === 152 && q.dayLow === 148 && q.volume === 1000000);
  ok('parseYahooQuote names + marketState + source', q.shortName === 'Apple' && q.longName === 'Apple Inc' && q.marketState === 'REGULAR' && q.source === 'yahoo');
  ok('parseYahooQuote regularMarketTime sec→ms', q.regularMarketTime === 1700000000 * 1000);
  ok('parseYahooQuote ext fields null (derived separately)', q.extPrice === null && q.extKind === null);

  // LSE pence: divisor 100 scales price/prevClose/hi-lo; currency normalized to GBP.
  const lseRes = { meta: { regularMarketPrice: 5000, regularMarketPreviousClose: 4900, currency: 'GBX', fiftyTwoWeekHigh: 6000 }, ...oneBar(1700000000) };
  q = parseYahooQuote(lseRes, 'LSE');
  ok('parseYahooQuote LSE pence → pounds', near(q.price, 50) && near(q.prevClose, 49) && near(q.yearHigh, 60));
  ok('parseYahooQuote LSE currency normalized to GBP', q.currency === 'GBP');

  // Currency normalization: a US holding Yahoo resolved to GBP is forced back to USD.
  q = parseYahooQuote({ meta: { regularMarketPrice: 10, currency: 'GBP' }, ...oneBar(1700000000) }, 'US');
  ok('parseYahooQuote US currency forced to USD (the £-render fix)', q.currency === 'USD');

  // prevClose derived from earlier-day bars OVERRIDES a stale meta previous close.
  const stale = {
    meta: { regularMarketPrice: 150, regularMarketPreviousClose: 999, currency: 'USD' },
    timestamp: [sec('2026-06-16T18:00:00Z'), sec('2026-06-17T18:00:00Z')],
    indicators: { quote: [{ close: [145, 150] }] }
  };
  q = parseYahooQuote(stale, 'US');
  ok('parseYahooQuote bars override stale meta prevClose', q.prevClose === 145 && near(q.change, 5));

  ok('parseYahooQuote null result → null', parseYahooQuote(null, 'US') === null);
  ok('parseYahooQuote missing regularMarketPrice → null', parseYahooQuote({ meta: { currency: 'USD' } }, 'US') === null);
}

// ── Anti-drift guard: app.js delegates to PBCore, no local parser definitions ──
const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
for (const fn of ['buildDailyBars', 'derivePrevClose', 'deriveIntradayExt', 'parseYahooQuote']) {
  ok(`app.js binds ${fn} from PBCore`, new RegExp(`const\\s+${fn}\\s*=\\s*PBCore\\.${fn}`).test(appSrc));
  ok(`app.js has no local function ${fn}`, !new RegExp(`function\\s+${fn}\\s*\\(`).test(appSrc));
}
ok('app.js has no local function marketDayKey', !/function\s+marketDayKey\s*\(/.test(appSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll quote-parsers tests passed');
process.exit(failures ? 1 : 0);
