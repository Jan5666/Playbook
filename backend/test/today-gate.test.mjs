// The "Today" gate — which markets may contribute to the Dashboard's day move.
//   cd backend/test && node today-gate.test.mjs
//
// Jan reported the hero pill reading "TODAY +R3,442.47 - +2.31%" at 10:06 SAST,
// which combined YESTERDAY's US session with today's JSE/LSE move. Two defects
// stacked to produce it, and this file pins both:
//
//   1. `derivePrevClose` documents its own assumption: "the last bar is the
//      current session". Before the US regular open Yahoo's 5d daily chart has
//      no bar for today, so the last bar is YESTERDAY's; the loop then skips
//      every bar sharing that day and returns the close from TWO sessions back.
//      `price` is meanwhile still yesterday's close, so `price - prevClose` is
//      yesterday's entire move. That is correct for a per-instrument "change
//      since its last close" reading (the stock card wants exactly that) and
//      wrong for a "today" aggregate — so the aggregate needs a gate.
//
//   2. `quoteTradedToday` was that gate, but it decided purely on
//      `quote.regularMarketTime` landing on the device-local day. A single
//      pre-market print stamps today's date and unlocks defect 1 — and the app
//      goes looking for exactly that print every SA morning, because at 10:06
//      SAST a US quote is ~12h old, so `looksStale` (pb-data.js) fires and
//      refetches `interval=1m&range=1d&includePrePost=true`, then splices
//      `regularMarketTime: fresh.regularMarketTime || quote.regularMarketTime`.
//
// The fix stops trusting `regularMarketTime` to answer "has this market opened"
// (pb-core already documents Yahoo's meta fields as unreliable) and derives it
// from SESSIONS instead, via `regularSessionStartedToday`. A market counts only
// from its REGULAR open — pre/after-hours never feed the pill — and keeps
// counting after its close until the viewer's own day rolls over.
//
// TZ: `tradedToday` compares DEVICE-local days by design (spec 2026-07-01 §1),
// so this file re-spawns itself under Jan's zone. Every instant below is an
// absolute UTC moment; the SAST/ET times in the comments are that same moment.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import PBCore from '../../pb-core.js';

const TZ = 'Africa/Johannesburg';
if (process.env.TZ !== TZ) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, TZ }, encoding: 'utf8', stdio: 'inherit'
  });
  process.exit(r.status ?? 1);
}

let failures = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const { quoteTradedToday, regularSessionStartedToday, derivePrevClose, marketDayKey } = PBCore;

// ─── Defect 1: prevClose is a session stale before the open ──────────────────
// Real calendar: 2026-08-04 is a Tuesday. Mon 3 Aug is the last completed US
// session; Sat 1 / Sun 2 are the weekend; Fri 31 Jul precedes it. Yahoo stamps
// daily bars at the session open, 09:30 ET = 13:30 UTC.
const bars = [
  { t: Date.parse('2026-07-29T13:30:00Z'), p: 200.00 },
  { t: Date.parse('2026-07-30T13:30:00Z'), p: 202.00 },
  { t: Date.parse('2026-07-31T13:30:00Z'), p: 205.00 }, // Friday close
  { t: Date.parse('2026-08-03T13:30:00Z'), p: 215.00 }  // Monday close  = +4.88% day
];
// Pre-open, meta.regularMarketPrice is still Monday's close.
const preOpenPrice = 215.00;

ok('last daily bar is yesterday, not today',
  marketDayKey(bars[bars.length - 1].t, 'US') === '2026-08-03');
ok('derivePrevClose reaches back TWO sessions before the open',
  derivePrevClose(bars, preOpenPrice, 999, 'US') === 205.00,
  'Friday 31 Jul close, not Monday 3 Aug');
ok('=> the raw day change IS yesterday\'s move',
  Math.abs((preOpenPrice - derivePrevClose(bars, preOpenPrice, 999, 'US')) - 10.00) < 1e-9,
  '215 - 205 = 10.00 = +4.88%, Monday\'s move');

// ─── Defect 2: the gate must not be unlocked by a pre-market print ───────────
// Tue 2026-08-04 08:13 UTC = 10:13 SAST = 04:13 ET. US pre-market; regular open
// is still five hours away. This is the exact moment from Jan's screenshot.
const preOpen = Date.parse('2026-08-04T08:13:00Z');
const tickMonClose = Date.parse('2026-08-03T20:00:00Z'); // Mon 16:00 ET regular close
const tickPreMkt   = Date.parse('2026-08-04T08:10:00Z'); // a pre-market print, today

ok('US: pre-market is NOT "opened today"',
  regularSessionStartedToday('US', preOpen) === false);
ok('US: yesterday-close tick rejected before the open',
  quoteTradedToday({ regularMarketTime: tickMonClose }, 'US', preOpen) === false);
