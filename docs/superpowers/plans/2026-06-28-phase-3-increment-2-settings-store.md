# Phase 3 Increment 2 — Settings slice → PBStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the 11 App-level settings out of per-key `usePersistedState` into a `settings` slice on `PBStore`, killing settings prop-drilling while keeping per-key localStorage persistence (cloud backup/restore byte-compatible).

**Architecture:** Add a generic, app-agnostic persisted-settings mechanism to `pb-store.js` (`configureSettings`/`getSetting`/`setSetting`/`useSetting`), with the app-specific schema + the `LS` storage adapter injected from `app.js` (mirrors `PBData.configure`). Migrate in two stages: first relocate ownership into the store with every prop still flowing (a fully-working checkpoint), then have consumers self-subscribe and drop the props (hybrid: `displayCurrency` stays a prop into deep money-math paths).

**Tech Stack:** Vanilla global-script React 18 (UMD), `useSyncExternalStore`, no build step. Node `node:test` for unit tests, headless-Chrome CDP harnesses for browser smoke.

## Global Constraints

- No build step: `pb-store.js` is a dual-mode classic script (`module.exports` for Node + `globalThis.PBStore` for browser). No new dependencies, no CDN libs.
- Each migrated setting MUST keep its own `pb.X.vN` localStorage key, written via the injected `LS` adapter (so `gatherBackup()` enumeration + the `_backupNotify` cloud-sync trigger stay identical). NO combined `pb.settings.v1` blob.
- React-binding hooks in `pb-store.js` MUST resolve React lazily via the existing `R()` guard so `require()` under Node never touches React.
- `setSetting(name, value)` takes a plain value — all call sites use the value form (verified); no functional-updater support needed.
- Selector-stability contract: `setSetting` replaces only the changed key inside `settings` (spread + overwrite); never rebuild sibling values.
- `app.js` ships with CRLF line endings; the Edit tool normalizes CRLF when matching, so `\n`-based edits are fine.
- Browser smoke (`verify-settings.mjs` + `verify-refresh-behavior.mjs`) is a REQUIRED gate before "done" — Node-only suites never load `app.js` in a browser (the Phase-2 `NAME_CACHE` / Increment-1 lessons).
- Test runner: no npm script; run each suite with `node backend/test/<name>.test.mjs`.
- Out of scope: `fxRates` (stays `usePersistedState`), portfolio slices, mutator→action, toast-out-of-data-layer, broader `React.memo` sweep.

---

### Task 1: PBStore settings mechanism + Node tests

**Files:**
- Modify: `pb-store.js` (add settings state, schema/storage injection, accessors, hooks, exports)
- Test: `backend/test/store.test.mjs` (append settings tests)

**Interfaces:**
- Consumes: existing `createStore`, the module-private `appStore`, `R()` (lazy React), `appStore.subscribe`.
- Produces:
  - `configureSettings({ schema, storage })` — `schema: [{name, key, default}]`; `storage: { get(key, default), set(key, value) }`. Seeds `appStore` `settings` slice (per entry: `storage.get(key, default)`); records `name→key`.
  - `getSettings() → object` (non-reactive whole settings slice)
  - `getSetting(name) → value` (non-reactive)
  - `setSetting(name, value)` — unknown `name` is a no-op; else `storage.set(key, value)` then replace `settings` with `{...settings, [name]: value}`.
  - `useSettings() → settings object` ; `useSetting(name) → value` (both `useSyncExternalStore`).

- [ ] **Step 1: Write the failing tests** — append to `backend/test/store.test.mjs` (after the existing `setPricesMap` test, before the `createStoreOf` helper line is fine; place at end of file after the anti-drift tests):

