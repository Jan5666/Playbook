// The DISPLAY side of the day move — the half that was never tested, and the
// half Jan was actually looking at.
//
// Every session-anchoring fix so far landed in the quote layer or the two "Today"
// aggregates, and they were right: a quote a session behind carries the correct
// sessionDay and is correctly dropped from the totals. But the holding row read
// q.changePct with no gate at all and captioned itself from the WALL CLOCK, so
// the same quote still printed yesterday's percentage as a bare live figure. Node
// suites never load the view code, so nothing could catch it.
//
// This runs the REAL HoldingRow and the REAL computeMarketSummary out of
// pb-views.js in a vm with a recording createElement — the same technique
// fundamentals-parse.test.mjs uses for FundamentalsBlock, and for the same reason
// (the browser smokes pull React from a CDN this container cannot reach).
//   cd backend/test && node day-display.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import PBCore from '../../pb-core.js';
import PBData from '../../pb-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const viewSrc = readFileSync(join(here, '..', '..', 'pb-views.js'), 'utf8');

let failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra != null ? ' — ' + extra : ''}`); if (!cond) failures++; };
const near = (a, b) => Math.abs(a - b) < 1e-6;

// SAST wall clock → epoch. Jan is in Johannesburg (UTC+2 year-round) and the JSE
// regular session is 09:00–17:05, so these are the clocks he actually reads.
const sast = (d, hh, mm = 0) => Date.UTC(2026, 7, d, hh - 2, mm);
const WED = '2026-08-05', TUE = '2026-08-04';

// ─── Harness ────────────────────────────────────────────────────────────────
const el = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(Infinity).filter(k => k != null && k !== false) });
// Flatten a recorded tree to the visible text, which is what "does the row show a
// number?" really means.
const text = (n) => {
  if (n == null || n === false) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  return (n.kids || []).map(text).join('');
};
const findByClass = (n, cls, out = []) => {
  if (!n || typeof n !== 'object') return out;
  const c = n.props && n.props.className;
  if (typeof c === 'string' && c.split(/\s+/).includes(cls)) out.push(n);
  (n.kids || []).forEach(k => findByClass(k, cls, out));
  return out;
};

// Slice a top-level declaration out of pb-views.js by source markers.
function slice(startMarker, endMarker) {
  const a = viewSrc.indexOf(startMarker);
  if (a < 0) return null;
  const b = viewSrc.indexOf(endMarker, a);
  return b < 0 ? null : viewSrc.slice(a, b + endMarker.length);
}

// ─── computeMarketSummary: the per-market "Today" denominator ───────────────
const SUMMARY = slice('  const computeMarketSummary = (rows, market) => {', '\n  };\n');
ok('pb-views still declares computeMarketSummary', !!SUMMARY);

// Only the market's own currency is in play here, so convertCcy is the identity
// for same-currency pairs — which is all these fixtures use.
// A vm context gets its OWN intrinsics, so the outer Date.now() patch does not
// reach computeMarketSummary's own `const nowMs = Date.now()`. Inject the clock.
function summaryCtx(prices, nowMs, isUnitTrustId = () => false) {
  const ctx = {
    Date: Object.assign(Object.create(Date), { now: () => nowMs }),
    prices,
    rates: { USD: 1, ZAR: 18 },
    marketCurrency: (m) => (PBCore.MARKET_CURRENCY[m] || PBCore.MARKET_CURRENCY.US).code,
    convertCcy: (v, from, to) => (from === to ? v : null),
    positionCostCcy: () => 'ZAR',
    priceKey: PBCore.priceKey,
    quoteTradedToday: PBCore.quoteTradedToday,
    marketDayKey: PBCore.marketDayKey,
    // Real shape, from pb-data: a Morningstar SecId (F + 9 alphanumerics).
    isUnitTrustId,
    console
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SUMMARY + '\nglobalThis.__CMS = computeMarketSummary;', ctx);
  return ctx.__CMS;
}

// Ten JSE holdings, one share each, all opening at R100. The market rises 1.24%
// to R101.24 — but only seven quotes have been refreshed into today's session;
// three are still carrying yesterday's (a sweep that missed them, a Stooq
// end-of-day row, a unit trust's T-1 NAV — the shapes really do occur).
const nowOpen = sast(5, 11);           // 11:00 SAST, JSE mid-session
const fresh = (n) => ({ price: 101.24, prevClose: 100, sessionDay: WED, regularMarketTime: sast(5, 10, 55) });
const behind = (n) => ({ price: 100, prevClose: 98.7, sessionDay: TUE, regularMarketTime: sast(4, 17, 0) });
const rows10 = Array.from({ length: 10 }, (_, i) => ({ id: 'p' + i, ticker: 'T' + i, shares: 1, costBasis: 90 }));
const prices10 = {};
rows10.forEach((p, i) => { prices10[PBCore.priceKey('JSE', p.ticker)] = i < 7 ? fresh(i) : behind(i); });

// Freeze the clock: computeMarketSummary calls Date.now() internally.
const realNow = Date.now;
Date.now = () => nowOpen;
const cms = summaryCtx(prices10, nowOpen);
const s = cms(rows10, 'JSE');
Date.now = realNow;

// THE FIX. The old denominator was `value` — every priced holding, including the
// three that contributed nothing to dayChange — so a market that moved 1.24%
// reported roughly 0.86%, and the figure crept upward as the rest of the sweep
// landed. It was never a number you could read twice and trust.
ok('per-market Today %: anchored to the holdings that contributed it',
  s.dayPct != null && near(Math.round(s.dayPct * 1e6) / 1e6, 1.24), s.dayPct);
ok('per-market Today amount: only the contributing holdings',
  near(Math.round(s.dayChange * 1e6) / 1e6, 8.68), s.dayChange);
// Non-vacuous: prove the old anchor really would have understated it.
const oldAnchor = s.dayChange / s.value * 100;
ok('per-market Today %: the old whole-market anchor understated it',
  oldAnchor < 0.9 && oldAnchor < s.dayPct, `old would read ${oldAnchor.toFixed(2)}%`);
ok('per-market coverage is reported so partial data is visible',
  s.dayCounted === 7 && s.dayPriced === 10, `${s.dayCounted} of ${s.dayPriced}`);
// Value and cost still span the WHOLE market — the fix is to the day figure only.
ok('per-market value still covers every priced holding', near(s.value, 7 * 101.24 + 3 * 100));

// With every quote current the coverage note disappears and the % is unchanged,
// so the common case reads exactly as before.
const pricesAll = {};
rows10.forEach(p => { pricesAll[PBCore.priceKey('JSE', p.ticker)] = fresh(); });
Date.now = () => nowOpen;
const sAll = summaryCtx(pricesAll, nowOpen)(rows10, 'JSE');
Date.now = realNow;
ok('full coverage: same %, nothing to flag',
  near(Math.round(sAll.dayPct * 1e6) / 1e6, 1.24) && sAll.dayCounted === sAll.dayPriced);

// Pre-open, no market has traded, so there is no Today figure at all.
Date.now = () => sast(5, 7, 53);
const sPre = summaryCtx(prices10, sast(5, 7, 53))(rows10, 'JSE');
Date.now = realNow;
ok('pre-open: no Today figure for a market that has not opened', sPre.dayPct === null && sPre.dayChange === null);

// ─── The denominator only counts holdings that COULD reach the numerator ────
// A unit trust strikes one NAV per day and Morningstar publishes it in arrears,
// so mid-session its sessionDay is necessarily an earlier one — it can never be
// counted, however well the sweep went. Counting it in the denominator pinned the
// coverage note permanently short ("17 of 18" every single day) and dressed a
// structural fact up as a failed sweep, which is the one thing the note is for.
const utId = 'F000002CRJ';                       // real Morningstar SecId shape
const isUT = PBData.isUnitTrustId;
ok('the fixture id really is a unit trust id', isUT(utId) && !isUT('NPN'));

const nineFresh = Array.from({ length: 9 }, (_, i) => ({ id: 'e' + i, ticker: 'E' + i, shares: 1, costBasis: 90 }));
const withUT = [...nineFresh, { id: 'ut', ticker: utId, shares: 1, costBasis: 90 }];
const pricesUT = {};
nineFresh.forEach(p => { pricesUT[PBCore.priceKey('JSE', p.ticker)] = fresh(); });
// A T-1 NAV, in the shape morningstarRowToQuote really builds: regularMarketTime
// IS the NAV date (never Date.now(), see data-providers.test.mjs) and sessionDay
// is that date on the Johannesburg calendar.
pricesUT[PBCore.priceKey('JSE', utId)] = { price: 250, prevClose: 248, sessionDay: TUE, regularMarketTime: sast(4, 17, 0) };

Date.now = () => nowOpen;
const sUT = summaryCtx(pricesUT, nowOpen, isUT)(withUT, 'JSE');
Date.now = realNow;
ok('unit trust: a T-1 NAV leaves the coverage denominator',
  sUT.dayCounted === 9 && sUT.dayPriced === 9, `${sUT.dayCounted} of ${sUT.dayPriced}`);
ok('unit trust: nothing to flag, so the note disappears', sUT.dayCounted === sUT.dayPriced);
ok('unit trust: its VALUE still counts toward the market', near(sUT.value, 9 * 101.24 + 250));
ok('unit trust: it contributes nothing to the Today figure',
  near(Math.round(sUT.dayPct * 1e6) / 1e6, 1.24), sUT.dayPct);

// ANTI-OVER-REACH. The exclusion is `isUnitTrustId`, NOT "any quote that failed
// the today gate" — a plain JSE share that has quietly stopped updating is
// exactly what the note exists to surface, and generalising the rule would
// silently swallow it. This is the case Jan was actually looking at.
const withDead = [...nineFresh, { id: 'dead', ticker: 'XYZ', shares: 1, costBasis: 90 }];
const pricesDead = { ...pricesUT };
delete pricesDead[PBCore.priceKey('JSE', utId)];
pricesDead[PBCore.priceKey('JSE', 'XYZ')] = { price: 250, prevClose: 248, sessionDay: TUE, regularMarketTime: sast(4, 17, 0) };
Date.now = () => nowOpen;
const sDead = summaryCtx(pricesDead, nowOpen, isUT)(withDead, 'JSE');
Date.now = realNow;
ok('a stalled ORDINARY holding stays in the denominator and is still flagged',
  sDead.dayCounted === 9 && sDead.dayPriced === 10, `${sDead.dayCounted} of ${sDead.dayPriced}`);

// In the evening a unit trust's NAV date CAN be today's JSE day, and then the
// move genuinely is today's — it must count on both sides, so counted <= priced
// never inverts. (The tick matters: quoteTradedToday's tail for a TICK-LESS quote
// is "is the market open right now?", which after the close would refuse today's
// own NAV. A real Morningstar quote carries the strike time, so it never gets there.)
const jseEvening = sast(5, 18);
const pricesUTToday = { ...pricesUT };
nineFresh.forEach(p => { pricesUTToday[PBCore.priceKey('JSE', p.ticker)] = fresh(); });
pricesUTToday[PBCore.priceKey('JSE', utId)] = { price: 250, prevClose: 248, sessionDay: WED, regularMarketTime: sast(5, 17, 0) };
Date.now = () => jseEvening;
const sUTToday = summaryCtx(pricesUTToday, jseEvening, isUT)(withUT, 'JSE');
Date.now = realNow;
ok('unit trust: a same-day NAV counts on BOTH sides (counted never exceeds priced)',
  sUTToday.dayCounted === 10 && sUTToday.dayPriced === 10,
  `${sUTToday.dayCounted} of ${sUTToday.dayPriced}`);

// ─── HoldingRow: the three session states ───────────────────────────────────
const ROW = slice('const HoldingRow = React.memo(function HoldingRow(_refHR) {', '\n});\n');
ok('pb-views still declares HoldingRow', !!ROW);

function renderRow({ quote, market = 'JSE', now, showExt = false }) {
  const ctx = {
    React: { createElement: el, Fragment: 'Fragment', memo: (f) => f },
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    window: { PBApp: {
      positionDisplayName: (p) => p.ticker,
      fmtCcy: (v) => 'R' + Number(v).toFixed(2),
      Icon: 'Icon'
    } },
    // Real kernels — the point is to exercise the shipped gate, not a copy of it.
    quoteSessionState: PBCore.quoteSessionState,
    marketSession: PBCore.marketSession,
    MARKET_CURRENCY: PBCore.MARKET_CURRENCY,
    isUnitTrustId: () => false,
    valuePositionInCostCcy: () => ({ ccy: 'ZAR', value: 101.24, cost: 90, gain: 11.24, gainPct: 12.49 }),
    fmtNum: (v) => Number(v).toFixed(2),
    fmtCcySigned: (v) => (v >= 0 ? '+' : '') + 'R' + Math.abs(Number(v)).toFixed(2),
    LogoMark: 'LogoMark',
    Icon: 'Icon',
    console
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(ROW + '\nglobalThis.__ROW = HoldingRow;', ctx);
  const realNow2 = Date.now;
  Date.now = () => now;
  try {
    return ctx.__ROW({
      position: { id: 'p1', ticker: 'NPN', shares: 1, costBasis: 90 },
      market, quote, rates: { USD: 1, ZAR: 18 }, showExt,
      onOpenDetail: () => {}
    });
  } finally { Date.now = realNow2; }
}

// The chip lives in the day column; "At close" is its caption.
const chipText = (tree) => {
  const chips = findByClass(tree, 'row-day');
  return chips.length ? chips.map(text).join(' ') : text(tree);
};

const wedQuote = { price: 101.24, prevClose: 100, changePct: 1.24, sessionDay: WED, regularMarketTime: sast(5, 10, 55) };
const tueQuote = { price: 100, prevClose: 97.14, changePct: 2.94, sessionDay: TUE, regularMarketTime: sast(4, 17, 0) };

// 1. LIVE — market open, quote from today's session: the bare percentage.
let out = chipText(renderRow({ quote: wedQuote, now: sast(5, 11) }));
ok('row LIVE: shows the percentage', /1\.24%/.test(out), JSON.stringify(out));
ok('row LIVE: no "At close" caption', !/At close/.test(out));

// 2. AT CLOSE — pre-open. Unchanged behaviour: yesterday's move IS the honest
// number before the bell (Yahoo shows the same), it just has to say so.
out = chipText(renderRow({ quote: tueQuote, now: sast(5, 7, 53) }));
ok('row AT CLOSE: still shows the percentage pre-open', /2\.94%/.test(out), JSON.stringify(out));
ok('row AT CLOSE: captioned "At close"', /At close/.test(out));

// 3. STALE — THE BUG. Market open, quote a session behind. This printed
// "+2.94%" bare, indistinguishable from a live figure, every SA morning, right
// after the chip said "Updated" — because the refresh dot tracks the SWEEP, not
// any individual quote's session. Jan chose to withhold it (2026-08-06).
out = chipText(renderRow({ quote: tueQuote, now: sast(5, 11) }));
ok('row STALE: yesterday\'s percentage is NOT shown', !/2\.94%/.test(out), JSON.stringify(out));
ok('row STALE: not captioned "At close" either (it is not this market\'s close)', !/At close/.test(out));
// …but withholding the number is not the same as rendering NOTHING. Outside
// pre-market mode the cell used to come back literally null, so the one holding
// the sweep could not anchor to today looked identical to a rendering fault —
// which is what "the prices won't load" was reporting, under a summary that said
// "17 of 18" and offered no way to ask which one. A dash is the honest minimum.
const dayCell = (tree) => findByClass(tree, 'holding-day-empty').map(text).join('');
ok('row STALE: the day cell renders a dash, not an empty cell',
  dayCell(renderRow({ quote: tueQuote, now: sast(5, 11) })) === '—');
ok('row NO QUOTE: the day cell renders a dash too',
  dayCell(renderRow({ quote: null, now: sast(5, 11) })) === '—');
ok('row LIVE: no dash when there IS a figure',
  dayCell(renderRow({ quote: wedQuote, now: sast(5, 11) })) === '');

// 4. After the close, today's own quote reads "At close" — the caption now comes
// from the quote's session rather than the clock, and lands on the same answer.
out = chipText(renderRow({ quote: wedQuote, now: sast(5, 18) }));
ok('row: after the close, today\'s quote is captioned', /1\.24%/.test(out) && /At close/.test(out));

// 5. A quote that MISSED a session that ran is stale even once the market shuts —
// "At close" would name the wrong close.
out = chipText(renderRow({ quote: tueQuote, now: sast(5, 18) }));
ok('row: a quote that missed today\'s whole session stays withheld', !/2\.94%/.test(out));

// 6. Crypto never closes, so it is never captioned and never withheld.
out = chipText(renderRow({ quote: { price: 1, prevClose: 1, changePct: 3.5 }, market: 'CRYPTO', now: sast(5, 3) }));
ok('row: crypto shows its move uncaptioned at any hour', /3\.50%/.test(out) && !/At close/.test(out));

// ─── Anti-drift source guards ───────────────────────────────────────────────
// pb-views.js carries 2 NUL bytes, so ripgrep classifies it as binary and SKIPS
// it silently — a grep for these symbols returns nothing at all with no warning.
// Reading the source as a string here is the only reliable way to assert this.
ok('pb-views binds quoteSessionState from PBCore',
  /const\s+quoteSessionState\s*=\s*PBCore\.quoteSessionState/.test(viewSrc));
ok('the holding row gates its day % on the quote\'s session',
  /daySession\s*!==\s*'stale'/.test(viewSrc));
ok('the "At close" caption is driven by the quote, not marketSession alone',
  /dayAtClose\s*=[^;]*daySession\s*===\s*'atClose'/.test(viewSrc)
  && !/dayAtClose\s*=[^;]*marketSession\(market\)\.phase/.test(viewSrc));
ok('the per-market Today % divides by the contributing base, not total value',
  /dayPct:\s*\(anyDay\s*&&\s*dayBase\s*>\s*0\)\s*\?\s*dayChange\s*\/\s*dayBase/.test(viewSrc)
  && !/dayPct:\s*\(anyDay\s*&&\s*value\s*>\s*0\)/.test(viewSrc));
ok('the watchlist card and portfolio heatmap use the same gate',
  (viewSrc.match(/quoteSessionState\(q,\s*\w+\.market\)\s*!==\s*'stale'/g) || []).length >= 2);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll day-display tests passed');
process.exit(failures ? 1 : 0);