ok('US: pre-market print does NOT unlock the gate (the reported bug)',
  quoteTradedToday({ regularMarketTime: tickPreMkt }, 'US', preOpen) === false);
ok('US: no-tick quote rejected before the open',
  quoteTradedToday({ price: 1 }, 'US', preOpen) === false);

// ─── US across the rest of Jan's day ─────────────────────────────────────────
const atOpen = Date.parse('2026-08-04T13:35:00Z');  // 15:35 SAST = 09:35 ET, regular
ok('US: counts once the regular session opens',
  regularSessionStartedToday('US', atOpen) === true);
ok('US: today-tick counts at the open',
  quoteTradedToday({ regularMarketTime: Date.parse('2026-08-04T13:34:00Z') }, 'US', atOpen) === true);

const afterClose = Date.parse('2026-08-04T20:30:00Z'); // 22:30 SAST = 16:30 ET, post
ok('US: still counts after its close, same viewer day',
  quoteTradedToday({ regularMarketTime: Date.parse('2026-08-04T20:00:00Z') }, 'US', afterClose) === true);

// 2026-08-04 23:00 UTC = 01:00 SAST on the 5th = 19:00 ET on the 4th. The US
// session is still live but it is a new day for Jan, so "Today" resets.
const pastMidnight = Date.parse('2026-08-04T23:00:00Z');
ok('US: drops out once the VIEWER\'s day rolls over',
  quoteTradedToday({ regularMarketTime: Date.parse('2026-08-04T20:00:00Z') }, 'US', pastMidnight) === false);

// ─── JSE: must keep counting after its own close ─────────────────────────────
// This is why the gate cannot be a marketSession() phase check: the JSE's phase
// is 'closed' from 17:05 SAST, but it plainly traded today.
const jseBefore = Date.parse('2026-08-04T06:00:00Z'); // 08:00 SAST, before 09:00
const jseDuring = Date.parse('2026-08-04T08:13:00Z'); // 10:13 SAST
const jseEvening = Date.parse('2026-08-04T16:00:00Z'); // 18:00 SAST, after 17:05
ok('JSE: not yet open at 08:00 SAST', regularSessionStartedToday('JSE', jseBefore) === false);
ok('JSE: open at 10:13 SAST',         regularSessionStartedToday('JSE', jseDuring) === true);
ok('JSE: STILL counts at 18:00 SAST, after its close',
  regularSessionStartedToday('JSE', jseEvening) === true);
ok('JSE: today tick counts in the evening',
  quoteTradedToday({ regularMarketTime: Date.parse('2026-08-04T15:05:00Z') }, 'JSE', jseEvening) === true);
ok('TFSA tracks JSE hours', regularSessionStartedToday('TFSA', jseDuring) === true);
ok('LSE: open at 10:13 SAST (09:13 London)', regularSessionStartedToday('LSE', jseDuring) === true);

// ─── Weekend + CRYPTO ────────────────────────────────────────────────────────
const saturday = Date.parse('2026-08-08T13:35:00Z'); // Sat 15:35 SAST
ok('US: weekend never counts',  regularSessionStartedToday('US', saturday) === false);
ok('JSE: weekend never counts', regularSessionStartedToday('JSE', saturday) === false);
ok('CRYPTO: always counts, weekend included',
  regularSessionStartedToday('CRYPTO', saturday) === true);
ok('CRYPTO: pre-market-hours instant still counts',
  quoteTradedToday({ regularMarketTime: preOpen }, 'CRYPTO', preOpen) === true);
ok('null quote still rejected', quoteTradedToday(null, 'US', atOpen) === false);

// ─── sessionDay: prevClose must be anchored to TODAY's session ───────────────
// Even after the open there is a window where Yahoo has not yet printed today's
// daily bar, so prevClose is still two sessions back and the holding would
// double-count yesterday. parseYahooQuote stamps the day its prevClose is
// anchored against so the aggregates can refuse it.
const todayKey = marketDayKey(atOpen, 'US');
ok('marketDayKey(now, US) is the NY trading day', todayKey === '2026-08-04');
const sameSession = (q, market, nowMs) =>
  q.sessionDay == null || q.sessionDay === marketDayKey(nowMs, market);
ok('sessionDay == today accepted',      sameSession({ sessionDay: '2026-08-04' }, 'US', atOpen) === true);
ok('sessionDay == yesterday refused',   sameSession({ sessionDay: '2026-08-03' }, 'US', atOpen) === false);
ok('sessionDay == null falls through (old cached quote)',
  sameSession({ sessionDay: null }, 'US', atOpen) === true);
ok('sessionDay absent falls through',   sameSession({}, 'US', atOpen) === true);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll today-gate tests passed');
process.exit(failures ? 1 : 0);
