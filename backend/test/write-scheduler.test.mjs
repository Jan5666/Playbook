// Increment 37 — PBStore.createWriteScheduler
//
// The `pb.prices.v1` write used to be an inline trailing debounce inside
// app.js's usePriceFeed (present since the repo's first commit — GAPS #9's
// "written on every sweep" claim was wrong). It could not be tested there:
// Node suites never load app.js.
//
// This suite does two jobs:
//   1. CHARACTERIZATION — replicates the old inline debounce as a reference
//      implementation and proves createWriteScheduler({ maxDelay: 0 }) produces
//      an IDENTICAL write trace across a scenario matrix. The old timing is the
//      contract; nothing about the quiet-period behaviour may drift.
//   2. The three defects the old debounce had, now fixed: max-wait ceiling,
//      flush-on-demand, and read-at-fire-time (no stale snapshot).
//
// Everything runs on a fake clock — deterministic, no real timers, no sleeps.
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PBStore = require('../../pb-store.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appSrc = readFileSync(join(ROOT, 'app.js'), 'utf8');
const storeSrc = readFileSync(join(ROOT, 'pb-store.js'), 'utf8');

const DELAY = 1200; // the shipped trailing quiet period

// ─── Fake clock ──────────────────────────────────────────────────────────────
function makeClock() {
  let t = 0, seq = 0;
  const timers = new Map(); // id -> { at, fn }  (insertion order breaks ties)
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    // Run every timer due within `ms`, in due order, moving `t` to each due time.
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let pickId = null, pickAt = Infinity;
        for (const [id, e] of timers) if (e.at <= target && e.at < pickAt) { pickAt = e.at; pickId = id; }
        if (pickId === null) break;
        const e = timers.get(pickId);
        timers.delete(pickId);
        t = e.at;
        e.fn();
      }
      t = target;
    }
  };
}

// The old app.js debounce, verbatim in shape:
//   if (persistRef.current) clearTimeout(persistRef.current);
//   persistRef.current = setTimeout(() => LS.set(KEY, obj), 1200);
function makeOldDebounce(clock, onWrite, delay) {
  let ref = null;
  return (obj) => {
    if (ref) clock.clearTimeout(ref);
    ref = clock.setTimeout(() => onWrite(obj), delay);
  };
}

function newScheduler(clock, onWrite, opts = {}) {
  return PBStore.createWriteScheduler({
    write: onWrite,
    delay: opts.delay === undefined ? DELAY : opts.delay,
    maxDelay: opts.maxDelay || 0,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
}

// A scenario is a list of ['schedule'] / ['advance', ms] steps. Both
// implementations get their own clock and the same steps; we compare the times
// at which writes fired.
const SCENARIOS = {
  'single schedule then quiet': [['schedule'], ['advance', 5000]],
  'burst of 5, 300ms apart': [
    ['schedule'], ['advance', 300], ['schedule'], ['advance', 300], ['schedule'],
    ['advance', 300], ['schedule'], ['advance', 300], ['schedule'], ['advance', 5000]
  ],
  'schedules just under the delay (starvation)': [
    ['schedule'], ['advance', 1199], ['schedule'], ['advance', 1199], ['schedule'],
    ['advance', 1199], ['schedule'], ['advance', 1199], ['schedule'], ['advance', 1199]
  ],
  'boundary: 1199 no write, +1 writes': [['schedule'], ['advance', 1199], ['advance', 1]],
  'two bursts separated by a gap': [
    ['schedule'], ['advance', 200], ['schedule'], ['advance', 5000],
    ['schedule'], ['advance', 200], ['schedule'], ['advance', 5000]
  ],
  'no schedules at all': [['advance', 10000]],
  'exact-delay re-schedule lands on the boundary': [
    ['schedule'], ['advance', 1200], ['schedule'], ['advance', 1200]
  ]
};

function runTrace(steps, build) {
  const clock = makeClock();
  const writes = [];
  const call = build(clock, () => { writes.push(clock.now()); });
  for (const [op, arg] of steps) {
    if (op === 'schedule') call();
    else clock.advance(arg);
  }
  return writes;
}

// ─── 1. Characterization: identical to the old inline debounce ───────────────
for (const [name, steps] of Object.entries(SCENARIOS)) {
  test(`characterization — ${name}: scheduler trace === old inline debounce`, () => {
    const oldTrace = runTrace(steps, (clock, onWrite) => makeOldDebounce(clock, onWrite, DELAY));
    const newTrace = runTrace(steps, (clock, onWrite) => {
      const s = newScheduler(clock, onWrite, { maxDelay: 0 });
      return () => s.schedule();
    });
    assert.deepStrictEqual(newTrace, oldTrace, `write times diverged for "${name}"`);
  });
}

test('characterization — the starvation scenario really did starve (0 writes)', () => {
  // Pins the defect itself, so a future change that "fixes" it silently is visible.
  const oldTrace = runTrace(SCENARIOS['schedules just under the delay (starvation)'],
    (clock, onWrite) => makeOldDebounce(clock, onWrite, DELAY));
  assert.deepStrictEqual(oldTrace, [], 'old debounce should never write under a sub-delay stream');
});

test('characterization — a burst collapses to exactly one write at last+delay', () => {
  const trace = runTrace(SCENARIOS['burst of 5, 300ms apart'],
    (clock, onWrite) => { const s = newScheduler(clock, onWrite, { maxDelay: 0 }); return () => s.schedule(); });
  assert.deepStrictEqual(trace, [1200 + 1200]); // last schedule at t=1200, write at 2400
});

// ─── 2. maxDelay: the checkpoint ceiling (defect 2) ──────────────────────────
test('maxDelay: a sub-delay stream still checkpoints at burstStart+maxDelay', () => {
  const trace = runTrace(SCENARIOS['schedules just under the delay (starvation)'],
    (clock, onWrite) => { const s = newScheduler(clock, onWrite, { maxDelay: 3000 }); return () => s.schedule(); });
  assert.ok(trace.length > 0, 'must not starve');
  assert.strictEqual(trace[0], 3000, 'first checkpoint is exactly at the ceiling');
});

test('maxDelay: measured from the first schedule of a burst, not the last', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()), { maxDelay: 3000 });
  s.schedule();                       // burst starts at t=0
  for (let i = 0; i < 6; i++) { clock.advance(500); s.schedule(); }
  assert.deepStrictEqual(writes, [3000]);
});

