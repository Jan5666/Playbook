// The Settings -> Diagnostics -> Price feed readout: which holdings are NOT
// contributing a "Today" figure, and why.
//   cd backend/test && node price-feed-rows.test.mjs
//
// Jan's SA tab said "17 of 18" with one row's Today cell blank, and there was no
// way — in the app or in the console — to learn which holding or why. Every cause
// renders the same: mergePrices is a shallow merge, so a symbol the sweep missed
// keeps showing its last stored quote at a believable price, and the row withholds
// the stale percentage. A dead Yahoo symbol, a Stooq end-of-day fallback and a
// quote the plausibility gate is freezing are three different bugs wearing one
// face. These rows are what tell them apart, so they are worth pinning.
//
// pb-modals.js is a browser-only classic script, so priceFeedRows is sliced out
// and run in a vm — the same technique day-display.test.mjs uses for HoldingRow.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import PBCore from '../../pb-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const modalSrc = readFileSync(join(here, '..', '..', 'pb-modals.js'), 'utf8');

let failures = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra != null ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// SAST wall clock -> epoch. JSE regular session is 09:00-17:05.
const sast = (d, hh, mm = 0) => Date.UTC(2026, 7, d, hh - 2, mm);
const WED = '2026-08-05', TUE = '2026-08-04';
const NOW = sast(5, 11);                       // Wednesday, JSE mid-session

const a = modalSrc.indexOf('function priceFeedRows(positions, prices, feedHealth, nowMs) {');
const b = modalSrc.indexOf('\n}\n', a);
const SRC = a < 0 ? null : modalSrc.slice(a, b + 3);
ok('pb-modals still declares priceFeedRows', !!SRC);

// Real kernels — the point is to exercise the shipped gates, not a copy of them.
const ctx = {
  priceKey: PBCore.priceKey,
  quoteTradedToday: PBCore.quoteTradedToday,
  regularSessionStartedToday: PBCore.regularSessionStartedToday,
  quoteSessionState: PBCore.quoteSessionState,
  marketDayKey: PBCore.marketDayKey,
  yahooSymbol: PBCore.yahooSymbol,
  fmtAgo: PBCore.fmtAgo,
  console
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC + '\nglobalThis.__PFR = priceFeedRows;', ctx);
const rows = ctx.__PFR;

const pos = (ticker, market = 'JSE') => ({ id: 'p-' + ticker, ticker, market, shares: 1, costBasis: 90 });
const healthy = { price: 101.24, prevClose: 100, sessionDay: WED, regularMarketTime: sast(5, 10, 55), fetchedAt: sast(5, 10, 58), source: 'yahoo' };
const byKey = (out) => Object.fromEntries(out.map(r => [r.label, r.value]));

// ── A healthy book reports nothing ──────────────────────────────────────────
let out = rows([pos('NPN'), pos('DTC')], {
  'JSE:NPN': healthy, 'JSE:DTC': healthy
}, {}, NOW);
ok('a fully-anchored market produces no rows', out.length === 0, JSON.stringify(out));

// ── The Stooq end-of-day shape: THE leading hypothesis for Jan's row ─────────
// Yahoo .JO fails for one ticker, Stooq answers with the previous session's row
// (parseStooqCsv reads its date from column 0 and carries no regularMarketTime).
// The value stays believable, so the holding is still "priced" and still counts in
// the denominator — it just can never reach the numerator. Permanently, silently,
// for one symbol only.
out = rows([pos('NPN'), pos('XYZ')], {
  'JSE:NPN': healthy,
  'JSE:XYZ': { price: 250, prevClose: 248, sessionDay: TUE, fetchedAt: sast(5, 10, 58), source: 'stooq' }
}, {}, NOW);
ok('a session-behind holding is reported', out.length === 1 && out[0].label === 'JSE:XYZ', JSON.stringify(out));
let v = byKey(out)['JSE:XYZ'];
ok('...names the source that anchored it', /src stooq/.test(v), v);
ok('...shows the quote session against the market day', /day 2026-08-04 vs 2026-08-05/.test(v), v);
ok('...classifies it stale', /\bstale\b/.test(v), v);
ok('...and the quote is FRESH, so age alone would have been misleading',
  /age 2m ago/.test(v), v);

// ── A missed sweep: the fetch itself is failing ─────────────────────────────
out = rows([pos('NPN')], { 'JSE:NPN': { ...healthy, sessionDay: TUE, regularMarketTime: sast(4, 17) } },
  { missing: [{ market: 'JSE', ticker: 'NPN' }] }, NOW);
ok('a missed symbol is flagged MISSED SWEEP', /MISSED SWEEP/.test(byKey(out)['JSE:NPN']), byKey(out)['JSE:NPN']);

// A symbol the sweep missed is reported even when its stored quote still looks
// current — that is the case where the number on screen is fine TODAY and will
// silently rot tomorrow.
out = rows([pos('NPN')], { 'JSE:NPN': healthy }, { missing: [{ market: 'JSE', ticker: 'NPN' }] }, NOW);
ok('a missed symbol is reported even while its stored quote is still current',
  out.length === 1 && /MISSED SWEEP/.test(out[0].value), JSON.stringify(out));

