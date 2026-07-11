// Tests for the fundamentals helpers in the shared core (pb-core.js):
// parseFundamentalsTimeseries (Yahoo ws/fundamentals-timeseries payloads) and
// mergeFundamentals (priority merge of partial per-source results).
//   cd backend/test && node fundamentals-parse.test.mjs
//
// The timeseries endpoint is the keyless fallback for the detail card's
// "Key stats & ratios" block — these tests pin the parse/derivation logic over
// a synthetic payload so a Yahoo shape change or a refactor can't silently
// empty the block again. A source guard confirms app.js delegates to the core.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';

const { parseFundamentalsTimeseries, mergeFundamentals } = PBCore;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;

ok('PBCore exports parseFundamentalsTimeseries', typeof parseFundamentalsTimeseries === 'function');
ok('PBCore exports mergeFundamentals', typeof mergeFundamentals === 'function');

// ── parseFundamentalsTimeseries over a synthetic Yahoo payload ──────────────
const row = (asOfDate, raw, currencyCode = 'USD') =>
  ({ asOfDate, periodType: '12M', currencyCode, reportedValue: { raw, fmt: String(raw) } });
const entry = (type, rows) => ({ meta: { symbol: ['TEST'], type: [type] }, [type]: rows });
const payload = {
  timeseries: {
    result: [
      entry('trailingPeRatio', [row('2026-06-30', 24.5)]),
      entry('trailingMarketCap', [row('2026-06-30', 3.1e12)]),
      entry('trailingPbRatio', [row('2026-06-30', 8.2)]),
      entry('trailingPsRatio', [row('2026-06-30', 6.5)]),
      // Padded periods arrive as nulls — the parser must skip them.
      entry('annualTotalRevenue', [null, row('2024-12-31', 100e9), row('2025-12-31', 110e9)]),
      entry('annualNetIncome', [row('2024-12-31', 20e9), row('2025-12-31', 25e9)]),
      entry('trailingNetIncome', [row('2026-03-31', 26e9)]),
      entry('annualStockholdersEquity', [row('2025-12-31', 80e9)]),
      entry('annualTotalDebt', [row('2025-12-31', 40e9)]),
      entry('annualCurrentAssets', [row('2025-12-31', 60e9)]),
      entry('annualCurrentLiabilities', [row('2025-12-31', 30e9)]),
      entry('trailingFreeCashFlow', [row('2026-03-31', 18e9)]),
      // A type Yahoo answered with no usable rows must be ignored, not crash.
      entry('trailingEBITDA', [null])
    ],
    error: null
  }
};
const f = parseFundamentalsTimeseries(payload, 'US');
ok('parses a hit (returns object)', f != null && typeof f === 'object');
if (f) {
  ok('peTrailing from trailingPeRatio', near(f.peTrailing, 24.5));
  ok('marketCap from trailingMarketCap', near(f.marketCap, 3.1e12));
  ok('priceToBook / priceToSales mapped', near(f.priceToBook, 8.2) && near(f.priceToSales, 6.5));
  ok('revenue prefers trailing, falls back to latest annual', near(f.revenue, 110e9));
  ok('profitMargin = trailingNetIncome / revenue', near(f.profitMargin, 26e9 / 110e9 * 100));
  ok('revenueGrowth YoY off annuals (skips padded null)', near(f.revenueGrowth, 10));
  ok('earningsGrowth YoY off annuals', near(f.earningsGrowth, 25));
  ok('roe = trailingNetIncome / equity', near(f.roe, 26e9 / 80e9 * 100));
  ok('debtToEquity in Yahoo percent convention', near(f.debtToEquity, 50));
  ok('currentRatio derived', near(f.currentRatio, 2));
  ok('freeCashflow mapped', near(f.freeCashflow, 18e9));
  ok('ebitda with no usable rows → null', f.ebitda === null);
  ok('lastFiscalYearEnd from latest annual asOfDate', f.lastFiscalYearEnd === Date.parse('2025-12-31'));
  ok('currency picked up from payload', f.currency === 'USD');
  ok('divisor is 1 (natural units)', f.divisor === 1);
  ok('source tagged yahoo-ts', f.source === 'yahoo-ts');
}
// Currency falls back to the market's currency when the payload has none.
const bare = {
  timeseries: { result: [
    entry('trailingPeRatio', [{ asOfDate: '2026-06-30', reportedValue: { raw: 12 } }]),
    entry('trailingPbRatio', [{ asOfDate: '2026-06-30', reportedValue: { raw: 2 } }]),
    entry('trailingPsRatio', [{ asOfDate: '2026-06-30', reportedValue: { raw: 3 } }])
  ] }
};
const bf = parseFundamentalsTimeseries(bare, 'JSE');
ok('currency falls back to market code', bf != null && bf.currency === 'ZAR');

// Sparse payloads (fewer than 3 real metrics) don't count as a hit — a
// half-empty block would suppress the retry/fallback path.
const sparse = { timeseries: { result: [entry('trailingPeRatio', [row('2026-06-30', 24.5)])] } };
ok('sparse payload → null (falls through to next source)', parseFundamentalsTimeseries(sparse, 'US') === null);
ok('malformed payload → null', parseFundamentalsTimeseries({}, 'US') === null);
ok('null payload → null', parseFundamentalsTimeseries(null, 'US') === null);

// ── mergeFundamentals: earlier source wins per field, later fills gaps ──────
const sa = { peTrailing: 25, marketCap: null, sector: 'Technology', currency: 'USD', divisor: 1, source: 'stockanalysis' };
const ts = { peTrailing: 24.5, marketCap: 3.1e12, roe: 30, sector: null, currency: 'USD', divisor: 1, source: 'yahoo-ts' };
const merged = mergeFundamentals([sa, ts]);
ok('merge keeps earlier source per field', merged.peTrailing === 25);
ok('merge fills gaps from later source', near(merged.marketCap, 3.1e12) && merged.roe === 30);
ok('merge keeps earlier non-null strings', merged.sector === 'Technology');
ok('merge joins source tags', merged.source === 'stockanalysis+yahoo-ts');
ok('merge fills empty-string fields', mergeFundamentals([{ currency: '', source: 'a' }, { currency: 'ZAR', source: 'b' }]).currency === 'ZAR');
ok('merge of one part returns it unchanged', mergeFundamentals([sa]) === sa);
ok('merge of nothing → null', mergeFundamentals([]) === null && mergeFundamentals([null, undefined]) === null);
ok('merge keeps zero values (0 is data)', mergeFundamentals([{ beta: 0, source: 'a' }, { beta: 1.2, source: 'b' }]).beta === 0);

// ── Source guard: app.js delegates to the core (no private reimplementation) ─
const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
ok('app.js calls PBCore.parseFundamentalsTimeseries', appSrc.includes('PBCore.parseFundamentalsTimeseries('));
ok('app.js merges via PBCore.mergeFundamentals', appSrc.includes('PBCore.mergeFundamentals('));
ok('app.js fetches the timeseries endpoint', appSrc.includes('/ws/fundamentals-timeseries/v1/finance/timeseries/'));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
