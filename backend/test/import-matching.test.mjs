// Unit tests for the import symbol-matching logic, now in pb-import.js.
//   cd backend/test && node import-matching.test.mjs
//
// pb-import.js is a dual-mode CommonJS module; import its default export
// (= module.exports). The DATA-derived ticker universe is injected here with the
// same fixtures the old vm-sandbox stubbed, so the assertions below are unchanged
// and prove the extraction is behaviour-preserving. priceKey + MARKET_CURRENCY
// come from the real pb-core. This pins the behaviour that stops mainstream stocks
// (Google, ASML, Berkshire, GE Vernova, iShares ETFs) being booked onto obscure
// foreign listings at the wrong-currency "live rate".
import PBImport from '../../pb-import.js';

PBImport.configure({ allTickers: [
  { ticker: 'BRK-B', name: 'Berkshire Hathaway', market: 'US' },
  // Satrix family — same issuer, official names that don't resemble the user's
  // shorthand. Aliases (as built in app.js) are what stop them collapsing onto
  // the flagship Top-40 fund on import.
  { ticker: 'STX40',  name: 'Satrix 40 ETF', market: 'JSE', aliases: ['Satrix Top 40 ETF', 'Satrix Top40'] },
  { ticker: 'STXGOV', name: 'Satrix SA Bond ETF', market: 'JSE', aliases: ['Satrix Government Bond ETF', 'Satrix GOVI', 'Satrix Gov Bonds', 'GOVI'] },
  { ticker: 'STXILB', name: 'Satrix Inflation-Linked Bond ETF', market: 'JSE', aliases: ['Satrix ILBI', 'Satrix Inflation Linked Bond ETF', 'ILBI'] },
  { ticker: 'STXEMG', name: 'Satrix MSCI Emerging Markets ETF', market: 'JSE', aliases: ['Satrix Emerging Markets ETF', 'Satrix MSCI EM ETF'] },
  { ticker: 'EEM',    name: 'iShares MSCI Emerging Markets ETF', market: 'US', aliases: ['iShares Emerging Markets'] },
] });

const { parseYahooSymbol, rankImportCandidates, bestNameScore } = PBImport;

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

// ── splitLine: delimiter auto-detection ──────────────────────────────────────
const { splitLine, splitCsvLine, splitTickerMarket, inferMarket } = PBImport;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ok('splitLine tab-delimited', eq(splitLine('AAPL\t10\t150'), ['AAPL', '10', '150']));
ok('splitLine markdown row', eq(splitLine('| AAPL | 10 | 150 |'), ['AAPL', '10', '150']));
ok('splitLine semicolon beats comma', eq(splitLine('a;b,c;d'), ['a', 'b,c', 'd']));
ok('splitLine 2+ spaces (fixed width)', eq(splitLine('AAPL    10    150'), ['AAPL', '10', '150']));
ok('splitLine single-space WITH number → columns', eq(splitLine('AAPL 10 150'), ['AAPL', '10', '150']));
ok('splitLine words only stay one cell', eq(splitLine('Anglo American'), ['Anglo American']));

// ── splitCsvLine: quoted fields ──────────────────────────────────────────────
ok('splitCsvLine respects quoted delimiter', eq(splitCsvLine('"Berkshire, Inc.",BRK-B,10', ','), ['Berkshire, Inc.', 'BRK-B', '10']));
ok('splitCsvLine escaped double-quote', eq(splitCsvLine('"a""b",c', ','), ['a"b', 'c']));

// ── splitTickerMarket: suffix → market ───────────────────────────────────────
ok('splitTickerMarket AGL.JO → JSE', eq(splitTickerMarket('AGL.JO'), { ticker: 'AGL', market: 'JSE' }));
ok('splitTickerMarket BHP:AX → ASX', eq(splitTickerMarket('BHP:AX'), { ticker: 'BHP', market: 'ASX' }));
ok('splitTickerMarket SAP.DE → FRA', eq(splitTickerMarket('SAP.DE'), { ticker: 'SAP', market: 'FRA' }));
ok('splitTickerMarket bare AAPL → null market', splitTickerMarket('AAPL').market === null && splitTickerMarket('AAPL').ticker === 'AAPL');

// ── inferMarket: suffix > market-text > currency > US fallback ────────────────
ok('inferMarket suffix wins', inferMarket('USD', 'NASDAQ', 'JSE') === 'JSE');
ok('inferMarket market-text NASDAQ → US', inferMarket(null, 'NASDAQ', null) === 'US');
ok('inferMarket market-text Johannesburg → JSE', inferMarket(null, 'Johannesburg', null) === 'JSE');
ok('inferMarket currency ZAR → JSE', inferMarket('ZAR', null, null) === 'JSE');
ok('inferMarket currency GBX → LSE', inferMarket('GBX', null, null) === 'LSE');
ok('inferMarket unrecognised → US fallback', inferMarket('', 'Zorg', null) === 'US');

// ── Anti-drift: the pure import core lives in pb-import.js, not app.js ────────
import { readFileSync as _rf } from 'node:fs';
import { fileURLToPath as _fu } from 'node:url';
import { dirname as _dn, join as _jn } from 'node:path';
const _appSrc = _rf(_jn(_dn(_fu(import.meta.url)), '..', '..', 'app.js'), 'utf8');
ok('app.js no longer defines rankImportCandidates', !/\bfunction rankImportCandidates\b/.test(_appSrc));
ok('app.js no longer defines parseYahooSymbol',    !/\bfunction parseYahooSymbol\b/.test(_appSrc));
ok('app.js no longer defines splitLine',           !/\bfunction splitLine\b/.test(_appSrc));
ok('app.js no longer defines inferMarket',         !/\bfunction inferMarket\b/.test(_appSrc));
ok('app.js binds rankImportCandidates from PBImport', /const rankImportCandidates = PBImport\.rankImportCandidates/.test(_appSrc));
ok('app.js injects the ticker universe',           /PBImport\.configure\(\{ allTickers: ALL_TICKERS \}\)/.test(_appSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll import-matching tests passed');
process.exit(failures ? 1 : 0);
