// Unit tests for tradedToday/quoteTradedToday in pb-core.js — the "only markets
// that traded today count toward Today's move" kernel (spec 2026-07-01 §1).
//   cd backend/test && node traded-today.test.mjs
//
// Behaviour change (2026-08-04): quoteTradedToday now ALSO requires the market's
// regular session to have opened today, via regularSessionStartedToday. Trusting
// quote.regularMarketTime alone let a single US pre-market print unlock the gate
// hours before the open, which is how yesterday's US session was landing in the
// SA morning's "Today" figure. The rationale and the full market/time matrix
// live in today-gate.test.mjs; this file keeps the device-local day kernel.
import PBCore from '../../pb-core.js';

let failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };
const { tradedToday, quoteTradedToday } = PBCore;

ok('exports tradedToday', typeof tradedToday === 'function');
ok('exports quoteTradedToday', typeof quoteTradedToday === 'function');

// All in device-local time: "now" = 2026-07-01 10:00 local.
const now = new Date(2026, 6, 1, 10, 0).getTime();
ok('tick earlier today counts',        tradedToday(new Date(2026, 6, 1, 9, 0).getTime(), now) === true);
ok('tick later today counts',          tradedToday(new Date(2026, 6, 1, 22, 30).getTime(), now) === true);
ok('tick yesterday 23:59 rejected',    tradedToday(new Date(2026, 6, 0, 23, 59).getTime(), now) === false);
ok('tick tomorrow 00:01 rejected',     tradedToday(new Date(2026, 6, 2, 0, 1).getTime(), now) === false);
ok('just after local midnight, yesterday-evening tick rejected',
   tradedToday(new Date(2026, 6, 0, 22, 0).getTime(), new Date(2026, 6, 1, 0, 30).getTime()) === false);
ok('missing tick rejected',            tradedToday(null, now) === false);
ok('NaN tick rejected',                tradedToday(NaN, now) === false);

// quoteTradedToday: prefers the quote's regularMarketTime; falls back to the
// market session clock only when the tick is missing.
// Instants here are explicit UTC, not device-local: quoteTradedToday now also
// requires the market's REGULAR session to have opened (see header note), so a
// device-local 10:00 is 06:00 ET in UTC and 04:00 ET in SAST - both pre-market,
// and the answer would flip with the runner's zone. 2026-07-01 is a Wednesday;
// 14:00 UTC = 10:00 EDT, mid-session.
const usOpenNow = Date.UTC(2026, 6, 1, 14, 30);
ok('quote with today tick counts',
   quoteTradedToday({ regularMarketTime: Date.UTC(2026, 6, 1, 14, 0) }, 'US', usOpenNow) === true);
// The gate the fix added: a pre-market print carries today's date but the
// regular session has not run, so the quote's "day move" is still yesterday's.
ok('pre-market tick rejected before the regular open',
   quoteTradedToday({ regularMarketTime: Date.UTC(2026, 6, 1, 8, 10) }, 'US', Date.UTC(2026, 6, 1, 8, 13)) === false);
ok('quote with yesterday tick rejected even if session open',
   quoteTradedToday({ regularMarketTime: new Date(2026, 6, 0, 16, 0).getTime() }, 'US', now) === false);
ok('null quote rejected', quoteTradedToday(null, 'US', now) === false);
// Fallback: no tick → market session must be 'open'. 2026-07-01 is a Wednesday.
// 14:00 UTC = 10:00 EDT (US open); 07:00 UTC = 03:00 EDT (US closed).
ok('no tick + US session open counts',
   quoteTradedToday({ price: 1 }, 'US', Date.UTC(2026, 6, 1, 14, 0)) === true);
ok('no tick + US closed rejected',
   quoteTradedToday({ price: 1 }, 'US', Date.UTC(2026, 6, 1, 7, 0)) === false);
// CRYPTO is always open → no-tick crypto quotes always count.
ok('no tick + CRYPTO counts (always open)',
   quoteTradedToday({ price: 1 }, 'CRYPTO', Date.UTC(2026, 6, 4, 3, 0)) === true);

// ── sessionDay: a quote that knows its own session must be from TODAY's ──────
// The no-tick fallback above is the hole this closes. Stooq's end-of-day CSV
// carries no regularMarketTime, so a row for YESTERDAY used to fall straight
// through to "US session is open → true" and be counted as today's move.
// sessionDay absent still passes, so every case above is unaffected.
const usOpen = Date.UTC(2026, 6, 1, 14, 0);           // Wed 2026-07-01, 10:00 EDT
ok('no tick + sessionDay is today counts',
   quoteTradedToday({ price: 1, sessionDay: '2026-07-01' }, 'US', usOpen) === true);
ok('no tick + sessionDay is yesterday rejected (the stooq EOD trap)',
   quoteTradedToday({ price: 1, sessionDay: '2026-06-30' }, 'US', usOpen) === false);
ok('sessionDay is market-local: a JSE quote is judged in Johannesburg',
   quoteTradedToday({ price: 1, sessionDay: '2026-07-01' }, 'JSE', Date.UTC(2026, 6, 1, 9, 0)) === true);
ok('a fresh tick cannot rescue a quote anchored to another session',
   quoteTradedToday({ regularMarketTime: usOpen, sessionDay: '2026-06-30' }, 'US', usOpen) === false);
