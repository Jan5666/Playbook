// The daily move %, and its separation from extended hours.
//   node backend/test/day-move.test.mjs
//
// Jan reported Oracle's day move reading +11.x% in the app while Yahoo Finance
// showed +9.x% for the same session. Three defects stacked, and this file pins
// all three plus the session matrix around them.
//
// The root cause is one wrong assumption about the feed: Yahoo's chart
// `meta.regularMarketPrice` is the last TRADED price, not the last REGULAR price.
// During pre/post it is the extended-hours price. pb-core treated it as a
// regular-session price in two places:
//
//   1. parseYahooQuote fed it into `price`, so `price - prevClose` silently
//      became (regular move + after-hours move). ORCL: +11.18% vs Yahoo's +9.00%.
//   2. deriveIntradayExt measured the ext move AGAINST it — i.e. against the ext
//      price itself — collapsing every after-hours readout to ~0.00%. That is why
//      the Holdings pre-market toggle showed nothing useful.
//
// And separately, inherited from derivePrevClose:
//
//   3. Before a market's open Yahoo has no daily bar for today, so the previous
//      close came from TWO sessions back. Combined with a spliced pre-market
//      price that reported yesterday's whole move PLUS today's pre-market move.
//      (today-gate.test.mjs pins the same trap from the Dashboard's side; the row
//      chips never had the gate, which is why Jan saw it and the hero pill didn't.)
//
// The fix resolves WHICH regular session `price` belongs to first, then picks the
// previous close relative to that session — so the pair can never straddle two
// sessions — and derives both the regular price and the ext baseline from the
// BARS rather than from meta.
//
// Note the fix is behaviour-preserving whenever the feed does return a clean
// regular price: deriving from the bars then yields the identical number. The
// "unchanged" cases below are asserted for exactly that reason.
import PBCore from '../../pb-core.js';
import PBData from '../../pb-data.js';

const { parseYahooQuote, deriveDayMove, deriveIntradayExt, resolveTradingWindows,
        lastCloseInWindow, marketDayKey } = PBCore;

let failures = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra !== undefined ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;
const S = iso => Math.floor(Date.parse(iso) / 1000); // Yahoo timestamps are seconds
const pct = n => (typeof n === 'number' && isFinite(n)) ? n.toFixed(2) : String(n);

for (const [n, f] of [['deriveDayMove', deriveDayMove], ['resolveTradingWindows', resolveTradingWindows],
  ['lastCloseInWindow', lastCloseInWindow]]) ok(`PBCore exports ${n}`, typeof f === 'function');

// ─── The ORCL scenario ───────────────────────────────────────────────────────
// Real calendar: 2026-08-04 is a Tuesday, 2026-08-03 Monday, 2026-07-31 Friday.
// Yahoo stamps daily bars at the regular open, 09:30 ET = 13:30 UTC.
//   Fri 31 Jul close 196
//   Mon  3 Aug close 200   (+2.04% — the session BEFORE the one we care about)
//   Tue  4 Aug close 218   (+9.00% — the move Yahoo shows)
//   Tue  4 Aug after-hours 222.36  (+2.00% on top of the close)
// 218/200 = +9.00%; 222.36/200 = +11.18%; 222.36/196 = +13.45%.
const FRI = S('2026-07-31T13:30:00Z'), MON = S('2026-08-03T13:30:00Z'), TUE = S('2026-08-04T13:30:00Z');
const REG_TUE = { start: S('2026-08-04T13:30:00Z'), end: S('2026-08-04T20:00:00Z') };
const PRE_TUE = { start: S('2026-08-04T08:00:00Z'), end: REG_TUE.start };
const POST_TUE = { start: REG_TUE.end, end: S('2026-08-05T00:00:00Z') };

// A daily 5d chart. `metaPrice` is what Yahoo puts in meta.regularMarketPrice —
// the LAST TRADED price, which after the close is the after-hours price.
const dailyChart = (closes, tss, metaPrice, tickIso) => ({
  meta: {
    regularMarketPrice: metaPrice, currency: 'USD', shortName: 'Oracle',
    chartPreviousClose: closes.length > 1 ? closes[closes.length - 2] : closes[0],
    regularMarketTime: S(tickIso)
  },
  timestamp: tss,
  indicators: { quote: [{ close: closes }] }
});

