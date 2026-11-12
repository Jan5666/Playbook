// Unit tests for the pure pLimit concurrency limiter in pb-core.js.
//   cd backend/test && node plimit.test.mjs
import PBCore from '../../pb-core.js';
const { pLimit } = PBCore;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const delay = (ms) => new Promise(r => setTimeout(r, ms));

ok('PBCore exports pLimit', typeof pLimit === 'function');

// Peak concurrency never exceeds the cap.
async function peakUnder(cap, total) {
  const limit = pLimit(cap);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: total }, () => limit(async () => {
    active++; peak = Math.max(peak, active);
    await delay(10);
    active--;
  })));
  return peak;
}
ok('cap=1 serializes (peak 1)', (await peakUnder(1, 5)) === 1);
ok('cap=3 over 9 tasks → peak === 3', (await peakUnder(3, 9)) === 3);

// All results resolve in order of completion with correct values.
const limit = pLimit(2);
const vals = await Promise.all([1, 2, 3, 4].map(n => limit(async () => { await delay(5); return n * 10; })));
ok('returns each fn result', vals.join(',') === '10,20,30,40');

// A rejecting task frees its slot; later tasks still run.
const lim2 = pLimit(1);
let ran = false;
const p1 = lim2(async () => { throw new Error('boom'); }).catch(e => e.message);
const p2 = lim2(async () => { ran = true; return 'ok'; });
ok('rejecting task surfaces error', (await p1) === 'boom');
ok('queue not wedged by rejection', (await p2) === 'ok' && ran === true);

// ── Priority lane (2026-11-12) ───────────────────────────────────────────────
// The price sweep shares one gate with growth-chart history, heatmap light quotes
// and fundamentals. FIFO let opening the Dashboard take most slots from the prices
// the user was waiting on; a priority call now goes first, and `reserve` keeps
// slots for the normal lane while it has work, so it can never be starved.
const manual = () => { let r; const p = new Promise(res => { r = res; }); return { p, r }; };
{
  // 1. a priority call queued BEHIND normal ones is admitted first when a slot frees
  const lim = pLimit(1);
  const order = [];
  const first = manual();
  const a = lim(async () => { order.push('busy'); await first.p; });
  const b = lim(async () => { order.push('lo1'); });
  const c = lim(async () => { order.push('lo2'); });
  const d = lim(async () => { order.push('HI'); }, { priority: true });
  first.r(); await Promise.all([a, b, c, d]);
  ok('priority call jumps the normal queue', order.join(',') === 'busy,HI,lo1,lo2');
}
{
  // 2. reserve: with the gate full of priority work and more queued, a freed slot
  //    goes to waiting NORMAL work -- priority holds at most cap - reserve then.
  const lim = pLimit(4, { reserve: 1 });
  const gates = [], admitted = [];
  const job = (tag, prio) => lim(async () => { admitted.push(tag); const g = manual(); gates.push(g); await g.p; }, prio ? { priority: true } : undefined);
  const all = Array.from({ length: 8 }, (_, i) => job('H' + i, true));
  await delay(2);
  ok('reserve: an all-priority gate fills every slot', admitted.join(',') === 'H0,H1,H2,H3');
  all.push(job('LO', false));
  await delay(2);
  gates.shift().r();                       // one priority slot frees, priority still queued
  await delay(2);
  ok('reserve: the freed slot goes to the waiting normal job', admitted[4] === 'LO', admitted.join(','));
  gates.shift().r();                       // priority is now at 3 = cap - reserve, so it may refill
  await delay(2);
  ok('reserve: priority refills up to cap - reserve', admitted[5] === 'H4', admitted.join(','));
  while (gates.length) { gates.shift().r(); await delay(1); }
  await Promise.all(all);
}
{
  // 3. with nothing else queued, priority gets the whole gate
  const lim = pLimit(4, { reserve: 2 });
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => lim(async () => { active++; peak = Math.max(peak, active); await delay(5); active--; }, { priority: true })));
  ok('priority alone uses every slot (reserve only applies while normal work waits)', peak === 4);
}
{
  // 4. no starvation: an endless priority stream still lets normal work finish
  const lim = pLimit(2, { reserve: 1 });
  let stop = false, loDone = false;
  const pump = async () => { while (!stop) await lim(async () => { await delay(1); }, { priority: true }); };
  const pumps = [pump(), pump(), pump()];
  await lim(async () => { loDone = true; });
  stop = true; await Promise.all(pumps);
  ok('normal work completes under a continuous priority stream', loDone === true);
}
{
  // 5. a rejecting priority task frees its slot too
  const lim = pLimit(1);
  const e = await lim(async () => { throw new Error('x'); }, { priority: true }).catch(err => err.message);
  const v = await lim(async () => 'after');
  ok('priority rejection does not wedge the gate', e === 'x' && v === 'after');
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll pLimit tests passed');
process.exit(failures ? 1 : 0);
