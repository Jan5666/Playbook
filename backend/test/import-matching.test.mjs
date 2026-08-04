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
import PBCore from '../../pb-core.js';

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

// ── TFSA is the JSE: same venue, so a JSE listing matches a TFSA row ─────────
// The bug: Yahoo tags every SA listing 'JSE' (AIETF.JO), the matcher compared
// markets with `===`, so on a TFSA row every live result looked off-market and the
// row reported "no match" for a listing that resolves one chip over on JSE. Both
// markets build the identical .JO symbol and settle in ZAR — a TFSA is a tax
// wrapper around JSE instruments, not a separate exchange.
const { buildImportAttempts } = PBImport;
const saRemote = [{ ticker: 'AIETF', market: 'JSE', name: 'EasyETFs AI Innovation Actively Managed ETF', exchange: 'JSE' }];
const saName = 'Ivy EasyETFs AI Innovation Actively Managed ETF';
const rankedTfsa = rankImportCandidates(saName, null, 'TFSA', saRemote);
const rankedJse  = rankImportCandidates(saName, null, 'JSE',  saRemote);
ok('rank: JSE candidate earns the on-market bonus on a TFSA row',
   rankedTfsa[0].ticker === 'AIETF' && rankedTfsa[0].score === rankedJse[0].score);
// A same-name US listing must not outrank the SA one for a TFSA import.
const rankedMixed = rankImportCandidates('Satrix 40 ETF', null, 'TFSA',
  [{ ticker: 'STX40', market: 'JSE', name: 'Satrix 40 ETF' }, { ticker: 'SAT', market: 'US', name: 'Satrix 40 ETF' }]);
ok('rank: SA listing outranks a same-name US listing for TFSA', rankedMixed[0].market === 'JSE');

// The crux — before the fix this array was EMPTY, which is what produced "no match".
const attemptsTfsa = buildImportAttempts(rankedTfsa, { market: 'TFSA', marketExplicit: true, symHint: null });
ok('TFSA row has a listing to try (was 0 attempts = "no match")', attemptsTfsa.length >= 1);
ok('TFSA attempt is the JSE listing, re-tagged to TFSA',
   attemptsTfsa[0].ticker === 'AIETF' && attemptsTfsa[0].market === 'TFSA');
ok('TFSA attempt prices via the same Yahoo symbol as JSE',
   PBCore.yahooSymbol(attemptsTfsa[0].ticker, attemptsTfsa[0].market) === 'AIETF.JO');
// And a row that did NOT name its exchange must stay in the TFSA rather than being
// silently booked as a plain JSE position (the second-order bug).
const attemptsLoose = buildImportAttempts(rankedTfsa, { market: 'TFSA', marketExplicit: false, symHint: null });
ok('bare-name TFSA row books onto TFSA, not JSE', attemptsLoose[0].market === 'TFSA');
// Symmetry: a TFSA-tagged candidate (curated TFSA_SUGGESTIONS) suits a JSE row too.
const attemptsJseRow = buildImportAttempts(
  rankImportCandidates(saName, null, 'JSE', [{ ...saRemote[0], market: 'TFSA' }]),
  { market: 'JSE', marketExplicit: true, symHint: null });
ok('TFSA-tagged candidate is on-market for a JSE row, tagged JSE',
   attemptsJseRow.length === 1 && attemptsJseRow[0].market === 'JSE');
// Same listing reached from both sides collapses to ONE attempt, not two.
const attemptsDupe = buildImportAttempts(
  rankImportCandidates(saName, null, 'TFSA', [saRemote[0], { ...saRemote[0], market: 'TFSA' }]),
  { market: 'TFSA', marketExplicit: true, symHint: null });
ok('JSE + TFSA copies of one listing dedupe to a single attempt', attemptsDupe.length === 1);

// ── buildImportAttempts: the pre-existing ordering rules are unchanged ────────
// Characterization of behaviour that predates the TFSA fix — nothing outside the
// JSE/TFSA pair may shift.
const brkRanked = rankImportCandidates('Berkshire Hathaway', null, 'US', remote);
const brkAttempts = buildImportAttempts(brkRanked, { market: 'US', marketExplicit: false, symHint: null });
ok('US row: chosen-market listing is attempted first', brkAttempts[0].ticker === 'BRK-B' && brkAttempts[0].market === 'US');
ok('US row: EUR/GBP cross-listings never enter the fallback',
   !brkAttempts.some(c => c.market === 'FRA' || c.market === 'LSE'));
const symAttempts = buildImportAttempts(brkRanked, { market: 'US', marketExplicit: false, symHint: 'BRKB' });
ok('symbol hint is tried second, on the chosen market',
   symAttempts[1].ticker === 'BRKB' && symAttempts[1].market === 'US');
// Same-currency off-market fallback still applies (PAR ↔ FRA both settle EUR)…
const euRemote = [{ ticker: 'MC', market: 'PAR', name: 'LVMH' }, { ticker: 'AAPL', market: 'US', name: 'Apple' }];
const euRanked = rankImportCandidates('LVMH', null, 'FRA', euRemote);
ok('FRA row falls back to the EUR listing on another market',
   buildImportAttempts(euRanked, { market: 'FRA', marketExplicit: false, symHint: null })
     .some(c => c.market === 'PAR'));
// …unless the row named its own exchange, where a miss must stay a miss.
ok('marketExplicit blocks the off-market fallback entirely',
   buildImportAttempts(euRanked, { market: 'FRA', marketExplicit: true, symHint: null }).length === 0);
