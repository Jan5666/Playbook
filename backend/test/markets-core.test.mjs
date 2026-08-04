// Tests for the market-symbol helpers that now live in the shared core
// (pb-core.js): centDivisor + yahooSymbol.
//   cd backend/test && node markets-core.test.mjs
//
// These two used to be copy-pasted into BOTH app.js and backend/worker.js and had
// DRIFTED — app.js's centDivisor had rich pence/cents detection the worker's crude
// copy lacked, and app.js's yahooSymbol mapped index tickers (^SPX/^VIX) the worker
// didn't. That drift can fetch the wrong instrument / wrong price unit and fire an
// alert the foreground app never would (the A4 class of bug). Phase 1 lifted the
// canonical (app.js) versions into pb-core.js so the client and the always-on push
// Worker share ONE implementation.
//
// Two layers:
//   1. Ground truth — the exact behavior the canonical app.js copy shipped (this
//      matrix was characterized against the real sliced app.js source before the
//      extraction; every row matched). PBCore must reproduce it bit-for-bit.
//   2. Anti-drift source guard — app.js and worker.js must DELEGATE to PBCore and
//      must NOT carry their own `function centDivisor`/`function yahooSymbol`, so
//      the copy-paste drift this fixes can't silently come back.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
const workerSrc = readFileSync(join(here, '..', 'worker.js'), 'utf8');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };

// ── 1. Ground truth: the canonical centDivisor/yahooSymbol behavior ──────────
// The interesting rows are the ones the worker's old crude copy got wrong:
// ('JSE','ZAR')→1 (rand, not cents), market-independent GBX/ZAX/ZAC→100, and the
// ^SPX/^VIX index remaps.
const CENT = [
  [['JSE', 'ZAc'], 100],   // Yahoo's real JSE unit (cents)
  [['JSE', 'ZAC'], 100],
  [['JSE', 'ZAR'], 1],     // rand, NOT cents — worker's old copy wrongly said 100
  [['TFSA', 'ZAc'], 100],
  [['LSE', 'GBX'], 100],
  [['LSE', 'GBp'], 100],   // mixed-case pence
  [['LSE', 'GBP'], 100],   // bare GBP on LSE is pence in practice
  [['US', 'USD'], 1],
  [['US', 'GBp'], 100],    // market-independent: trailing-lowercase GB* → pence
  [['US', 'GBX'], 100],
  [['US', 'ZAX'], 100],
  [['US', 'ZAc'], 100],
  [['CRYPTO', 'USD'], 1],
  [['US', ''], 1],
  [['US', null], 1]
];
const SYM = [
  [['NPN', 'JSE'], 'NPN.JO'],
  [['STX', 'TFSA'], 'STX.JO'],
  [['SHEL', 'LSE'], 'SHEL.L'],
  [['BHP', 'ASX'], 'BHP.AX'],
  [['SAP', 'FRA'], 'SAP.F'],
  [['MC', 'PAR'], 'MC.PA'],
  [['ASML', 'AMS'], 'ASML.AS'],
  [['BTC', 'CRYPTO'], 'BTC-USD'],
  [['ETH-USD', 'CRYPTO'], 'ETH-USD'],   // already a pair → not doubled
  [['^SPX', 'US'], '%5EGSPC'],          // index remaps the worker's copy lacked
  [['^VIX', 'US'], '%5EVIX'],
  [['^GSPC', 'US'], '%5EGSPC'],
  [['AAPL', 'US'], 'AAPL'],
  [['BRK.B', 'US'], 'BRK.B']
];
const show = a => a.map(v => v === null ? 'null' : `'${v}'`).join(',');

ok('PBCore exports centDivisor', typeof PBCore.centDivisor === 'function');
ok('PBCore exports yahooSymbol', typeof PBCore.yahooSymbol === 'function');
for (const [args, exp] of CENT) ok(`centDivisor(${show(args)}) === ${exp}`, PBCore.centDivisor(...args) === exp);
for (const [args, exp] of SYM)  ok(`yahooSymbol(${show(args)}) === '${exp}'`, PBCore.yahooSymbol(...args) === exp);