// ── Defect 1: after-hours folded into the day move ───────────────────────────
{
  const res = dailyChart([196, 200, 218], [FRI, MON, TUE], 222.36, '2026-08-04T21:30:00Z');
  const q = parseYahooQuote(res, 'US', { now: Date.parse('2026-08-04T21:35:00Z') });
  ok('POST: day move is the REGULAR session only', pct(q.changePct) === '9.00', pct(q.changePct) + '% (was 11.18%)');
  ok('POST: price is the regular close, not the after-hours print', q.price === 218, q.price);
  ok('POST: prevClose is the prior session close', q.prevClose === 200, q.prevClose);
  ok('POST: sessionDay is the session that produced the price', q.sessionDay === '2026-08-04', q.sessionDay);
}

// ── Defect 2: prevClose a session too far back, before the open ──────────────
// 04:13 ET Tuesday. No Tuesday bar yet; meta already carries a pre-market print.
{
  const res = dailyChart([196, 200], [FRI, MON], 222.36, '2026-08-04T08:10:00Z');
  const q = parseYahooQuote(res, 'US', { now: Date.parse('2026-08-04T08:13:00Z') });
  ok('PRE-OPEN: shows the last COMPLETED session move', pct(q.changePct) === '2.04', pct(q.changePct) + '% (was 13.45%)');
  ok('PRE-OPEN: price is Monday\'s close, not the pre-market print', q.price === 200, q.price);
  ok('PRE-OPEN: prevClose is Friday, one session back — not two', q.prevClose === 196, q.prevClose);
  ok('PRE-OPEN: sessionDay is Monday, so the Today gates exclude it', q.sessionDay === '2026-08-03', q.sessionDay);
}

// ── Defect 3: the ext baseline was the ext price itself ──────────────────────
{
  const ts = [], closes = [];
  for (let t = REG_TUE.start; t < REG_TUE.end; t += 3600) { ts.push(t); closes.push(218); }
  ts.push(S('2026-08-04T20:30:00Z')); closes.push(220);
  ts.push(S('2026-08-04T21:30:00Z')); closes.push(222.36);
  const intra = {
    meta: { regularMarketPrice: 222.36, currency: 'USD',
            currentTradingPeriod: { pre: PRE_TUE, regular: REG_TUE, post: POST_TUE } },
    timestamp: ts, indicators: { quote: [{ close: closes }] }
  };
  const e = deriveIntradayExt(intra, 'US', Date.parse('2026-08-04T21:35:00Z'));
  ok('POST ext: measured from the regular CLOSE', pct(e.extChangePct) === '2.00', pct(e.extChangePct) + '% (was 0.00%)');
  ok('POST ext: regPrice carries the regular close out', e.regPrice === 218, e.regPrice);
  ok('POST ext: extPrice is the last after-hours trade', near(e.extPrice, 222.36), e.extPrice);
  ok('POST ext: live session asserts POST', e.extKind === 'post' && e.extLive === true && e.marketState === 'POST');
}

// A PRE session is the case the chart alone cannot answer: today's regular window
// is still empty, so the baseline must be supplied by the caller (the daily
// quote's price = yesterday's close). Without it the baseline falls back to meta,
// which in pre-market is the pre-market price — the 0.00% collapse again.
{
  const ts = [], closes = [];
  for (let t = PRE_TUE.start; t < S('2026-08-04T12:00:00Z'); t += 1800) { ts.push(t); closes.push(204); }
  const intra = {
    meta: { regularMarketPrice: 204, currency: 'USD',
            currentTradingPeriod: { pre: PRE_TUE, regular: REG_TUE, post: POST_TUE } },
    timestamp: ts, indicators: { quote: [{ close: closes }] }
  };
  const now = Date.parse('2026-08-04T12:05:00Z');
  const withBase = deriveIntradayExt(intra, 'US', now, { regularClose: 200 });
  ok('PRE ext: measured from YESTERDAY\'s close via opts.regularClose',
    pct(withBase.extChangePct) === '2.00', pct(withBase.extChangePct) + '% (204 vs 200)');
  ok('PRE ext: kind is pre and live', withBase.extKind === 'pre' && withBase.extLive === true);
  const noBase = deriveIntradayExt(intra, 'US', now);
  ok('PRE ext: with no baseline supplied it self-cancels (why the caller passes one)',
    noBase === null || pct(noBase.extChangePct) === '0.00', noBase && pct(noBase.extChangePct));
}

