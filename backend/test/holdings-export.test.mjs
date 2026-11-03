// Holdings export table (Settings -> Export holdings): PBCore.buildHoldingsTable
// + PBCore.holdingsTableText. Pins what every column means, so the exported
// numbers can't drift from the rest of the app's money math.
//   node backend/test/holdings-export.test.mjs
//
// Semantics pinned here:
//   * purchase price / purchase value are in the position's COST currency
//     (positionCostCcy) and are never FX-converted; fees excluded (costBasis).
//   * % of portfolio = current market value in the display currency over the
//     WHOLE book's market value - same basis as the allocation chart - even when
//     only some markets are exported.
//   * an unpriced / unconvertible holding gets null %, and is not in the
//     denominator.
//   * CSV/TSV: raw '.' decimals, quoted text, CSV-injection neutralised.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';

const { buildHoldingsTable, holdingsTableText, HOLDINGS_TABLE_HEADERS, priceKey } = PBCore;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-9) => a != null && b != null && Math.abs(a - b) < eps;

// $1 = R18.50, GBP 0.80
const RATES = { USD: 1, ZAR: 18.5, GBP: 0.8, EUR: 0.92, AUD: 1.52 };
const ORDER = ['US', 'JSE', 'TFSA', 'LSE', 'ASX', 'FRA', 'PAR', 'AMS', 'CRYPTO'];

const positions = [
  { id: 'a', ticker: 'NPN', market: 'JSE', shares: 10, costBasis: 3000, name: 'Naspers' },     // R30,000 cost
  { id: 'b', ticker: 'AAPL', market: 'US', shares: 5, costBasis: 150 },                       // $750 cost
  { id: 'c', ticker: 'STX40', market: 'TFSA', shares: 100, costBasis: 70 },                    // R7,000 cost
  { id: 'd', ticker: 'BTC', market: 'CRYPTO', shares: 0.01, costBasis: 1000000, costCurrency: 'ZAR' }, // R10,000 cost, priced in USD
  { id: 'e', ticker: 'VOD', market: 'LSE', shares: 1000, costBasis: 0.7 },                     // unpriced
];
const prices = {
  [priceKey('JSE', 'NPN')]: { price: 3700 },      // R37,000 = $2,000
  [priceKey('US', 'AAPL')]: { price: 200 },       // $1,000
  [priceKey('TFSA', 'STX40')]: { price: 92.5 },   // R9,250 = $500
  [priceKey('CRYPTO', 'BTC')]: { price: 50000 },  // $500
};
// Portfolio = 2000 + 1000 + 500 + 500 = $4,000 (VOD unpriced, excluded)

ok('exports buildHoldingsTable', typeof buildHoldingsTable === 'function');
ok('exports holdingsTableText', typeof holdingsTableText === 'function');
ok('headers are the eight requested columns + market/currency',
  HOLDINGS_TABLE_HEADERS.join('|') === 'Name|Ticker|Market|Currency|Purchase price|Holding (shares)|Purchase value|% of portfolio');

// ── All holdings ──
const all = buildHoldingsTable(positions, prices, { rates: RATES, displayCurrency: 'USD', marketOrder: ORDER });
const byT = t => all.rows.find(r => r.ticker === t);
ok('all: every position is a row', all.rows.length === 5);
ok('all: portfolio value is the priced book in display ccy', near(all.portfolioValue, 4000));
ok('all: rows ordered by market order', all.rows.map(r => r.market).join(',') === 'US,JSE,TFSA,LSE,CRYPTO');
ok('JSE: purchase price = costBasis per share', byT('NPN').purchasePrice === 3000);
ok('JSE: purchase value = shares x costBasis, in ZAR', byT('NPN').purchaseValue === 30000 && byT('NPN').currency === 'ZAR');
ok('JSE: % of portfolio by market value (R37,000 = $2,000 of $4,000)', near(byT('NPN').pctOfPortfolio, 50));
ok('US: % = 25', near(byT('AAPL').pctOfPortfolio, 25));
ok('US: purchase value in USD', byT('AAPL').purchaseValue === 750 && byT('AAPL').currency === 'USD');
ok('crypto bought in ZAR: currency is the cost currency', byT('BTC').currency === 'ZAR');
ok('crypto bought in ZAR: purchase value in ZAR, not converted', near(byT('BTC').purchaseValue, 10000));
ok('crypto: % from its USD market value', near(byT('BTC').pctOfPortfolio, 12.5));
ok('unpriced holding: % is null, purchase figures still shown', byT('VOD').pctOfPortfolio === null && near(byT('VOD').purchaseValue, 700));
ok('all: unpriced counted', all.unpriced === 1);
ok('all: selection % sums to 100 over priced rows', near(all.selectionPct, 100));
ok('all: mixed currencies -> no purchase-value total', all.totalPurchaseValue === null);
ok('name: saved name used, ticker as fallback', byT('NPN').name === 'Naspers' && byT('AAPL').name === 'AAPL');

// ── Display currency doesn't change the weights ──
const zar = buildHoldingsTable(positions, prices, { rates: RATES, displayCurrency: 'ZAR', marketOrder: ORDER });
ok('ZAR display: same weights', near(zar.rows.find(r => r.ticker === 'NPN').pctOfPortfolio, 50));
ok('ZAR display: portfolio value converted', near(zar.portfolioValue, 4000 * 18.5));

