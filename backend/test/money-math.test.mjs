// Characterization tests for the core money math, now in the shared core
// (pb-core.js): convertCcy, contribInDisplay, marketCurrency, positionCostCcy,
// valuePositionInCostCcy, resolvePositionUpdates + the MARKET_CURRENCY table.
//   cd backend/test && node money-math.test.mjs
//
// These used to be sliced out of app.js (which had no exports). Phase 1 moved the
// whole self-contained money block + MARKET_CURRENCY into pb-core.js, so the tests
// now import the real shared module directly — same guarantee (real shipped code,
// can't drift from what the app uses), simpler harness. The 41 assertions are
// unchanged from when they characterized the app.js originals, so they prove the
// move is bit-for-bit behavior-preserving. A source guard at the end confirms
// app.js delegates and carries no local copies.
//
// Conventions pinned here (so a future refactor can't silently change them):
//   • fxRates.rates are "source units per USD", with USD === 1
//     (e.g. rates.ZAR = 18.5 means $1 = R18.50). convertCcy goes amount/from*to.
//   • A contribution's locked rate (fxRateAtContrib) = source units ÷ USD landed,
//     so "money put in" is measured at the dollars that actually entered, then
//     revalued into the display currency at today's rate.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';

const { convertCcy, contribInDisplay, marketCurrency, positionCostCcy, valuePositionInCostCcy, resolvePositionUpdates, MARKET_CURRENCY } = PBCore;

// $1 = R18.50, £0.79, €0.92, A$1.52
const RATES = { USD: 1, ZAR: 18.5, GBP: 0.79, EUR: 0.92, AUD: 1.52 };

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;

ok('PBCore exports convertCcy', typeof convertCcy === 'function');
ok('PBCore exports contribInDisplay', typeof contribInDisplay === 'function');
ok('PBCore exports marketCurrency', typeof marketCurrency === 'function');
ok('PBCore exports positionCostCcy', typeof positionCostCcy === 'function');
ok('PBCore exports valuePositionInCostCcy', typeof valuePositionInCostCcy === 'function');
ok('PBCore exports resolvePositionUpdates', typeof resolvePositionUpdates === 'function');
ok('PBCore exports MARKET_CURRENCY table', MARKET_CURRENCY && MARKET_CURRENCY.US && MARKET_CURRENCY.US.code === 'USD');

