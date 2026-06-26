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

console.log(failures ? `\n${failures} test(s) failed` : '\nAll pLimit tests passed');
process.exit(failures ? 1 : 0);
