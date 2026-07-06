// Standalone unit test for the Easy Equities screenshot parser. It imports the
// *actual* parsers from pb-import.js (dual-mode CommonJS; default export =
// module.exports) so it can't drift from the shipped code, and runs them against
// realistic, noisy OCR text for the four sample holding screenshots. parseDecimal
// (used internally by the parsers) comes from the real pb-core via pb-import.
// Run: node backend/test/ee-ocr-parse.test.mjs
import PBImport from '../../pb-import.js';

const parse = PBImport.parseEasyEquitiesScreenshot;
const dedupe = PBImport.dedupeEeHoldings;

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

// ── Emailed broker note (trade confirmation) ─────────────────────────────────
// Realistic full-page OCR of an Easy Equities ZAR trade confirmation: the logo
// text, the split "SHARES | FSRs" cell, the brokerage's own name/address, and
// the costs table. The parser must read the company name, derive shares from
// trade value ÷ trade price, take the trade price (excl. fees) as cost basis,
// the submission date, and resolve the market to JSE off the ZAR account.
const EMAIL_AFRIMAT = `AFRIMAT
LIMITED
Afrimat Limited
TRADED 1:
SHARES FSRs TRADE PRICE:
34 .5052 R 28.8000
Jan Stander
Account: EasyEquities ZAR
Acc. number: EE683862-2544267
Trader: System
First World Trader t/a EasyEquities
WeWork - Coworking Space, 173 Oxford Road,
Rosebank, Johannesburg, South Africa, 2196
Reg No. 1999/021265/07
VAT No. 445 0255 759
INVOICE NUMBER: #102962720
SUBMISSION DATE: 2026-06-22 12:11:41
SETTLEMENT DATE: 2026-07-02
DETAIL ZAR
BROKER COMMISSION 2.48
SETTLEMENT AND ADMINISTRATION 0.79
INVESTOR PROTECTION LEVY AND ADMINISTRATION (IPL) 0.01
SECURITIES TRANSFER TAX AND ADMINISTRATION 2.48
VALUE-ADDED TAX ON COSTS (VAT) 0.49
EASYMONEY CREDIT ( How do I earn credit?) (EM 0.00)
TOTAL TRANSACTION COST 6.25
TRADE VALUE 993.75
TOTAL COST 1,000.00`;
const EMAIL_JUBILEE = `Jubilee
Metals Group
Jubilee Metals Group PLC
TRADED 1:
SHARES FSRs TRADE PRICE:
1684 .3220 R 0.5900
Account: EasyEquities ZAR
INVOICE NUMBER: #102962794
SUBMISSION DATE: 2026-06-22 12:13:21
SETTLEMENT DATE: 2026-07-02
DETAIL ZAR
BROKER COMMISSION 2.48
SECURITIES TRANSFER TAX AND ADMINISTRATION 2.48
TOTAL TRANSACTION COST 6.25
TRADE VALUE 993.75
TOTAL COST 1,000.00`;
const EMAIL_HOSKEN = `HCI
Hosken Consolidated Investments Limited
TRADED 1:
SHARES FSRs TRADE PRICE:
0 .2105 R 170.5000
Account: EasyEquities ZAR
INVOICE NUMBER: #102962764
SUBMISSION DATE: 2026-06-22 12:12:39
SETTLEMENT DATE: 2026-07-02
DETAIL ZAR
BROKER COMMISSION 0.09
SECURITIES TRANSFER TAX AND ADMINISTRATION 0.09
TOTAL TRANSACTION COST 0.24
TRADE VALUE 35.89
TOTAL COST 36.13`;

console.log('\nEmail broker note (Afrimat)');
const ea = parse(EMAIL_AFRIMAT, 'JSE')[0] || {};
check('one holding parsed', !!ea.query, `got ${JSON.stringify(ea)}`);
check('name = Afrimat Limited', ea.query === 'Afrimat Limited', `got "${ea.query}"`);
check('shares = trade value ÷ price ≈ 34.5052', approx(ea.shares, 34.5052, 0.01), `got ${ea.shares}`);
check('cost = trade price 28.80 (excl. fees)', approx(ea.costBasis, 28.80, 0.005), `got ${ea.costBasis}`);
check('market resolves to JSE (ZAR account)', ea.marketHint === 'JSE', `got ${ea.marketHint}`);
check('purchase date = submission date', ea.purchaseDate === '2026-06-22', `got ${ea.purchaseDate}`);
check('no ticker hint (resolved by name)', ea.tickerHint == null, `got ${ea.tickerHint}`);
check('name carries no amount', !moneyInName(ea.query), `got "${ea.query}"`);

console.log('\nEmail broker note (Jubilee / Hosken names)');
const ej = parse(EMAIL_JUBILEE, 'JSE')[0] || {};
check('Jubilee name', ej.query === 'Jubilee Metals Group PLC', `got "${ej.query}"`);
check('Jubilee cost = R0.59', approx(ej.costBasis, 0.59, 0.005), `got ${ej.costBasis}`);
check('Jubilee shares ≈ 1684.322', approx(ej.shares, 1684.322, 0.5), `got ${ej.shares}`);
const eh = parse(EMAIL_HOSKEN, 'JSE')[0] || {};
check('Hosken name', eh.query === 'Hosken Consolidated Investments Limited', `got "${eh.query}"`);
check('Hosken cost = R170.50', approx(eh.costBasis, 170.50, 0.005), `got ${eh.costBasis}`);