test('maxDelay: a quiet burst still writes at delay, not at the ceiling', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()), { maxDelay: 10000 });
  s.schedule();
  clock.advance(5000);
  assert.deepStrictEqual(writes, [DELAY], 'ceiling must not delay a normal write');
});

test('maxDelay: the ceiling starts a fresh burst after each fire', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()), { maxDelay: 3000 });
  for (let i = 0; i < 14; i++) { s.schedule(); clock.advance(500); }
  assert.deepStrictEqual(writes, [3000, 6000], 'ceilings repeat, not accumulate');
});

test('maxDelay: fires synchronously when the ceiling is already past', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()), { delay: 1000, maxDelay: 500 });
  s.schedule();                       // ceiling 500 < delay 1000
  clock.advance(400);
  assert.deepStrictEqual(writes, []);
  clock.advance(100);                 // t=500, ceiling reached
  assert.deepStrictEqual(writes, [500]);
});

// ─── 3. flush: durability on hide/unmount (defect 1) ─────────────────────────
test('flush: writes a pending value immediately and reports true', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()));
  s.schedule();
  clock.advance(100);
  assert.strictEqual(s.flush(), true);
  assert.deepStrictEqual(writes, [100], 'flush writes at flush time, not at delay');
});

test('flush: is a no-op when nothing is pending', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()));
  assert.strictEqual(s.flush(), false);
  assert.deepStrictEqual(writes, []);
});

test('flush: cancels the pending timer — no double write', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()));
  s.schedule();
  s.flush();
  clock.advance(10000);
  assert.deepStrictEqual(writes, [0], 'the queued timer must not fire again');
});

test('flush: repeated flushes without a new schedule write once', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()));
  s.schedule();
  s.flush(); s.flush(); s.flush();
  assert.deepStrictEqual(writes, [0]);
});

test('flush: scheduling after a flush starts a new pending write', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()));
  s.schedule(); s.flush();
  clock.advance(50);
  s.schedule();
  clock.advance(DELAY);
  assert.deepStrictEqual(writes, [0, 50 + DELAY]);
});

test('the old debounce loses the write the flush now saves', () => {
  // The defect, stated as a test: page hides 100ms after the last merge.
  const clock = makeClock();
  const writes = [];
  makeOldDebounce(clock, () => writes.push(clock.now()), DELAY)({});
  clock.advance(100);                 // ...user swipes away; timers die here
  assert.deepStrictEqual(writes, [], 'old behaviour: the write never happened');
});

// ─── 4. cancel / isPending ───────────────────────────────────────────────────
test('cancel: drops a pending write without firing it', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()));
  s.schedule();
  s.cancel();
  clock.advance(10000);
  assert.deepStrictEqual(writes, []);
});

test('cancel: clears the burst so the next ceiling is measured fresh', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()), { maxDelay: 3000 });
  s.schedule();                        // burst A starts at t=0
  clock.advance(1000); s.schedule();   // t=1000, still pending
  clock.advance(1000); s.schedule();   // t=2000, still pending (A's ceiling is 3000)
  assert.deepStrictEqual(writes, [], 'burst A has not written yet');
  s.cancel();                          // drop burst A entirely
  s.schedule();                        // burst B starts at t=2000
  clock.advance(1000); s.schedule();   // t=3000 — burst A's old ceiling; must NOT fire
  assert.deepStrictEqual(writes, [], 'a cancelled burst must not leave its ceiling behind');
  clock.advance(1000); s.schedule();   // t=4000
  clock.advance(1000);                 // t=5000 = burst B start + maxDelay
  assert.deepStrictEqual(writes, [5000]);
});

