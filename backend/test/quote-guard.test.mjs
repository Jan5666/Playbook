// Tests for the live-quote plausibility guard (pb-core.js): the merge-path
// gate that stops a transiently mis-scaled Yahoo quote (a pence/cents symbol
// whose meta.currency momentarily falls outside centDivisor's vocabulary →
// price ~100x off) from rendering a bogus holding value/growth %, while never
// permanently blocking a real split/repricing.
//   cd backend/test && node quote-guard.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';

const { valuePositionInCostCcy, guardQuote, plausiblePriceMove } = PBCore;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;

// ── Characterization: the value math itself has NO clamp ────────────────────
// Pins the user-confirmed semantics of valuePositionInCostCcy: it trusts
// whatever quote it is given. A 100x mis-scaled price yields a ~9,900% gain —
// by design the plausibility gate lives UPSTREAM in the merge path
// (guardQuote), not inside the money math. These must keep passing unchanged.
const pos = { market: 'US', ticker: 'ZZZ', shares: 10, costBasis: 100 };
const normal = valuePositionInCostCcy(pos, { price: 120 }, {});
ok('characterize: normal quote → gainPct 20', normal != null && near(normal.gainPct, 20));
const scaled = valuePositionInCostCcy(pos, { price: 12000 }, {});
ok('characterize: 100x mis-scaled quote flows straight through (gainPct 11900)',
  scaled != null && near(scaled.gainPct, 11900));

// ── plausiblePriceMove ──────────────────────────────────────────────────────
ok('exports guardQuote + plausiblePriceMove', typeof guardQuote === 'function' && typeof plausiblePriceMove === 'function');
ok('plausible: ordinary move', plausiblePriceMove(100, 108));
ok('plausible: large-but-real crash (-80%)', plausiblePriceMove(100, 20));
ok('implausible: 100x pence/pounds mixup', !plausiblePriceMove(100, 10000) && !plausiblePriceMove(10000, 100));
ok('implausible: exactly at the 20x bound', !plausiblePriceMove(100, 2000));
ok('degenerate inputs are not blocked', plausiblePriceMove(0, 100) && plausiblePriceMove(100, 0) && plausiblePriceMove(null, 100) && plausiblePriceMove(NaN, 5));

// ── guardQuote ──────────────────────────────────────────────────────────────
const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;
const q = (price, extra) => Object.assign({ price, prevClose: price, fetchedAt: T0 }, extra);

// Pass-throughs.
ok('no prev → accept', guardQuote(null, q(120), T0).rejected === false);
ok('prev without a usable price → accept', guardQuote({ price: 0, fetchedAt: T0 }, q(120), T0).rejected === false);
ok('unusable next passes through untouched (parse layer owns it)', guardQuote(q(100), { price: NaN }, T0).rejected === false);
ok('normal move → accept, next wins', (() => { const g = guardQuote(q(100), q(108, { fetchedAt: T0 + MIN }), T0 + MIN); return !g.rejected && g.quote.price === 108; })());
ok('prev older than 3 days → accept any move (long-gap repricing)',
  guardQuote(q(100, { fetchedAt: T0 - 4 * 24 * 3600 * 1000 }), q(10000), T0).rejected === false);
ok('prev without fetchedAt → accept (age unknowable)', guardQuote({ price: 100 }, q(10000), T0).rejected === false);

// The glitch: a 100x mis-scaled quote is held back, last good quote keeps rendering.
const bad = q(10000, { fetchedAt: T0 + MIN });
const g1 = guardQuote(q(100), bad, T0 + MIN);
ok('100x jump → rejected', g1.rejected === true);
ok('rejected: last good price keeps rendering', g1.quote.price === 100);
ok('rejected: contested level recorded as suspect', g1.quote.suspect && g1.quote.suspect.price === 10000 && g1.quote.suspect.at === T0 + MIN);
ok('rejected: prev fields preserved (copy, not mutation)', g1.quote.prevClose === 100 && g1.quote !== bad);

// Recovery: the next normal poll replaces the quote, suspect gone.
const g2 = guardQuote(g1.quote, q(101, { fetchedAt: T0 + 2 * MIN }), T0 + 2 * MIN);
ok('glitch clears next poll → normal quote accepted', !g2.rejected && g2.quote.price === 101);
ok('accepted quote carries no suspect', !('suspect' in g2.quote));

// Persistence: the same new level must hold ≥5 min before it is believed.
const g3 = guardQuote(g1.quote, q(10050, { fetchedAt: T0 + 2 * MIN }), T0 + 2 * MIN);
ok('same level again within 5 min → still rejected', g3.rejected === true);
ok('confirmation clock runs from first sighting', g3.quote.suspect.at === T0 + MIN);
const g4 = guardQuote(g3.quote, q(10020, { fetchedAt: T0 + 7 * MIN }), T0 + 7 * MIN);
ok('same level after 5 min → accepted (real split/repricing)', !g4.rejected && g4.quote.price === 10020);
const g5 = guardQuote(g1.quote, q(500000, { fetchedAt: T0 + 2 * MIN }), T0 + 2 * MIN);
ok('a different bogus level restarts the suspect clock', g5.rejected === true && g5.quote.suspect.price === 500000 && g5.quote.suspect.at === T0 + 2 * MIN);

// ── Source guards: wiring (anti-drift) ──────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
const dataSrc = readFileSync(join(here, '..', '..', 'pb-data.js'), 'utf8');
ok('app.js gates store merges through PBCore.guardQuote', appSrc.includes('PBCore.guardQuote('));
ok('both merge call sites ride the gate (no raw PBStore.mergePrices(obj/partial))',
  !/PBStore\.mergePrices\((obj|partial)\)/.test(appSrc));
ok('pb-data intraday splice is gated by plausiblePriceMove', /plausiblePriceMove\(quote\.price, fresh\.price\)/.test(dataSrc));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
