// Unit tests for the pure fmtAgo + refreshChipState helpers in pb-core.js
// (refresh-confidence UX).   cd backend/test && node refresh-chip.test.mjs
import PBCore from '../../pb-core.js';

let failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };
const { fmtAgo, refreshChipState } = PBCore;

ok('exports fmtAgo', typeof fmtAgo === 'function');
ok('exports refreshChipState', typeof refreshChipState === 'function');

// fmtAgo coarsens with age.
ok('fmtAgo just now (0s)',  fmtAgo(1000, 1000) === 'just now');
ok('fmtAgo just now (<5s)', fmtAgo(0, 4000)  === 'just now');
ok('fmtAgo seconds',        fmtAgo(0, 12000) === '12s ago');
ok('fmtAgo minutes',        fmtAgo(0, 3 * 60000) === '3m ago');
ok('fmtAgo hours',          fmtAgo(0, 2 * 3600000) === '2h ago');
ok('fmtAgo days',           fmtAgo(0, 49 * 3600000) === '2d ago');
ok('fmtAgo invalid → empty', fmtAgo(null, 1000) === '');

// refreshChipState priority: updating > error > success > idle(ago) > loading.
ok('cold start → Loading…', refreshChipState({ loading: false, lastUpdateMs: null }).text === 'Loading…');
ok('loading → Updating…', refreshChipState({ loading: true, lastUpdateMs: 123 }).phase === 'updating');
ok('pendingAck → Updating… (instant ack)', refreshChipState({ loading: false, pendingAck: true, lastUpdateMs: 123 }).phase === 'updating');
ok('manual fail shows error immediately', refreshChipState({ failStreak: 1, lastManual: true, lastUpdateMs: 123 }).phase === 'error');
ok('auto fail at 1 does NOT show error', refreshChipState({ failStreak: 1, lastManual: false, lastUpdateMs: 123 }).phase === 'idle');
ok('auto fail at 2 shows error', refreshChipState({ failStreak: 2, lastManual: false, lastUpdateMs: 123 }).phase === 'error');
ok('success flash → Updated ✓', refreshChipState({ justSucceeded: true, lastUpdateMs: 123 }).text === 'Updated ✓');
ok('steady state → Updated Ns ago', refreshChipState({ lastUpdateMs: 0, nowMs: 12000 }).text === 'Updated 12s ago');
ok('error dot is stale', refreshChipState({ failStreak: 2, lastUpdateMs: 1 }).dot === 'stale');
ok('idle dot is live', refreshChipState({ lastUpdateMs: 0, nowMs: 1000 }).dot === 'live');

console.log(failures ? `\n${failures} test(s) failed` : '\nAll refresh-chip tests passed');
process.exit(failures ? 1 : 0);
