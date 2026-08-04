// Tests for the fundamentals helpers in the shared core (pb-core.js):
// parseFundamentalsTimeseries (Yahoo ws/fundamentals-timeseries payloads),
// mergeFundamentals (priority merge of partial per-source results),
// fundamentalsMoney / baseCurrencyCode (the card's currency resolution) and
// parseDividendEvents (TTM yield off the chart API's dividend events) - plus a
// vm render of the REAL FundamentalsBlock out of pb-modals.js.
//   cd backend/test && node fundamentals-parse.test.mjs
//
// The timeseries endpoint is the keyless fallback for the detail card's
// "Key stats & ratios" block — these tests pin the parse/derivation logic over
// a synthetic payload so a Yahoo shape change or a refactor can't silently
// empty the block again. A source guard confirms app.js delegates to the core.
//
// The currency half exists because of a live bug: a fundamentals object mixes
// TWO currencies (statements vs listing) and the code carried one field for
// both, so Naspers - rand-listed, dollar-reporting - rendered a R570bn market
// cap as "$600B" with no conversion at all. Parse-level assertions alone would
// not have caught it (the parser's number was fine, the view's label was not),
// hence the rendered-card section at the bottom.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import PBCore from '../../pb-core.js';

const { parseFundamentalsTimeseries, mergeFundamentals, fundamentalsMoney,
        baseCurrencyCode, parseDividendEvents } = PBCore;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;

ok('PBCore exports parseFundamentalsTimeseries', typeof parseFundamentalsTimeseries === 'function');
ok('PBCore exports mergeFundamentals', typeof mergeFundamentals === 'function');
ok('PBCore exports fundamentalsMoney', typeof fundamentalsMoney === 'function');
ok('PBCore exports baseCurrencyCode', typeof baseCurrencyCode === 'function');
ok('PBCore exports parseDividendEvents', typeof parseDividendEvents === 'function');

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
  // Margins divide like by like. This payload has trailing net income but NO
  // trailing revenue, so the whole ratio drops to the annual basis rather than
  // pairing a TTM numerator with a fiscal-year denominator (which is what this
  // did before, and it read 23.6% for a company that earned 22.7%).
  ok('profitMargin falls to the annual basis when TTM revenue is absent', near(f.profitMargin, 25e9 / 110e9 * 100));
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