// A pence listing: the supplied baseline is in display units and makes a divisor
// round-trip, so the flat/forward-filled test must not depend on exact equality.
{
  const ts = [], closes = [];
  for (let t = PRE_TUE.start; t < S('2026-08-04T12:00:00Z'); t += 1800) { ts.push(t); closes.push(50000); }
  const intra = {
    meta: { regularMarketPrice: 50000, currency: 'GBp',
            currentTradingPeriod: { pre: PRE_TUE, regular: REG_TUE, post: POST_TUE } },
    timestamp: ts, indicators: { quote: [{ close: closes }] }
  };
  const e = deriveIntradayExt(intra, 'LSE', Date.parse('2026-08-04T12:05:00Z'), { regularClose: 500 });
  ok('LSE pence: forward-filled flat still suppressed across the divisor round-trip', e === null, e && pct(e.extChangePct));
}

// ── Defect 4: the daily series lagging its own tape ──────────────────────────
// Jan, 07:53 SAST on Wed 2026-08-05 (JSE opens 09:00): the SA and TFSA books
// showed a market value and a total growth that did not include TUESDAY's rise,
// while every row chip read "+x.xx% At close".
//
// Both figures are shares x quote.price, so a stale value means a stale QUOTE —
// chip included. The cause: `price = lastBar.p` outside the regular session
// assumed the newest daily bar is always the last completed close. Yahoo's daily
// series can lag its own tape — the bar for a finished session arrives late, or
// arrives with a null close, which buildDailyBars drops — and then `lastBar` is a
// session too far back. deriveDayMove's else branch anchored prevClose one further
// back again, so price AND chip slid together and the quote stayed internally
// consistent: nothing on screen could reveal it.
//
// Before the open, the "no daily bar yet" branch cannot fire: it is gated on
// regularSessionStartedToday, false until the bell. regularTickAfterBars is the
// branch that catches a FINISHED session the series has not printed.
//
// JSE prices arrive in cents (ZAc), so these fixtures also exercise the divisor.
// Yahoo stamps .JO daily bars at the 09:00 SAST open = 07:00 UTC.
const J_FRI = S('2026-07-31T07:00:00Z'), J_MON = S('2026-08-03T07:00:00Z'), J_TUE = S('2026-08-04T07:00:00Z');
const JSE_PRE_OPEN = Date.parse('2026-08-05T05:53:00Z');   // 07:53 SAST Wednesday
const TICK_TUE_CLOSE = S('2026-08-04T15:00:00Z');          // 17:00 SAST Tuesday
const jseChart = (closes, tss, metaPrice, tickSec) => ({
  meta: {
    regularMarketPrice: metaPrice, currency: 'ZAc', shortName: 'Naspers',
    regularMarketPreviousClose: closes.filter(c => c != null).slice(-2)[0],
    chartPreviousClose: closes.filter(c => c != null).slice(-2)[0],
    regularMarketTime: tickSec, marketState: 'PREPRE'
  },
  timestamp: tss, indicators: { quote: [{ close: closes }] }
});
// Mon closed at R48.00, Tue at R49.4112 (+2.94%), Fri at R47.00.
const C_FRI = 470000, C_MON = 480000, C_TUE = 494112;
{
  const healthy = parseYahooQuote(jseChart([C_FRI, C_MON, C_TUE], [J_FRI, J_MON, J_TUE], C_TUE, TICK_TUE_CLOSE),
    'JSE', { now: JSE_PRE_OPEN });
  ok('JSE pre-open, series healthy: Tuesday\'s close', healthy.price === 4941.12, healthy.price);
  ok('JSE pre-open, series healthy: +2.94%', pct(healthy.changePct) === '2.94', pct(healthy.changePct));

  // The bug: Tuesday's bar simply absent from the 5d series.
  const missing = parseYahooQuote(jseChart([C_FRI, C_MON], [J_FRI, J_MON], C_TUE, TICK_TUE_CLOSE),
    'JSE', { now: JSE_PRE_OPEN });
  ok('LAGGING SERIES: price is Tuesday\'s close, not Monday\'s (was 4800)',
    missing.price === 4941.12, missing.price);
  ok('LAGGING SERIES: prevClose is Monday, one session back (was Friday)',
    missing.prevClose === 4800, missing.prevClose);
  ok('LAGGING SERIES: chip is Tuesday\'s move (was 2.13%)',
    pct(missing.changePct) === '2.94', pct(missing.changePct));
  ok('LAGGING SERIES: sessionDay is Tuesday (was 2026-08-03)',
    missing.sessionDay === '2026-08-04', missing.sessionDay);

  // Same defect, the other shape: Yahoo returns the bar but has not finalised it,
  // so buildDailyBars drops the null close and the series is short by one again.
  const nulled = parseYahooQuote(jseChart([C_FRI, C_MON, null], [J_FRI, J_MON, J_TUE], C_TUE, TICK_TUE_CLOSE),
    'JSE', { now: JSE_PRE_OPEN });
  ok('LAGGING SERIES (null close): identical to the healthy series',
    nulled.price === healthy.price && nulled.prevClose === healthy.prevClose
    && nulled.sessionDay === healthy.sessionDay, `${nulled.price}/${nulled.prevClose}`);

  // A cents/rand divisor glitch must not ride in on the new path: meta 100x off
  // vs the bars means the bar (same units as prevClose) still wins.
  const glitched = parseYahooQuote(jseChart([C_FRI, C_MON], [J_FRI, J_MON], C_TUE * 100, TICK_TUE_CLOSE),
    'JSE', { now: JSE_PRE_OPEN });
  ok('LAGGING SERIES: implausible meta price rejected, bar kept',
    glitched.price === 4800, glitched.price);

  // No tick timestamp → no evidence the series lags → unchanged behaviour.
  const noTick = jseChart([C_FRI, C_MON], [J_FRI, J_MON], C_TUE, TICK_TUE_CLOSE);
  delete noTick.meta.regularMarketTime;
  ok('no regularMarketTime: falls back to the bar, unchanged',
    parseYahooQuote(noTick, 'JSE', { now: JSE_PRE_OPEN }).price === 4800);
}

