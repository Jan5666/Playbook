// GAPS #2 — sw.js delegates symbols / cent-divisor / alert-eval to pb-core.
//   cd backend/test && node sw-core-delegation.test.mjs   (or run from repo root)
//
// The background service worker used to carry hand-ported copies of yahooSymbol,
// centDivisor and evaluateTriggers (swYahooSymbol / swCentDivisor / swEvaluate).
// They had DRIFTED from pb-core.js — the single source of truth — so a closed-PWA
// background alert could fetch the wrong instrument (^SPX) or mis-scale a JSE/LSE
// price 100x and fire differently from the foreground app + the server. This test:
//   1. pins PBCore.evaluateAlerts on the EXACT call pattern sw.js now uses (a
//      MARKET:TICKER -> number price map + the 5-min SW cooldown) — the state
//      machine sw.js depends on;
//   2. pins the corrected symbol/divisor values, recording the old (buggy) sw
//      values that changed on purpose;
//   3. asserts sw.js actually delegates (importScripts + PBCore.*) and no longer
//      defines the drifted copies (the anti-drift source guard).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const SW = join(here, '..', '..', 'sw.js');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };

// ─── 1. evaluateAlerts on the SW call pattern (number price map + SW cooldown) ──
const CD = 5 * 60 * 1000;              // == SW_TRIGGER_COOLDOWN_MS (sw.js) == PBCore.TRIGGER_COOLDOWN_MS
const T = 1_700_000_000_000;
const A = { id: 'a1', active: true, market: 'US', ticker: 'AAPL', direction: 'above', targetPrice: 200, note: 'earnings' };

// fresh crossing -> fire once, land in { status:'hit', at }
let r = PBCore.evaluateAlerts([A], { 'US:AAPL': 201 }, {}, { now: T, cooldownMs: CD });
ok('fresh cross fires exactly once', r.newTriggers.length === 1 && r.changed === true);
ok('seen lands hit@now', r.nextSeen.a1 && r.nextSeen.a1.status === 'hit' && r.nextSeen.a1.at === T);
const t0 = r.newTriggers[0];
ok('trigger carries the fields sw.js reads', t0.triggerPrice === 201 && typeof t0.triggeredAt === 'string' &&
   t0.ticker === 'AAPL' && t0.direction === 'above' && t0.targetPrice === 200 && t0.note === 'earnings' &&
   t0.id === 'a1' && t0.market === 'US');

// still above -> no re-fire, hit-state carried
r = PBCore.evaluateAlerts([A], { 'US:AAPL': 205 }, { a1: { status: 'hit', at: T } }, { now: T + 1000, cooldownMs: CD });
ok('still-above does not re-fire', r.newTriggers.length === 0 && r.nextSeen.a1.status === 'hit');

// cleared within cooldown -> holds hit-state (no re-arm yet)
r = PBCore.evaluateAlerts([A], { 'US:AAPL': 190 }, { a1: { status: 'hit', at: T } }, { now: T + CD - 1000, cooldownMs: CD });
ok('cleared within cooldown holds hit-state', r.newTriggers.length === 0 && r.nextSeen.a1.status === 'hit');

// cleared past cooldown -> re-arm to 'waiting'
r = PBCore.evaluateAlerts([A], { 'US:AAPL': 190 }, { a1: { status: 'hit', at: T } }, { now: T + CD + 1000, cooldownMs: CD });
ok('cleared past cooldown re-arms to waiting', r.newTriggers.length === 0 && r.nextSeen.a1 === 'waiting' && r.changed === true);

// direction:'below' fires when price drops to/under target
const B = { id: 'b1', active: true, market: 'US', ticker: 'GOOG', direction: 'below', targetPrice: 100 };
r = PBCore.evaluateAlerts([B], { 'US:GOOG': 99 }, {}, { now: T, cooldownMs: CD });
ok('below-direction fires on drop through target', r.newTriggers.length === 1 && r.newTriggers[0].triggerPrice === 99);

