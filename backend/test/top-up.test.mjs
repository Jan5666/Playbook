// PBCore.mergeTopUp — adding a lot to a holding you already own (Add holding,
// and a bulk import that matches an existing position). Rule #3: the same-
// currency cases are CHARACTERIZATION of the pre-2026-10-31 inline code in
// app.js addPosition/importPositions and must never move; the cross-currency
// cases pin the fix.   node backend/test/top-up.test.mjs
import PBCore from '../../pb-core.js';
import { readFileSync } from 'fs';

const { mergeTopUp, mergeCostBasis } = PBCore;
let failures = 0;
const ok = (n, c, got) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${n}${c ? '' : '  — got ' + JSON.stringify(got)}`); if (!c) failures++; };
const near = (a, b) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b));
const rates = { USD: 1, ZAR: 18, GBP: 0.8 };

// ── Characterization: same currency = old inline behaviour ──
const us = { ticker: 'AAPL', market: 'US', shares: 10, costBasis: 100, fxRateAtCost: 1 };
let r = mergeTopUp(us, 10, 200, 'USD', 1, rates);
ok('same ccy: averages like mergeCostBasis', r.shares === 20 && r.costBasis === 150 && r.fxRateAtCost === 1, r);
const jse = { ticker: 'NPN', market: 'JSE', shares: 2, costBasis: 3000, fxRateAtCost: 18.5 };
r = mergeTopUp(jse, 2, 3400, 'ZAR', 17.9, rates);
ok('same ccy: the newest lot\'s rate replaces the stored one (unchanged semantics)', r.costBasis === 3200 && r.fxRateAtCost === 17.9, r);
r = mergeTopUp(jse, 2, 3400, 'ZAR', null, rates);
ok('same ccy: no new rate keeps the stored one', r.fxRateAtCost === 18.5, r);
const m = mergeCostBasis(jse.shares, jse.costBasis, 2, 3400);
ok('same ccy: identical to mergeCostBasis', r.shares === m.shares && r.costBasis === m.costBasis, r);

// ── Fixed: lot in a different currency from the holding's cost ──
const btcZar = { ticker: 'BTC', market: 'CRYPTO', shares: 1, costBasis: 1800000, costCurrency: 'ZAR', fxRateAtCost: 18 };
r = mergeTopUp(btcZar, 0.1, 100000, 'USD', 1, rates);   // USD lot: 100k USD = 1.8m ZAR
ok('cross ccy: lot converted into the holding\'s cost currency', near(r.costBasis, 1800000) && near(r.shares, 1.1), r);
ok('cross ccy: holding keeps its own ZAR rate (was overwritten with USD\'s 1.0)', r.fxRateAtCost === 18, r);
const btcUsd = { ticker: 'BTC', market: 'CRYPTO', shares: 1, costBasis: 100000, fxRateAtCost: 1 };
r = mergeTopUp(btcUsd, 1, 1800000, 'ZAR', 18, rates);
ok('cross ccy (reverse): ZAR lot into a USD holding', near(r.costBasis, 100000) && r.fxRateAtCost === 1, r);
r = mergeTopUp(btcZar, 0.1, 100000, 'USD', 1, null);
ok('cross ccy, no rates: falls back to the raw figure (old behaviour) but keeps the rate', near(r.costBasis, (1800000 + 10000) / 1.1) && r.fxRateAtCost === 18, r);

// ── Anti-drift: both app.js merge sites delegate ──
const app = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
ok('app.js calls PBCore.mergeTopUp from addPosition and importPositions', (app.match(/PBCore\.mergeTopUp\(/g) || []).length === 2);
ok('app.js no longer writes `fxRateAtCost: rateAtCost || p.fxRateAtCost` inline', !/fxRateAtCost:\s*r?\.?rateAtCost\s*\|\|/.test(app));

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nALL PASSED');