// ── 2. Anti-drift guard: both call sites delegate to PBCore, no local copies ──
ok('app.js binds centDivisor from PBCore', /const\s+centDivisor\s*=\s*PBCore\.centDivisor/.test(appSrc));
ok('app.js binds yahooSymbol from PBCore', /const\s+yahooSymbol\s*=\s*PBCore\.yahooSymbol/.test(appSrc));
ok('app.js has no local centDivisor definition', !/function\s+centDivisor\s*\(/.test(appSrc));
ok('app.js has no local yahooSymbol definition', !/function\s+yahooSymbol\s*\(/.test(appSrc));
ok('worker.js destructures centDivisor from PBCore', /const\s*\{[^}]*\bcentDivisor\b[^}]*\}\s*=\s*PBCore/.test(workerSrc));
ok('worker.js destructures yahooSymbol from PBCore', /const\s*\{[^}]*\byahooSymbol\b[^}]*\}\s*=\s*PBCore/.test(workerSrc));
ok('worker.js has no local centDivisor definition', !/function\s+centDivisor\s*\(/.test(workerSrc));
ok('worker.js has no local yahooSymbol definition', !/function\s+yahooSymbol\s*\(/.test(workerSrc));

// ── sameUnderlyingExchange: JSE and TFSA are one venue ──────────────────────
// A TFSA is a tax wrapper around JSE-listed instruments, not a separate exchange:
// yahooSymbol above already proves it (NPN.JO either way) and MARKET_CURRENCY
// prices both in ZAR. Anything asking "is this listing on the market the user
// chose?" must use this, not `===` — strict equality is what made a live JSE
// search result look off-market to a TFSA import row and report "no match".
ok('PBCore exports sameUnderlyingExchange', typeof PBCore.sameUnderlyingExchange === 'function');
const SAME = [
  [['JSE', 'TFSA'], true],
  [['TFSA', 'JSE'], true],   // symmetric
  [['TFSA', 'TFSA'], true],
  [['JSE', 'JSE'], true],
  [['US', 'US'], true],
  [['US', 'TFSA'], false],   // ZAR wrapper does not absorb foreign markets
  [['LSE', 'JSE'], false],
  [['TFSA', 'CRYPTO'], false],
  [[null, null], true],
  [[undefined, 'JSE'], false]
];
for (const [args, exp] of SAME) ok(`sameUnderlyingExchange(${show(args)}) === ${exp}`, PBCore.sameUnderlyingExchange(...args) === exp);
// The pair it declares equal must genuinely price identically — otherwise
// re-tagging a JSE candidate to TFSA would silently change the instrument.
ok('the equal pair builds one symbol', PBCore.yahooSymbol('AIETF', 'JSE') === PBCore.yahooSymbol('AIETF', 'TFSA'));
ok('the equal pair shares one currency', PBCore.MARKET_CURRENCY.JSE.code === PBCore.MARKET_CURRENCY.TFSA.code);
ok('the equal pair shares one cent divisor', PBCore.centDivisor('JSE', 'ZAc') === PBCore.centDivisor('TFSA', 'ZAc'));
ok('app.js binds sameUnderlyingExchange from PBCore', /const\s+sameUnderlyingExchange\s*=\s*PBCore\.sameUnderlyingExchange/.test(appSrc));
ok('app.js has no local sameUnderlyingExchange definition', !/function\s+sameUnderlyingExchange\s*\(/.test(appSrc));

// ── priceKey: single-sourced market:ticker key (Phase 2 carve) ───────────────
ok('PBCore exports priceKey', typeof PBCore.priceKey === 'function');
ok("priceKey('US','AAPL')", PBCore.priceKey('US', 'AAPL') === 'US:AAPL');
ok("priceKey('JSE','NPN')", PBCore.priceKey('JSE', 'NPN') === 'JSE:NPN');
ok('app.js binds priceKey from PBCore', /const\s+priceKey\s*=\s*PBCore\.priceKey/.test(appSrc));
ok('app.js has no local function priceKey', !/function\s+priceKey\s*\(/.test(appSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll markets-core tests passed');
process.exit(failures ? 1 : 0);
