// Unit tests for the import symbol-matching logic in app.js.
//   cd test && node import-matching.test.mjs
//
// app.js is a browser global script (no module exports), so we slice out the
// pure import-matching helpers and evaluate just that block in a vm sandbox with
// small stubs for its few external references (priceKey, MARKET_CURRENCY,
// ALL_TICKERS). This pins the behaviour that stops mainstream stocks (Google,
// ASML, Berkshire, GE Vernova, iShares ETFs) being booked onto obscure foreign
// listings at the wrong-currency "live rate".
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'app.js'), 'utf8');

// Slice from YAHOO_EXCHANGE_MAP through the end of rankImportCandidates.
const start = src.indexOf('const YAHOO_EXCHANGE_MAP');
const endMarker = '}).sort((a, b) => b.score - a.score);';
const endIdx = src.indexOf(endMarker, start);
if (start < 0 || endIdx < 0) { console.error('FAIL: could not locate import-matching block in app.js'); process.exit(1); }
const block = src.slice(start, endIdx + endMarker.length) + '\n}\n';

// Sandbox stubs for the block's external references.
const sandbox = {
  priceKey: (market, ticker) => market + ':' + ticker,
  MARKET_CURRENCY: {
    US: { code: 'USD' }, JSE: { code: 'ZAR' }, TFSA: { code: 'ZAR' },
    LSE: { code: 'GBP' }, ASX: { code: 'AUD' }, FRA: { code: 'EUR' },
    PAR: { code: 'EUR' }, AMS: { code: 'EUR' },
  },
  ALL_TICKERS: [
    { ticker: 'BRK-B', name: 'Berkshire Hathaway', market: 'US' },
    // Satrix family — same issuer, official names that don't resemble the user's
    // shorthand. Aliases (as built in app.js) are what stop them collapsing onto
    // the flagship Top-40 fund on import.
    { ticker: 'STX40',  name: 'Satrix 40 ETF', market: 'JSE', aliases: ['Satrix Top 40 ETF', 'Satrix Top40'] },
    { ticker: 'STXGOV', name: 'Satrix SA Bond ETF', market: 'JSE', aliases: ['Satrix Government Bond ETF', 'Satrix GOVI', 'Satrix Gov Bonds', 'GOVI'] },
    { ticker: 'STXILB', name: 'Satrix Inflation-Linked Bond ETF', market: 'JSE', aliases: ['Satrix ILBI', 'Satrix Inflation Linked Bond ETF', 'ILBI'] },
    { ticker: 'STXEMG', name: 'Satrix MSCI Emerging Markets ETF', market: 'JSE', aliases: ['Satrix Emerging Markets ETF', 'Satrix MSCI EM ETF'] },
    { ticker: 'EEM',    name: 'iShares MSCI Emerging Markets ETF', market: 'US', aliases: ['iShares Emerging Markets'] },
  ],
  cacheName: () => {},
  fetchViaProxies: async () => null,
};
vm.createContext(sandbox);
vm.runInContext(block + '\nglobalThis.__x = { parseYahooSymbol, rankImportCandidates, companyNameScore, bestNameScore, looksLikeTickerToken };', sandbox);
const { parseYahooSymbol, rankImportCandidates, bestNameScore } = sandbox.__x;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const mkt = (sym) => { const p = parseYahooSymbol(sym); return p ? p.market : null; };