```js
// ─── settings slice (Increment 2) ────────────────────────────────────────────
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  return {
    get: (k, d) => (map.has(k) ? map.get(k) : d),
    set: (k, v) => { map.set(k, v); writes.push([k, v]); },
    _map: map, _writes: writes,
  };
}

test('configureSettings: seeds from storage, falling back to default', () => {
  const storage = fakeStorage({ 'pb.theme.v2': 'light' });
  PBStore.configureSettings({ storage, schema: [
    { name: 'theme', key: 'pb.theme.v2', default: 'dark' },
    { name: 'displayCurrency', key: 'pb.displayCurrency.v1', default: 'USD' },
  ]});
  assert.strictEqual(PBStore.getSetting('theme'), 'light');          // stored value wins
  assert.strictEqual(PBStore.getSetting('displayCurrency'), 'USD');  // default when absent
});

test('getSettings: returns the whole settings object', () => {
  const storage = fakeStorage();
  PBStore.configureSettings({ storage, schema: [
    { name: 'theme', key: 'pb.theme.v2', default: 'dark' },
    { name: 'donutTopN', key: 'pb.donutTopN.v1', default: 10 },
  ]});
  assert.deepStrictEqual(PBStore.getSettings(), { theme: 'dark', donutTopN: 10 });
});

test('setSetting: write-through to storage + updates slice + notifies subscribers', () => {
  const storage = fakeStorage();
  PBStore.configureSettings({ storage, schema: [
    { name: 'theme', key: 'pb.theme.v2', default: 'dark' },
  ]});
  let hits = 0;
  const unsub = PBStore.subscribe(() => { hits++; });
  PBStore.setSetting('theme', 'light');
  assert.strictEqual(PBStore.getSetting('theme'), 'light');
  assert.deepStrictEqual(storage._writes, [['pb.theme.v2', 'light']]);
  assert.strictEqual(hits, 1);
  unsub();
});

test('setSetting: unchanged settings keep their reference (selector stability)', () => {
  const storage = fakeStorage();
  PBStore.configureSettings({ storage, schema: [
    { name: 'ribbonItems', key: 'pb.ribbonItems.v1', default: ['US:^SPX'] },
    { name: 'theme', key: 'pb.theme.v2', default: 'dark' },
  ]});
  const ribbonBefore = PBStore.getSetting('ribbonItems');
  PBStore.setSetting('theme', 'light');
  assert.strictEqual(PBStore.getSetting('ribbonItems'), ribbonBefore,
    'untouched setting keeps its reference after a sibling changes');
});

test('setSetting: unknown name is a safe no-op', () => {
  const storage = fakeStorage();
  PBStore.configureSettings({ storage, schema: [
    { name: 'theme', key: 'pb.theme.v2', default: 'dark' },
  ]});
  assert.doesNotThrow(() => PBStore.setSetting('nope', 1));
  assert.strictEqual(PBStore.getSetting('nope'), undefined);
  assert.strictEqual(storage._writes.length, 0, 'no write for unknown setting');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node backend/test/store.test.mjs`
Expected: FAIL — `TypeError: PBStore.configureSettings is not a function` (and the other new accessors undefined).

- [ ] **Step 3: Implement the settings mechanism in `pb-store.js`**

Change the store's initial state to include `settings` (find `const appStore = createStore({ prices: {} });`):

```js
  // The single app store. Holds prices (Increment 1) + settings (Increment 2).
  const appStore = createStore({ prices: {}, settings: {} });
```

Add the settings block immediately after the `setPricesMap` function (before the `// ─── React bindings` comment):

```js
  // ─── Settings slice (Increment 2) ───────────────────────────────────────────
  // App-agnostic: app.js injects the schema (name→localStorage key + default) and
  // a storage adapter ({get,set}) at startup via configureSettings. The store
  // seeds from storage on configure and write-throughs on every setSetting, so each
  // setting keeps its own pb.* key (cloud backup/restore stays byte-compatible).
  let _settingsSchema = [];       // [{ name, key, default }]
  let _settingsKeyByName = {};    // name -> localStorage key
  let _settingsStorage = null;    // { get(key, default), set(key, value) }

  function configureSettings(cfg) {
    _settingsSchema = (cfg && cfg.schema) || [];
    _settingsStorage = (cfg && cfg.storage) || null;
    _settingsKeyByName = {};
    const seeded = {};
    for (const e of _settingsSchema) {
      _settingsKeyByName[e.name] = e.key;
      seeded[e.name] = _settingsStorage ? _settingsStorage.get(e.key, e.default) : e.default;
    }
    appStore.setState({ settings: seeded });
  }
  function getSettings() { return appStore.getState().settings; }
  function getSetting(name) { return appStore.getState().settings[name]; }
  // Replace only the changed key (selector-stability contract: siblings keep refs).
  function setSetting(name, value) {
    const key = _settingsKeyByName[name];
    if (!key) return;             // unknown setting: no-op
    if (_settingsStorage) _settingsStorage.set(key, value);
    appStore.setState(prev => ({ settings: Object.assign({}, prev.settings, { [name]: value }) }));
  }
```

Add the two hooks next to `usePricesMap` (inside the React-bindings section):

```js
  function useSettings() {
    return R().useSyncExternalStore(appStore.subscribe, getSettings);
  }
  function useSetting(name) {
    return R().useSyncExternalStore(appStore.subscribe, () => appStore.getState().settings[name]);
  }
```

Extend the exported `PBStore` object (find the existing literal and add the new members):

```js
  const PBStore = {
    createStore,
    getPrices, mergePrices, setPricesMap,
    configureSettings, getSettings, getSetting, setSetting,
    subscribe: appStore.subscribe,
    usePricesMap, useSettings, useSetting
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node backend/test/store.test.mjs`
Expected: PASS — all existing price tests + the 5 new settings tests pass. Also run `node --check pb-store.js` → no output (clean).

- [ ] **Step 5: Commit**

```bash
git add pb-store.js backend/test/store.test.mjs
git commit -m "Phase 3 inc 2: PBStore settings slice (configureSettings/getSetting/setSetting/useSetting) + tests"
```

---