test('isPending reflects the timer state', () => {
  const clock = makeClock();
  const s = newScheduler(clock, () => {});
  assert.strictEqual(s.isPending(), false);
  s.schedule();
  assert.strictEqual(s.isPending(), true);
  clock.advance(DELAY);
  assert.strictEqual(s.isPending(), false);
});

// ─── 5. read-at-fire-time (defect 3) ─────────────────────────────────────────
test('write() takes no snapshot — it reads the freshest value at fire time', () => {
  const clock = makeClock();
  let current = 'v1';
  const written = [];
  const s = newScheduler(clock, () => written.push(current));
  s.schedule();
  current = 'v2';                     // a merge that did NOT re-schedule
  clock.advance(DELAY);
  assert.deepStrictEqual(written, ['v2'], 'must not persist the value seen at schedule time');
});

test('the old debounce persisted the captured snapshot instead', () => {
  const clock = makeClock();
  let current = 'v1';
  const written = [];
  const call = makeOldDebounce(clock, obj => written.push(obj), DELAY);
  call(current);
  current = 'v2';
  clock.advance(DELAY);
  assert.deepStrictEqual(written, ['v1'], 'pins the old stale-snapshot behaviour');
});

test('flush also reads at fire time', () => {
  const clock = makeClock();
  let current = 'a';
  const written = [];
  const s = newScheduler(clock, () => written.push(current));
  s.schedule();
  current = 'b';
  s.flush();
  assert.deepStrictEqual(written, ['b']);
});

// ─── 6. Defensive input handling ─────────────────────────────────────────────
test('a scheduler with no write fn never throws', () => {
  const s = PBStore.createWriteScheduler({});
  s.schedule(); s.flush(); s.cancel();
  assert.strictEqual(s.isPending(), false);
});

test('createWriteScheduler() with no args never throws', () => {
  const s = PBStore.createWriteScheduler();
  s.schedule();
  assert.strictEqual(s.flush(), false);
});

test('delay 0 fires on the next tick, not synchronously', () => {
  const clock = makeClock();
  const writes = [];
  const s = newScheduler(clock, () => writes.push(clock.now()), { delay: 0 });
  s.schedule();
  assert.deepStrictEqual(writes, [], 'still asynchronous');
  clock.advance(0);
  assert.deepStrictEqual(writes, [0]);
});

test('a throwing write does not wedge the scheduler', () => {
  const clock = makeClock();
  let boom = true;
  const s = newScheduler(clock, () => { if (boom) { boom = false; throw new Error('quota'); } });
  s.schedule();
  assert.throws(() => clock.advance(DELAY), /quota/);
  assert.strictEqual(s.isPending(), false, 'the timer must be cleared even when write throws');
  s.schedule();
  clock.advance(DELAY);               // recovers
  assert.strictEqual(s.isPending(), false);
});

test('uses real timers when no clock is injected', async () => {
  let hits = 0;
  const s = PBStore.createWriteScheduler({ write: () => { hits++; }, delay: 1 });
  s.schedule();
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(hits, 1);
});

// ─── 7. Anti-drift source guards ─────────────────────────────────────────────
test('guard: pb-store.js owns createWriteScheduler and exports it', () => {
  assert.ok(/function createWriteScheduler\(/.test(storeSrc), 'definition present');
  assert.ok(/\bcreateWriteScheduler\b/.test(storeSrc.split('const PBStore = {')[1] || ''),
    'listed on the PBStore export object');
  assert.strictEqual(typeof PBStore.createWriteScheduler, 'function');
});

test('guard: app.js no longer hand-rolls the price debounce', () => {
  assert.ok(!/setTimeout\(\s*\(\)\s*=>\s*LS\.set\(PRICES_LS_KEY/.test(appSrc),
    'the inline setTimeout(() => LS.set(PRICES_LS_KEY, obj), 1200) must be gone');
  assert.strictEqual((appSrc.match(/function createWriteScheduler/g) || []).length, 0,
    'app.js must delegate, not redefine');
});

test('guard: usePriceFeed delegates the price write to the store scheduler', () => {
  assert.ok(/PBStore\.createWriteScheduler\(/.test(appSrc), 'app.js builds the scheduler');
  assert.ok(/write:\s*\(\)\s*=>\s*LS\.set\(PRICES_LS_KEY,\s*PBStore\.getPrices\(\)\)/.test(appSrc),
    'the write still goes through the LS adapter to the same key (rule #5)');
});

test('guard: the pending price write is flushed when the page goes away', () => {
  assert.ok(/addEventListener\('pagehide'/.test(appSrc), 'pagehide flush wired');
  assert.ok(/PRICES_PERSIST_MAX_MS/.test(appSrc), 'the checkpoint ceiling is configured');
});

test('guard: pb.prices.v1 stays in BACKUP_SKIP (no cloud-sync churn)', () => {
  const skip = appSrc.split('const BACKUP_SKIP')[1].split(']);')[0];
  assert.ok(/'pb\.prices\.v1'/.test(skip), 'still skipped by cloud backup');
});
