// Tests for the shared alert/market-hours core (pb-core.js) — the single source
// of truth that replaces the copy-pasted, drifted logic in app.js + worker.js.
//   cd backend/test && node alerts-core.test.mjs
//
// Two layers:
//   1. Unit tests of PBCore.evaluateAlerts / marketOpen (the state machine).
//   2. An EQUIVALENCE proof: we vm-slice the CLIENT's current evaluateTriggers
//      straight out of app.js and assert it fires the same alerts and lands in
//      the same seen-state as PBCore on identical scenarios. That's what makes
//      it safe to later swap app.js over to the shared core — if the two ever
//      diverge, this test goes red.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import PBCore from '../../pb-core.js';

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };

const { evaluateAlerts, marketOpen } = PBCore;
const A = { id: 'a1', ticker: 'AAPL', market: 'US', direction: 'above', targetPrice: 200, active: true, note: '' };

// ── 1. evaluateAlerts: the state machine ─────────────────────────────────────
let r = evaluateAlerts([A], { 'US:AAPL': 201 }, {});
ok('fires once when price crosses above', r.newTriggers.length === 1 && r.changed && r.nextSeen.a1.status === 'hit');
ok('trigger carries price + iso timestamp', r.newTriggers[0].triggerPrice === 201 && typeof r.newTriggers[0].triggeredAt === 'string');

r = evaluateAlerts([A], { 'US:AAPL': 202 }, { a1: { status: 'hit', at: Date.now() } });
ok('does not re-fire while still above', r.newTriggers.length === 0 && !r.changed);

r = evaluateAlerts([A], { 'US:AAPL': 199 }, { a1: { status: 'hit', at: Date.now() - 1000 } });
ok('holds hit-state during cooldown', r.newTriggers.length === 0 && r.nextSeen.a1.status === 'hit');

r = evaluateAlerts([A], { 'US:AAPL': 199 }, { a1: { status: 'hit', at: Date.now() - 10 * 60 * 1000 } });
ok('re-arms to waiting after cooldown', r.nextSeen.a1 === 'waiting' && r.changed);

const B = { ...A, id: 'b1', direction: 'below', targetPrice: 150 };
r = evaluateAlerts([B], { 'US:AAPL': 149 }, {});
ok('fires on below-direction cross', r.newTriggers.length === 1 && r.changed);

r = evaluateAlerts([{ ...A, active: false }], { 'US:AAPL': 999 }, {});
ok('ignores inactive alerts', r.newTriggers.length === 0);

r = evaluateAlerts([A], {}, {});
ok('no fire / no change when price unavailable', r.newTriggers.length === 0 && !r.changed);

r = evaluateAlerts([{ ...A, targetPrice: NaN }], { 'US:AAPL': 500 }, {});
ok('ignores malformed targetPrice', r.newTriggers.length === 0 && !r.changed);

r = evaluateAlerts([], {}, { a1: 'waiting' });
ok('prunes seen-state for removed alerts', r.changed);

// ── 2. marketOpen: DST-correct, identical table to before ────────────────────
ok('US open  — Wed 14:00 UTC (10:00 EDT)', marketOpen('US', new Date('2026-06-17T14:00:00Z')) === true);
ok('US closed — Wed 03:00 UTC', marketOpen('US', new Date('2026-06-17T03:00:00Z')) === false);
ok('US closed — Saturday', marketOpen('US', new Date('2026-06-20T14:00:00Z')) === false);
ok('JSE open  — Wed 10:00 UTC (12:00 SAST)', marketOpen('JSE', new Date('2026-06-17T10:00:00Z')) === true);
ok('CRYPTO open on weekend', marketOpen('CRYPTO', new Date('2026-06-20T03:00:00Z')) === true);

// ── 3. The client's evaluateTriggers DELEGATES to the shared core ────────────
// app.js's evaluateTriggers is now a thin adapter around PBCore.evaluateAlerts:
// it converts { price, fetchedAt } quote objects into the number map the core
// expects, dropping stale quotes. Slice it out (injecting the real PBCore) and
// confirm (a) it passes fresh prices through to the core unchanged, and (b) it
// still drops stale quotes — the guard that had to survive the refactor.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
const start = src.indexOf('function evaluateTriggers(');
const end = src.indexOf('const Icon', start);
if (start < 0 || end < 0) { console.error('FAIL: could not locate evaluateTriggers in app.js'); process.exit(1); }
const sandbox = { priceKey: (m, t) => m + ':' + t, PBCore };
vm.createContext(sandbox);
vm.runInContext(src.slice(start, end) + '\nglobalThis.__ev = evaluateTriggers;', sandbox);
const appEvaluate = sandbox.__ev;

// The client takes quote OBJECTS and skips stale ones; feed fresh fetchedAt so
// the only thing under test is the trigger state machine, not staleness.
const shape = s => (s && typeof s === 'object') ? 'hit' : s; // collapse {status,at} → 'hit'
function assertEquivalent(label, alerts, numberPrices, seen) {
  const objPrices = {};
  for (const k in numberPrices) objPrices[k] = { price: numberPrices[k], fetchedAt: Date.now() };
  const core = evaluateAlerts(alerts, numberPrices, seen);
  const app = appEvaluate(alerts, objPrices, seen);
  const sameFired = core.newTriggers.map(t => t.id).sort().join(',') === app.newTriggers.map(t => t.id).sort().join(',');
  const ids = new Set([...Object.keys(core.nextSeen), ...Object.keys(app.nextSeen)]);
  let sameState = true;
  for (const id of ids) if (shape(core.nextSeen[id]) !== shape(app.nextSeen[id])) sameState = false;
  ok(`equivalence: ${label}`, sameFired && sameState);
}

assertEquivalent('new cross above fires identically', [A], { 'US:AAPL': 201 }, {});
assertEquivalent('still above: neither re-fires', [A], { 'US:AAPL': 202 }, { a1: { status: 'hit', at: Date.now() } });
assertEquivalent('below in cooldown: both hold hit', [A], { 'US:AAPL': 199 }, { a1: { status: 'hit', at: Date.now() - 1000 } });
assertEquivalent('below after cooldown: both re-arm', [A], { 'US:AAPL': 199 }, { a1: { status: 'hit', at: Date.now() - 10 * 60 * 1000 } });
assertEquivalent('below-direction cross fires identically', [B], { 'US:AAPL': 149 }, {});
assertEquivalent('inactive ignored by both', [{ ...A, active: false }], { 'US:AAPL': 999 }, {});
assertEquivalent('missing price: neither fires', [A], {}, {});

// The stale-price guard must survive: a crossing price older than the cooldown
// must NOT fire (the client never has fresh server data the way the worker does).
const staleRes = appEvaluate([A], { 'US:AAPL': { price: 250, fetchedAt: Date.now() - 10 * 60 * 1000 } }, {});
ok('client drops stale quotes (no fire on >cooldown-old crossing price)', staleRes.newTriggers.length === 0 && !staleRes.seenChanged);
const freshRes = appEvaluate([A], { 'US:AAPL': { price: 250, fetchedAt: Date.now() } }, {});
ok('client fires on a fresh crossing price', freshRes.newTriggers.length === 1 && freshRes.seenChanged);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll alerts-core tests passed');
process.exit(failures ? 1 : 0);