### Task 2: Relocate the 11 settings into the store (props still flow — working checkpoint)

**Files:**
- Modify: `app.js` — add `SETTINGS_SCHEMA` + `configureSettings` call at module scope; replace the 11 `usePersistedState` settings declarations in `App()` with `useSetting` + stable `useCallback` setters bound to the SAME local names.
- Test: `backend/test/store.test.mjs` — add anti-drift source guards.

**Interfaces:**
- Consumes: `PBStore.configureSettings`, `PBStore.useSetting`, `PBStore.setSetting` (Task 1); existing `LS`, `DEFAULT_RIBBON_ITEMS`, `DEFAULT_TAB_ORDER`, `useCallback`, `useEffect`.
- Produces: the local names `theme/setTheme`, `iconTheme/setIconTheme`, `perplexityKey/setPerplexityKey`, `pushBackend/setPushBackend`, `displayCurrency/setDisplayCurrency`, `donutPalette/setDonutPalette`, `donutTopN/setDonutTopN`, `ribbonItems/setRibbonItems`, `ribbonMode/setRibbonMode`, `tabOrder/setTabOrder`, `hiddenTabs/setHiddenTabs` — identical shapes to before, now store-backed. Every existing `createElement(SettingsModal/Hero/OverviewView/PortfolioView, …)` prop pass is UNCHANGED in this task.

- [ ] **Step 1: Write the failing anti-drift tests** — append to `backend/test/store.test.mjs`:

```js
test('anti-drift: migrated settings no longer use usePersistedState', () => {
  for (const k of ['pb.theme.v2','pb.iconTheme.v1','pb.perplexityKey.v1','pb.pushBackend.v1',
    'pb.displayCurrency.v1','pb.donutPalette.v1','pb.donutTopN.v1','pb.ribbonItems.v1',
    'pb.ribbonMode.v1','pb.tabOrder.v2','pb.hiddenTabs.v1']) {
    const re = new RegExp("usePersistedState\\('" + k.replace(/\./g, '\\.') + "'");
    assert.ok(!re.test(appSrc), `${k} should be migrated off usePersistedState into PBStore`);
  }
});

test('anti-drift: app.js configures PBStore settings with the LS adapter', () => {
  assert.ok(/PBStore\.configureSettings\(\{\s*schema:\s*SETTINGS_SCHEMA,\s*storage:\s*LS\s*\}\)/.test(appSrc),
    'app.js should call PBStore.configureSettings({ schema: SETTINGS_SCHEMA, storage: LS })');
});

test('anti-drift: fxRates stays usePersistedState (out of scope)', () => {
  assert.ok(/usePersistedState\('pb\.fxRates\.v1'/.test(appSrc),
    'fxRates must remain usePersistedState this increment');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node backend/test/store.test.mjs`
Expected: FAIL — the migrated-keys guard fails (app.js still has `usePersistedState('pb.theme.v2'…)`) and the `configureSettings` guard fails (call not present yet).

- [ ] **Step 3a: Add `SETTINGS_SCHEMA` + the configure call at module scope**

Immediately AFTER the `DEFAULT_TAB_ORDER` definition (`const DEFAULT_TAB_ORDER = ALL_TAB_KEYS.slice();`), insert:

```js
// ─── Settings registry (Increment 2: migrated from per-key usePersistedState) ──
// Each entry { name, key, default } is seeded from localStorage via the injected LS
// adapter and write-through on change, so every setting keeps its own pb.* key and
// cloud backup/restore stays byte-compatible. fxRates is intentionally NOT here.
const SETTINGS_SCHEMA = [
  { name: 'theme',           key: 'pb.theme.v2',           default: 'dark' },
  { name: 'iconTheme',       key: 'pb.iconTheme.v1',       default: (typeof window !== 'undefined' && window.__pbIconTheme) || 'dark' },
  { name: 'perplexityKey',   key: 'pb.perplexityKey.v1',   default: '' },
  { name: 'pushBackend',     key: 'pb.pushBackend.v1',     default: '' },
  { name: 'displayCurrency', key: 'pb.displayCurrency.v1', default: 'USD' },
  { name: 'donutPalette',    key: 'pb.donutPalette.v1',    default: 'spectrum' },
  { name: 'donutTopN',       key: 'pb.donutTopN.v1',       default: 10 },
  { name: 'ribbonItems',     key: 'pb.ribbonItems.v1',     default: DEFAULT_RIBBON_ITEMS },
  { name: 'ribbonMode',      key: 'pb.ribbonMode.v1',      default: 'rows' },
  { name: 'tabOrder',        key: 'pb.tabOrder.v2',        default: DEFAULT_TAB_ORDER },
  { name: 'hiddenTabs',      key: 'pb.hiddenTabs.v1',      default: [] },
];
PBStore.configureSettings({ schema: SETTINGS_SCHEMA, storage: LS });
```