// regularTickAfterBars directly — the guard's whole truth table. The regular-HOURS
// condition is what keeps the ORCL fix intact: a US pre/post print also lands on a
// day the daily series has no bar for, and must never be believed as a close.
{
  const bar = t => ({ t: t * 1000, p: 1 });
  const jseBars = [bar(J_MON)], usBars = [bar(MON), bar(TUE)];
  ok('exports regularTickAfterBars', typeof PBCore.regularTickAfterBars === 'function');
  ok('rTAB: JSE close print on a day the series lacks → that day',
    PBCore.regularTickAfterBars(jseBars, Date.parse('2026-08-04T15:00:00Z'), 'JSE') === '2026-08-04');
  ok('rTAB: series level with the tape → null',
    PBCore.regularTickAfterBars([bar(J_MON), bar(J_TUE)], Date.parse('2026-08-04T15:00:00Z'), 'JSE') === null);
  ok('rTAB: US PRE-market print on a later day → null (the ORCL trap)',
    PBCore.regularTickAfterBars(usBars, Date.parse('2026-08-05T10:00:00Z'), 'US') === null);
  ok('rTAB: US POST print on a later day → null',
    PBCore.regularTickAfterBars([bar(FRI), bar(MON)], Date.parse('2026-08-04T22:00:00Z'), 'US') === null);
  ok('rTAB: US regular-hours print with no bar yet → today (agrees with the open branch)',
    PBCore.regularTickAfterBars(usBars, Date.parse('2026-08-05T13:45:00Z'), 'US') === '2026-08-05');
  ok('rTAB: tick older than the last bar → null',
    PBCore.regularTickAfterBars([bar(J_MON), bar(J_TUE)], Date.parse('2026-08-03T15:00:00Z'), 'JSE') === null);
  ok('rTAB: no tick → null', PBCore.regularTickAfterBars(jseBars, null, 'JSE') === null);
  ok('rTAB: empty bars → null', PBCore.regularTickAfterBars([], Date.parse('2026-08-04T15:00:00Z'), 'JSE') === null);
  ok('rTAB: untimestamped bar → null',
    PBCore.regularTickAfterBars([{ t: null, p: 1 }], Date.parse('2026-08-04T15:00:00Z'), 'JSE') === null);
}

