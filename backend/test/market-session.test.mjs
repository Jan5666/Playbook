// Unit tests for the pure marketSession kernel in pb-core.js (refresh-confidence UX).
//   cd backend/test && node market-session.test.mjs
import PBCore from '../../pb-core.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js'), 'utf8');

let failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };
const { marketSession, marketOpen } = PBCore;
// 2026-06-30 is a Tuesday; late June ⇒ US is on EDT (UTC−4). JSE is UTC+2, no DST.
const US = (...utc) => marketSession('US', Date.UTC(...utc)).phase;
const JSE = (...utc) => marketSession('JSE', Date.UTC(...utc)).phase;

ok('exports marketSession', typeof marketSession === 'function');

// US weekday windows (EDT = UTC−4): pre 04:00–09:30, regular 09:30–16:00, post 16:00–20:00.
ok('US pre-market (08:00 EDT)',        US(2026, 5, 30, 12, 0)  === 'pre');
ok('US open at 09:30 boundary',        US(2026, 5, 30, 13, 30) === 'open');
ok('US regular hours (10:00 EDT)',     US(2026, 5, 30, 14, 0)  === 'open');
ok('US post at 16:00 boundary',        US(2026, 5, 30, 20, 0)  === 'post');
ok('US after-hours (19:00 EDT)',       US(2026, 5, 30, 23, 0)  === 'post');
ok('US closed pre-dawn (03:00 EDT)',   US(2026, 5, 30, 7, 0)   === 'closed');
ok('US closed after 20:00 (20:30 EDT)', US(2026, 6, 1, 0, 30)  === 'closed'); // 00:30 UTC Jul1 = 20:30 EDT Jun30

// Weekend → closed, with an "opens" label.
const wknd = marketSession('US', Date.UTC(2026, 5, 27, 14, 0)); // Sat 2026-06-27, 10:00 EDT
ok('US weekend closed', wknd.phase === 'closed');
ok('US closed shows regular-open label', /09:30/.test(wknd.nextOpen || ''), JSON.stringify(wknd.nextOpen));
ok('US open state has no nextOpen', marketSession('US', Date.UTC(2026, 5, 30, 14, 0)).nextOpen === null);

// JSE has no extended hours ⇒ only open/closed, never pre/post.
ok('JSE open (10:00 SAST)',  JSE(2026, 5, 30, 8, 0)  === 'open');
ok('JSE open at 09:30 (no pre tier)', JSE(2026, 5, 30, 7, 30) === 'open');
ok('JSE closed before open (08:00 SAST)', JSE(2026, 5, 30, 6, 0) === 'closed');

// CRYPTO is always open, even on the weekend; no nextOpen.
ok('CRYPTO always open', marketSession('CRYPTO', Date.UTC(2026, 5, 27, 3, 0)).phase === 'open');
ok('CRYPTO nextOpen null', marketSession('CRYPTO').nextOpen === null);

// marketOpen must be UNCHANGED by the new regOpen/regClose fields (US window 04:00–20:00).
ok('marketOpen US regular still true', marketOpen('US', new Date(Date.UTC(2026, 5, 30, 14, 0))) === true);  // 10:00 EDT
ok('marketOpen US night still false',  marketOpen('US', new Date(Date.UTC(2026, 5, 30, 7, 0)))  === false); // 03:00 EDT

ok('app.js binds marketSession from PBCore', /const\s+marketSession\s*=\s*PBCore\.marketSession/.test(appSrc));
ok('app.js has no local function marketSession', !/function\s+marketSession\s*\(/.test(appSrc));
console.log(failures ? `\n${failures} test(s) failed` : '\nAll market-session tests passed');
process.exit(failures ? 1 : 0);
