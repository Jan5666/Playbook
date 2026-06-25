// Characterization tests for the core money math in app.js.
//   cd backend/test && node money-math.test.mjs
//
// app.js is a browser global script (no exports), so — exactly like the
// import-matching / ee-ocr tests — we slice the real MARKET_CURRENCY table and
// the contiguous money-helper block out of the shipped source and evaluate just
// those in a vm sandbox. Using the actual source (not a copy) means these tests
// can't drift from what the app ships, and they form the safety net for the
// upcoming /core extraction: cost-basis, FX, contribution and re-pricing logic
// must behave bit-for-bit the same after we move it.
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
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');

function slice(label, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) { console.error(`FAIL: could not locate ${label} in app.js`); process.exit(1); }
  return src.slice(start, end);
}

// The real currency table (433-445) and the six money helpers (convertCcy …
// resolvePositionUpdates, ending right before fmtCcy).
// NB: markers avoid '\n' because app.js ships with CRLF line endings.
const mcBlock = slice('MARKET_CURRENCY', 'const MARKET_CURRENCY = {', '};') + '};';
const moneyBlock = slice('money helpers', 'function convertCcy(', 'function fmtCcy(');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  mcBlock + '\n' + moneyBlock +
  '\nglobalThis.__x = { convertCcy, contribInDisplay, marketCurrency, positionCostCcy, valuePositionInCostCcy, resolvePositionUpdates };',
  sandbox
);
const { convertCcy, contribInDisplay, marketCurrency, positionCostCcy, valuePositionInCostCcy, resolvePositionUpdates } = sandbox.__x;

// $1 = R18.50, £0.79, €0.92, A$1.52
const RATES = { USD: 1, ZAR: 18.5, GBP: 0.79, EUR: 0.92, AUD: 1.52 };

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;

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

console.log(failures ? `\n${failures} test(s) failed` : '\nAll money-math tests passed');
process.exit(failures ? 1 : 0);
