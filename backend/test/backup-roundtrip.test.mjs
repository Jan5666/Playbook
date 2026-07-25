// Cloud-backup round-trip characterization (GAPS #13)
//
// `gatherBackup` / `applyBackup` / `LEGACY_KEY_MAP` are the disaster-recovery
// path: they are what stands between a wiped device and a lost portfolio. Until
// now they had NO unit coverage. `verify-cloud-backup.mjs` looks like coverage
// but is not — it hand-mirrors both functions ("kept identical on purpose") and
// has already drifted from app.js in two ways:
//   * its BACKUP_SKIP lists 7 keys; app.js lists 9 (pb.rotation.lastgood.v1 and
//     pb.hotStocks.v1 are missing), so it cannot catch a volatile blob starting
//     to ride cloud backups;
//   * its applyBackup handles only the new envelope — the entire legacy (v3)
//     flat-format branch that exists so Jan's OLD backup files still restore is
//     untested there.
// That suite's real subject is the AES-GCM/PBKDF2 crypto, and it stays the
// authority on that. This suite is the behavioural authority, and it runs the
// REAL app.js source rather than a copy.
//
// Mechanism: Node suites never load app.js (it is a browser classic script that
// mounts React at the bottom), so the backup block is sliced out by marker and
// evaluated in a `vm` context over a fake localStorage. The slice is bounded by
// source markers, not line numbers, so it survives app.js moving around.
//
// This is also the rule-#5 pin Phase 5 (IndexedDB behind the LS adapter) needs
// BEFORE it touches anything: gatherBackup and applyBackup are two of the three
// places that bypass the LS adapter and talk to localStorage directly, so they
// are exactly the code an async storage swap has to rewrite. Cloud backup must
// stay byte-compatible across that change (CLAUDE.md rule #5) — these tests are
// what makes "byte-compatible" checkable instead of hoped-for.
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appSrc = readFileSync(join(ROOT, 'app.js'), 'utf8');

// ─── Slice the real backup block out of app.js ───────────────────────────────
// From `const BACKUP_PREFIX` through the closing brace of `applyBackup`. That
// span carries BACKUP_SKIP, _backupNotify, the LS adapter, gatherBackup,
// LEGACY_KEY_MAP and applyBackup — the whole durable-state seam.
function sliceBackupBlock(src) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.startsWith('const BACKUP_PREFIX'));
  assert.ok(start >= 0, 'app.js still declares BACKUP_PREFIX at top level');
  const applyAt = lines.findIndex(l => l.startsWith('function applyBackup('));
  assert.ok(applyAt > start, 'app.js still declares applyBackup after BACKUP_PREFIX');
  let end = -1;
  for (let i = applyAt + 1; i < lines.length; i++) {
    if (lines[i] === '}') { end = i; break; }  // column-0 brace closes the fn
  }
  assert.ok(end > applyAt, 'found the end of applyBackup');
  return lines.slice(start, end + 1).join('\n');
}
const BLOCK = sliceBackupBlock(appSrc);

// A fake localStorage with real insertion order (gatherBackup enumerates by index).
function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    _map: map,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

// Evaluate the sliced block over a given store and hand back its exports.
function load(seed) {
  const localStorage = makeStorage(seed);
  const ctx = vm.createContext({ localStorage, console });
  vm.runInContext(BLOCK + `
globalThis.__x = { LS, gatherBackup, applyBackup, BACKUP_SKIP, LEGACY_KEY_MAP, BACKUP_PREFIX,
                   setNotify: fn => { _backupNotify = fn; } };`, ctx);
  return { ...ctx.__x, localStorage };
}

// A realistic durable store: money slices, settings, and every skip-set key.
function seedRealistic() {
  return {
    'pb.positions.v2': JSON.stringify([{ id: 'a1', ticker: 'NVDA', market: 'US', shares: 12.5, costBasis: 98.4 }]),
    'pb.transactions.v1': JSON.stringify([{ id: 't1', type: 'buy', ticker: 'NVDA', market: 'US', shares: 12.5, price: 98.4 }]),
    'pb.tfsa.deposits.v1': JSON.stringify([{ id: 'd1', amount: 36000, date: '2026-03-01' }]),
    'pb.watchlist.v2': JSON.stringify([{ ticker: 'ASML', market: 'US' }]),
    'pb.alerts.v2': JSON.stringify([{ id: 'al1', ticker: 'NVDA', market: 'US', op: 'above', value: 200 }]),
    'pb.theme.v2': '"dark"',
    'pb.displayCurrency.v1': '"ZAR"',
    // every BACKUP_SKIP member — these must never appear in an envelope
    'pb.prices.v1': JSON.stringify({ 'US:NVDA': { price: 181.2 } }),
    'pb.nameCache.v1': JSON.stringify({ 'US:NVDA': 'NVIDIA Corporation' }),
    'pb.fxRates.v1': JSON.stringify({ ZAR: 18.1 }),
    'pb.sectorCache.v1': JSON.stringify({ 'US:NVDA': 'Technology' }),
    'pb.heatmap.lastgood.v1': JSON.stringify({ sp500: { rows: [] } }),
    'pb.rotation.lastgood.v1': JSON.stringify({ sp500: { series: null } }),
    'pb.installDismissed.v2': 'true',
    'pb.hotStocks.v1': JSON.stringify({ at: 1, list: [] }),
    'pb.backup.lastSync.v1': '1750000000000',
    // foreign keys that share the origin — must be ignored entirely
    'theme': 'light',
    'someOtherApp.state': '{"x":1}',
  };
}