// ── Two currencies, never one: statements vs listing ───────────────────────
// The defect these pin: Naspers and Datatec TRADE in rand and FILE in dollars.
// The parser used to treat "the first currencyCode in the payload" as THE
// currency of the whole object, so the market cap inherited the statement
// currency, the card's USD branch was taken, and an unconverted R570bn cap was
// printed as "$600B" (Datatec's R20bn likewise as "$20B").
const jseRows = (capCcy) => ({
  timeseries: { result: [
    // Statement rows first, exactly as Yahoo tends to order them.
    entry('annualTotalRevenue', [row('2025-03-31', 5.9e9, 'USD'), row('2026-03-31', 6.4e9, 'USD')]),
    entry('trailingTotalRevenue', [row('2026-06-30', 6.5e9, 'USD')]),
    entry('trailingNetIncome', [row('2026-06-30', 1.3e9, 'USD')]),
    entry('trailingMarketCap', [row('2026-06-30', 570e9, capCcy)]),
    entry('trailingPeRatio', [row('2026-06-30', 18.4, 'USD')])
  ] }
});
const npn = parseFundamentalsTimeseries(jseRows('ZAR'), 'JSE');
ok('JSE/USD-reporter: statement currency is the reporting one', npn.currency === 'USD');
ok('JSE/USD-reporter: market cap currency is the LISTING one', npn.marketCapCurrency === 'ZAR');
ok('JSE/USD-reporter: cap value untouched by the parser', near(npn.marketCap, 570e9));
// Yahoo also tags the valuation row itself with the reporting currency on these
// listings. The market decides, not the payload: a cap is price x shares.
const npnMislabelled = parseFundamentalsTimeseries(jseRows('USD'), 'JSE');
ok('a USD-tagged cap row on a JSE listing is still ZAR', npnMislabelled.marketCapCurrency === 'ZAR');
ok('TFSA is JSE under the hood', parseFundamentalsTimeseries(jseRows('ZAR'), 'TFSA').marketCapCurrency === 'ZAR');
// Statement currency must not depend on the order Yahoo happens to answer in.
const reversed = { timeseries: { result: jseRows('ZAR').timeseries.result.slice().reverse() } };
ok('statement currency is order-independent', parseFundamentalsTimeseries(reversed, 'JSE').currency === 'USD');
// The mirror image: a US listing whose statements are filed in euros. The old
// code divided a dollar cap by the EUR rate and read ~8% high.
const usEur = parseFundamentalsTimeseries({
  timeseries: { result: [
    entry('trailingTotalRevenue', [row('2026-06-30', 30e9, 'EUR')]),
    entry('trailingNetIncome', [row('2026-06-30', 9e9, 'EUR')]),
    entry('trailingMarketCap', [row('2026-06-30', 300e9, 'EUR')]),
    entry('trailingPeRatio', [row('2026-06-30', 33)])
  ] }
}, 'US');
ok('US listing filing in EUR: statements EUR, cap USD', usEur.currency === 'EUR' && usEur.marketCapCurrency === 'USD');
// mostRecentQuarter now comes from a REPORTED period, not a valuation date.
ok('mostRecentQuarter is a statement period end', npn.mostRecentQuarter === Date.parse('2026-06-30'));
const valuationOnly = parseFundamentalsTimeseries({
  timeseries: { result: [
    entry('quarterlyMarketCap', [row('2026-06-30', 1e9)]),
    entry('quarterlyPeRatio', [row('2026-06-30', 12)]),
    entry('quarterlyPbRatio', [row('2026-06-30', 2)])
  ] }
}, 'US');
ok('no statement rows → no claimed quarter end', valuationOnly.mostRecentQuarter === null);

// ── fundamentalsMoney: the one place market cap gets valued ────────────────
const rates = { USD: 1, ZAR: 18, GBP: 0.79, EUR: 0.92 };
const npnMoney = fundamentalsMoney(npn, 'JSE', rates);
ok('cap converts off the LISTING currency', near(npnMoney.capUsd, 570e9 / 18, 1));
ok('cap keeps its native figure too', near(npnMoney.capNative, 570e9));
ok('statement currency carried through', npnMoney.statementCcy === 'USD' && npnMoney.capCcy === 'ZAR');
ok('a dollar cap is not converted', near(fundamentalsMoney(usEur, 'US', rates).capUsd, 300e9));
// Objects cached before marketCapCurrency existed still render right: the
// fallback is the market's currency, which is all that field ever holds.
ok('legacy object without marketCapCurrency falls back to the market', (() => {
  const m = fundamentalsMoney({ marketCap: 570e9, currency: 'USD' }, 'JSE', rates);
  return m.capCcy === 'ZAR' && near(m.capUsd, 570e9 / 18, 1);
})());
ok('no FX rate → no USD figure, native survives', (() => {
  const m = fundamentalsMoney(npn, 'JSE', { USD: 1 });
  return m.capUsd === null && near(m.capNative, 570e9);
})());
ok('missing/zero cap → nulls, never NaN', (() => {
  const a = fundamentalsMoney({ marketCap: null }, 'JSE', rates);
  const b = fundamentalsMoney({ marketCap: 0 }, 'US', rates);
  return a.capNative === null && a.capUsd === null && b.capNative === null && b.capUsd === null;
})());
ok('crypto prices in USD', fundamentalsMoney({ marketCap: 2e12 }, 'CRYPTO', rates).capCcy === 'USD');
ok('baseCurrencyCode maps minor units to their base', baseCurrencyCode('ZAc', 'JSE') === 'ZAR'
  && baseCurrencyCode('GBp', 'LSE') === 'GBP' && baseCurrencyCode('GBX', 'LSE') === 'GBP'
  && baseCurrencyCode('', 'TFSA') === 'ZAR' && baseCurrencyCode('', 'US') === 'USD'
  && baseCurrencyCode('JPY', 'US') === 'JPY');