if (typeof convertCcy === 'function' && typeof marketCurrency === 'function') {
  // ── MARKET_CURRENCY table: native code + symbol per market ──────────────────
  ok('MARKET_CURRENCY JSE → ZAR/R', MARKET_CURRENCY.JSE.code === 'ZAR' && MARKET_CURRENCY.JSE.sym === 'R');
  ok('MARKET_CURRENCY LSE → GBP', MARKET_CURRENCY.LSE.code === 'GBP');
  ok('MARKET_CURRENCY CRYPTO → USD', MARKET_CURRENCY.CRYPTO.code === 'USD');

  // ── convertCcy: direction, identity, and the guard quirks ────────────────────
  ok('convertCcy same currency → unchanged', convertCcy(100, 'USD', 'USD', RATES) === 100);
  ok('convertCcy USD→ZAR multiplies by rate', near(convertCcy(100, 'USD', 'ZAR', RATES), 1850));
  ok('convertCcy ZAR→USD divides by rate', near(convertCcy(1850, 'ZAR', 'USD', RATES), 100));
  ok('convertCcy ZAR→GBP cross', near(convertCcy(185, 'ZAR', 'GBP', RATES), 7.9));
  ok('convertCcy null amount → null', convertCcy(null, 'USD', 'ZAR', RATES) === null);
  ok('convertCcy NaN amount → null', convertCcy(NaN, 'USD', 'ZAR', RATES) === null);
  ok('convertCcy no rates object → null', convertCcy(100, 'USD', 'ZAR', null) === null);
  ok('convertCcy unknown target → null', convertCcy(100, 'USD', 'XXX', RATES) === null);
  // Quirk pinned on purpose: a falsy `from` short-circuits and returns the amount
  // untouched (no conversion), rather than null.
  ok('convertCcy falsy from → amount unchanged (quirk)', convertCcy(100, '', 'ZAR', RATES) === 100);

  // ── marketCurrency: native currency per market, unknown → USD ────────────────
  ok('marketCurrency US → USD', marketCurrency('US') === 'USD');
  ok('marketCurrency JSE → ZAR', marketCurrency('JSE') === 'ZAR');
  ok('marketCurrency TFSA → ZAR', marketCurrency('TFSA') === 'ZAR');
  ok('marketCurrency LSE → GBP', marketCurrency('LSE') === 'GBP');
  ok('marketCurrency CRYPTO → USD', marketCurrency('CRYPTO') === 'USD');
  ok('marketCurrency unknown → USD fallback', marketCurrency('ZZZ') === 'USD');

  // ── positionCostCcy: explicit costCurrency wins, else market native ──────────
  ok('positionCostCcy JSE position → ZAR', positionCostCcy({ market: 'JSE' }) === 'ZAR');
  ok('positionCostCcy US position → USD', positionCostCcy({ market: 'US' }) === 'USD');
  ok('positionCostCcy explicit costCurrency wins', positionCostCcy({ market: 'US', costCurrency: 'ZAR' }) === 'ZAR');
  ok('positionCostCcy null → USD', positionCostCcy(null) === 'USD');

  // ── valuePositionInCostCcy: same-currency no-op vs cross-currency convert ────
  const jse = valuePositionInCostCcy({ market: 'JSE', shares: 10, costBasis: 100 }, { price: 120 }, RATES);
  ok('value JSE same-ccy: cost = shares*costBasis', near(jse.cost, 1000));
  ok('value JSE same-ccy: value = shares*price', near(jse.value, 1200));
  ok('value JSE same-ccy: gain', near(jse.gain, 200));
  ok('value JSE same-ccy: gainPct', near(jse.gainPct, 20));
  ok('value JSE same-ccy: ccy=ZAR native=ZAR', jse.ccy === 'ZAR' && jse.native === 'ZAR');

  // Crypto bought in ZAR but priced in USD: live value converts USD→ZAR cost ccy.
  const cryp = valuePositionInCostCcy({ market: 'US', costCurrency: 'ZAR', shares: 2, costBasis: 500000 }, { price: 100000 }, RATES);
  ok('value crypto cross-ccy: native USD, ccy ZAR', cryp.native === 'USD' && cryp.ccy === 'ZAR');
  ok('value crypto cross-ccy: value converted to ZAR', near(cryp.value, 2 * 100000 * 18.5)); // 3,700,000
  ok('value crypto cross-ccy: cost stays in ZAR', near(cryp.cost, 1000000));
  ok('value crypto cross-ccy: gain', near(cryp.gain, 2700000));

  const noQuote = valuePositionInCostCcy({ market: 'US', shares: 5, costBasis: 10 }, null, RATES);
  ok('value with no quote: value/gain/gainPct null', noQuote.value === null && noQuote.gain === null && noQuote.gainPct === null);
  const zeroCost = valuePositionInCostCcy({ market: 'US', shares: 5, costBasis: 0 }, { price: 10 }, RATES);
  ok('value with zero cost: gainPct null (no divide-by-zero)', zeroCost.gainPct === null);

  // ── contribInDisplay: locked-rate "money put in" vs fallback ─────────────────
  ok('contrib same currency → face amount', contribInDisplay({ amount: 1000, currency: 'USD' }, 'USD', RATES) === 1000);
  ok('contrib null → 0', contribInDisplay(null, 'USD', RATES) === 0);
  ok('contrib non-finite amount → 0', contribInDisplay({ amount: NaN, currency: 'USD' }, 'USD', RATES) === 0);
  // R18,000 deposited, $1,000 actually landed → locked rate 18.
  const locked = { amount: 18000, currency: 'ZAR', fxRateAtContrib: 18 };
  ok('contrib locked-rate → USD landed ($1,000 committed)', near(contribInDisplay(locked, 'USD', RATES), 1000));
  // Pinned subtlety: when the display currency equals the deposit currency, the
  // function short-circuits to the FACE amount (R18,000) — it does NOT revalue.
  ok('contrib display==deposit ccy → face amount (no revalue)', contribInDisplay(locked, 'ZAR', RATES) === 18000);
  // The revalue-committed-USD path only fires for a different display currency:
  // $1,000 committed × today's £0.79 = £790.
  ok('contrib locked-rate → other ccy revalues committed USD', near(contribInDisplay(locked, 'GBP', RATES), 790));
  // No locked rate → today's market conversion.
  ok('contrib no locked rate → today conversion', near(contribInDisplay({ amount: 1000, currency: 'EUR' }, 'USD', RATES), 1000 / 0.92));

  // ── resolvePositionUpdates: only re-rate on market/date/ccy change ───────────
  const ctxToday = { today: '2026-06-25', fxRates: { rates: RATES }, historicalFx: null };
  const plainEdit = resolvePositionUpdates({ market: 'US', purchaseDate: '2026-06-25' }, { shares: 5 }, ctxToday);
  ok('resolve plain shares edit leaves fxRateAtCost untouched', plainEdit.fxRateAtCost === undefined && plainEdit.shares === 5);

  const marketMove = resolvePositionUpdates({ market: 'US', purchaseDate: '2026-06-25' }, { market: 'JSE' }, ctxToday);
  ok('resolve market change re-rates from today fx (ZAR=18.5)', marketMove.fxRateAtCost === 18.5);

  const ctxHist = { today: '2026-06-25', fxRates: { rates: RATES }, historicalFx: 0.95 };
  const dateMove = resolvePositionUpdates({ market: 'US', purchaseDate: '2026-06-25' }, { purchaseDate: '2024-01-01' }, ctxHist);
  ok('resolve past-date change uses historicalFx', dateMove.fxRateAtCost === 0.95);

  const noExisting = resolvePositionUpdates(null, { shares: 3 }, ctxToday);
  ok('resolve with no existing returns updates as-is', noExisting.shares === 3 && noExisting.fxRateAtCost === undefined);
}

// ── Anti-drift guard: app.js delegates to PBCore, carries no local copies ─────
const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
ok('app.js binds MARKET_CURRENCY from PBCore', /const\s+MARKET_CURRENCY\s*=\s*PBCore\.MARKET_CURRENCY/.test(appSrc));
ok('app.js has no local MARKET_CURRENCY object literal', !/const\s+MARKET_CURRENCY\s*=\s*\{/.test(appSrc));
for (const fn of ['convertCcy', 'contribInDisplay', 'marketCurrency', 'positionCostCcy', 'valuePositionInCostCcy', 'resolvePositionUpdates']) {
  ok(`app.js binds ${fn} from PBCore`, new RegExp(`const\\s+${fn}\\s*=\\s*PBCore\\.${fn}`).test(appSrc));
  ok(`app.js has no local function ${fn}`, !new RegExp(`function\\s+${fn}\\s*\\(`).test(appSrc));
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll money-math tests passed');
process.exit(failures ? 1 : 0);