// inactive + missing-price alerts never fire, prior state carried untouched
r = PBCore.evaluateAlerts([{ ...A, id: 'c1', active: false }], { 'US:AAPL': 201 }, { c1: 'waiting' }, { now: T, cooldownMs: CD });
ok('inactive alert never fires (carries prior)', r.newTriggers.length === 0 && r.nextSeen.c1 === 'waiting');
r = PBCore.evaluateAlerts([A], {}, { a1: 'waiting' }, { now: T, cooldownMs: CD });
ok('missing price never fires (carries prior)', r.newTriggers.length === 0 && r.nextSeen.a1 === 'waiting');

// CONTRACT: prices values MUST be numbers. Passing the app's {price,fetchedAt}
// object (the old swEvaluate shape) is not a finite number, so nothing fires —
// this is exactly why swRunAlertCheck now stores bare numbers in its price map.
r = PBCore.evaluateAlerts([A], { 'US:AAPL': { price: 201 } }, {}, { now: T, cooldownMs: CD });
ok('object price value does NOT fire (number-map contract)', r.newTriggers.length === 0);

// ─── 2. corrected symbol/divisor values (old buggy sw values noted) ────────────
ok("yahooSymbol('^SPX') -> %5EGSPC  (old sw: %5ESPX, a dead instrument)", PBCore.yahooSymbol('^SPX') === '%5EGSPC');
ok("yahooSymbol('^VIX') -> %5EVIX",  PBCore.yahooSymbol('^VIX') === '%5EVIX');
ok("yahooSymbol('AAPL','US') -> AAPL", PBCore.yahooSymbol('AAPL', 'US') === 'AAPL');
ok("yahooSymbol('BTC','CRYPTO') -> BTC-USD", PBCore.yahooSymbol('BTC', 'CRYPTO') === 'BTC-USD');
ok("yahooSymbol('NPN','JSE') -> NPN.JO", PBCore.yahooSymbol('NPN', 'JSE') === 'NPN.JO');
ok("yahooSymbol('VOD','LSE') -> VOD.L", PBCore.yahooSymbol('VOD', 'LSE') === 'VOD.L');

ok("centDivisor('JSE','ZAX') -> 100  (old sw: 1 — lacked the ZAX code, 100x off)", PBCore.centDivisor('JSE', 'ZAX') === 100);
ok("centDivisor('JSE','ZAc') -> 100", PBCore.centDivisor('JSE', 'ZAc') === 100);
ok("centDivisor('LSE','GBX') -> 100", PBCore.centDivisor('LSE', 'GBX') === 100);
ok("centDivisor('LSE','GBp') -> 100", PBCore.centDivisor('LSE', 'GBp') === 100);
ok("centDivisor('LSE','GBP') -> 100  (bare GBP on LSE = pence)", PBCore.centDivisor('LSE', 'GBP') === 100);
ok("centDivisor('US','USD') -> 1", PBCore.centDivisor('US', 'USD') === 1);

// ─── 3. anti-drift source guard: sw.js delegates, defines no drifted copies ─────
const swSrc = readFileSync(SW, 'utf8');
ok("sw.js importScripts('./pb-core.js')", swSrc.includes("importScripts('./pb-core.js')"));
ok('sw.js calls PBCore.yahooSymbol', /PBCore\.yahooSymbol\s*\(/.test(swSrc));
ok('sw.js calls PBCore.centDivisor', /PBCore\.centDivisor\s*\(/.test(swSrc));
ok('sw.js calls PBCore.evaluateAlerts', /PBCore\.evaluateAlerts\s*\(/.test(swSrc));
ok('sw.js no longer defines swYahooSymbol', !/function\s+swYahooSymbol/.test(swSrc));
ok('sw.js no longer defines swCentDivisor', !/function\s+swCentDivisor/.test(swSrc));
ok('sw.js no longer defines swEvaluate', !/function\s+swEvaluate/.test(swSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll sw-core-delegation tests passed');
process.exit(failures ? 1 : 0);