(`DEFAULT_RIBBON_ITEMS` and `LS` are defined earlier in the file; `configureSettings` only seeds the store — it does not render.)

- [ ] **Step 3b: Replace the 11 `usePersistedState` declarations in `App()`**

Find this block at the top of `function App() {` (lines ~2722–2746):

```js
  const [theme, setTheme] = usePersistedState('pb.theme.v2', 'dark');
  // Home-screen / favicon icon tile. Synced to the bootstrap in index.html via
  // window.applyIconTheme so the apple-touch-icon + manifest swap to match.
  const [iconTheme, setIconTheme] = usePersistedState('pb.iconTheme.v1',
    (typeof window !== 'undefined' && window.__pbIconTheme) || 'dark');
  useEffect(() => {
    if (typeof window !== 'undefined' && window.applyIconTheme) window.applyIconTheme(iconTheme);
  }, [iconTheme]);
  const [perplexityKey, setPerplexityKey] = usePersistedState('pb.perplexityKey.v1', '');
  const [pushBackend, setPushBackend] = usePersistedState('pb.pushBackend.v1', '');
  const [displayCurrency, setDisplayCurrency] = usePersistedState('pb.displayCurrency.v1', 'USD');
  // Allocation donut appearance (Settings → Appearance), two independent knobs:
  //  • palette — 'spectrum' (a distinct multi-hue colour per holding) or 'indigo'
  //    (the brand's periwinkle→blue gradient). Both scale to any holding count.
  //  • topN — how many of the largest holdings to show individually before the
  //    rest fold into one "Other" wedge (0 = show all). Holdings view only;
  //    sectors and markets are never grouped.
  const [donutPalette, setDonutPalette] = usePersistedState('pb.donutPalette.v1', 'spectrum');
  const [donutTopN, setDonutTopN] = usePersistedState('pb.donutTopN.v1', 10);
  const [fxRates, setFxRates] = usePersistedState('pb.fxRates.v1', null);
  const [ribbonItems, setRibbonItems] = usePersistedState('pb.ribbonItems.v1', DEFAULT_RIBBON_ITEMS);
  const [ribbonMode, setRibbonMode] = usePersistedState('pb.ribbonMode.v1', 'rows');
  const [showSettings, setShowSettings] = useState(false);
  const [tabOrder, setTabOrder] = usePersistedState('pb.tabOrder.v2', DEFAULT_TAB_ORDER);
  const [hiddenTabs, setHiddenTabs] = usePersistedState('pb.hiddenTabs.v1', []);
```

Replace it with (settings now read from the store; `fxRates` + `showSettings` unchanged; the `iconTheme` effect preserved; setters are stable via `useCallback` to match the old `useState`-setter identity contract):

```js
  const theme = PBStore.useSetting('theme');
  const setTheme = useCallback((v) => PBStore.setSetting('theme', v), []);
  // Home-screen / favicon icon tile. Synced to the bootstrap in index.html via
  // window.applyIconTheme so the apple-touch-icon + manifest swap to match.
  const iconTheme = PBStore.useSetting('iconTheme');
  const setIconTheme = useCallback((v) => PBStore.setSetting('iconTheme', v), []);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.applyIconTheme) window.applyIconTheme(iconTheme);
  }, [iconTheme]);
  const perplexityKey = PBStore.useSetting('perplexityKey');
  const setPerplexityKey = useCallback((v) => PBStore.setSetting('perplexityKey', v), []);
  const pushBackend = PBStore.useSetting('pushBackend');
  const setPushBackend = useCallback((v) => PBStore.setSetting('pushBackend', v), []);
  const displayCurrency = PBStore.useSetting('displayCurrency');
  const setDisplayCurrency = useCallback((v) => PBStore.setSetting('displayCurrency', v), []);
  // Allocation donut appearance (Settings → Appearance), two independent knobs:
  //  • palette — 'spectrum' (a distinct multi-hue colour per holding) or 'indigo'
  //    (the brand's periwinkle→blue gradient). Both scale to any holding count.
  //  • topN — how many of the largest holdings to show individually before the
  //    rest fold into one "Other" wedge (0 = show all). Holdings view only;
  //    sectors and markets are never grouped.
  const donutPalette = PBStore.useSetting('donutPalette');
  const setDonutPalette = useCallback((v) => PBStore.setSetting('donutPalette', v), []);
  const donutTopN = PBStore.useSetting('donutTopN');
  const setDonutTopN = useCallback((v) => PBStore.setSetting('donutTopN', v), []);
  const [fxRates, setFxRates] = usePersistedState('pb.fxRates.v1', null);
  const ribbonItems = PBStore.useSetting('ribbonItems');
  const setRibbonItems = useCallback((v) => PBStore.setSetting('ribbonItems', v), []);
  const ribbonMode = PBStore.useSetting('ribbonMode');
  const setRibbonMode = useCallback((v) => PBStore.setSetting('ribbonMode', v), []);
  const [showSettings, setShowSettings] = useState(false);
  const tabOrder = PBStore.useSetting('tabOrder');
  const setTabOrder = useCallback((v) => PBStore.setSetting('tabOrder', v), []);
  const hiddenTabs = PBStore.useSetting('hiddenTabs');
  const setHiddenTabs = useCallback((v) => PBStore.setSetting('hiddenTabs', v), []);
```