// ── The plausibility gate freezing a symbol ─────────────────────────────────
// The JSE-shaped hazard: a ZAc/ZAR divisor flip is a 100x jump, so guardQuote
// rejects it and re-merges the previous quote. Right price, old session, forever.
out = rows([pos('NPN')], { 'JSE:NPN': { ...healthy, sessionDay: TUE, regularMarketTime: sast(4, 17) } },
  { held: { 'JSE:NPN': { price: 25000, at: sast(5, 10) } } }, NOW);
ok('a guard-held symbol is flagged with the contested level',
  /HELD at 25000/.test(byKey(out)['JSE:NPN']), byKey(out)['JSE:NPN']);

// ── A doubled suffix is visible in the resolved symbol ──────────────────────
// yahooSymbol is idempotent now, so this proves the readout shows what the url
// actually carries — the reason it is printed encoded rather than prettified.
out = rows([pos('SOL.JO')], {}, { missing: [{ market: 'JSE', ticker: 'SOL.JO' }] }, NOW);
ok('the resolved Yahoo symbol is shown', /as SOL\.JO(?!\.JO)/.test(out[0].value), out[0].value);
out = rows([pos('A B')], {}, { missing: [{ market: 'JSE', ticker: 'A B' }] }, NOW);
ok('...encoded, so a malformed ticker is visible', /as A%20B\.JO/.test(out[0].value), out[0].value);

// ── No quote at all ─────────────────────────────────────────────────────────
out = rows([pos('NEW')], {}, {}, NOW);
ok('a holding with no quote is reported as none/never',
  /src none/.test(out[0].value) && /age never/.test(out[0].value) && /\bnone\b/.test(out[0].value),
  out[0].value);

// ── Non-holdings the sweep missed still belong here ─────────────────────────
// Same feed: a proxy rate-limiting the watchlist is rate-limiting the holdings.
out = rows([pos('NPN')], { 'JSE:NPN': healthy }, { missing: [{ market: 'US', ticker: 'AAPL' }] }, NOW);
ok('a missed non-holding is reported too', out.length === 1 && out[0].label === 'US:AAPL', JSON.stringify(out));

// ── Two lots of one holding produce one row ─────────────────────────────────
out = rows([pos('XYZ'), pos('XYZ')], {
  'JSE:XYZ': { price: 250, prevClose: 248, sessionDay: TUE, fetchedAt: NOW, source: 'stooq' }
}, {}, NOW);
ok('duplicate positions in one ticker collapse to a single row', out.length === 1, JSON.stringify(out));

// ── Degenerate inputs never throw ───────────────────────────────────────────
ok('null inputs are safe', rows(null, null, null, NOW).length === 0);

// ── Pre-open the readout must be QUIET ──────────────────────────────────────
// Before the bell quoteTradedToday refuses every quote in the market — correctly,
// and identically for all of them, so a row per holding carries no information.
// Listing the whole book every morning is how a diagnostic stops being read;
// computeMarketSummary suppresses its Today block at the same hour for the same
// reason. (The "17 of 18" note Jan is chasing only appears once the market is
// running, which is exactly when these rows become meaningful.)
const PRE = sast(5, 7, 53);
out = rows([pos('NPN'), pos('DTC')], { 'JSE:NPN': healthy, 'JSE:DTC': healthy }, {}, PRE);
ok('pre-open: a priced book reports nothing', out.length === 0, JSON.stringify(out));
// …but a real fault is still a fault at any hour.
out = rows([pos('NPN')], {}, {}, PRE);
ok('pre-open: a holding with no quote at all is still reported', out.length === 1, JSON.stringify(out));
out = rows([pos('NPN')], { 'JSE:NPN': healthy }, { missing: [{ market: 'JSE', ticker: 'NPN' }] }, PRE);
ok('pre-open: a missed sweep is still reported',
  out.length === 1 && /MISSED SWEEP/.test(out[0].value), JSON.stringify(out));
out = rows([pos('NPN')], { 'JSE:NPN': healthy }, { held: { 'JSE:NPN': { price: 25000, at: PRE } } }, PRE);
ok('pre-open: a guard-held symbol is still reported',
  out.length === 1 && /HELD/.test(out[0].value), JSON.stringify(out));
// Non-vacuous: the same book DOES report once the market opens and one row is behind.
out = rows([pos('NPN'), pos('XYZ')], {
  'JSE:NPN': healthy,
  'JSE:XYZ': { price: 250, prevClose: 248, sessionDay: TUE, fetchedAt: NOW, source: 'stooq' }
}, {}, PRE);
ok('pre-open: even a session-behind row is held back (no signal yet)', out.length === 0, JSON.stringify(out));
out = rows([pos('NPN'), pos('XYZ')], {
  'JSE:NPN': healthy,
  'JSE:XYZ': { price: 250, prevClose: 248, sessionDay: TUE, fetchedAt: NOW, source: 'stooq' }
}, {}, NOW);
ok('...and reported the moment the market opens', out.length === 1 && out[0].label === 'JSE:XYZ');

console.log(failures ? `\n${failures} test(s) failed` : '\nAll price-feed-rows tests passed');
process.exit(failures ? 1 : 0);
