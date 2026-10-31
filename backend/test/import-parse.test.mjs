// Parsing half of the holdings import (pb-import.js): delimiter detection, the
// header-row scan, column claiming, date normalisation and the Easy Equities
// screenshot labels.   node backend/test/import-parse.test.mjs
//
// Part A is CHARACTERIZATION: inputs that already parsed correctly before the
// 2026-10-31 bug sweep, pinned so the fixes below cannot move them (rule #3 —
// import is money code). Part B pins each defect the sweep fixed, with the
// wrong figure it used to produce noted beside it.
import PBImport from '../../pb-import.js';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const { parseHoldingsFromText: P, rowsToHoldings: R, parseImportDate: D, parseEasyEquitiesScreenshot: EE } = PBImport;

let failures = 0;
const ok = (name, cond, got) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond ? '' : '  — got ' + JSON.stringify(got)}`);
  if (!cond) failures++;
};
const pick = (hs) => hs.map(h => [h.query, h.shares, h.costBasis, h.purchaseDate]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (name, got, want) => ok(name, same(got, want), got);

// ── A. Characterization ─────────────────────────────────────────────────────
eq('A1 CSV with header', pick(P('Ticker,Shares,Avg Cost\nAAPL,10,150\nMSFT,5,300')),
  [['AAPL', 10, 150, ''], ['MSFT', 5, 300, '']]);
eq('A2 header-less CSV, ticker first', pick(P('AAPL, 10, 150\nMSFT, 5, 300')),
  [['AAPL', 10, 150, ''], ['MSFT', 5, 300, '']]);
eq('A3 header-less CSV, date + name first', pick(P('2024-10-01, Apple, 10, 150.25')),
  [['Apple', 10, 150.25, '2024-10-01']]);
eq('A4 tab-separated with header', pick(P('Symbol\tQuantity\tAverage Price\nNPN.JO\t3\t3450.5')),
  [['NPN.JO', 3, 3450.5, '']]);
eq('A5 markdown table', pick(P('| Company | Shares | Avg Cost |\n|---|---|---|\n| Broadcom | 4 | 120 |')),
  [['Broadcom', 4, 120, '']]);
eq('A6 PDF-style double-space columns, no thousands', pick(P('Name  Shares  Avg Cost\nNaspers Ltd  12  345.00')),
  [['Naspers Ltd', 12, 345, '']]);
eq('A7 quoted CSV thousands', pick(P('Symbol,Quantity,Average Cost\n"AAPL","1,250","3,450.00"')),
  [['AAPL', 1250, 3450, '']]);
eq('A8 Book Cost is a TOTAL column', pick(P('Symbol,Quantity,Book Cost\nAAPL,10,1500')),
  [['AAPL', 10, 150, '']]);
eq('A9 bare company list (one per line)', pick(P('- Broadcom\n- Anglo American')),
  [['Broadcom', null, null, ''], ['Anglo American', null, null, '']]);
eq('A10 single-space tokens', pick(P('AAPL 10 150')), [['AAPL', 10, 150, '']]);
eq('A11 header row is never a holding', pick(P('Name,Quantity\nApple,10')), [['Apple', 10, null, '']]);
eq('A12 ISO date', D('2024-03-15'), '2024-03-15');
eq('A13 DD/MM/YYYY', D('15/03/2024'), '2024-03-15');
eq('A14 ambiguous NN/NN/YYYY is day-first', D('05/03/2024'), '2024-03-05');
eq('A15 MM/DD/YYYY when day > 12', D('03/15/2024'), '2024-03-15');
eq('A16 garbage date', D('soon'), '');

// ── B. Defects fixed 2026-10-31 ──────────────────────────────────────────────
// B1: the delimiter was chosen per LINE, so a comma inside a number split the
// cell whenever the input wasn't comma-separated. PDF text (cells joined with two
// spaces) hit it on every amount >= 1,000; semicolon CSVs on every decimal comma.
eq('B1a PDF row with thousands commas', pick(P('Name  Shares  Avg Cost\nNaspers Ltd  1,250  3,450.00')),
  [['Naspers Ltd', 1250, 3450, '']]);   // was "Naspers Ltd  1", 2503, 450
eq('B1b semicolon CSV with decimal commas', pick(P('Name;Shares;Avg Cost\nNaspers;10,5;3450,50')),
  [['Naspers', 10.5, 3450.5, '']]);     // was "Naspers;10", 53450, 50
// B2: any row whose text CONTAINED a synonym ("Texas Instruments", "Walt Disney
// Company") was taken as the header and every row above it discarded.
eq('B2a data row containing "instrument" is not a header',
  pick(P('Apple, 10, 150\nMicrosoft, 5, 300\nTexas Instruments, 8, 180\nNvidia, 4, 120')),
  [['Apple', 10, 150, ''], ['Microsoft', 5, 300, ''], ['Texas Instruments', 8, 180, ''], ['Nvidia', 4, 120, '']]);
eq('B2b data row containing "company" is not a header',
  pick(P('Apple, 10, 150\nThe Walt Disney Company, 3, 90')),
  [['Apple', 10, 150, ''], ['The Walt Disney Company', 3, 90, '']]);
// ...and a title row above the real header stopped the scan, so the header was
// read as data and "Total Cost" never divided by shares (a 10x cost error).
eq('B2c title row above the real header',
  pick(R([['Portfolio holdings'], ['Symbol', 'Quantity', 'Total Cost'], ['AAPL', '10', '1500']])),
  [['AAPL', 10, 150, '']]);
// B3: Fidelity's "Cost Basis Total" was claimed as the per-share cost.
eq('B3 Cost Basis Total is a total, Average Cost Basis is per share',
  pick(R([['Symbol', 'Quantity', 'Last Price', 'Current Value', 'Cost Basis Total', 'Average Cost Basis'],
          ['AAPL', '10', '160', '1600', '1500', '150']])),
  [['AAPL', 10, 150, '']]);             // was 1500
// B4: the Date.parse fallback went through toISOString(), so in SAST/CET every
// textual date landed a day early (and that date picks the locked FX rate).
const tzRun = (tz) => spawnSync(process.execPath, ['-e', `
  const D = require(${JSON.stringify(fileURLToPath(new URL('../../pb-import.js', import.meta.url)))}).parseImportDate;
  process.stdout.write(JSON.stringify(['15 Mar 2024','Mar 15, 2024','2024.03.15','15.03.2024','05/03/24','15/03/24','31/02/2026'].map(D)));
`], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
for (const tz of ['Africa/Johannesburg', 'Europe/Amsterdam', 'America/New_York', 'UTC']) {
  const r = tzRun(tz);
  let got = null; try { got = JSON.parse(r.stdout); } catch (e) { got = r.stderr; }
  eq(`B4 textual / dotted / 2-digit-year dates in ${tz}`, got,
    ['2024-03-15', '2024-03-15', '2024-03-15', '2024-03-15', '2024-03-05', '2024-03-15', '']);
}
// B5: the "# Shares" label regex had no left anchor, so a fund NAMED "...Shares"
// (CoreShares, iShares) had its title line read as the share count.
const eeDetail = (title) => [title, 'My Holding', 'Total Value R8 100.69', '# Shares 157', '# FSRs 0.6010',
  'Avg. Purchase Price R39.93', 'Purchase Value R6 293.12'].join('\n');
const ee1 = EE(eeDetail('CoreShares Top 50 ETF'));
ok('B5a CoreShares title is not the share count', ee1 && ee1[0] && Math.abs(ee1[0].shares - 157.601) < 1e-9, ee1);
const ee2 = EE(eeDetail('iShares Core S&P 500 ETF'));
ok('B5b iShares title is not the share count', ee2 && ee2[0] && Math.abs(ee2[0].shares - 157.601) < 1e-9, ee2);

// B6: a history row whose NAME ends in a number glued it onto the quantity.
const hist = EE('COMMENT Bought Satrix 40 12.5000 @\n8,000.00\nDEBIT/CREDIT -R1000.00');
ok('B6 "Satrix 40 12.5000" is 12.5 of Satrix 40', hist && hist[0] && hist[0].query === 'Satrix 40' && hist[0].shares === 12.5, hist);  // was 4012.5
// B7: parseDecimal (pb-core) read a lone comma + 3 digits as thousands even after
// a zero integer part, and multi-dot thousands fell through to parseFloat.
eq('B7a "0,125" shares (SA decimal comma)', pick(P('Name;Shares;Avg Cost\nNaspers;0,125;3450,50')), [['Naspers', 0.125, 3450.5, '']]);  // was 125
eq('B7b "1.234.567" dotted thousands', pick(P('Name;Shares;Avg Cost\nNaspers;10;1.234.567')), [['Naspers', 10, 1234567, '']]);  // was 1.234

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nALL PASSED');