- [ ] **Step 4: Syntax-check + run the anti-drift tests**

Run: `node --check app.js`
Expected: no output (clean parse).

Run: `node backend/test/store.test.mjs`
Expected: PASS — the 3 new anti-drift guards pass and all earlier tests stay green.

- [ ] **Step 5: Browser smoke (required gate — proves store seeding + persistence end-to-end)**

Run: `node backend/test/verify-settings.mjs`
Expected: `✅ ALL CHECKS PASSED` (app mounts; Settings opens; Currency/Tabs/Holdings/Connections sections render; the Tabs drag reorders — exercising `setTabOrder` write-through; the seeded `pb.perplexityKey.v1` reads through the store into the Connections card).

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: `✅ ALL CHECKS PASSED` (app mounts with the new store wiring; prices still paint).

> If `verify-settings` fails an assertion tied to a setting, the store wiring is broken — fix before committing. (Screenshot-only harnesses have a known flaky CDP "Execution context destroyed" race; `verify-settings`/`verify-refresh-behavior` are assertion-based and reliable.)

- [ ] **Step 6: Commit**

```bash
git add app.js backend/test/store.test.mjs
git commit -m "Phase 3 inc 2: settings own-state moves to PBStore (props still flow); anti-drift guards"
```

---

### Task 3: `SettingsModal` self-subscribes (drop 19 settings props)

**Files:**
- Modify: `app.js` — `SettingsModal` signature + internals; the `createElement(SettingsModal, {…})` call site in `App()`; remove the now-dead App setter bindings.

**Interfaces:**
- Consumes: `PBStore.useSetting`, `PBStore.setSetting`.
- Produces: `SettingsModal` no longer receives `displayCurrency, onSetDisplayCurrency, ribbonItems, onSetRibbonItems, ribbonMode, onSetRibbonMode, onSetTabOrder, onSetHiddenTabs, perplexityKey, onSetPerplexityKey, pushBackend, iconTheme, onSetIconTheme, theme, onSetTheme, donutPalette, onSetDonutPalette, donutTopN, onSetDonutTopN`. It STILL receives `tabOrder` (the reconciled `orderedKeys`) + `hiddenTabs` as read props, plus all non-settings props.

- [ ] **Step 1: Rewrite the `SettingsModal` parameter list**

Find:

```js
function SettingsModal({ displayCurrency, onSetDisplayCurrency, fxRates, onRefreshFx,
                        positions, contributions, onExport, onImport, cloudBackup, onDeleteHoldings,
                        ribbonItems, onSetRibbonItems, ribbonMode, onSetRibbonMode,
                        tabOrder, hiddenTabs, onSetTabOrder, onSetHiddenTabs,
                        perplexityKey, onSetPerplexityKey, pushBackend, pushStatus,
                        onConnectPush, onTestPush, onDisconnectPush,
                        iconTheme, onSetIconTheme, theme, onSetTheme,
                        donutPalette, onSetDonutPalette, donutTopN, onSetDonutTopN, onClose }) {
  const prices = PBStore.usePricesMap();
```

Replace with (drop the 19 settings props; keep `tabOrder`/`hiddenTabs` reads + all non-settings props; self-subscribe the rest at the top):

```js
function SettingsModal({ fxRates, onRefreshFx,
                        positions, contributions, onExport, onImport, cloudBackup, onDeleteHoldings,
                        tabOrder, hiddenTabs,
                        pushStatus, onConnectPush, onTestPush, onDisconnectPush, onClose }) {
  const prices = PBStore.usePricesMap();
  // Settings edited here are read/written directly on the store (no prop-drilling).
  const displayCurrency = PBStore.useSetting('displayCurrency');
  const ribbonItems = PBStore.useSetting('ribbonItems');
  const ribbonMode = PBStore.useSetting('ribbonMode');
  const perplexityKey = PBStore.useSetting('perplexityKey');
  const pushBackend = PBStore.useSetting('pushBackend');
  const iconTheme = PBStore.useSetting('iconTheme');
  const theme = PBStore.useSetting('theme');
  const donutPalette = PBStore.useSetting('donutPalette');
  const donutTopN = PBStore.useSetting('donutTopN');
```

- [ ] **Step 2: Replace the `onSetX(...)` write callbacks inside `SettingsModal` with `PBStore.setSetting(...)`**

Within the `SettingsModal` body, replace each call (use exact-string edits; there is one logical replacement per name):