// ─── Session matrix — price and prevClose always bracket ONE session ──────────
const matrix = [
  ['REGULAR HOURS (live)', [196, 200, 218], [FRI, MON, TUE], 218, '2026-08-04T15:00:00Z', '2026-08-04T15:00:00Z', 218, 200, '9.00'],
  ['JUST AFTER OPEN (no daily bar yet)', [196, 200], [FRI, MON], 218, '2026-08-04T13:35:00Z', '2026-08-04T13:35:00Z', 218, 200, '9.00'],
  ['OVERNIGHT (closed, post over)', [196, 200, 218], [FRI, MON, TUE], 222.36, '2026-08-04T21:30:00Z', '2026-08-05T06:00:00Z', 218, 200, '9.00'],
  ['WEEKEND (Saturday)', [196, 200, 218], [FRI, MON, TUE], 222.36, '2026-08-04T21:30:00Z', '2026-08-08T12:00:00Z', 218, 200, '9.00'],
  ['HOLIDAY (clock says open, nothing traded)', [196, 200], [FRI, MON], 200, '2026-08-03T20:00:00Z', '2026-08-04T15:00:00Z', 200, 196, '2.04']
];
for (const [label, closes, tss, metaPrice, tickIso, nowIso, wantPrice, wantPrev, wantPct] of matrix) {
  const q = parseYahooQuote(dailyChart(closes, tss, metaPrice, tickIso), 'US', { now: Date.parse(nowIso) });
  ok(`${label}: ${wantPct}%`,
    q.price === wantPrice && q.prevClose === wantPrev && pct(q.changePct) === wantPct,
    `price=${q.price} prev=${q.prevClose} pct=${pct(q.changePct)}`);
}

// CRYPTO trades 24/7, so meta's price is always the "regular" price and the
// session rule must never rewrite it to a bar close.
{
  const res = dailyChart([60000, 62000], [MON, TUE], 63000, '2026-08-04T21:30:00Z');
  res.meta.currency = 'USD';
  const q = parseYahooQuote(res, 'CRYPTO', { now: Date.parse('2026-08-04T21:35:00Z') });
  ok('CRYPTO: keeps the live meta price (no session to be outside of)', q.price === 63000, q.price);
}

