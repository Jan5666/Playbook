# Phase 3 Increment 3a — Non-money portfolio slices → PBStore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 5 non-money `usePortfolio` slices (`watchlist`, `watchlistGroups`, `alerts`, `sectorCache`, `sectorWeights`) off per-key `usePersistedState` into a generic `portfolio` collections slice on `PBStore`, behavior-identical.

**Architecture:** Add a settings-mechanism-twin to `pb-store.js` — `configureCollections`/`getCollection`/`setCollection`/`useCollection` — differing only in that `setCollection` accepts a value **or** an updater function (the mutators use `prev => next`). `app.js` injects a 5-entry schema + the existing `LS` adapter, so each slice keeps its own `pb.*` key and cloud backup stays byte-identical. In `usePortfolio` the 5 slices become `useCollection` reads + `useCallback`-stable setter wrappers; mutator bodies are untouched.

**Tech Stack:** Vanilla ES (no build step), React 18 UMD, `useSyncExternalStore`, `node:test`, headless-Chrome verify harnesses.

## Global Constraints

- **No build step.** `pb-store.js` is a dual-mode classic script: `module.exports` (Node) + `globalThis.PBStore` (browser). Keep both export paths.
- **`"use strict";`** — `pb-store.js` is already strict; no new globals.
- **Persistence is byte-identical.** Each slice keeps its own `pb.X.vN` key, written via the injected `LS` adapter (so `LS.set`'s cloud-backup-notify + `BACKUP_SKIP` handling are unchanged). No combined blob.
- **Selector-stability contract.** `setCollection` replaces only the changed key inside `portfolio` (spread + overwrite); never rebuild sibling collections.
- **Out of scope (do NOT touch):** the 4 money slices `pb.positions.v2`/`pb.transactions.v1`/`pb.contributions.v1`/`pb.tfsa.deposits.v1` and their mutators (`addPosition`, `importPositions`, `updatePosition`, `sellPosition`, `removePosition(s)`, `addContribution`, `removeContribution`, `importContributions`, `addTfsaDeposit`, `updateTfsaDeposit`, `removeTfsaDeposit(s)`); `pb.fxRates.v1`; removing `toast`; any self-subscription/`React.memo` sweep.
- **Mutator bodies stay unchanged** — only the slice declarations + setter wrappers change in `usePortfolio`.
- **This session does NOT commit/push/merge.** Jan does that manually. Where a task says "Commit," instead leave the change staged-but-uncommitted and report status. Run all tests regardless.
- **Test runner:** no npm script; run each suite with `node backend/test/<file>.test.mjs`. app.js ships **CRLF**; the Edit tool normalizes CRLF when matching, so `\n`-based edits are fine.

---

### Task 1: PBStore collections mechanism (pure + Node tests)

**Files:**
- Modify: `pb-store.js` (store init ~29; add mechanism after the settings block ~67; extend export object ~83-89)
- Test: `backend/test/store.test.mjs` (append after the settings tests, before/after the existing helpers)

**Interfaces:**
- Consumes: the module-local `appStore = createStore(...)`, `R()` React resolver, `appStore.subscribe`.
- Produces (added to `PBStore`):
  - `configureCollections({ schema, storage })` — `schema: [{name,key,default}]`, `storage: {get(key,default), set(key,value)}`. Seeds `portfolio[name] = storage.get(key, default)`.
  - `getCollection(name) -> any` (non-reactive).
  - `setCollection(name, valueOrFn)` — `valueOrFn(prev)` when a function; writes through `storage.set(key, value)` then replaces only `portfolio[name]`. Unknown name = no-op.
  - `useCollection(name) -> any` — `useSyncExternalStore` binding (browser-only).

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/store.test.mjs` (the `fakeStorage` helper from the settings block is reused):

```js
// ─── portfolio collections slice (Increment 3a) ──────────────────────────────
test('configureCollections: seeds from storage, falling back to default', () => {
  const storage = fakeStorage({ 'pb.watchlist.v2': [{ ticker: 'AAPL' }] });
  PBStore.configureCollections({ storage, schema: [
    { name: 'watchlist', key: 'pb.watchlist.v2', default: [] },
    { name: 'sectorWeights', key: 'pb.sectorWeights.v1', default: {} },
  ]});
  assert.deepStrictEqual(PBStore.getCollection('watchlist'), [{ ticker: 'AAPL' }]); // stored wins
  assert.deepStrictEqual(PBStore.getCollection('sectorWeights'), {});               // default when absent
});

test('setCollection: value form writes through + updates slice + notifies', () => {
  const storage = fakeStorage();
  PBStore.configureCollections({ storage, schema: [
    { name: 'alerts', key: 'pb.alerts.v2', default: [] },
  ]});
  let hits = 0;
  const unsub = PBStore.subscribe(() => { hits++; });
  PBStore.setCollection('alerts', [{ id: 1 }]);
  assert.deepStrictEqual(PBStore.getCollection('alerts'), [{ id: 1 }]);
  assert.deepStrictEqual(storage._writes, [['pb.alerts.v2', [{ id: 1 }]]]);
  assert.strictEqual(hits, 1);
  unsub();
});

test('setCollection: function form applies fn(prev) and persists the result', () => {
  const storage = fakeStorage({ 'pb.watchlist.v2': [{ ticker: 'AAPL' }] });
  PBStore.configureCollections({ storage, schema: [
    { name: 'watchlist', key: 'pb.watchlist.v2', default: [] },
  ]});
  PBStore.setCollection('watchlist', prev => [...prev, { ticker: 'MSFT' }]);
  assert.deepStrictEqual(PBStore.getCollection('watchlist'),
    [{ ticker: 'AAPL' }, { ticker: 'MSFT' }]);
  assert.deepStrictEqual(storage._writes[0],
    ['pb.watchlist.v2', [{ ticker: 'AAPL' }, { ticker: 'MSFT' }]]);
});

test('setCollection: unchanged collections keep their reference (selector stability)', () => {
  const storage = fakeStorage();
  PBStore.configureCollections({ storage, schema: [
    { name: 'watchlist', key: 'pb.watchlist.v2', default: [] },
    { name: 'alerts', key: 'pb.alerts.v2', default: [] },
  ]});
  const watchBefore = PBStore.getCollection('watchlist');
  PBStore.setCollection('alerts', [{ id: 1 }]);
  assert.strictEqual(PBStore.getCollection('watchlist'), watchBefore,
    'untouched collection keeps its reference after a sibling changes');
});

test('setCollection: unknown name is a safe no-op', () => {
  const storage = fakeStorage();
  PBStore.configureCollections({ storage, schema: [
    { name: 'alerts', key: 'pb.alerts.v2', default: [] },
  ]});
  assert.doesNotThrow(() => PBStore.setCollection('nope', 1));
  assert.strictEqual(PBStore.getCollection('nope'), undefined);
  assert.strictEqual(storage._writes.length, 0, 'no write for unknown collection');
});

test('namespace isolation: collections and settings do not clobber each other', () => {
  const cStore = fakeStorage();
  const sStore = fakeStorage();
  PBStore.configureSettings({ storage: sStore, schema: [
    { name: 'theme', key: 'pb.theme.v2', default: 'dark' },
  ]});
  PBStore.configureCollections({ storage: cStore, schema: [
    { name: 'alerts', key: 'pb.alerts.v2', default: [] },
  ]});
  PBStore.setCollection('alerts', [{ id: 1 }]);
  assert.strictEqual(PBStore.getSetting('theme'), 'dark', 'collection write left settings intact');
  PBStore.setSetting('theme', 'light');
  assert.deepStrictEqual(PBStore.getCollection('alerts'), [{ id: 1 }], 'setting write left collections intact');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node backend/test/store.test.mjs`
Expected: FAIL — `TypeError: PBStore.configureCollections is not a function` (and the others).

- [ ] **Step 3: Implement the mechanism in `pb-store.js`**

3a. Change the store init (line ~29) to add the `portfolio` namespace:

```js
  const appStore = createStore({ prices: {}, settings: {}, portfolio: {} });
```

3b. Insert this block immediately after the settings block (after `setSetting`, ~line 67, before the `// ─── React bindings` comment):

```js
  // ─── Portfolio collections slice (Increment 3a) ─────────────────────────────
  // Like the settings slice, but for app data collections (arrays/maps): app.js
  // injects the schema (name→pb.* key + default) + an LS storage adapter, so each
  // collection keeps its own key and cloud backup stays byte-identical. Unlike
  // setSetting, setCollection also accepts an updater fn (the mutators use prev=>next).
  let _collKeyByName = {};   // name -> localStorage key
  let _collStorage = null;   // { get(key, default), set(key, value) }

  function configureCollections(cfg) {
    const schema = (cfg && cfg.schema) || []; // [{ name, key, default }]
    _collStorage = (cfg && cfg.storage) || null;
    _collKeyByName = {};
    const seeded = {};
    for (const e of schema) {
      _collKeyByName[e.name] = e.key;
      seeded[e.name] = _collStorage ? _collStorage.get(e.key, e.default) : e.default;
    }
    appStore.setState({ portfolio: seeded });
  }
  function getCollection(name) { return appStore.getState().portfolio[name]; }
  // Replace only the changed key (siblings keep refs). valueOrFn may be a value or
  // an updater applied to the current value.
  function setCollection(name, valueOrFn) {
    const key = _collKeyByName[name];
    if (!key) return;             // unknown collection: no-op
    const prev = appStore.getState().portfolio[name];
    const value = typeof valueOrFn === 'function' ? valueOrFn(prev) : valueOrFn;
    if (_collStorage) _collStorage.set(key, value);
    appStore.setState(p => ({ portfolio: Object.assign({}, p.portfolio, { [name]: value }) }));
  }
```

3c. Add the React binding next to `useSetting` (~line 81):

```js
  function useCollection(name) {
    return R().useSyncExternalStore(appStore.subscribe, () => appStore.getState().portfolio[name]);
  }
```

3d. Extend the `PBStore` export object (~line 83-89) so it includes the new members:

```js
  const PBStore = {
    createStore,
    getPrices, mergePrices, setPricesMap,
    configureSettings, getSettings, getSetting, setSetting,
    configureCollections, getCollection, setCollection,
    subscribe: appStore.subscribe,
    usePricesMap, useSettings, useSetting, useCollection
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node backend/test/store.test.mjs`
Expected: PASS — all existing prices/settings/anti-drift tests plus the 6 new collections tests.

- [ ] **Step 5: Sanity-check the module loads**

Run: `node --check pb-store.js`
Expected: no output (syntax OK).

- [ ] **Step 6: Leave staged for Jan (do not commit)**

Report: Task 1 done, `node backend/test/store.test.mjs` green, `pb-store.js` parses. Changes left uncommitted for Jan.

---

### Task 2: Wire `usePortfolio` slices to the store + anti-drift guards + SW bump

**Files:**
- Modify: `app.js` — `usePortfolio` slice decls (2185, 2191-2192, 2205, 2212); add `PORTFOLIO_SCHEMA` + `configureCollections` call after the `configureSettings` call (after 2669)
- Modify: `sw.js` (cache version bump)
- Test: `backend/test/store.test.mjs` (anti-drift guards); browser smokes `backend/test/verify-watchlist.mjs`, `backend/test/verify-refresh-behavior.mjs`

**Interfaces:**
- Consumes from Task 1: `PBStore.configureCollections`, `PBStore.useCollection`, `PBStore.setCollection`.
- Produces: `usePortfolio` returns the same names (`watchlist`/`setWatchlist`/`alerts`/`setAlerts`/`sectorCache`/`setSectorCache`/`sectorWeights`/`setSectorWeights`/`setSectorWeightsFor`/`watchlistGroups`/`setWatchlistGroups` + all mutators), now store-backed. No consumer signature changes.

- [ ] **Step 1: Write the failing anti-drift guards**

Append to `backend/test/store.test.mjs`:

```js
test('anti-drift: migrated non-money slices no longer use usePersistedState', () => {
  for (const k of ['pb.watchlist.v2','pb.watchlistGroups.v1','pb.alerts.v2',
    'pb.sectorCache.v1','pb.sectorWeights.v1']) {
    const re = new RegExp("usePersistedState\\('" + k.replace(/\./g, '\\.') + "'");
    assert.ok(!re.test(appSrc), `${k} should be migrated off usePersistedState into PBStore`);
  }
});

test('anti-drift: app.js configures PBStore collections with the LS adapter', () => {
  assert.ok(/PBStore\.configureCollections\(\{\s*schema:\s*PORTFOLIO_SCHEMA,\s*storage:\s*LS\s*\}\)/.test(appSrc),
    'app.js should call PBStore.configureCollections({ schema: PORTFOLIO_SCHEMA, storage: LS })');
});

test('anti-drift: money slices stay usePersistedState (3b out of scope)', () => {
  for (const k of ['pb.positions.v2','pb.transactions.v1','pb.contributions.v1','pb.tfsa.deposits.v1']) {
    const re = new RegExp("usePersistedState\\('" + k.replace(/\./g, '\\.') + "'");
    assert.ok(re.test(appSrc), `${k} must remain usePersistedState this increment`);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node backend/test/store.test.mjs`
Expected: FAIL — the watchlist/etc. keys still match `usePersistedState`, and `configureCollections` isn't called yet.

- [ ] **Step 3: Migrate the 5 slice declarations in `usePortfolio`**

In `app.js`, replace line 2185:
```js
  const [watchlist, setWatchlist] = usePersistedState('pb.watchlist.v2', []);
```
with:
```js
  const watchlist = PBStore.useCollection('watchlist');
  const setWatchlist = useCallback(v => PBStore.setCollection('watchlist', v), []);
```

Replace line 2191 (keep the preceding comment block intact):
```js
  const [watchlistGroups, setWatchlistGroups] = usePersistedState('pb.watchlistGroups.v1', []);
```
with:
```js
  const watchlistGroups = PBStore.useCollection('watchlistGroups');
  const setWatchlistGroups = useCallback(v => PBStore.setCollection('watchlistGroups', v), []);
```

Replace line 2192:
```js
  const [alerts, setAlerts] = usePersistedState('pb.alerts.v2', []);
```
with:
```js
  const alerts = PBStore.useCollection('alerts');
  const setAlerts = useCallback(v => PBStore.setCollection('alerts', v), []);
```

Replace line 2205 (keep the preceding comment block intact):
```js
  const [sectorCache, setSectorCache] = usePersistedState('pb.sectorCache.v1', {});
```
with:
```js
  const sectorCache = PBStore.useCollection('sectorCache');
  const setSectorCache = useCallback(v => PBStore.setCollection('sectorCache', v), []);
```

Replace line 2212 (keep the preceding comment block intact):
```js
  const [sectorWeights, setSectorWeights] = usePersistedState('pb.sectorWeights.v1', {});
```
with:
```js
  const sectorWeights = PBStore.useCollection('sectorWeights');
  const setSectorWeights = useCallback(v => PBStore.setCollection('sectorWeights', v), []);
```

Leave `setSectorWeightsFor` (2213-2220) and every mutator body unchanged — they call these wrappers.

- [ ] **Step 4: Add the schema + configure call**

In `app.js`, immediately after line 2669 (`PBStore.configureSettings({ schema: SETTINGS_SCHEMA, storage: LS });`), insert:

```js
// ─── Portfolio collections registry (Increment 3a: non-money slices → PBStore) ─
// The 5 non-money usePortfolio slices, each seeded from / written through to its
// own pb.* key via the injected LS adapter (cloud backup stays byte-identical;
// pb.sectorCache.v1 is in BACKUP_SKIP so LS.set still skips its backup-notify).
// The 4 money slices + their async mutators stay in usePortfolio (Increment 3b).
const PORTFOLIO_SCHEMA = [
  { name: 'watchlist',       key: 'pb.watchlist.v2',       default: [] },
  { name: 'watchlistGroups', key: 'pb.watchlistGroups.v1', default: [] },
  { name: 'alerts',          key: 'pb.alerts.v2',          default: [] },
  { name: 'sectorCache',     key: 'pb.sectorCache.v1',     default: {} },
  { name: 'sectorWeights',   key: 'pb.sectorWeights.v1',   default: {} },
];
PBStore.configureCollections({ schema: PORTFOLIO_SCHEMA, storage: LS });
```

- [ ] **Step 5: Verify the anti-drift guards + full node suite pass**

Run: `node backend/test/store.test.mjs`
Expected: PASS — including the 3 new guards.

Run the full suite to confirm nothing else regressed:
Run: `for f in backend/test/*.test.mjs; do node "$f" || echo "FAIL $f"; done`
Expected: every suite exits 0 (no `FAIL` lines).

- [ ] **Step 6: Verify `app.js` parses**

Run: `node --check app.js`
Expected: no output.

- [ ] **Step 7: Bump the SW cache version**

In `sw.js`, find the cache constant (currently `...v38`) and bump it to `v39` (single occurrence; matches the value bumped to v38 in Increment 2).

Run: `node --check sw.js`
Expected: no output.

- [ ] **Step 8: Browser smoke — the required gate**

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: app MOUNTS (no `PBStore.useCollection`/ReferenceError); the refresh-behavior assertions match baseline (incl. the standing "holdings rows deliberately have NO session badge" assertion).

Run: `node backend/test/verify-watchlist.mjs`
Expected: adding a watch + toggling a list works and persists across reload — i.e. `addWatch`/`toggleWatchList`/`removeWatch` still drive `pb.watchlist.v2` through the store. (If this harness needs the dev server, start it per the harness's header comment.)

If either smoke fails to MOUNT, that's a real regression in the wiring — debug before proceeding (node suites can't catch a browser-only ReferenceError; this is the Increment-1/2 lesson).

- [ ] **Step 9: Leave staged for Jan (do not commit)**

Report: Task 2 done. List the green node suites + browser-smoke results. Note `sw.js` v38→v39. Changes left uncommitted for Jan to review + commit.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Store mechanism (configureCollections/getCollection/setCollection/useCollection + functional updater + namespace isolation) → Task 1. ✅
- 5 non-money slices migrated; money slices untouched → Task 2 Steps 3-4 + the out-of-scope guard. ✅
- Persistence byte-identical via injected `LS` (incl. sectorCache backup-skip) → Task 2 Step 4 schema uses `storage: LS`; Global Constraints. ✅
- Mutator bodies unchanged; setter wrappers store-backed → Task 2 Step 3 (only decls change). ✅
- `importPositions` + App sector-fill effects keep calling `setSectorCache` (now a wrapper) → no edit needed; covered by "mutator bodies unchanged" + wrappers. ✅
- Anti-drift guards (migrated keys off usePersistedState; configureCollections called; money slices retained) → Task 2 Step 1. ✅
- SW bump v38→v39 → Task 2 Step 7. ✅
- Browser smoke required gate → Task 2 Step 8. ✅
- No commit (Jan's) → Global Constraints + each task's final step. ✅

**Placeholder scan:** none — every step has concrete code/commands. ✅

**Type/name consistency:** `configureCollections`/`getCollection`/`setCollection`/`useCollection`, `PORTFOLIO_SCHEMA`, slice names (`watchlist`/`watchlistGroups`/`alerts`/`sectorCache`/`sectorWeights`) are identical across Task 1 interfaces, Task 2 wiring, and the tests. ✅
