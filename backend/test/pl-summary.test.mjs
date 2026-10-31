// Holdings-tab market summary (pb-views.js computeMarketSummary), evaluated from
// the REAL view source in a vm.   node backend/test/pl-summary.test.mjs
// 2026-10-31: cost was summed for EVERY holding but value only for priced ones,
// so one unpriced holding (no quote yet, force-added symbol) read as a loss of
// its whole cost. Cost is now paired with value per holding. The all-priced
// cases are characterization and must not move.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import PBCore from '../../pb-core.js';

const src = readFileSync(new URL('../../pb-views.js', import.meta.url), 'latin1');
function sliceArrow(name) {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', src.indexOf('=>', start)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1) + ';';
}
let failures = 0;
const ok = (n, c, got) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${n}${c ? '' : '  — got ' + JSON.stringify(got)}`); if (!c) failures++; };

function summary(rows, market, prices, rates) {
  const ctx = { prices, rates, out: null, isFinite, Date,
    convertCcy: PBCore.convertCcy, positionCostCcy: PBCore.positionCostCcy, marketCurrency: PBCore.marketCurrency,
    priceKey: PBCore.priceKey, quoteTradedToday: () => false, marketDayKey: PBCore.marketDayKey || (() => ''),
    isUnitTrustId: () => false };
  vm.createContext(ctx);
  vm.runInContext(sliceArrow('computeMarketSummary') + '\nout = computeMarketSummary;', ctx);
  return ctx.out(rows, market);
}
const r2 = x => x == null ? x : Math.round(x * 100) / 100;
const A = { ticker: 'AAA', market: 'JSE', shares: 10, costBasis: 1000 };
const B = { ticker: 'BBB', market: 'JSE', shares: 10, costBasis: 1000 };

let s = summary([A, B], 'JSE', { 'JSE:AAA': { price: 1100 }, 'JSE:BBB': { price: 900 } }, { USD: 1, ZAR: 18 });
ok('all priced: value/cost/gain unchanged', s.value === 20000 && s.cost === 20000 && s.gain === 0 && s.gainPct === 0, s);
s = summary([A], 'JSE', { 'JSE:AAA': { price: 1100 } }, { USD: 1, ZAR: 18 });
ok('all priced: +10%', s.gain === 1000 && r2(s.gainPct) === 10, s);
s = summary([A, B], 'JSE', { 'JSE:AAA': { price: 1100 } }, { USD: 1, ZAR: 18 });
ok('one unpriced: P/L covers the priced holding only (was -9000 / -45%)', s.value === 11000 && s.cost === 10000 && s.gain === 1000 && r2(s.gainPct) === 10, s);
s = summary([A], 'JSE', {}, {});
ok('nothing priced: no gain figure', s.anyPrice === false && s.gain === null && s.gainPct === null, s);
// Crypto bought in ZAR: cost converted into the market's USD before pairing.
const C = { ticker: 'BTC', market: 'CRYPTO', shares: 1, costBasis: 1800000, costCurrency: 'ZAR' };
s = summary([C], 'CRYPTO', { 'CRYPTO:BTC': { price: 110000 } }, { USD: 1, ZAR: 18 });
ok('cross-currency cost still converted', s.cost === 100000 && s.gain === 10000, s);

// Source guards: the Dashboard aggregates pair cost with value too.
ok('Dashboard marketGroups adds cost only alongside value', /if \(c != null && v != null\) \{ cost \+= c; value \+= v; \}/.test(src));
ok('Dashboard computeStats adds cost inside the priced branch', /if \(q && sameCcy && isFinite\(q\.price\)\) \{\s*cost \+=/.test(src));

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nALL PASSED');