// ─── deriveDayMove directly: fallbacks and guards ────────────────────────────
{
  const bars = [{ t: FRI * 1000, p: 196 }, { t: MON * 1000, p: 200 }, { t: TUE * 1000, p: 218 }];
  const at = iso => ({ now: Date.parse(iso) });
  ok('deriveDayMove: empty bars → fallback untouched',
    deriveDayMove([], 218, 999, 'US', at('2026-08-04T21:00:00Z')).prevClose === 999);
  ok('deriveDayMove: livePrice <= 0 → fallback untouched',
    deriveDayMove(bars, 0, 999, 'US', at('2026-08-04T21:00:00Z')).prevClose === 999);
  // Unit mismatch (cents vs dollars): 200/0.5 = 400x → rejected, same guard as
  // derivePrevClose. Real moves, including flash crashes, still pass through.
  ok('deriveDayMove: unit-mismatch ratio guard rejects the candidate',
    deriveDayMove(bars, 0.5, 999, 'US', at('2026-08-04T21:00:00Z')).prevClose === 999);
  // An intraday chart's bars all share one day. The previous close must come from
  // the caller's fallback, never from the adjacent bar (= the previous MINUTE),
  // which would report a ~0.00% day move.
  const minutes = [];
  for (let t = REG_TUE.start; t < REG_TUE.start + 600; t += 60) minutes.push({ t: t * 1000, p: 217.9 });
  minutes.push({ t: (REG_TUE.start + 600) * 1000, p: 218 });
  const intraMove = deriveDayMove(minutes, 218, 200, 'US', at('2026-08-04T15:00:00Z'));
  ok('deriveDayMove: single-day (intraday) bars fall back, not to the previous minute',
    intraMove.prevClose === 200, intraMove.prevClose);
}

// ─── End-to-end through the real fetchQuote ──────────────────────────────────
// Both numbers Yahoo shows, separately, out of the actual provider path.
//
// fetchQuote reads the wall clock (no injectable `now`), so the fixtures here are
// built RELATIVE to it: the daily chart's last bar is dated today and the intraday
// chart's post window brackets this instant. That pins the same 9.00% / 2.00%
// split at any hour the suite happens to run, instead of only during the one
// session the literal 2026-08-04 timestamps above would land in.
{
  PBData.configure({ indicatorCatalog: {} });
  const nowSec = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const dTs = [nowSec - 4 * DAY, nowSec - 3 * DAY, nowSec];
  // marketState POST is what makes this deterministic at any wall-clock hour: it
  // is the same signal a half-day early close sends, and it is what tells
  // fetchQuote to go get the intraday chart regardless of the clock kernel.
  const daily = { chart: { result: [{
    meta: { regularMarketPrice: 222.36, currency: 'USD', shortName: 'Oracle',
            chartPreviousClose: 200, regularMarketTime: nowSec, marketState: 'POST' },
    timestamp: dTs, indicators: { quote: [{ close: [196, 200, 218] }] }
  }] } };
  // now sits inside `post`; the regular window just ended and holds the 218 close.
  const reg = { start: nowSec - 8 * 3600, end: nowSec - 3600 };
  const wins = { pre: { start: reg.start - 5 * 3600, end: reg.start }, regular: reg,
                 post: { start: reg.end, end: nowSec + 3600 } };
  const ts = [], closes = [];
  for (let t = reg.start; t < reg.end; t += 3600) { ts.push(t); closes.push(218); }
  ts.push(reg.end + 60); closes.push(220);
  ts.push(nowSec - 60); closes.push(222.36);
  const intra = { chart: { result: [{
    meta: { regularMarketPrice: 222.36, currency: 'USD', regularMarketTime: nowSec,
            currentTradingPeriod: wins },
    timestamp: ts, indicators: { quote: [{ close: closes }] }
  }] } };
  const seen = [];
  globalThis.fetch = async (u) => {
    const dec = decodeURIComponent(u);
    seen.push(dec);
    return { ok: true, text: async () => JSON.stringify(dec.includes('interval=1m') ? intra : daily) };
  };
  const q = await PBData.fetchQuote('ORCL', 'US');
  // The daily chart must NOT carry includePrePost: with it, the current day's
  // daily bar absorbs after-hours trades and the "regular close" is no longer one.
  const dailyReq = seen.find(u => u.includes('interval=1d'));
  ok('fetchQuote: daily chart requested WITHOUT includePrePost', !!dailyReq && !dailyReq.includes('includePrePost'), dailyReq);
  const intraReq = seen.find(u => u.includes('interval=1m'));
  ok('fetchQuote: intraday chart still requested WITH includePrePost',
    !intraReq || intraReq.includes('includePrePost=true'), intraReq);
  if (q) {
    ok('fetchQuote: day move = regular session', pct(q.changePct) === '9.00', pct(q.changePct) + '%');
    ok('fetchQuote: price is the regular close', q.price === 218, q.price);
    ok('fetchQuote: after-hours reported separately', pct(q.extChangePct) === '2.00', pct(q.extChangePct) + '%');
    ok('fetchQuote: extPrice is the after-hours print', near(q.extPrice, 222.36), q.extPrice);
    // 9.00 + 2.00 = 11.18% compounded — the number Jan saw. The whole point is
    // that it never appears as one figure again.
    ok('fetchQuote: the two are never combined into one chip',
      pct(q.changePct) === '9.00' && pct((q.price * (1 + q.extChangePct / 100) / q.prevClose - 1) * 100) === '11.18');
  } else {
    ok('fetchQuote returned a quote', false);
  }
}

