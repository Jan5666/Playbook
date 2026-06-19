// Standalone unit test for the Easy Equities screenshot parser. It pulls the
// *actual* parser source out of app.js (so it can't drift from the shipped
// code) and runs it against realistic, noisy OCR text for the four sample
// holding screenshots. Run: node backend/test/ee-ocr-parse.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');

function slice(from, to) {
  const a = appSrc.indexOf(from);
  const b = appSrc.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`anchor not found: ${from} .. ${to}`);
  return appSrc.slice(a, b);
}

const parseDecimalSrc = slice('function parseDecimal(raw) {', 'const MAX_TRIGGER_HISTORY');
const eeSrc = slice('const TESSERACT_CDN =', '// ── Deposit / withdrawal');

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(parseDecimalSrc + '\n' + eeSrc + '\nthis.parse = parseEasyEquitiesScreenshot;', ctx);
const parse = ctx.parse;

let failures = 0;
function approx(a, b, tol = 0.001) { return a != null && Math.abs(a - b) <= tol; }
function check(label, cond, detail) {
  if (cond) { console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

// ── Sample OCR text (line-based, with the kind of noise Tesseract emits:
//    status bar, brand text in the logo card, the back chevron, etc.) ──────────
const SHOTS = [
  {
    name: '1NVEST MSCI EM Asia',
    text: `11:13
Biz News
74
< 1NVEST MSCI EM Asia Index STANLIB Feeder ETF
ETF
1invest
MSCI
EM Asia
Index Feeder
ETFEMA
PROFIT/LOSS
EXCHANGE
R1 807.30
JSE
28.72%
OPEN
Sell
Buy More
My Holding
Current Value R8 100.69
Purchase Value R6 293.39
Avg. Purchase Price R39.93
Previous Close Price R50.52
# Shares 157
# FSRs 0.6010
Your Dividend Rewards are set to: Re-
Invest the income.
Tap here to change
Pricing
Last Updated Price: 15-min. Delayed`,
    expect: { ticker: 'ETFEMA', shares: 157.601, cost: 39.93, nameHas: /msci em asia/i },
  },
  {
    name: 'Ivy EasyETFs AI Innovation',
    text: `11:13
74
Ivy EasyETFs AI Innovation Actively Managed ETF
AMETF
IVY
ASSET MANAGEMENT
Ivy EasyETFs AI Innovation
Actively Managed ETF
IVYAI
PROFIT/LOSS
EXCHANGE
R68.97
JSE
1.97%
OPEN
Sell
Buy More
My Holding
Current Value R3 436.62
Purchase Value R3 505.59
Avg. Purchase Price R13.20
Previous Close Price R13.01
# Shares 265
# FSRs 0.5810
Pricing
Last Updated Price: 15-min. Delayed`,
    expect: { ticker: 'IVYAI', shares: 265.581, cost: 13.20, nameHas: /ai innovation/i },
    defaultMarket: 'JSE', market: 'JSE',
  },
  {
    name: 'Satrix 40',
    text: `11:13
73
Satrix 40 ETF
ETF
SATRIX
OWN THE MARKET
Top40
STX40
PROFIT/LOSS
EXCHANGE
R82.13
JSE
1.65%
OPEN
Sell
Buy More
My Holding
Current Value R4 909.49
Purchase Value R4 991.62
Avg. Purchase Price R110.01
Previous Close Price R108.90
# Shares 45
# FSRs 0.3741
Pricing
Last Updated Price: 15-min. Delayed`,
    expect: { ticker: 'STX40', shares: 45.3741, cost: 110.01, nameHas: /satrix 40/i },
    market: 'JSE',   // no defaultMarket passed — exchange detected from the screenshot
  },
  {
    name: 'Satrix GOVI',
    text: `11:13
73
Satrix GOVI ETF
ETF
SATRIX
OWN THE MARKET
GOVI
STXGVI
PROFIT/LOSS
EXCHANGE
R125.00
JSE
1.49%
OPEN
Sell
Buy More
My Holding
Current Value R8 281.87
Purchase Value R8 406.87
Avg. Purchase Price R90.33
Previous Close Price R86.70
# Shares 93
# FSRs 0.0651
Pricing
Last Updated Price: 15-min. Delayed`,
    expect: { ticker: 'STXGVI', shares: 93.0651, cost: 90.33, nameHas: /satrix govi/i },
    // Screenshot says JSE even though the user started on the US tab — the
    // screenshot's own exchange wins.
    defaultMarket: 'US', market: 'JSE',
  },
  {
    // US holding: $ values, NASDAQ exchange, short two-word name. Must resolve to
    // the US market and read fine even though it isn't a JSE share.
    name: 'Apple (US / NASDAQ)',
    text: `9:41
74
Apple Inc.
AAPL
PROFIT/LOSS
EXCHANGE
$120.50
NASDAQ
2.10%
OPEN
Sell
Buy More
My Holding
Current Value $3 450.00
Purchase Value $3 000.00
Avg. Purchase Price $150.00
Previous Close Price $172.30
# Shares 20
# FSRs 0.0000
Pricing
Last Updated Price: 15-min. Delayed`,
    expect: { ticker: 'AAPL', shares: 20, cost: 150, nameHas: /apple/i },
    defaultMarket: 'US', market: 'US',
  },
  {
    // OCR ran the P/L value and % into the title line — the parsed NAME must come
    // out clean (no "R125.00", no "1.49%"), and still resolve the holding.
    name: 'Amount-merged header',
    text: `11:13
73
Satrix GOVI ETF R125.00 1.49%
GOVI
STXGVI
PROFIT/LOSS
EXCHANGE
R125.00
JSE
OPEN
Sell
Buy More
My Holding
Purchase Value R8 406.87
Avg. Purchase Price R90.33
Previous Close Price R86.70
# Shares 93
# FSRs 0.0651
Pricing`,
    expect: { ticker: 'STXGVI', shares: 93.0651, cost: 90.33, nameHas: /satrix govi/i, nameExact: 'Satrix GOVI ETF' },
    defaultMarket: 'JSE', market: 'JSE',
  },
];

// The first shot exercises the TFSA context override: screenshot reads JSE, but
// the user started on the TFSA tab, so the holding should land in TFSA.
SHOTS[0].defaultMarket = 'TFSA';
SHOTS[0].market = 'TFSA';

const moneyInName = (s) => /[R$£€]\s?\d|\b\d+\.\d{2}\b|%/.test(s || '');

for (const shot of SHOTS) {
  console.log(`\n${shot.name}`);
  const out = parse(shot.text, shot.defaultMarket);
  check('one holding parsed', out.length === 1, `got ${out.length}`);
  const h = out[0] || {};
  check('ticker hint', h.tickerHint === shot.expect.ticker, `got ${h.tickerHint}`);
  check('shares = #Shares + #FSRs', approx(h.shares, shot.expect.shares), `got ${h.shares}`);
  check('cost = avg purchase price', approx(h.costBasis, shot.expect.cost, 0.005), `got ${h.costBasis}`);
  check(`market hint = ${shot.market}`, h.marketHint === shot.market, `got ${h.marketHint}`);
  check('name captured', shot.expect.nameHas.test(h.query || ''), `got "${h.query}"`);
  check('name has NO amount in it', !moneyInName(h.query), `got "${h.query}"`);
  if (shot.expect.nameExact) check('name is exactly the clean title', h.query === shot.expect.nameExact, `got "${h.query}"`);
}

// ── Title-bar OCR (headerText) supplies the full, clean name ─────────────────
console.log('\nTitle-bar name (headerText) preference');
// Full-page OCR only caught the short logo-card name; the dedicated title-bar
// read has the complete name and must win — this is the "missing name details" fix.
const partialText = `11:13
74
MSCI EM Asia Index Feeder
ETFEMA
PROFIT/LOSS
EXCHANGE
R1 807.30
JSE
28.72%
OPEN
My Holding
Avg. Purchase Price R39.93
# Shares 157
# FSRs 0.6010`;
const hdr = parse(partialText, 'JSE', { headerText: '< 1NVEST MSCI EM Asia Index STANLIB Feeder ETF' })[0];
check('uses full title-bar name', /STANLIB Feeder ETF/i.test(hdr.query || ''), `got "${hdr.query}"`);
check('title-bar name carries no amount', !moneyInName(hdr.query), `got "${hdr.query}"`);
check('still extracts shares/cost', approx(hdr.shares, 157.601) && approx(hdr.costBasis, 39.93, 0.005));
// Title bar where OCR also ran the back-chevron / a stray amount in must clean up.
const hdr2 = parse(partialText, 'JSE', { headerText: '<  Satrix GOVI ETF  R125.00' })[0];
check('header name cleaned of amount', hdr2.query === 'Satrix GOVI ETF', `got "${hdr2.query}"`);
// A blank/garbled header strip falls back to the full-page heuristic name.
const fb = parse(partialText, 'JSE', { headerText: '   ' })[0];
check('falls back when header empty', /msci em asia/i.test(fb.query || ''), `got "${fb.query}"`);
// Real-OCR artifact: the back-chevron reads as a lone digit before the name.
const cv1 = parse(partialText, 'JSE', { headerText: '4 INVEST MSCI EM Asia Index STANLIB Feeder ETF' })[0];
check('strips chevron-as-digit (4 INVEST…)', cv1.query === 'INVEST MSCI EM Asia Index STANLIB Feeder ETF', `got "${cv1.query}"`);
const cv2 = parse(partialText, 'JSE', { headerText: '4 1NVEST MSCI EM Asia Index STANLIB Feeder ETF' })[0];
check('keeps the real leading 1 (4 1NVEST…)', cv2.query === '1NVEST MSCI EM Asia Index STANLIB Feeder ETF', `got "${cv2.query}"`);
const cv3 = parse(partialText, 'JSE', { headerText: '£ Satrix 40 ETF' })[0];
check('keeps legit leading number (Satrix 40)', cv3.query === 'Satrix 40 ETF', `got "${cv3.query}"`);

// ── Portfolio-list screenshot: many name-only rows, no per-share cost ─────────
console.log('\nPortfolio list (best-effort)');
const list = parse(`11:13
74
My Investments
Satrix 40 ETF
R4 909.49
1nvest MSCI EM Asia Index STANLIB Feeder ETF
R8 100.69
Satrix GOVI ETF
R8 281.87
Total Value
R24 728.67`, 'JSE');
check('list yields ≥3 name rows', list.length >= 3, `got ${list.length}`);
check('list rows are name-only', list.every(h => h.shares == null && h.costBasis == null && h.marketHint === 'JSE'));
check('list excludes Total', !list.some(h => /total/i.test(h.query)));
check('list names carry no amounts', list.every(h => !moneyInName(h.query)), JSON.stringify(list.map(h => h.query)));

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