// ── parseYahooSymbol: supported markets resolve, unsupported foreign drop ─────
ok('AAPL (no suffix) → US', mkt('AAPL') === 'US');
ok('BRK-B (hyphen class) → US', mkt('BRK-B') === 'US' && parseYahooSymbol('BRK-B').ticker === 'BRK-B');
ok('ASML.AS → AMS', mkt('ASML.AS') === 'AMS' && parseYahooSymbol('ASML.AS').ticker === 'ASML');
ok('NPN.JO → JSE', mkt('NPN.JO') === 'JSE');
ok('HSBA.L → LSE', mkt('HSBA.L') === 'LSE');
ok('SAP.DE → FRA', mkt('SAP.DE') === 'FRA');
// The crux: unsupported foreign venues are DROPPED (null), not mislabelled US.
ok('ASML.VI (Vienna) → dropped', parseYahooSymbol('ASML.VI') === null);
ok('GOOGL.MX (Mexico) → dropped', parseYahooSymbol('GOOGL.MX') === null);
ok('BRKB.SG (Stuttgart) → dropped', parseYahooSymbol('BRKB.SG') === null);
ok('IVV.MI (Milan) → dropped', parseYahooSymbol('IVV.MI') === null);
ok('NESN.SW (Swiss) → dropped', parseYahooSymbol('NESN.SW') === null);

// ── rankImportCandidates: primary US listing beats same-name cross-listings ──
const remote = [
  { ticker: 'BRH',   market: 'FRA', name: 'Berkshire Hathaway', exchange: 'Frankfurt' },
  { ticker: '0HN0',  market: 'LSE', name: 'Berkshire Hathaway', exchange: 'London' },
  { ticker: 'BRK-B', market: 'US',  name: 'Berkshire Hathaway', exchange: 'NYSE' },
];
const rankedBrk = rankImportCandidates('Berkshire Hathaway', null, 'US', remote);
ok('Berkshire/US: primary US listing ranks first',
   rankedBrk[0].ticker === 'BRK-B' && rankedBrk[0].market === 'US');

// EUR import legitimately prefers its own-currency listing.
const rankedEu = rankImportCandidates('Berkshire Hathaway', null, 'FRA', remote);
ok('Berkshire/FRA: EUR listing ranks first', rankedEu[0].market === 'FRA');

// ── Alias-aware ETF matching: same-issuer funds resolve to their own listing ──
// The regression the user hit: distinct Satrix ETFs imported from a markdown list
// all landed on STX40 (Satrix Top 40), then merged into one summed position.
// Even when Yahoo only surfaces the flagship STX40, the curated alias signal must
// win so each fund books to its own ticker.
ok('bestNameScore: alias beats display name',
   bestNameScore('Satrix ILBI', 'Satrix Inflation-Linked Bond ETF', ['Satrix ILBI']) >
   bestNameScore('Satrix ILBI', 'Satrix 40 ETF', ['Satrix Top 40 ETF']));

const stxFlagshipOnly = [{ ticker: 'STX40', market: 'JSE', name: 'Satrix 40 ETF', exchange: 'JSE' }];
const govPick = rankImportCandidates('Satrix Gov Bonds', null, 'JSE', stxFlagshipOnly)[0];
ok('Satrix Gov Bonds → STXGOV (not STX40)', govPick.ticker === 'STXGOV' && govPick.market === 'JSE');

const ilbPick = rankImportCandidates('Satrix ILBI', null, 'JSE', stxFlagshipOnly)[0];
ok('Satrix ILBI → STXILB (not STX40)', ilbPick.ticker === 'STXILB' && ilbPick.market === 'JSE');

const emPick = rankImportCandidates('Satrix Emerging Markets', null, 'JSE', stxFlagshipOnly)[0];
ok('Satrix Emerging Markets → STXEMG', emPick.ticker === 'STXEMG');

const top40Pick = rankImportCandidates('Satrix Top 40', null, 'JSE', stxFlagshipOnly)[0];
ok('Satrix Top 40 still → STX40', top40Pick.ticker === 'STX40');

// iShares MSCI Emerging Markets resolves to the US EEM listing from the curated
// universe (there is no JSE iShares EM listing).
const eemPick = rankImportCandidates('iShares MSCI Emerging Markets ETF', null, 'US', [])[0];
ok('iShares MSCI Emerging Markets → EEM', eemPick && eemPick.ticker === 'EEM');

console.log(failures ? `\n${failures} test(s) failed` : '\nAll import-matching tests passed');
process.exit(failures ? 1 : 0);