// ─── fetchQuoteLight: the heatmap must not disagree with the holding row ─────
// Same price-selection rule, same lagging-series hole. Fixtures are built
// relative to the wall clock (fetchQuoteLight takes no injectable `now`), with
// the tick placed at 12:00 SAST so it lands inside the JSE regular window on a
// market-local day AFTER the newest bar.
{
  PBData.configure({ indicatorCatalog: {} });
  const DAY = 86400;
  const utcMid = (backDays, hh) => {
    const d = new Date(Date.now() - backDays * DAY * 1000);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, 0, 0) / 1000);
  };
  const bars = [utcMid(3, 7), utcMid(2, 7)];   // 09:00 SAST opens
  const tick = utcMid(1, 10);                  // 12:00 SAST, one market day later
  const payload = { chart: { result: [{
    // POSTPOST rather than CLOSED so `outsideRegular` is asserted by the FEED, not
    // by the wall clock: the only thing that can then switch it back off is the
    // lagging-series guard under test, at any hour the suite runs.
    meta: { regularMarketPrice: C_TUE, currency: 'ZAc', chartPreviousClose: C_MON,
            regularMarketTime: tick, marketState: 'POSTPOST' },
    timestamp: bars, indicators: { quote: [{ close: [C_FRI, C_MON] }] }
  }] } };
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify(payload) });
  const light = await PBData.fetchQuoteLight('NPN', 'JSE');
  ok('fetchQuoteLight: lagging series → meta close, not the stale bar (was 4800)',
    light && light.price === 4941.12, light && light.price);
  ok('fetchQuoteLight: and its % is that session\'s move',
    light && pct(light.changePct) === '2.94', light && pct(light.changePct));
}

// ─── The intraday splice must not drag the price back a session ──────────────
// The daily and 1m charts are separate requests and can land on different proxies
// with different cache ages. A 1m chart still serving the PREVIOUS session hands
// back an ext.regPrice from that session; splicing it would undo the fix above.
// Runs against whichever of US/ASX is currently outside its regular session, so
// the `phase` branch under test is reached at any hour.
{
  PBData.configure({ indicatorCatalog: {} });
  const MKT = ['US', 'ASX'].find(m => PBCore.marketSession(m).phase !== 'open') || 'US';
  const CCY = MKT === 'US' ? 'USD' : 'AUD';
  const nowSec = Math.floor(Date.now() / 1000), DAY = 86400, HOUR = 3600;
  // Daily chart: healthy, newest bar dated today, close 218.
  const daily = { chart: { result: [{
    meta: { regularMarketPrice: 218, currency: CCY, chartPreviousClose: 200,
            regularMarketTime: nowSec, marketState: 'POST' },
    timestamp: [nowSec - 2 * DAY, nowSec - DAY, nowSec],
    indicators: { quote: [{ close: [196, 200, 218] }] }
  }] } };
  // Intraday chart: a whole session behind — its regular window sits ~27h back,
  // and its post window is over, so deriveIntradayExt returns a FINAL reading
  // whose regPrice (190) belongs to that earlier session.
  const reg = { start: nowSec - 30 * HOUR, end: nowSec - 27 * HOUR };
  const wins = { pre: { start: reg.start - 5 * HOUR, end: reg.start }, regular: reg,
                 post: { start: reg.end, end: reg.end + HOUR } };
  const ts = [], closes = [];
  for (let t = reg.start; t < reg.end; t += HOUR) { ts.push(t); closes.push(190); }
  ts.push(reg.end + 60); closes.push(193);
  const intra = { chart: { result: [{
    meta: { regularMarketPrice: 193, currency: CCY, regularMarketTime: reg.end,
            currentTradingPeriod: wins },
    timestamp: ts, indicators: { quote: [{ close: closes }] }
  }] } };
  globalThis.fetch = async (u) => {
    const dec = decodeURIComponent(u);
    return { ok: true, text: async () => JSON.stringify(dec.includes('interval=1m') ? intra : daily) };
  };
  const q = await PBData.fetchQuote('TEST', MKT);
  ok(`splice guard (${MKT}): a session-behind intraday chart cannot override the daily close`,
    !!q && q.price === 218, q && q.price);
  ok(`splice guard (${MKT}): the day move stays the daily pair`,
    !!q && pct(q.changePct) === '9.00', q && pct(q.changePct));
}