// If OCR mangles the "SUBMISSION DATE" label, the trade date must still be read
// from that line — never fall through to the (10-days-later) SETTLEMENT DATE.
const mangledDate = parse(EMAIL_AFRIMAT.replace('SUBMISSION DATE:', 'SUBMISSON OATE'), 'JSE')[0] || {};
check('mangled label → trade date, not settlement', mangledDate.purchaseDate === '2026-06-22', `got ${mangledDate.purchaseDate}`);

// ── Transaction-history rows (price quoted in cents on the JSE) ───────────────
// The COMMENT wraps over several OCR lines; cost basis comes from the cash debit
// and the "@" price, with the cents convention ("@ 2,880.00" = R28.80) detected
// automatically by which reading reproduces the debit.
const HIST_AFRIMAT = `DATE 2026-06-22
COMMENT Bought Afrimat
Limited 34.5052 @
2,880.00
DEBIT/CREDIT -R993.75`;
const HIST_JUBILEE = `DATE 2026-06-22
COMMENT Bought Jubilee Metals
Group PLC 1,684.3220
@ 59.00
DEBIT/CREDIT -R993.75`;
const HIST_HOSKEN = `DATE 2026-06-22
COMMENT Bought Hosken
Consolidated
Investments Limited
0.2105 @ 17,050.00
DEBIT/CREDIT -R35.89`;

console.log('\nTransaction-history row (cents price)');
const ha = parse(HIST_AFRIMAT, 'JSE')[0] || {};
check('name = Afrimat Limited', ha.query === 'Afrimat Limited', `got "${ha.query}"`);
check('shares = 34.5052', approx(ha.shares, 34.5052), `got ${ha.shares}`);
check('@2,880.00 cents → R28.80', approx(ha.costBasis, 28.80, 0.01), `got ${ha.costBasis}`);
check('purchase date = 2026-06-22', ha.purchaseDate === '2026-06-22', `got ${ha.purchaseDate}`);
const hh = parse(HIST_HOSKEN, 'JSE')[0] || {};
check('Hosken name (wrapped comment)', hh.query === 'Hosken Consolidated Investments Limited', `got "${hh.query}"`);
check('Hosken shares = 0.2105', approx(hh.shares, 0.2105), `got ${hh.shares}`);
check('@17,050.00 cents → R170.50', approx(hh.costBasis, 170.50, 0.05), `got ${hh.costBasis}`);

// A US-dollar history row must NOT have its price divided by 100 — the cents
// convention is JSE-only, and the debit cross-check keeps dollars as dollars.
const usHist = parse(`DATE 2026-06-20
COMMENT Bought Apple Inc 2.0000 @ 150.00
DEBIT/CREDIT -$300.00`, 'US')[0] || {};
check('US row keeps $150 (no cents ÷100)', approx(usHist.costBasis, 150, 0.01), `got ${usHist.costBasis}`);
check('US row market = US', usHist.marketHint === 'US', `got ${usHist.marketHint}`);

// ── De-dup: the same trade arriving as both a note and a history row ──────────
// The user dropped 6 screenshots for 3 trades; they must collapse to 3 holdings,
// and the share counts must NOT double (the commit path sums shares per ticker).
console.log('\nDe-dup (note + history of the same trade)');
const allSix = [
  ...parse(EMAIL_AFRIMAT, 'JSE'), ...parse(EMAIL_JUBILEE, 'JSE'), ...parse(EMAIL_HOSKEN, 'JSE'),
  ...parse(HIST_AFRIMAT, 'JSE'), ...parse(HIST_JUBILEE, 'JSE'), ...parse(HIST_HOSKEN, 'JSE'),
];
check('6 rows parsed before de-dup', allSix.length === 6, `got ${allSix.length}`);
const merged = dedupe(allSix);
check('6 screenshots → 3 holdings', merged.length === 3, `got ${merged.length}`);
const mAfr = merged.find(h => /afrimat/i.test(h.query)) || {};
check('Afrimat shares NOT doubled', approx(mAfr.shares, 34.5052, 0.01), `got ${mAfr.shares}`);
check('Afrimat cost intact', approx(mAfr.costBasis, 28.80, 0.01), `got ${mAfr.costBasis}`);
check('every merged holding has shares + cost', merged.every(h => h.shares > 0 && h.costBasis > 0), JSON.stringify(merged.map(h => [h.query, h.shares, h.costBasis])));
// De-dup must not collapse two genuinely different buys of the same stock.
const twoBuys = dedupe([...parse(HIST_AFRIMAT, 'JSE'), ...parse(`DATE 2026-06-25
COMMENT Bought Afrimat Limited 10.0000 @ 2,900.00
DEBIT/CREDIT -R290.00`, 'JSE')]);
check('distinct same-stock buys kept separate', twoBuys.length === 2, `got ${twoBuys.length}`);

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