// ─── gatherBackup ────────────────────────────────────────────────────────────

test('gatherBackup emits the versioned envelope shape', () => {
  const { gatherBackup } = load(seedRealistic());
  const env = gatherBackup();
  assert.equal(env.v, 1, 'envelope version is 1');
  assert.equal(env.app, 'playbook', 'envelope is tagged with the app name');
  assert.ok(!Number.isNaN(Date.parse(env.exportedAt)), 'exportedAt is an ISO timestamp');
  assert.equal(typeof env.keys, 'object', 'keys is a plain object');
});

test('gatherBackup captures durable pb.* keys as RAW strings (no re-serialization)', () => {
  const seed = seedRealistic();
  const { gatherBackup } = load(seed);
  const { keys } = gatherBackup();
  // The byte-for-byte guarantee: the stored string is carried through untouched.
  assert.equal(keys['pb.positions.v2'], seed['pb.positions.v2'], 'positions carried verbatim');
  assert.equal(keys['pb.theme.v2'], '"dark"', 'a JSON string value keeps its quotes');
  assert.equal(typeof keys['pb.transactions.v1'], 'string', 'values are strings, not parsed objects');
});

test('gatherBackup excludes every BACKUP_SKIP key', () => {
  const { gatherBackup, BACKUP_SKIP } = load(seedRealistic());
  const { keys } = gatherBackup();
  for (const skipped of BACKUP_SKIP) {
    assert.ok(!(skipped in keys), `${skipped} is excluded from the envelope`);
  }
  assert.equal(BACKUP_SKIP.size, 9, 'the skip set still has 9 members (update this test if it changes)');
});

test('gatherBackup ignores keys outside the pb. prefix', () => {
  const { gatherBackup } = load(seedRealistic());
  const { keys } = gatherBackup();
  assert.ok(!('theme' in keys), 'a bare foreign key is not captured');
  assert.ok(!('someOtherApp.state' in keys), 'another app sharing the origin is not captured');
  assert.ok(Object.keys(keys).every(k => k.startsWith('pb.')), 'every captured key is pb.*');
});

test('gatherBackup captures exactly the durable set — no hand-maintained field list', () => {
  const { gatherBackup } = load(seedRealistic());
  const { keys } = gatherBackup();
  assert.deepEqual(Object.keys(keys).sort(), [
    'pb.alerts.v2', 'pb.displayCurrency.v1', 'pb.positions.v2', 'pb.tfsa.deposits.v1',
    'pb.theme.v2', 'pb.transactions.v1', 'pb.watchlist.v2',
  ], 'the 7 durable keys in the seed, and only those');
});

// ─── round-trip ──────────────────────────────────────────────────────────────

test('round-trip onto a wiped store is byte-identical', () => {
  const seed = seedRealistic();
  const { gatherBackup } = load(seed);
  const envelope = gatherBackup();

  // A fresh device: empty storage, restore the envelope.
  const fresh = load({});
  const n = fresh.applyBackup(envelope);
  assert.equal(n, 7, 'every durable key was restored');
  for (const [k, v] of Object.entries(envelope.keys)) {
    assert.equal(fresh.localStorage.getItem(k), v, `${k} restored byte-for-byte`);
  }
  // and re-gathering from the restored device reproduces the same key set/values
  const again = fresh.gatherBackup();
  assert.deepEqual(again.keys, envelope.keys, 're-export after restore is identical');
});

test('restore overwrites existing values rather than merging into them', () => {
  const { gatherBackup } = load(seedRealistic());
  const envelope = gatherBackup();
  const device = load({ 'pb.positions.v2': JSON.stringify([{ ticker: 'STALE' }]), 'pb.theme.v2': '"light"' });
  device.applyBackup(envelope);
  assert.equal(device.localStorage.getItem('pb.positions.v2'), envelope.keys['pb.positions.v2'],
    'the stale local value is replaced by the backup');
  assert.equal(device.localStorage.getItem('pb.theme.v2'), '"dark"', 'settings are overwritten too');
});