// ─── Anti-drift source guards ────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
const coreSrc = readFileSync(new URL('../../pb-core.js', import.meta.url), 'utf8');
const dataSrc = readFileSync(new URL('../../pb-data.js', import.meta.url), 'utf8');
ok('pb-core defines deriveDayMove', /function\s+deriveDayMove\s*\(/.test(coreSrc));
ok('parseYahooQuote routes through deriveDayMove',
  /function\s+parseYahooQuote[\s\S]{0,5000}?deriveDayMove\(/.test(coreSrc));
ok('deriveIntradayExt no longer baselines on meta.regularMarketPrice',
  !/regularPrice\s*=\s*meta\.regularMarketPrice/.test(coreSrc));
ok('the daily quote URLs carry no includePrePost',
  !/interval=1d&range=5d&includePrePost/.test(dataSrc));
ok('the intraday quote URL still carries includePrePost',
  /interval=1m&range=1d&includePrePost=true/.test(dataSrc));
ok('the splice never writes meta price straight into `price`',
  !/price:\s*fresh\.price,/.test(dataSrc));
ok('pb-core defines regularTickAfterBars', /function\s+regularTickAfterBars\s*\(/.test(coreSrc));
ok('pb-core exports regularTickAfterBars', /\n\s*regularTickAfterBars,/.test(coreSrc));
ok('deriveDayMove consults regularTickAfterBars',
  /function\s+deriveDayMove[\s\S]{0,3000}?regularTickAfterBars\(/.test(coreSrc));
ok('parseYahooQuote consults regularTickAfterBars before taking the bar',
  /function\s+parseYahooQuote[\s\S]{0,5000}?regularTickAfterBars\([\s\S]{0,600}?price\s*=\s*lastBar\.p/.test(coreSrc));
// The regular-hours condition is the ORCL fix's load-bearing half: without it a
// pre/post print on a later day would be believed as a regular close again.
ok('regularTickAfterBars gates on the regular window, not just the day',
  /function\s+regularTickAfterBars[\s\S]{0,1200}?mins\s*>=\s*regOpen\s*&&\s*mins\s*<=\s*regClose/.test(coreSrc));
ok('fetchQuoteLight delegates to the same guard, no private copy',
  /outsideRegular[\s\S]{0,400}?regularTickAfterBars\(/.test(dataSrc));
ok('the intraday splice checks the ext reading is not a session behind',
  /extRegUsable[\s\S]{0,200}?extRegDay\s*>=\s*quote\.sessionDay/.test(dataSrc));
ok('parseStooqCsv reads its own session date, not just the closes',
  /function\s+parseStooqCsv[\s\S]{0,2500}?sessionDay:\s*dateCol/.test(dataSrc));
ok('quoteTradedToday rejects a quote anchored to another session',
  /function\s+quoteTradedToday[\s\S]{0,1500}?quote\.sessionDay\s*!==\s*marketDayKey\(nowMs, market\)/.test(coreSrc));

console.log(failures === 0 ? '\nAll day-move tests passed' : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