ok('sessionDay null still passes (unknown = do not block)',
   quoteTradedToday({ price: 1, sessionDay: null }, 'US', usOpen) === true);

// ── quoteSessionState: the kernel the ROWS were missing ─────────────────────
// The two "Today" aggregates always gated on quoteTradedToday + sessionDay. The
// holding row gated on nothing and captioned itself from the wall clock, so a
// quote a session behind rendered its stale % as a bare live figure. These pin
// all four states against real SAST/JSE wall clocks, since that is where Jan
// sees it. SAST = UTC+2 year-round; the JSE regular session is 09:00–17:05.
const { quoteSessionState } = PBCore;
const sast = (d, hh, mm) => Date.UTC(2026, 7, d, hh - 2, mm);   // SAST wall clock → epoch
const wedQuote = { price: 1, sessionDay: '2026-08-05' };        // from Wednesday's session
const tueQuote = { price: 1, sessionDay: '2026-08-04' };        // a session behind

ok('exports quoteSessionState', typeof quoteSessionState === 'function');
ok('no quote → none', quoteSessionState(null, 'JSE', sast(5, 9, 30)) === 'none');

// Pre-open: EVERY quote is the last completed session's, fresh ones included.
// This must stay 'atClose', not 'stale' — nothing is wrong, it just needs saying.
ok('07:53 SAST, pre-open, Tue quote → atClose',
   quoteSessionState(tueQuote, 'JSE', sast(5, 7, 53)) === 'atClose');

// Market open + quote from today's session = the only genuinely live case.
ok('09:30 SAST, open, Wed quote → live',
   quoteSessionState(wedQuote, 'JSE', sast(5, 9, 30)) === 'live');

// THE BUG: market open, quote a session behind. Used to render +2.94% bare.
ok('09:30 SAST, open, Tue quote → stale',
   quoteSessionState(tueQuote, 'JSE', sast(5, 9, 30)) === 'stale');

// After the close, today's quote is today's completed session.
ok('18:00 SAST, closed, Wed quote → atClose',
   quoteSessionState(wedQuote, 'JSE', sast(5, 18, 0)) === 'atClose');

// After the close, a quote that MISSED the whole session is still stale — the
// JSE plainly traded today, so "At close" would name the wrong close.
ok('18:00 SAST, closed, Tue quote → stale (session ran, quote missed it)',
   quoteSessionState(tueQuote, 'JSE', sast(5, 18, 0)) === 'stale');

// Weekend: no session has run, so the last completed one is all there is.
ok('Saturday, Fri quote → atClose',
   quoteSessionState({ price: 1, sessionDay: '2026-08-07' }, 'JSE', sast(8, 11, 0)) === 'atClose');

// US seen from SA: 11:00 SAST is 05:00 EDT — pre-market, session not yet started.
ok('11:00 SAST (US pre-market) → atClose, not live',
   quoteSessionState({ price: 1, sessionDay: '2026-08-04' }, 'US', sast(5, 11, 0)) === 'atClose');
ok('16:00 SAST (US open) + today US quote → live',
   quoteSessionState({ price: 1, sessionDay: '2026-08-05' }, 'US', sast(5, 16, 0)) === 'live');
ok('16:00 SAST (US open) + yesterday US quote → stale',
   quoteSessionState({ price: 1, sessionDay: '2026-08-04' }, 'US', sast(5, 16, 0)) === 'stale');

// Crypto never closes, so it has no "at close" to report.
ok('CRYPTO is always live', quoteSessionState({ price: 1 }, 'CRYPTO', sast(5, 3, 0)) === 'live');

// sessionDay null (old cached quote, unit trust) keeps the pre-existing semantics:
// it falls through to quoteTradedToday's tick/clock rules rather than being blocked.
ok('sessionDay null + open market + tick today → live',
   quoteSessionState({ price: 1, regularMarketTime: sast(5, 9, 25) }, 'JSE', sast(5, 9, 30)) === 'live');
ok('sessionDay null + open market + yesterday tick → stale',
   quoteSessionState({ price: 1, regularMarketTime: sast(4, 16, 0) }, 'JSE', sast(5, 9, 30)) === 'stale');

// ── Consistency with the aggregate gate (anti-drift) ────────────────────────
// The rows use quoteSessionState; the two "Today" sums use quoteTradedToday.
// They must not disagree about which quotes are stale, or a number can be in the
// totals but hidden on its own row (or worse, the reverse). Checked over the
// cross-product of a realistically-shaped quote (both signals present, as every
// live Yahoo quote has) and the SAST clock through a whole trading day.
let drift = 0;
for (const d of [4, 5]) {
  for (const hh of [6, 8, 9, 11, 14, 17, 18, 22]) {
    for (const sd of ['2026-08-04', '2026-08-05']) {
      const now = sast(5, hh, 0);
      const q = { price: 1, sessionDay: sd, regularMarketTime: Date.UTC(2026, 7, d, 12, 0) };
      const state = quoteSessionState(q, 'JSE', now);
      const counted = quoteTradedToday(q, 'JSE', now);
      // A quote the aggregates count must never render as 'stale' on its row,
      // and a 'live' row must always be one the aggregates counted.
      if ((counted && state === 'stale') || (state === 'live' && !counted)) drift++;
    }
  }
}
ok('quoteSessionState never contradicts the aggregate gate', drift === 0, `${drift} disagreement(s)`);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll traded-today tests passed');
process.exit(failures ? 1 : 0);
