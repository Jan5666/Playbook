// Dashboard growth chart (pb-views.js PortfolioLineChart) — the points series,
// rendered from the REAL view source in a vm with stub hooks.
//   node backend/test/growth-chart.test.mjs
// Pins three fixes from the 2026-10-31 bug sweep:
//   1. holdings with no price history (fetch failed) are drawn at cost without
//      zeroing every OTHER holding on the date they introduce;
//   2. the "contributed" line values deposits like the total does (locked
//      landed-USD rate), so it doesn't step on the last point;
//   3. "today" is the LOCAL date (SAST 00:00-02:00 used to be yesterday).
process.env.TZ = 'Africa/Johannesburg';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import PBCore from '../../pb-core.js';

const src = readFileSync(new URL('../../pb-views.js', import.meta.url), 'latin1');
const code = src.slice(src.indexOf('const CHART_MONTHS'), src.indexOf('function DashboardView('))
  + '\n' + src.slice(src.indexOf('function tfsaTodayStr()'), src.indexOf('function fmtRand('));

let failures = 0;
const ok = (n, c, got) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${n}${c ? '' : '  — got ' + JSON.stringify(got)}`); if (!c) failures++; };

function points({ positions, contributions = [], history = {}, prices, rates, disp = 'USD', now }) {
  let n = 0; const memos = [];
  const preset = ['all', history, false, null];   // range, historyCache, loading, hoverIdx
  class FDate extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  const ctx = { Date: FDate,
    React: { createElement: (t, p, ...k) => ({ t, p, k }), Fragment: 'F' },
    useState: () => [preset[n++], () => {}], useEffect: () => {}, useRef: () => ({ current: null }),
    useMemo: f => { const r = f(); memos.push(r); return r; }, useCallback: f => f,
    PBStore: { usePricesMap: () => prices, useSetting: () => false },
    priceKey: PBCore.priceKey, marketCurrency: PBCore.marketCurrency, convertCcy: PBCore.convertCcy,
    positionCostCcy: PBCore.positionCostCcy, contribInDisplay: PBCore.contribInDisplay, PBCore,
    fetchHistory: async () => null, CURRENCY_SYMBOLS: { USD: '$', ZAR: 'R' }, out: null };
  vm.createContext(ctx);
  vm.runInContext(code + ';out = PortfolioLineChart;', ctx);
  ctx.out({ positions, contributions, displayCurrency: disp, fxRates: { rates } });
  return memos.find(m => Array.isArray(m) && m.length && m[0] && 'contributed' in m[0]) || [];
}
const bar = (d, p) => ({ t: Date.parse(d + 'T14:30:00Z'), p });
const series = pts => Object.fromEntries(pts.map(p => [p.date, Math.round(p.value * 100) / 100]));
const NOW = Date.parse('2026-10-14T10:00:00Z');

// 1a. X has history (flat 1000); Y's history fetch failed, added on Saturday 10-10.
const hist = { 'US:X': ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13'].map(d => bar(d, 100)) };
const X = { id: 1, ticker: 'X', market: 'US', shares: 10, costBasis: 90, purchaseDate: '2026-10-01' };
const Y = { id: 2, ticker: 'Y', market: 'US', shares: 5, costBasis: 100, addedAt: '2026-10-10T09:00:00Z' };
let s = series(points({ positions: [X, Y], history: hist, prices: { 'US:X': { price: 100 }, 'US:Y': { price: 100 } }, rates: { USD: 1 }, now: NOW }));
ok('1a no-history holding added on a weekend: its date carries X (was 10-10=500)', s['2026-10-09'] === 1000 && s['2026-10-10'] === 1500 && s['2026-10-12'] === 1500, s);
ok('1a today = live value of both', s['2026-10-14'] === 1500, s);

// 1b. Two holdings with no history, different entry dates.
const A = { id: 1, ticker: 'A', market: 'US', shares: 10, costBasis: 100, purchaseDate: '2026-01-05' };
const B = { id: 2, ticker: 'B', market: 'US', shares: 10, costBasis: 50, purchaseDate: '2026-06-01' };
s = series(points({ positions: [A, B], prices: { 'US:A': { price: 120 }, 'US:B': { price: 60 } }, rates: { USD: 1 }, now: NOW }));
ok('1b second fallback date carries the first one\'s cost (was 06-01=500)', s['2026-01-05'] === 1000 && s['2026-06-01'] === 1500 && s['2026-10-14'] === 1800, s);

// 1c. Characterization: all holdings with history -> forward-filled sum, unchanged.
s = series(points({ positions: [X], history: hist, prices: { 'US:X': { price: 100 } }, rates: { USD: 1 }, now: NOW }));
ok('1c history-only series unchanged', s['2026-10-05'] === 1000 && s['2026-10-13'] === 1000 && Object.keys(s).length === 7, s);

// 2. ZAR deposit locked at 18.5, live rand 17.5, USD display: flat 1000 everywhere.
const pts = points({ positions: [X], contributions: [{ id: 'c', amount: 18500, currency: 'ZAR', date: '2026-10-06', fxRateAtContrib: 18.5 }],
  history: { 'US:X': hist['US:X'].concat([bar('2026-10-14', 101)]) }, prices: { 'US:X': { price: 100 } }, rates: { USD: 1, ZAR: 17.5 }, now: NOW });
const c = pts.filter(p => p.date >= '2026-10-06').map(p => Math.round(p.contributed * 100) / 100);
ok('2 contributed line is flat at the locked-rate value (was 1057.14 then 1000)', c.length > 1 && c.every(v => v === 1000), c);

// 3. 01:30 SAST on 29 Oct: B was bought "today" (local 10-29). The last point must
// be today's live total, not B alone.
const NIGHT = Date.parse('2026-10-28T23:30:00Z');
const histA = { 'US:A': ['2026-10-26', '2026-10-27', '2026-10-28'].map(d => bar(d, 100)) };
const pl = points({ positions: [{ ...A, purchaseDate: '2026-10-01', costBasis: 90 }, { ...B, purchaseDate: '2026-10-29' }],
  history: histA, prices: { 'US:A': { price: 100 }, 'US:B': { price: 50 } }, rates: { USD: 1 }, now: NIGHT });
const last = pl[pl.length - 1];
ok('3 last point is local today with both holdings (was 10-29=500 after 10-28=1500)', last && last.date === '2026-10-29' && last.value === 1500, pl.slice(-2));

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nALL PASSED');