test('restore leaves untouched local keys alone (skip-set caches survive)', () => {
  const { gatherBackup } = load(seedRealistic());
  const envelope = gatherBackup();
  const device = load({ 'pb.prices.v1': '{"US:AAPL":{"price":1}}', 'theme': 'light' });
  device.applyBackup(envelope);
  assert.equal(device.localStorage.getItem('pb.prices.v1'), '{"US:AAPL":{"price":1}}',
    'a skip-set cache the envelope never carried is not cleared');
  assert.equal(device.localStorage.getItem('theme'), 'light', 'foreign keys are untouched');
});

// ─── applyBackup: legacy (v3) flat format ────────────────────────────────────

test('applyBackup migrates every LEGACY_KEY_MAP field from a flat v3 export', () => {
  const { applyBackup, LEGACY_KEY_MAP, localStorage } = load({});
  const legacy = {
    positions: [{ ticker: 'NVDA', shares: 3 }],
    watchlist: [{ ticker: 'ASML' }],
    watchlistGroups: [{ id: 'g1', name: 'Core' }],
    alerts: [{ id: 'al1', value: 200 }],
    triggered: [{ id: 'tr1' }],
    contributions: [{ id: 'c1', amount: 500 }],
    transactions: [{ id: 't1', type: 'buy' }],
    tfsaDeposits: [{ id: 'd1', amount: 36000 }],
  };
  const n = applyBackup(legacy);
  assert.equal(n, 8, 'all 8 legacy fields restored');
  assert.equal(Object.keys(LEGACY_KEY_MAP).length, 8, 'the legacy map still covers 8 fields');
  for (const [field, key] of Object.entries(LEGACY_KEY_MAP)) {
    assert.equal(localStorage.getItem(key), JSON.stringify(legacy[field]),
      `${field} -> ${key} migrated and re-serialized`);
  }
});

test('applyBackup accepts a PARTIAL legacy export', () => {
  const { applyBackup, localStorage } = load({});
  const n = applyBackup({ positions: [{ ticker: 'NVDA' }], alerts: [] });
  assert.equal(n, 2, 'only the present fields are restored');
  assert.equal(localStorage.getItem('pb.positions.v2'), '[{"ticker":"NVDA"}]');
  assert.equal(localStorage.getItem('pb.alerts.v2'), '[]', 'an empty array is still a real value');
  assert.equal(localStorage.getItem('pb.transactions.v1'), null, 'absent fields are not invented');
});

test('the new envelope branch wins over legacy field sniffing', () => {
  const { applyBackup, localStorage } = load({});
  // A payload carrying BOTH shapes must be read as an envelope.
  applyBackup({ keys: { 'pb.positions.v2': '[{"ticker":"ENVELOPE"}]' }, positions: [{ ticker: 'LEGACY' }] });
  assert.equal(localStorage.getItem('pb.positions.v2'), '[{"ticker":"ENVELOPE"}]',
    'payload.keys takes precedence');
});

// ─── applyBackup: rejection + hostile input ──────────────────────────────────

test('applyBackup returns -1 for unrecognisable payloads', () => {
  const { applyBackup } = load({});
  assert.equal(applyBackup(null), -1, 'null');
  assert.equal(applyBackup(undefined), -1, 'undefined');
  assert.equal(applyBackup('a string'), -1, 'a string');
  assert.equal(applyBackup(42), -1, 'a number');
  assert.equal(applyBackup({}), -1, 'an object with neither shape');
  assert.equal(applyBackup({ nothing: 'useful' }), -1, 'an object with no known fields');
});

test('applyBackup drops keys outside the pb. prefix (a backup cannot write foreign keys)', () => {
  const { applyBackup, localStorage } = load({});
  const n = applyBackup({ keys: {
    'pb.positions.v2': '[]',
    'evil.token': '"stolen"',
    '__proto__x': '1',
  } });
  assert.equal(n, 1, 'only the pb.* key counted');
  assert.equal(localStorage.getItem('evil.token'), null, 'a foreign key in a backup file is not written');
});

test('applyBackup restores a skip-set key if a backup file happens to carry one', () => {
  // gatherBackup never emits these, but a hand-edited or older file might.
  // Characterizing current behaviour: applyBackup does not re-filter the skip set.
  const { applyBackup, localStorage } = load({});
  const n = applyBackup({ keys: { 'pb.prices.v1': '{"US:NVDA":{"price":1}}' } });
  assert.equal(n, 1, 'it is written');
  assert.equal(localStorage.getItem('pb.prices.v1'), '{"US:NVDA":{"price":1}}',
    'applyBackup filters on prefix only — the skip set is a gather-side rule');
});