// ── Subset: % stays of the WHOLE portfolio ──
const sa = buildHoldingsTable(positions, prices, { rates: RATES, displayCurrency: 'USD', marketOrder: ORDER, markets: ['JSE', 'TFSA'] });
ok('subset: only selected markets', sa.rows.map(r => r.ticker).join(',') === 'NPN,STX40');
ok('subset: % is of the whole portfolio, not the selection', near(sa.rows[0].pctOfPortfolio, 50) && near(sa.rows[1].pctOfPortfolio, 12.5));
ok('subset: selection % = 62.5', near(sa.selectionPct, 62.5));
ok('subset: single currency -> purchase-value total', near(sa.totalPurchaseValue, 37000));
ok('subset: markets listed', sa.markets.join(',') === 'JSE,TFSA');
ok('empty markets array means all', buildHoldingsTable(positions, prices, { rates: RATES, markets: [] }).rows.length === 5);

// ── Ordering within a market: biggest weight first ──
const two = buildHoldingsTable([
  { id: 1, ticker: 'SMALL', market: 'US', shares: 1, costBasis: 1 },
  { id: 2, ticker: 'BIG', market: 'US', shares: 1, costBasis: 1 },
  { id: 3, ticker: 'NOPX', market: 'US', shares: 1, costBasis: 1 },
], { 'US:SMALL': { price: 10 }, 'US:BIG': { price: 90 } }, { rates: RATES, marketOrder: ORDER });
ok('within market: weight desc, unpriced last', two.rows.map(r => r.ticker).join(',') === 'BIG,SMALL,NOPX');

// ── FX not loaded: cross-currency rows can't be weighted ──
const nofx = buildHoldingsTable(positions, prices, { rates: null, displayCurrency: 'USD', marketOrder: ORDER });
ok('no FX: only display-ccy holdings weighted', near(nofx.rows.find(r => r.ticker === 'AAPL').pctOfPortfolio, 1000 / 1500 * 100)
  && nofx.rows.find(r => r.ticker === 'NPN').pctOfPortfolio === null);
ok('no FX: unpriced count includes unconvertible rows', nofx.unpriced === 3);

// ── Degenerate input never throws ──
let threw = false;
try {
  const e = buildHoldingsTable(null, null, null);
  ok('null input -> empty table', e.rows.length === 0 && e.portfolioValue === null && e.selectionPct === null);
  buildHoldingsTable([null, { ticker: 'X' }, { ticker: 'Y', market: 'US', shares: NaN, costBasis: null }], {}, {});
} catch (_e) { threw = true; }
ok('malformed positions do not throw', !threw);
ok('nameOf throwing falls back to ticker',
  buildHoldingsTable([{ ticker: 'Q', market: 'US', shares: 1, costBasis: 1 }], {}, { nameOf: () => { throw new Error('x'); } }).rows[0].name === 'Q');
ok('nameOf used when given',
  buildHoldingsTable([{ ticker: 'Q', market: 'US', shares: 1, costBasis: 1 }], {}, { nameOf: () => 'Quux Inc' }).rows[0].name === 'Quux Inc');

// ── Serialisation ──
const csv = holdingsTableText(sa, ',');
const lines = csv.trimEnd().split('\r\n');
ok('csv: header line', lines[0] === 'Name,Ticker,Market,Currency,Purchase price,Holding (shares),Purchase value,% of portfolio');
ok('csv: data row has raw numbers', lines[1] === 'Naspers,NPN,JSE,ZAR,3000,10,30000,50');
ok('csv: total row', lines[3] === 'Total,,,ZAR,,,37000,62.5');
ok('csv: CRLF line endings', csv.endsWith('\r\n') && csv.indexOf('\n') === csv.indexOf('\r\n') + 1);
const tsv = holdingsTableText(sa, '\t');
ok('tsv: tab-delimited', tsv.split('\r\n')[1] === 'Naspers\tNPN\tJSE\tZAR\t3000\t10\t30000\t50');
const tricky = holdingsTableText({ rows: [{ name: 'Smith, "Jr" & Co', ticker: 'SJC', market: 'US', currency: 'USD', purchasePrice: 1.23456789, shares: 0.123456789, purchaseValue: 1 / 3, pctOfPortfolio: 2 / 3 }], currencies: ['USD'], totalPurchaseValue: 1 / 3, selectionPct: 2 / 3 }, ',');
ok('csv: comma/quote in name is quoted + escaped', tricky.split('\r\n')[1].startsWith('"Smith, ""Jr"" & Co",SJC'));
ok('csv: rounding (price 6dp, shares 8dp, value 2dp, % 2dp)', tricky.split('\r\n')[1].endsWith(',1.234568,0.12345679,0.33,0.67'));
const inj = holdingsTableText({ rows: [{ name: '=HYPERLINK("x")', ticker: '@SUM', market: 'US', currency: 'USD' }] }, ',');
ok('csv: formula injection neutralised', inj.split('\r\n')[1].startsWith('"\'=HYPERLINK(""x"")",\'@SUM,'));
ok('csv: null numbers are blank', inj.split('\r\n')[1].endsWith('USD,,,,'));
ok('empty table -> header only', holdingsTableText({ rows: [] }, ',') === HOLDINGS_TABLE_HEADERS.join(',') + '\r\n');

// ── Anti-drift: the view must use the core, not its own copy ──
const here = dirname(fileURLToPath(import.meta.url));
const modals = readFileSync(join(here, '../../pb-modals.js'), 'latin1');
ok('pb-modals delegates to PBCore.buildHoldingsTable', /PBCore\.buildHoldingsTable\(/.test(modals));
ok('pb-modals serialises via PBCore.holdingsTableText', /PBCore\.holdingsTableText\(/.test(modals));
ok('no local copy of the builder in pb-modals', !/function buildHoldingsTable/.test(modals));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