// A candidate still carrying an exchange suffix is never an on-market pick.
ok('suffixed ticker is not treated as on-market',
   buildImportAttempts([{ ticker: 'ASML.VI', market: 'US', name: 'ASML' }],
     { market: 'US', marketExplicit: true, symHint: null }).length === 0);
ok('buildImportAttempts tolerates an empty candidate list',
   buildImportAttempts([], { market: 'US', marketExplicit: false, symHint: null }).length === 0);

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

// ── parseDecimal: locale-aware number parsing (moved to pb-core) ─────────────
const { parseDecimal } = PBCore;
ok('parseDecimal US 1,234.56', parseDecimal('1,234.56') === 1234.56);
ok('parseDecimal EU 1.234,56', parseDecimal('1.234,56') === 1234.56);
ok('parseDecimal lone-comma decimal 12,50', parseDecimal('12,50') === 12.5);
ok('parseDecimal lone-comma thousands 1,500', parseDecimal('1,500') === 1500);
ok('parseDecimal strips rand + space "R8 100.69"', parseDecimal('R8 100.69') === 8100.69);
ok('parseDecimal strips £ + thousands', parseDecimal('£1,234.50') === 1234.5);
ok('parseDecimal empty → NaN', Number.isNaN(parseDecimal('')));
ok('parseDecimal null → NaN', Number.isNaN(parseDecimal(null)));

// ── parseImportDate: locale-tolerant date normalisation ──────────────────────
const { parseImportDate } = PBImport;
ok('parseImportDate ISO passthrough', parseImportDate('2024-10-01') === '2024-10-01');
ok('parseImportDate zero-pads ISO', parseImportDate('2024-3-5') === '2024-03-05');
ok('parseImportDate DD/MM (day>12)', parseImportDate('13/02/2024') === '2024-02-13');
ok('parseImportDate MM/DD flip (month>12)', parseImportDate('02/13/2024') === '2024-02-13');
ok('parseImportDate day-first default', parseImportDate('01/02/2024') === '2024-02-01');
ok('parseImportDate junk → empty', parseImportDate('not a date') === '');

// ── parseHoldingsFromText: generic-table mapper (header + headerless) ─────────
const { parseHoldingsFromText } = PBImport;
const one = (rows) => rows.length === 1 ? rows[0] : {};
const hHeader = one(parseHoldingsFromText('Ticker,Shares,Price\nAAPL,10,150'));
ok('header table resolves shares', hHeader.shares === 10);
ok('header table resolves cost from price', hHeader.costBasis === 150);
const hTotal = one(parseHoldingsFromText('Ticker,Shares,Book Cost\nAAPL,10,1500'));
ok('"Book Cost" claimed as total (not per-share) → cost = total / shares', hTotal.costBasis === 150);
const hHeadless = one(parseHoldingsFromText('AAPL\t10\t150'));
ok('headerless: shares from first numeric col', hHeadless.shares === 10);
ok('headerless: cost from second numeric col', hHeadless.costBasis === 150);
ok('headerless: query from the text column', hHeadless.query === 'AAPL');
const hMarkdown = one(parseHoldingsFromText('- **Broadcom** 5 900'));
ok('markdown list marker + emphasis stripped', hMarkdown.query === 'Broadcom');
ok('markdown row shares parsed', hMarkdown.shares === 5);
ok('markdown row cost parsed', hMarkdown.costBasis === 900);

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

// Increment 5: the import parsers live in pb-import.js / pb-core.js, not app.js.
ok('app.js no longer defines parseDecimal',              !/\bfunction parseDecimal\b/.test(_appSrc));
ok('app.js no longer defines rowsToHoldings',            !/\bfunction rowsToHoldings\b/.test(_appSrc));
ok('app.js no longer defines parseHoldingsFromText',     !/\bfunction parseHoldingsFromText\b/.test(_appSrc));
ok('app.js no longer defines parseEasyEquitiesScreenshot', !/\bfunction parseEasyEquitiesScreenshot\b/.test(_appSrc));
ok('app.js binds parseDecimal from PBCore',              /const parseDecimal = PBCore\.parseDecimal/.test(_appSrc));
ok('app.js binds rowsToHoldings from PBImport',          /const rowsToHoldings\s*=\s*PBImport\.rowsToHoldings/.test(_appSrc));

// TFSA listing fix: the market-equality rule is single-sourced in pb-core, and the
// import modal delegates its attempt ordering instead of re-filtering by hand — a
// re-inlined `c.market === market` filter is exactly how this bug got in.
const _modalSrc = _rf(_jn(_dn(_fu(import.meta.url)), '..', '..', 'pb-modals.js'), 'utf8');
ok('app.js binds sameUnderlyingExchange from PBCore',
   /const sameUnderlyingExchange = PBCore\.sameUnderlyingExchange/.test(_appSrc));
ok('app.js has no local sameUnderlyingExchange definition',
   !/function\s+sameUnderlyingExchange\s*\(/.test(_appSrc));
ok('pb-import binds sameUnderlyingExchange from PBCore',
   /\bsameUnderlyingExchange\b[^\n]*\}\s*=\s*PBCore/.test(_rf(_jn(_dn(_fu(import.meta.url)), '..', '..', 'pb-import.js'), 'utf8')));
ok('pb-modals delegates attempt ordering to PBImport.buildImportAttempts',
   /buildImportAttempts\(ranked,\s*\{/.test(_modalSrc));
ok('pb-modals no longer filters candidates by strict market equality',
   !/ranked\.filter\(c => c\.market [=!]== market/.test(_modalSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll import-matching tests passed');
process.exit(failures ? 1 : 0);
