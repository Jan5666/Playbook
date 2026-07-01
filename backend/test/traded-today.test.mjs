// Unit tests for tradedToday/quoteTradedToday in pb-core.js — the "only markets
// that traded today count toward Today's move" kernel (spec 2026-07-01 §1).
//   cd backend/test && node traded-today.test.mjs
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
ok('quote with today tick counts',
   quoteTradedToday({ regularMarketTime: new Date(2026, 6, 1, 9, 30).getTime() }, 'US', now) === true);
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

console.log(failures ? `\n${failures} test(s) failed` : '\nAll traded-today tests passed');
process.exit(failures ? 1 : 0);