// ── Margins: matched basis only ────────────────────────────────────────────
const matched = parseFundamentalsTimeseries({
  timeseries: { result: [
    entry('trailingTotalRevenue', [row('2026-06-30', 200e9)]),
    entry('trailingNetIncome', [row('2026-06-30', 40e9)]),
    entry('trailingOperatingIncome', [row('2026-06-30', 60e9)]),
    entry('annualTotalRevenue', [row('2025-12-31', 100e9)]),
    entry('annualNetIncome', [row('2025-12-31', 10e9)])
  ] }
}, 'US');
ok('TTM income over TTM revenue when both exist', near(matched.profitMargin, 20) && near(matched.operatingMargin, 30));
const noRevenue = parseFundamentalsTimeseries({
  timeseries: { result: [
    entry('trailingNetIncome', [row('2026-06-30', 40e9)]),
    entry('trailingPeRatio', [row('2026-06-30', 20)]),
    entry('trailingPbRatio', [row('2026-06-30', 3)]),
    entry('trailingPsRatio', [row('2026-06-30', 5)])
  ] }
}, 'US');
ok('no revenue on either basis → no margin (not a wrong one)', noRevenue.profitMargin === null);

// ── parseDividendEvents: TTM yield off actual payments ─────────────────────
const NOW = Date.parse('2026-08-01T00:00:00Z');
const day = 24 * 3600 * 1000;
const divPayload = (meta, list) => ({ chart: { result: [{
  meta,
  events: { dividends: Object.fromEntries(list.map(d => [String(Math.floor(d.at / 1000)), { amount: d.amount, date: Math.floor(d.at / 1000) }])) }
}] } });
// LSE: price and dividends both arrive in pence, so the ratio is divisor-proof
// while the per-share rate is scaled to pounds.
const lseDiv = parseDividendEvents(divPayload({ currency: 'GBp', regularMarketPrice: 780 }, [
  { at: NOW - 30 * day, amount: 5 },
  { at: NOW - 200 * day, amount: 5 },
  { at: NOW - 400 * day, amount: 5 }     // outside the TTM window
]), 'LSE', NOW);
ok('TTM window excludes payments older than a year', lseDiv.dividendCount === 2);
ok('yield is divisor-immune (pence over pence)', near(lseDiv.dividendYield, 10 / 780 * 100, 1e-9));
ok('per-share rate IS scaled to major units', near(lseDiv.dividendRate, 0.10, 1e-9));
ok('last dividend date carried', lseDiv.lastDividendDate === NOW - 30 * day);
ok('no dividends → null (not a 0% yield)', parseDividendEvents(divPayload({ currency: 'USD', regularMarketPrice: 100 }, []), 'US', NOW) === null);
ok('a future-dated event is ignored', parseDividendEvents(divPayload({ currency: 'USD', regularMarketPrice: 100 }, [{ at: NOW + 5 * day, amount: 1 }]), 'US', NOW) === null);
ok('malformed dividend payloads → null', parseDividendEvents({}, 'US', NOW) === null
  && parseDividendEvents(null, 'US', NOW) === null
  && parseDividendEvents({ chart: { result: [{ meta: { currency: 'USD' } }] } }, 'US', NOW) === null);
ok('no price → rate only, no invented yield', (() => {
  const d = parseDividendEvents(divPayload({ currency: 'USD' }, [{ at: NOW - day, amount: 2 }]), 'US', NOW);
  return d.dividendYield === null && near(d.dividendRate, 2);
})());
ok('dividend part carries no currency (it cannot hijack the statement one)', (() => {
  const d = parseDividendEvents(divPayload({ currency: 'ZAc', regularMarketPrice: 5000 }, [{ at: NOW - day, amount: 100 }]), 'JSE', NOW);
  return d.currency === undefined && d.source === 'yahoo-div';
})());

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

