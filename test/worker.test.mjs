// Unit tests for the Worker's pure logic (trigger evaluation + market hours).
//   cd backend/test && node worker.test.mjs
import { evaluate, marketOpen, yahooSymbol, centDivisor, sanitizeAlerts } from '../worker.js';

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };

// ── evaluate() ───────────────────────────────────────────────────────────────
const A = { id: 'a1', ticker: 'AAPL', market: 'US', direction: 'above', targetPrice: 200, active: true, note: '' };

// 1. crossing the target fires exactly once and records the hit
let r = evaluate([A], { 'US:AAPL': 201 }, {});
ok('fires when price crosses above target', r.newTriggers.length === 1 && r.changed && r.nextSeen.a1.status === 'hit');

// 2. staying above does not re-fire
r = evaluate([A], { 'US:AAPL': 202 }, { a1: { status: 'hit', at: Date.now() } });
ok('does not re-fire while still above', r.newTriggers.length === 0 && !r.changed);

// 3. dipping below inside the cooldown stays armed (no flap)
r = evaluate([A], { 'US:AAPL': 199 }, { a1: { status: 'hit', at: Date.now() - 1000 } });
ok('holds hit-state during cooldown', r.newTriggers.length === 0 && r.nextSeen.a1.status === 'hit');

// 4. dipping below after the cooldown re-arms to waiting
r = evaluate([A], { 'US:AAPL': 199 }, { a1: { status: 'hit', at: Date.now() - 10 * 60 * 1000 } });
ok('re-arms to waiting after cooldown', r.nextSeen.a1 === 'waiting' && r.changed);

// 5. below-direction alert
const B = { ...A, id: 'b1', direction: 'below', targetPrice: 150 };
r = evaluate([B], { 'US:AAPL': 149 }, {});
ok('fires on below-direction cross', r.newTriggers.length === 1 && r.changed);

// 6. inactive alerts are ignored
r = evaluate([{ ...A, active: false }], { 'US:AAPL': 999 }, {});
ok('ignores inactive alerts', r.newTriggers.length === 0);

// 7. missing price → no fire, no spurious change
r = evaluate([A], {}, {});
ok('no fire when price unavailable', r.newTriggers.length === 0 && !r.changed);

// 8. removing an alert is detected as a change (so stale seen-state is pruned)
r = evaluate([], {}, { a1: 'waiting' });
ok('prunes seen-state for removed alerts', r.changed);

// ── marketOpen() — DST-correct via Intl ─────────────────────────────────────
ok('US open  — Wed 14:00 UTC (10:00 EDT)', marketOpen('US', new Date('2026-06-17T14:00:00Z')) === true);
ok('US closed — Wed 03:00 UTC (23:00 EDT prev)', marketOpen('US', new Date('2026-06-17T03:00:00Z')) === false);
ok('US closed — Saturday', marketOpen('US', new Date('2026-06-20T14:00:00Z')) === false);
ok('JSE open  — Wed 10:00 UTC (12:00 SAST)', marketOpen('JSE', new Date('2026-06-17T10:00:00Z')) === true);
ok('JSE closed — Wed 16:00 UTC (18:00 SAST)', marketOpen('JSE', new Date('2026-06-17T16:00:00Z')) === false);

// ── symbol + unit helpers ────────────────────────────────────────────────────
ok('yahooSymbol JSE → .JO', yahooSymbol('NPN', 'JSE') === 'NPN.JO');
ok('yahooSymbol LSE → .L', yahooSymbol('SHEL', 'LSE') === 'SHEL.L');
ok('yahooSymbol CRYPTO → -USD pair', yahooSymbol('BTC', 'CRYPTO') === 'BTC-USD');
ok('yahooSymbol CRYPTO no double -USD', yahooSymbol('ETH-USD', 'CRYPTO') === 'ETH-USD');
ok('marketOpen CRYPTO true on weekend', marketOpen('CRYPTO', new Date('2026-06-20T03:00:00Z')) === true);
ok('centDivisor JSE ZAc = 100', centDivisor('JSE', 'ZAc') === 100);
ok('centDivisor US USD = 1', centDivisor('US', 'USD') === 1);
ok('sanitizeAlerts drops malformed rows', sanitizeAlerts([{ id: 'x', ticker: 'AAPL', market: 'US', targetPrice: 1 }, { ticker: 'NOID' }]).length === 1);

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
