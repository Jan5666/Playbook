// Unit tests for the pure fmtAgo + refreshChipState helpers in pb-core.js
// (refresh-confidence UX).   cd backend/test && node refresh-chip.test.mjs
import PBCore from '../../pb-core.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js'), 'utf8');

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

ok('app.js binds fmtAgo from PBCore', /const\s+fmtAgo\s*=\s*PBCore\.fmtAgo/.test(appSrc));
ok('app.js binds refreshChipState from PBCore', /const\s+refreshChipState\s*=\s*PBCore\.refreshChipState/.test(appSrc));
ok('app.js has no local function fmtAgo / refreshChipState', !/function\s+fmtAgo\s*\(/.test(appSrc) && !/function\s+refreshChipState\s*\(/.test(appSrc));

// ── The sweep must never be able to latch the chip on "Updating…" ───────────
// refreshChipState gives `loading` top priority, so a sweep that never finishes
// pins the chip there forever — and because runFetch's loadingRef gates BOTH the
// auto-poll and the manual button, the button silently stops doing anything.
// That is what "I press refresh and nothing happens" was. usePriceFeed is React
// and never loads under node, so this is a source guard; the behaviour it depends
// on (every network read settling) is covered by data-proxy.test.mjs.
const feed = appSrc.slice(appSrc.indexOf('function usePriceFeed('), appSrc.indexOf('function useAlertEngine('));
ok('a sweep watchdog constant exists', /const\s+SWEEP_WATCHDOG_MS\s*=\s*\d+/.test(appSrc));
ok('runFetch arms the watchdog', /setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]{0,200}?release\(\);?\s*\}\s*,\s*SWEEP_WATCHDOG_MS\)/.test(feed));
ok('the watchdog reports a failure so the chip stops claiming progress',
  /if\s*\(seq\s*!==\s*sweepSeqRef\.current\)\s*return;\s*\n\s*setFailStreak/.test(feed));
ok('release clears BOTH the ref and the react flag', /loadingRef\.current\s*=\s*false;\s*\n\s*setLoading\(false\);/.test(feed));
ok('release is generation-guarded so a late sweep cannot clear a newer one',
  /const\s+release\s*=[\s\S]{0,300}?seq\s*!==\s*sweepSeqRef\.current/.test(feed));
ok('the watchdog is cleared on the normal path', /clearTimeout\(watchdog\);/.test(feed));
ok('a thrown sweep drops its queued force instead of leaking it',
  /catch\s*\(e\)\s*\{[\s\S]{0,300}?pendingForceRef\.current\s*=\s*false;/.test(feed));
console.log(failures ? `\n${failures} test(s) failed` : '\nAll refresh-chip tests passed');
process.exit(failures ? 1 : 0);