| Find | Replace |
|---|---|
| `onSetDisplayCurrency(` | `PBStore.setSetting('displayCurrency', ` — and ensure the matching close paren stays balanced |
| `onSetRibbonItems(ribbonItems.filter(k => k !== item.key))` | `PBStore.setSetting('ribbonItems', ribbonItems.filter(k => k !== item.key))` |
| `onSetRibbonItems([...ribbonItems, item.key])` | `PBStore.setSetting('ribbonItems', [...ribbonItems, item.key])` |
| `onSetRibbonMode(` | `PBStore.setSetting('ribbonMode', ` |
| `onSetTabOrder(finalOrder)` | `PBStore.setSetting('tabOrder', finalOrder)` |
| `onSetHiddenTabs(hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key])` | `PBStore.setSetting('hiddenTabs', hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key])` |
| `onSetPerplexityKey(` | `PBStore.setSetting('perplexityKey', ` |
| `onSetIconTheme(` | `PBStore.setSetting('iconTheme', ` |
| `onSetTheme(` | `PBStore.setSetting('theme', ` |
| `onSetDonutPalette(` | `PBStore.setSetting('donutPalette', ` |
| `onSetDonutTopN(` | `PBStore.setSetting('donutTopN', ` |

For the four `(`-suffixed entries, grep first to see each call and rewrite the whole call so parens stay balanced:

Run: `git grep -n "onSetDisplayCurrency(\|onSetRibbonMode(\|onSetPerplexityKey(\|onSetIconTheme(\|onSetTheme(\|onSetDonutPalette(\|onSetDonutTopN(" -- app.js`
Then edit each matched call to the `PBStore.setSetting('<name>', <sameArg>)` form.

- [ ] **Step 3: Trim the `createElement(SettingsModal, {…})` call site in `App()`**

Find the props object (lines ~3392–3426) and DELETE these lines (the 19 dropped props):

```js
    displayCurrency: displayCurrency,
    onSetDisplayCurrency: setDisplayCurrency,
    ribbonItems: ribbonItems,
    onSetRibbonItems: setRibbonItems,
    ribbonMode: ribbonMode,
    onSetRibbonMode: setRibbonMode,
    onSetTabOrder: setTabOrder,
    onSetHiddenTabs: setHiddenTabs,
    perplexityKey: perplexityKey,
    onSetPerplexityKey: setPerplexityKey,
    pushBackend: pushBackend,
    iconTheme: iconTheme,
    onSetIconTheme: setIconTheme,
    theme: theme,
    onSetTheme: setTheme,
    donutPalette: donutPalette,
    onSetDonutPalette: setDonutPalette,
    donutTopN: donutTopN,
    onSetDonutTopN: setDonutTopN,
```

KEEP (do not delete): `fxRates`, `onRefreshFx`, `positions`, `contributions`, `onExport`, `onImport`, `cloudBackup`, `onDeleteHoldings`, `tabOrder: orderedKeys`, `hiddenTabs: hiddenTabs`, `pushStatus`, `onConnectPush`, `onTestPush`, `onDisconnectPush`, `onClose`.

- [ ] **Step 4: Remove the now-dead App setter bindings**

In `App()`, delete the setter lines that ONLY fed `SettingsModal` (their READ bindings stay; `setTabOrder`/`setHiddenTabs` are now unused since SettingsModal writes direct):

```js
  const setTheme = useCallback((v) => PBStore.setSetting('theme', v), []);
  const setIconTheme = useCallback((v) => PBStore.setSetting('iconTheme', v), []);
  const setPerplexityKey = useCallback((v) => PBStore.setSetting('perplexityKey', v), []);
  const setDonutPalette = useCallback((v) => PBStore.setSetting('donutPalette', v), []);
  const setDonutTopN = useCallback((v) => PBStore.setSetting('donutTopN', v), []);
  const setRibbonItems = useCallback((v) => PBStore.setSetting('ribbonItems', v), []);
  const setRibbonMode = useCallback((v) => PBStore.setSetting('ribbonMode', v), []);
  const setTabOrder = useCallback((v) => PBStore.setSetting('tabOrder', v), []);
  const setHiddenTabs = useCallback((v) => PBStore.setSetting('hiddenTabs', v), []);
```

**Do NOT delete** `setPushBackend` (used by `usePushBackend`) or `setDisplayCurrency` (still passed as `onSetDisplayCurrency` to the holdings/portfolio view at ~app.js:3215) — both must remain.

Before deleting each line above, verify it has no OTHER use:
Run: `git grep -n "setRibbonItems\|setRibbonMode\|setTabOrder\|setHiddenTabs\|setTheme\|setIconTheme\|setPerplexityKey\|setDonutPalette\|setDonutTopN" -- app.js`
Each should now appear ONLY in its own `const … = useCallback` definition (zero other references) → safe to delete that line. If any name still has another use, KEEP its binding.

- [ ] **Step 5: Syntax-check + browser smoke**

Run: `node --check app.js`
Expected: clean.