// ─── the LS adapter + the backup-notify seam ─────────────────────────────────

test('LS.get parses, falls back on absent keys, and never throws on corrupt JSON', () => {
  const { LS } = load({ 'pb.positions.v2': '[{"ticker":"NVDA"}]', 'pb.broken.v1': '{not json' });
  assert.deepEqual(LS.get('pb.positions.v2', []), [{ ticker: 'NVDA' }], 'valid JSON parses');
  assert.deepEqual(LS.get('pb.missing.v1', ['fallback']), ['fallback'], 'absent key returns the fallback');
  assert.deepEqual(LS.get('pb.broken.v1', 'safe'), 'safe', 'corrupt JSON returns the fallback, no throw');
});

test('LS.set notifies cloud backup only for durable pb.* keys', () => {
  const { LS, setNotify } = load({});
  let hits = [];
  setNotify(() => hits.push('x'));

  LS.set('pb.positions.v2', [1]);
  assert.equal(hits.length, 1, 'a durable key triggers a backup sync');

  LS.set('pb.prices.v1', { a: 1 });
  assert.equal(hits.length, 1, 'a BACKUP_SKIP key does NOT — this is what stops sync churn');

  LS.set('someOtherApp.state', 1);
  assert.equal(hits.length, 1, 'a non-pb key does not notify');

  LS.remove('pb.positions.v2');
  assert.equal(hits.length, 2, 'removal of a durable key also notifies');

  LS.remove('pb.prices.v1');
  assert.equal(hits.length, 2, 'removal of a skipped key does not');
});

test('LS.set reports failure instead of throwing when storage rejects the write', () => {
  const { LS, localStorage } = load({});
  localStorage.setItem = () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; };
  assert.equal(LS.set('pb.positions.v2', [1]), false, 'a full/blocked store returns false, does not throw');
});

// ─── anti-drift source guards ────────────────────────────────────────────────

test('guard: the backup seam still lives in app.js and still goes through localStorage', () => {
  assert.ok(/function gatherBackup\(\)/.test(appSrc), 'gatherBackup defined in app.js');
  assert.ok(/function applyBackup\(payload\)/.test(appSrc), 'applyBackup defined in app.js');
  assert.ok(/const LEGACY_KEY_MAP = \{/.test(appSrc), 'LEGACY_KEY_MAP defined in app.js');
  assert.ok(/const BACKUP_PREFIX = 'pb\.';/.test(appSrc), 'the pb. prefix is still the durable-state marker');
});

test('guard: gatherBackup enumerates storage rather than listing fields by hand', () => {
  const body = appSrc.split('function gatherBackup()')[1].split('\n}')[0];
  assert.ok(/localStorage\.length/.test(body) && /localStorage\.key\(/.test(body),
    'it walks every key, so a new pb.* slice is backed up automatically');
  assert.ok(!/SETTINGS_SCHEMA|PORTFOLIO_SCHEMA/.test(body),
    'it does not depend on a schema that could fall out of date');
});

test('guard: BACKUP_SKIP holds only volatile/re-derivable caches', () => {
  const { BACKUP_SKIP } = load({});
  // Money + durable settings must NEVER be skipped — that would silently drop
  // them from every cloud backup (CLAUDE.md rule #5).
  for (const durable of ['pb.positions.v2', 'pb.transactions.v1', 'pb.contributions.v1',
                         'pb.tfsa.deposits.v1', 'pb.alerts.v2', 'pb.watchlist.v2',
                         'pb.theme.v2', 'pb.sectorWeights.v1']) {
    assert.ok(!BACKUP_SKIP.has(durable), `${durable} is durable and must ride cloud backup`);
  }
});

test('guard: verify-cloud-backup.mjs mirrored BACKUP_SKIP agrees with app.js', () => {
  // That harness hand-copies the skip set to exercise the crypto round-trip.
  // A copy that drifts silently weakens it — this pins the two together.
  const mirrorSrc = readFileSync(join(ROOT, 'backend', 'test', 'verify-cloud-backup.mjs'), 'utf8');
  const grab = src => new Set((src.split('const BACKUP_SKIP')[1].split(']')[0].match(/'pb\.[^']+'/g) || []));
  assert.deepEqual([...grab(mirrorSrc)].sort(), [...grab(appSrc)].sort(),
    'the mirrored skip set in verify-cloud-backup.mjs must match app.js');
});