// A gap may only be filled across sources when the currencies agree - otherwise
// the object ends up tagged one currency while carrying figures in another, and
// nothing downstream can tell.
const usdPart = { currency: 'USD', marketCapCurrency: 'ZAR', revenue: 6.5e9, marketCap: null, ebitda: null, peTrailing: null, source: 'yahoo-ts' };
const zarPart = { currency: 'ZAR', marketCapCurrency: 'ZAR', ebitda: 40e9, peTrailing: 12, analystCount: 4, source: 'other' };
const mixed = mergeFundamentals([usdPart, zarPart]);
ok('a rand EBITDA cannot fill a gap in a dollar-reporting object', mixed.ebitda === null);
ok('unitless fields still cross the currency line', mixed.peTrailing === 12 && mixed.analystCount === 4);
ok('the winning statement currency is kept', mixed.currency === 'USD');
const capMix = mergeFundamentals([
  { marketCapCurrency: 'ZAR', marketCap: null, source: 'a' },
  { marketCapCurrency: 'USD', marketCap: 32e9, source: 'b' }
]);
ok('a dollar market cap cannot fill a rand-quoted gap', capMix.marketCap === null);
ok('same-currency money still fills gaps', mergeFundamentals([
  { currency: 'USD', revenue: null, source: 'a' },
  { currency: 'USD', revenue: 6.5e9, source: 'b' }
]).revenue === 6.5e9);
ok('an untagged part (analyst/dividend only) still donates', mergeFundamentals([
  { currency: 'USD', dividendYield: null, targetMean: null, source: 'yahoo-ts' },
  { dividendYield: 3.1, targetMean: 120, source: 'yahoo-div' }
]).dividendYield === 3.1);