Run: `node backend/test/verify-settings.mjs`
Expected: `✅ ALL CHECKS PASSED` — the Settings modal now reads/writes every knob via the store; Currency select, Tabs drag-reorder, Connections (Perplexity + push) all still work.

Run: `node backend/test/store.test.mjs`
Expected: PASS (anti-drift guards unaffected).

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "Phase 3 inc 2: SettingsModal self-subscribes settings via PBStore (drop 19 props)"
```

---

### Task 4: `Hero` (ribbon) self-subscribes `ribbonItems` / `ribbonMode`

**Files:**
- Modify: `app.js` — `Hero` signature + the `createElement(Hero, {…})` call site. App keeps `ribbonItems` (used by the fetch plan) but drops `ribbonMode` if fully unused.

**Interfaces:**
- Consumes: `PBStore.useSetting`.
- Produces: `Hero` receives only `onOpenDetail`; reads `ribbonItems`/`ribbonMode` from the store.

- [ ] **Step 1: Self-subscribe in `Hero`**

Find:

```js
function Hero(_ref4) {
  let {
    ribbonItems,
    ribbonMode,
    onOpenDetail
  } = _ref4;
  const prices = PBStore.usePricesMap();
```

Replace with:

```js
function Hero(_ref4) {
  let {
    onOpenDetail
  } = _ref4;
  const ribbonItems = PBStore.useSetting('ribbonItems');
  const ribbonMode = PBStore.useSetting('ribbonMode');
  const prices = PBStore.usePricesMap();
```

- [ ] **Step 2: Trim the `createElement(Hero, {…})` call site**

Find:

```js
  }), React.createElement(Hero, {
    ribbonItems: ribbonItems,
    ribbonMode: ribbonMode,
    onOpenDetail: openDetail
  }), React.createElement("nav", {
```

Replace with:

```js
  }), React.createElement(Hero, {
    onOpenDetail: openDetail
  }), React.createElement("nav", {
```

- [ ] **Step 3: Drop `ribbonMode` from App if now unused (keep `ribbonItems` — fetch plan reads it)**

Run: `git grep -n "ribbonMode" -- app.js`
Expected remaining: only inside `Hero` and `SettingsModal` (both self-subscribed) + `SETTINGS_SCHEMA`. If `App()` no longer references `ribbonMode`, delete its binding line in `App()`:

```js
  const ribbonMode = PBStore.useSetting('ribbonMode');
```

Run: `git grep -n "\\bribbonItems\\b" -- app.js`
Confirm `App()` STILL uses `ribbonItems` (the `buildFetchPlan` memo references it) → KEEP `const ribbonItems = PBStore.useSetting('ribbonItems');` in `App()`.

- [ ] **Step 4: Syntax-check + browser smoke**

Run: `node --check app.js`
Expected: clean.

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: `✅ ALL CHECKS PASSED` (Hero/ribbon renders; fetch plan still includes the ribbon symbols).

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "Phase 3 inc 2: Hero ribbon self-subscribes ribbonItems/ribbonMode via PBStore"
```

---

### Task 5: `PortfolioPieChart` self-subscribes `donutPalette` / `donutTopN`

**Files:**
- Modify: `app.js` — `PortfolioPieChart` signature; remove `donutPalette`/`donutTopN` from the whole App→OverviewView/PortfolioView→PortfolioPieChart pass-through chain; remove App's now-dead `donutPalette`/`donutTopN` bindings.

**Interfaces:**
- Consumes: `PBStore.useSetting`.
- Produces: `PortfolioPieChart` reads `donutPalette`/`donutTopN` from the store; no intermediate view threads them.

- [ ] **Step 1: Self-subscribe in `PortfolioPieChart`**

Find the signature:

```js
function PortfolioPieChart({ positions, displayCurrency, fxRates, onOpenDetail, sectorCache, fundamentals, sectorWeights, onSetSectorWeights, availableModes, donutPalette, donutTopN }) {
```

Replace with (drop the two params, add store reads as the first lines of the body):

```js
function PortfolioPieChart({ positions, displayCurrency, fxRates, onOpenDetail, sectorCache, fundamentals, sectorWeights, onSetSectorWeights, availableModes }) {
  const donutPalette = PBStore.useSetting('donutPalette');
  const donutTopN = PBStore.useSetting('donutTopN');
```

(Insert the two `const` lines immediately after the function's opening brace, before its existing first statement.)

- [ ] **Step 2: Strip `donutPalette`/`donutTopN` from every pass-through site (grep-driven)**

`PortfolioPieChart` now reads both from the store, so NO caller threads them. There are **two** consumer views, each with three sites — do NOT stop after one:
- The holdings/portfolio view (App view-map entry at ~3221–3222 → its `_ref6` signature destructure at ~4585–4586 → its `createElement(PortfolioPieChart, {…})` at ~4731).
- `TFSAView` (App view-map entry at ~3287–3288 → its signature destructure at ~8996 → its `createElement(PortfolioPieChart, {…})` at ~9023).

Run: `git grep -n "donutPalette\|donutTopN" -- app.js`

Delete `donutPalette`/`donutTopN` from EVERY match EXCEPT this allowed-remaining set (these must stay):
- `function donutPaletteColors(palette, n)` — unrelated helper (~4184).
- Inside `PortfolioPieChart`: the two `PBStore.useSetting(...)` reads added in Step 1, plus its internal logic (`const groupN = (mode === 'ticker' && typeof donutTopN === 'number' && donutTopN > 0) ? donutTopN : 0;`, `const paletteName = donutPalette === 'indigo' ? 'indigo' : 'spectrum';`, and the `donutTopN` comment ~4327).
- Inside `SettingsModal`: the two `PBStore.useSetting(...)` reads added in Task 3, plus its segmented-control / select usages (~12472–12498).
- The two `SETTINGS_SCHEMA` entries.

Concretely, remove:
- The App view-map props `donutPalette: donutPalette,` + `donutTopN: donutTopN` at ~3221–3222 and ~3287–3288 (fix the now-trailing comma on the preceding `onSetSectorWeights: …,` line if needed).
- The `donutPalette,` + `donutTopN` lines in the `_ref6` holdings/portfolio view destructure (~4585–4586) and in the `TFSAView` signature destructure (~8996).
- `donutPalette, donutTopN` from both inner `createElement(PortfolioPieChart, {…})` calls (~4731 and ~9023).

After editing, re-run `git grep -n "donutPalette\|donutTopN" -- app.js` and confirm the ONLY remaining matches are the allowed-remaining set above.

- [ ] **Step 3: Remove App's now-dead `donutPalette`/`donutTopN` bindings**

In `App()`, delete:

```js
  const donutPalette = PBStore.useSetting('donutPalette');
  const donutTopN = PBStore.useSetting('donutTopN');
```

Run: `git grep -n "donutPalette\|donutTopN" -- app.js` and confirm `App()` no longer references either (all remaining matches are in `PortfolioPieChart`, `OverviewView`/`PortfolioView` are now clean, and `SETTINGS_SCHEMA`).

- [ ] **Step 4: Syntax-check + browser smoke**

Run: `node --check app.js`
Expected: clean.

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: `✅ ALL CHECKS PASSED` (Overview allocation donut still renders with palette/topN read from the store).

> Optional visual confirmation (donut appearance): `node backend/test/verify-sector-weights.mjs` — note this is a screenshot harness with the known flaky CDP race; treat a non-assertion failure as environmental, not a regression.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "Phase 3 inc 2: PortfolioPieChart self-subscribes donutPalette/donutTopN (drop pass-through chain)"
```

---

### Task 6: SW cache bump + full verification sweep

**Files:**
- Modify: `sw.js` (cache version v37 → v38)

**Interfaces:** none (rollout only).

- [ ] **Step 1: Bump the service-worker cache name**

Find: `const CACHE_NAME   = 'playbook-shell-v37';`
Replace: `const CACHE_NAME   = 'playbook-shell-v38';`

(No `index.html` / `static.yml` change — `pb-store.js` was already loaded, precached, and allowlisted in Increment 1.)

- [ ] **Step 2: Full Node test sweep**

Run: `for f in backend/test/*.test.mjs; do echo "== $f =="; node "$f" || echo "FAILED: $f"; done`
Expected: every `*.test.mjs` suite passes (15 suites incl. the extended `store.test.mjs`). No `FAILED:` lines.

- [ ] **Step 3: Browser smoke gate (both assertion-based harnesses)**

Run: `node backend/test/verify-settings.mjs`
Expected: `✅ ALL CHECKS PASSED`.

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: `✅ ALL CHECKS PASSED`.

- [ ] **Step 4: Confirm no stray settings prop-drilling remains**

Run: `git grep -n "onSetDisplayCurrency\|onSetTheme\|onSetIconTheme\|onSetDonutPalette\|onSetDonutTopN\|onSetRibbonItems\|onSetRibbonMode\|onSetPerplexityKey\|onSetTabOrder\|onSetHiddenTabs" -- app.js`
Expected: NO matches (every `onSetX` settings callback prop is gone; writes go through `PBStore.setSetting`).

- [ ] **Step 5: Commit**

```bash
git add sw.js
git commit -m "Phase 3 inc 2: bump SW cache v37->v38 for the settings-store migration"
```

---

## Notes for the implementer
- After every `app.js` edit, `node --check app.js` is the fast guard; the browser smoke is the real gate (a green Node suite cannot prove `app.js` mounts).
- Keep `displayCurrency` as a prop wherever a component renders money/format — it is intentionally NOT swept to `useSetting` this increment (hybrid decision). `SettingsModal` self-subscribes it only for its own currency selector.
- Do NOT touch `fxRates` (stays `usePersistedState`), portfolio slices, or `toast` — later increments.
- Worker / `wrangler`: no impact (client-only).
