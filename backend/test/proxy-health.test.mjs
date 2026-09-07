// The Settings -> Diagnostics "Proxy health" readout: PBData.proxyHealthSnapshot
// (the ladder's real breaker state) and pb-modals' pure proxyHealthRows kernel.
//   cd backend/test && node proxy-health.test.mjs
//
// Why this readout exists: the same complaint -- "prices are not updating" -- is
// produced by three unrelated faults that look identical from outside the app (a
// rate-limited ladder, a sweep that never ran, and a chip claiming "Loading..."
// over perfectly current data). Nothing distinguished them, so the report could
// never be acted on directly. These rows are what make the next one a measurement.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import PBCore from '../../pb-core.js';
import PBData from '../../pb-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const modalSrc = readFileSync(join(here, '..', '..', 'pb-modals.js'), 'utf8');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };

// ── the kernel, sliced out of the shipped file ───────────────────────────────
const a = modalSrc.indexOf('function proxyHealthRows(snapshot, feedHealth, nowMs) {');
const b = modalSrc.indexOf('\n}\n', a);
const SRC = a < 0 ? null : modalSrc.slice(a, b + 3);
ok('pb-modals still declares proxyHealthRows', !!SRC);

const ctx = { fmtAgo: PBCore.fmtAgo, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC + '\nglobalThis.__PHR = proxyHealthRows;', ctx);
const rows = ctx.__PHR;
const byKey = (out) => Object.fromEntries(out.map(r => [r.label, r.value]));
const NOW = Date.UTC(2026, 8, 7, 12, 0);

// ── snapshot shape ───────────────────────────────────────────────────────────
PBData._resetProxyHealth();
const cold = PBData.proxyHealthSnapshot(NOW);
ok('snapshot: one row per PROVIDER, not per rung', cold.length === 5);
ok('snapshot: the two allorigins rungs collapse to one provider',
  cold.filter(p => p.provider === 'allorigins').length === 1);
ok('snapshot: a cold ladder reads untried', cold.every(p => p.state === 'untried' && p.fails === 0));
ok('snapshot: nothing is last-good before anything has won', cold.every(p => !p.isLastGood));

// ── rows render every provider, plus a sweep line ────────────────────────────
const coldRows = rows(cold, null, NOW);
ok('rows: one line per provider plus the sweep line', coldRows.length === 6);
ok('rows: an untried ladder says so', byKey(coldRows)['corsmirror'] === 'untried');
// A sweep that has never completed is itself the answer when nothing updates.
ok('rows: no completed sweep is reported explicitly',
  byKey(coldRows)['last sweep'] === 'none completed this session');

// ── the states a real ladder moves through ───────────────────────────────────
const snap = [
  { provider: 'corsmirror', state: 'penalised', fails: 3, okAgeMs: null, openForMs: 42000, isLastGood: false },
  { provider: 'cors.lol', state: 'ok', fails: 0, okAgeMs: 30000, openForMs: 0, isLastGood: true },
  { provider: 'allorigins', state: 'failing', fails: 1, okAgeMs: 600000, openForMs: 0, isLastGood: false }
];
const r = byKey(rows(snap, { sweep: { ms: 8420, at: NOW - 60000, symbols: 118 } }, NOW));
ok('rows: a penalised provider names its cooldown', /penalised/.test(r['corsmirror']) && /cooldown 42s/.test(r['corsmirror']));
ok('rows: a penalised provider reports no stale success age', !/\bok\b/.test(r['corsmirror']));
ok('rows: the carrying proxy is flagged LAST GOOD', /LAST GOOD/.test(r['cors.lol']));
ok('rows: a failing-but-open provider shows its streak', /failing/.test(r['allorigins']) && /fails 1/.test(r['allorigins']));
// The sweep line is the "taking very long" half of the report, in seconds.
ok('rows: the sweep line reports duration and symbol count',
  /8\.4s over 118 symbols/.test(r['last sweep']));
ok('rows: ...and how long ago it finished', /ago/.test(r['last sweep']));

// ── it must never throw on the shapes React can hand it ──────────────────────
ok('rows: null snapshot is safe', rows(null, null, NOW).length === 1);
ok('rows: a malformed entry is skipped, not rendered', rows([null, {}, snap[1]], null, NOW).length === 2);
ok('rows: a sweep object with no ms falls back to the empty line',
  byKey(rows([], { sweep: { at: NOW } }, NOW))['last sweep'] === 'none completed this session');

// ── anti-drift: the panel must actually be wired to the live ladder ──────────
ok('pb-modals reads the REAL snapshot, not a copy',
  /proxyHealthRows\(PBData\.proxyHealthSnapshot\(/.test(modalSrc));
ok('pb-modals renders the proxy rows', /proxyRows\.map\(/.test(modalSrc));
ok('pb-modals puts them in the copied diagnostics blob', /'PROXY HEALTH'/.test(modalSrc));
// The rows are computed only while the section is open, like priceFeedRows.
ok('pb-modals gates the scan on the open section',
  /activeSection === 'diagnostics'[\s\S]{0,120}proxyHealthSnapshot/.test(modalSrc));

const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
ok('app.js measures the sweep and publishes it', /setFeedSweep\(\{ ms: Date\.now\(\) - sweepStartedAt/.test(appSrc));
ok('app.js only lets the OWNING sweep publish its timing',
  /if \(seq === sweepSeqRef\.current\) \{\s*\n\s*setFeedSweep/.test(appSrc));
ok('app.js passes the sweep through feedHealth', /sweep: feedSweep/.test(appSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll proxy-health tests passed');
process.exit(failures ? 1 : 0);