// ── Source guard: app.js delegates to the core (no private reimplementation) ─
const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
ok('app.js calls PBCore.parseFundamentalsTimeseries', appSrc.includes('PBCore.parseFundamentalsTimeseries('));
ok('app.js merges via PBCore.mergeFundamentals', appSrc.includes('PBCore.mergeFundamentals('));
ok('app.js fetches the timeseries endpoint', appSrc.includes('/ws/fundamentals-timeseries/v1/finance/timeseries/'));
ok('app.js parses dividend events via the core', appSrc.includes('PBCore.parseDividendEvents('));
ok('app.js does not reimplement the dividend parser', !/function\s+parseDividendEvents\s*\(/.test(appSrc));
// The dividend probe rides its OWN url. Bolting events=div onto the quote
// fetch would put an extra query param on the interval=1d request whose daily
// bars the day move is anchored to - the one request in this app that has
// earned the right to be left alone.
ok('dividend events use a dedicated chart request', appSrc.includes('&range=1y&events=div'));
ok('no events param leaked onto the quote fetch', !/interval=1d&range=5d[^`\n]*events=/.test(appSrc));

// -- Source guard: the card delegates its money math ------------------------
// The market-cap bug lived in an inline `f.marketCap / rate` in the view, next
// to a single currency field that could not describe what it was dividing.
const modSrc = readFileSync(join(here, '..', '..', 'pb-modals.js'), 'utf8');
ok('pb-modals values the cap via the core', modSrc.includes('PBCore.fundamentalsMoney('));
ok('pb-modals does no inline cap FX', !modSrc.includes('f.marketCap / rate'));
ok('pb-modals binds baseCurrencyCode instead of copying it', modSrc.includes('PBCore.baseCurrencyCode')
  && !/function\s+baseCurrency\s*\(/.test(modSrc));

// -- Source guard: stockanalysis.com fetchers must fail FAST, never via the --
// -- proxy cascade. Its /api/symbol paths went 404-dead (2026-07-12) while  --
// -- serving ACAO:* again, so each proxied lookup burned the whole 6-proxy  --
// -- chain (~25s, two hung 8s timeouts) INSIDE the Promise.all that gates   --
// -- the card's stats render - live timeseries data sat ready at ~400ms     --
// -- while the block showed "Loading...". Direct + abort keeps failure      --
// -- sub-second and lets the source self-heal if the API ever returns.      --
const fnBody = (name) => {
  const start = appSrc.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const rest = appSrc.slice(start + 1);
  const next = rest.search(/\r?\n(?:async )?function /);
  return next < 0 ? rest : rest.slice(0, next);
};
const saFund = fnBody('fetchFundamentalsStockAnalysis');
const saSector = fnBody('fetchSectorStockAnalysis');
ok('fetchFundamentalsStockAnalysis exists', !!saFund);
ok('fetchSectorStockAnalysis exists', !!saSector);
ok('fetchFundamentalsStockAnalysis does NOT ride the proxy chain', !!saFund && !saFund.includes('fetchViaProxies'));
ok('fetchSectorStockAnalysis does NOT ride the proxy chain', !!saSector && !saSector.includes('fetchViaProxies'));
ok('fetchFundamentalsStockAnalysis uses the time-boxed direct fetch', !!saFund && saFund.includes('fetchJsonDirect('));
ok('fetchSectorStockAnalysis uses the time-boxed direct fetch', !!saSector && saSector.includes('fetchJsonDirect('));
const directHelper = fnBody('fetchJsonDirect');
ok('fetchJsonDirect helper exists and aborts on a timer', !!directHelper && directHelper.includes('AbortController') && directHelper.includes('setTimeout'));

// ── The card itself, rendered ──────────────────────────────────────────────
// The parse-level tests above can all pass while the view still prints the
// wrong thing - that is precisely how "$600B" survived. The browser smokes are
// the usual gate, but they pull React from a CDN, so this runs the REAL
// FundamentalsBlock source out of pb-modals.js in a vm with a recording
// createElement instead. Slice bounded by source markers, like the backup
// round-trip suite does with app.js.
const fbStart = modSrc.indexOf('\nfunction fmtLarge(');
const fbAt = modSrc.indexOf('\nfunction FundamentalsBlock(');
ok('pb-modals still declares fmtLarge and FundamentalsBlock', fbStart > 0 && fbAt > fbStart);
const fbEnd = modSrc.indexOf('\n}\n', fbAt);
const BLOCK = modSrc.slice(fbStart, fbEnd + 3);
const el = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(Infinity).filter(k => k != null && k !== false) });
const ctx = {
  React: { createElement: el, Fragment: 'Fragment', memo: (x) => x },
  PBCore,
  PBContent: (await import('../../pb-content.js')).default,
  MARKET_CURRENCY: PBCore.MARKET_CURRENCY,
  CURRENCY_SYMBOLS: (await import('../../pb-content.js')).default.CURRENCY_SYMBOLS,
  window: { PBApp: { fmt: (n, m) => (PBCore.MARKET_CURRENCY[m] || PBCore.MARKET_CURRENCY.US).sym + Number(n).toFixed(2) } },
  console
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(BLOCK + '\nglobalThis.__FB = FundamentalsBlock;', ctx);
const FB = ctx.__FB;
ok('FundamentalsBlock evaluates outside a browser', typeof FB === 'function');
// Walk the recorded tree into { label: [value, sub] } for the two stat grids.
const cells = (tree) => {
  const out = {};
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.props && n.props.className === 'fund-cell') {
      const [label, value, sub] = n.kids;
      out[label.kids[0]] = [value.kids[0], sub ? sub.kids[0] : null];
      return;
    }
    (n.kids || []).forEach(walk);
  };
  walk(tree);
  return out;
};
// Naspers, as the pipeline really delivers it: rand cap, dollar statements.
const npnCard = cells(FB({
  fundamentals: { data: Object.assign({}, npn, { revenue: 6.5e9, eps: 12.34, ebitda: 1.9e9 }) },
  quote: { price: 5700, currency: 'ZAR' },
  market: 'JSE',
  fxRates: { rates }
}));
ok('CARD: market cap converted and labelled in dollars', npnCard['Market cap'][0] === '$31.67B');
ok('CARD: the rand figure is shown underneath', npnCard['Market cap'][1] === 'R570.00B');
ok('CARD: dollar revenue is not dressed up as rand', npnCard['Revenue'][0] === '$6.50B' && npnCard['Revenue'][1] === 'TTM USD');
ok('CARD: EPS follows the statements too', npnCard['EPS (TTM)'][0] === '$12.34' && npnCard['EPS (TTM)'][1] === 'USD');
ok('CARD: EBITDA follows the statements', npnCard['EBITDA'][0] === '$1.90B' && npnCard['EBITDA'][1] === 'USD');
// A rand-reporting JSE listing reads entirely in rand, with no noisy tags.
const shp = cells(FB({
  fundamentals: { data: { marketCap: 130e9, marketCapCurrency: 'ZAR', currency: 'ZAR', revenue: 250e9, eps: 12.5 } },
  quote: { price: 240, currency: 'ZAR' }, market: 'JSE', fxRates: { rates }
}));
ok('CARD: rand reporter reads in rand, untagged', shp['Revenue'][0] === 'R250.00B' && shp['Revenue'][1] === 'TTM' && shp['EPS (TTM)'][1] === null);
ok('CARD: rand reporter cap still converts', shp['Market cap'][0] === '$7.22B' && shp['Market cap'][1] === 'R130.00B');
// A US name is unchanged by all of this: dollars, no sub-labels.
const us = cells(FB({
  fundamentals: { data: { marketCap: 3.1e12, marketCapCurrency: 'USD', currency: 'USD', revenue: 400e9, peTrailing: 32 } },
  quote: { price: 210, currency: 'USD' }, market: 'US', fxRates: { rates }
}));
ok('CARD: US cap unchanged, no native sub-line', us['Market cap'][0] === '$3.10T' && us['Market cap'][1] === null);
ok('CARD: US revenue unchanged', us['Revenue'][0] === '$400.00B' && us['Revenue'][1] === 'TTM');
// Without an FX rate the cap is shown as quoted rather than vanishing.
const noFx = cells(FB({
  fundamentals: { data: { marketCap: 570e9, marketCapCurrency: 'ZAR', currency: 'USD' } },
  quote: { price: 5700 }, market: 'JSE', fxRates: { rates: { USD: 1 } }
}));
ok('CARD: no FX rate → native cap, not a missing row', noFx['Market cap'][0] === 'R570.00B' && noFx['Market cap'][1] === 'ZAR');
// The dividend backfill surfaces with the per-share rate beneath it.
const withDiv = cells(FB({
  fundamentals: { data: { dividendYield: 3.42, dividendRate: 12.5, currency: 'ZAR', marketCapCurrency: 'ZAR' } },
  quote: { price: 365 }, market: 'JSE', fxRates: { rates }
}));
ok('CARD: dividend yield renders with its rate, in the LISTING currency',
  withDiv['Dividend yield'][0] === '3.42%' && withDiv['Dividend yield'][1] === 'R12.50 / share (TTM)');
// A NAV premium across two currencies is not a number anyone can use.
const navMixed = cells(FB({
  fundamentals: { data: { bookValue: 100, priceToBook: 1.8, currency: 'USD', marketCapCurrency: 'ZAR' } },
  quote: { price: 5700 }, market: 'JSE', fxRates: { rates }
}));
ok('CARD: cross-currency NAV premium falls back to P/B', navMixed['NAV premium'][0] === '+80.0%');
const navSame = cells(FB({
  fundamentals: { data: { bookValue: 100, priceToBook: 1.8, currency: 'ZAR', marketCapCurrency: 'ZAR' } },
  quote: { price: 120 }, market: 'JSE', fxRates: { rates }
}));
ok('CARD: same-currency NAV premium still uses the live price', navSame['NAV premium'][0] === '+20.0%');
// P/E's caption names the period it actually has.
const periods = cells(FB({
  fundamentals: { data: { peTrailing: 18.4, mostRecentQuarter: Date.parse('2026-06-30'), currency: 'USD', marketCapCurrency: 'ZAR' } },
  quote: { price: 5700 }, market: 'JSE', fxRates: { rates }
}));
ok('CARD: P/E sub says Q ended when it has a quarter', /^Q ended /.test(periods['P/E (TTM)'][1]));
const fyOnly = cells(FB({
  fundamentals: { data: { peTrailing: 18.4, lastFiscalYearEnd: Date.parse('2025-12-31'), currency: 'USD', marketCapCurrency: 'ZAR' } },
  quote: { price: 5700 }, market: 'JSE', fxRates: { rates }
}));
ok('CARD: a fiscal-year end is not captioned as a quarter', /^FY ended /.test(fyOnly['P/E (TTM)'][1]));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
