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

console.log(failures ? `\n${failures} test(s) failed` : '\nAll traded-today tests passed');
process.exit(failures ? 1 : 0);
