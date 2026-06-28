# Phase 3 Increment 1 — Prices Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `prices` map out of `usePriceFeed`'s React state into a tiny hand-rolled store (`pb-store.js`) wired through `useSyncExternalStore`, so a price-batch merge no longer re-renders `App()` and its whole subtree.

**Architecture:** A new dual-mode global script `pb-store.js` (browser `globalThis.PBStore` + CommonJS for Node tests) exposes a pure `createStore` plus a single app store holding `{ prices }`, price read/write helpers, and React hooks. `usePriceFeed` becomes the store's writer; views read via `usePricesMap()`/`usePrice(key)`; `App` drops `prices` prop-drilling. Three single-symbol leaves get `React.memo`.

**Tech Stack:** Plain ES5-ish classic script (no build step), React 18 UMD global (`useSyncExternalStore`), Node's built-in test via `node X.test.mjs`.

## Global Constraints

- **No build step.** `pb-store.js` is a classic `<script>` with a dual-mode footer: `if (typeof module !== 'undefined' && module.exports) module.exports = PBStore;` and `if (typeof globalThis !== 'undefined') globalThis.PBStore = PBStore;`. Mirror `pb-core.js`/`pb-data.js` exactly.
- **React is browser-only.** The pure store core (`createStore`, `getState`/`setState`/`subscribe`, price helpers) MUST run under Node with no React present. Hooks reference `globalThis.React` and are only ever called in the browser.
- **Selector-stability contract:** `mergePrices` MUST build `Object.assign({}, prevPrices, obj)` so every unchanged symbol keeps its existing quote object reference. Never deep-clone untouched quotes — the per-symbol memo win depends on this.
- **Load order in `index.html`:** `pb-core.js` → `pb-data.js` → **`pb-store.js`** → `data.js` → `app.js`.
- **Scope fence:** ONLY `prices` moves. Do not touch settings, portfolio slices, mutator→action conversion, or toast-in-data-layer.
- **Browser smoke is a required gate.** `node verify-refresh-behavior.mjs` (headless Chrome) must pass before any task that touches app.js wiring is considered done — a node-only suite cannot catch a broken browser global (this is the suite that caught the Phase 2 `NAME_CACHE` regression).
- **Test runner:** no npm script; run each suite with `node backend/test/<name>.test.mjs`. Current suite count is 14 (will become 15).
- **app.js / pb-store.js ship CRLF.** The Edit tool normalizes CRLF when matching, so `\n`-based edits are fine. Do NOT add a vm-slice marker that depends on `\n` for app.js.
- **Commit message footer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Pure store core + Node tests (`pb-store.js`)

Build the dependency-free, React-free store and its price helpers. No app wiring yet.

**Files:**
- Create: `pb-store.js`
- Create: `backend/test/store.test.mjs`

**Interfaces:**
- Produces (pure, used by all later tasks):
  - `PBStore.createStore(initial) → { getState(): object, setState(patchOrFn): void, subscribe(listener): () => void }`
  - `PBStore.getPrices() → object` (the current prices map)
  - `PBStore.mergePrices(obj): void` (shallow-merges quotes into the prices slice, preserving unchanged refs)
  - `PBStore.setPricesMap(map): void` (replaces the prices slice wholesale — used for the initial rehydrate seed)
  - `PBStore.subscribe(listener): () => void` (subscribe to the app store; alias of the app store's subscribe)

- [ ] **Step 1: Write the failing test**

Create `backend/test/store.test.mjs`:

```js
import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PBStore = require('../../pb-store.js');

test('createStore: getState returns initial, setState shallow-merges', () => {
  const s = createStoreOf({ a: 1, b: 2 });
  assert.deepStrictEqual(s.getState(), { a: 1, b: 2 });
  s.setState({ b: 9 });
  assert.deepStrictEqual(s.getState(), { a: 1, b: 9 });
});

test('createStore: setState accepts an updater fn', () => {
  const s = createStoreOf({ n: 1 });
  s.setState(prev => ({ n: prev.n + 1 }));
  assert.strictEqual(s.getState().n, 2);
});

test('createStore: setState replaces the top-level reference', () => {
  const s = createStoreOf({ a: 1 });
  const before = s.getState();
  s.setState({ a: 2 });
  assert.notStrictEqual(s.getState(), before);
});

test('createStore: subscribe fires on change; unsubscribe stops it', () => {
  const s = createStoreOf({ a: 1 });
  let hits = 0;
  const unsub = s.subscribe(() => { hits++; });
  s.setState({ a: 2 });
  s.setState({ a: 3 });
  assert.strictEqual(hits, 2);
  unsub();
  s.setState({ a: 4 });
  assert.strictEqual(hits, 2);
});

test('mergePrices: merges and preserves unchanged quote references', () => {
  PBStore.setPricesMap({});
  const aQuote = { price: 10 };
  const bQuote = { price: 20 };
  PBStore.mergePrices({ 'US:A': aQuote, 'US:B': bQuote });
  // a tick on B only
  const bQuote2 = { price: 21 };
  PBStore.mergePrices({ 'US:B': bQuote2 });
  const prices = PBStore.getPrices();
  assert.strictEqual(prices['US:A'], aQuote, 'unchanged symbol keeps its ref');
  assert.strictEqual(prices['US:B'], bQuote2, 'changed symbol updated');
});

test('setPricesMap: replaces the whole prices slice', () => {
  PBStore.setPricesMap({ 'US:X': { price: 1 } });
  assert.deepStrictEqual(Object.keys(PBStore.getPrices()), ['US:X']);
});

// helper: expose createStore via the public API
function createStoreOf(init) { return PBStore.createStore(init); }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node backend/test/store.test.mjs`
Expected: FAIL — `Cannot find module '../../pb-store.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `pb-store.js`:

```js
// ─── Playbook state store ────────────────────────────────────────────────────
// A tiny hand-rolled store (no build step → no Zustand/CDN dependency) wired into
// React 18 via useSyncExternalStore. It exists to move churny shared state (the
// prices map, this increment) out of App()'s React state so a price-batch merge
// re-renders only the components that subscribe — not the whole tree. Third
// member of the pb-core/pb-data family: pure core is React-free + Node-testable;
// the hooks reach for the browser's React global and are only called in-browser.
//
// Dual-mode footer like pb-core.js/pb-data.js: CommonJS module.exports (Node
// tests) + globalThis.PBStore (browser <script> before app.js).
"use strict";
(function () {
  // Pure, React-free, fully unit-testable.
  function createStore(initial) {
    let state = initial;
    const listeners = new Set();
    return {
      getState() { return state; },
      setState(patchOrFn) {
        const patch = typeof patchOrFn === 'function' ? patchOrFn(state) : patchOrFn;
        state = Object.assign({}, state, patch);
        listeners.forEach(fn => fn());
      },
      subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }
    };
  }

  // The single app store. Holds only { prices } this increment (room to grow).
  const appStore = createStore({ prices: {} });

  function getPrices() { return appStore.getState().prices; }
  // Shallow-merge: unchanged symbols keep their existing quote object reference
  // (the per-symbol memo win depends on this — do NOT deep-clone untouched quotes).
  function mergePrices(obj) {
    if (!obj || !Object.keys(obj).length) return;
    appStore.setState(prev => ({ prices: Object.assign({}, prev.prices, obj) }));
  }
  function setPricesMap(map) { appStore.setState({ prices: map || {} }); }

  // ─── React bindings (browser-only) ──────────────────────────────────────────
  // Resolved lazily inside each hook so requiring this file under Node (where
  // there is no React) never throws — the hooks are simply never called there.
  function R() { return (typeof globalThis !== 'undefined' && globalThis.React) || null; }
  function usePricesMap() {
    return R().useSyncExternalStore(appStore.subscribe, getPrices);
  }
  function usePrice(key) {
    return R().useSyncExternalStore(appStore.subscribe, () => getPrices()[key]);
  }

  const PBStore = {
    createStore,
    getPrices, mergePrices, setPricesMap,
    subscribe: appStore.subscribe,
    usePricesMap, usePrice
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PBStore;
  if (typeof globalThis !== 'undefined') globalThis.PBStore = PBStore;
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node backend/test/store.test.mjs`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Sanity-check Node load + syntax**

Run: `node --check pb-store.js`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add pb-store.js backend/test/store.test.mjs
git commit -m "Phase 3 inc 1: pure pb-store.js (createStore + price helpers) + tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wire `pb-store.js` into the app shell (loaded, unused)

Load the new file in the browser and add it to precache + deploy allowlist, WITHOUT app.js using it yet. Proves the script loads cleanly and the app still mounts before any behavior change.

**Files:**
- Modify: `index.html` (script tags, ~line 74-77)
- Modify: `sw.js` (cache version line 2, precache list ~line 9-11)
- Modify: `.github/workflows/static.yml` (cp list line 44, guard list line 50)

**Interfaces:**
- Consumes: `PBStore` global from Task 1.
- Produces: `pb-store.js` available as a browser global at runtime, precached, and deployed.

- [ ] **Step 1: Add the script tag in `index.html`**

Find (around line 74):
```html
<script src="./pb-core.js"></script>
<script src="./pb-data.js"></script>
<script src="./data.js"></script>
```
Replace with (pb-store.js loads after pb-data.js, before data.js):
```html
<script src="./pb-core.js"></script>
<script src="./pb-data.js"></script>
<script src="./pb-store.js"></script>
<script src="./data.js"></script>
```

- [ ] **Step 2: Bump the service-worker cache and precache `pb-store.js`**

In `sw.js` line 2, change:
```js
const CACHE_NAME   = 'playbook-shell-v35';
```
to:
```js
const CACHE_NAME   = 'playbook-shell-v36';
```
Then in the precache array (around line 9-11), change:
```js
  './pb-core.js',
  './pb-data.js',
  './app.js',
```
to:
```js
  './pb-core.js',
  './pb-data.js',
  './pb-store.js',
  './app.js',
```

- [ ] **Step 3: Add `pb-store.js` to the deploy allowlist + guard**

In `.github/workflows/static.yml` line 44, change:
```yaml
          cp index.html sw.js app.js data.js pb-core.js pb-data.js styles.css \
```
to:
```yaml
          cp index.html sw.js app.js data.js pb-core.js pb-data.js pb-store.js styles.css \
```
And in the Guard 1 list (line 50), change:
```yaml
          for f in index.html sw.js app.js data.js pb-core.js pb-data.js styles.css \
```
to:
```yaml
          for f in index.html sw.js app.js data.js pb-core.js pb-data.js pb-store.js styles.css \
```

- [ ] **Step 4: Verify the app still mounts with the new global loaded (browser smoke)**

Run: `node verify-refresh-behavior.mjs`
Expected: PASS — app mounts, prices rehydrate/paint, refresh works (unchanged behavior; the store is loaded but unused). If it fails to find Chrome, note it and run any sibling `verify-*.mjs` smoke that is runnable in this environment; the gate is "app mounts with pb-store.js loaded."

- [ ] **Step 5: Commit**

```bash
git add index.html sw.js .github/workflows/static.yml
git commit -m "Phase 3 inc 1: load + precache + deploy pb-store.js (sw v35->v36)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Make `usePriceFeed` the store's writer (App keeps a bridge — still green)

Move the prices map into the store on the WRITE side, while `App` temporarily keeps reading it via a bridge subscription so every existing consumer keeps working. No perf win yet; this keeps the app green and isolates the writer change for review.

**Files:**
- Modify: `app.js` — `usePriceFeed` (~line 1750-1855), `App` body (~line 2925 call site + add bridge)
- Modify: `backend/test/store.test.mjs` (add anti-drift source guard)

**Interfaces:**
- Consumes: `PBStore.setPricesMap`, `PBStore.mergePrices`, `PBStore.getPrices`, `PBStore.usePricesMap` from Tasks 1-2.
- Produces: `usePriceFeed(order, fetchKey, toast)` now returns `{ loading, lastUpdate, failStreak, refresh, refreshNow, mergePrices }` (NO `prices`). All quote writes go through `PBStore`.

- [ ] **Step 1: Write the failing anti-drift guard test**

Append to `backend/test/store.test.mjs`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(__dir, '..', '..', 'app.js'), 'utf8');

test('anti-drift: usePriceFeed no longer owns prices in React state', () => {
  // The prices map must live in PBStore, not a useState inside usePriceFeed.
  assert.ok(!/const \[prices, setPrices\] = useState/.test(appSrc),
    'usePriceFeed should not hold prices in useState anymore');
});

test('anti-drift: usePriceFeed does not return a prices field', () => {
  const m = appSrc.match(/return \{ loading, lastUpdate, failStreak, refresh, refreshNow, mergePrices \};/);
  assert.ok(m, 'usePriceFeed return bundle should omit prices');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node backend/test/store.test.mjs`
Expected: FAIL — both new guards fail (prices still in useState / still returned).

- [ ] **Step 3: Convert `usePriceFeed` to write into the store**

In `app.js`, in `usePriceFeed` (~line 1754), replace the prices `useState` initializer:
```js
  const [prices, setPrices] = useState(() => {
    const saved = LS.get(PRICES_LS_KEY, null);
    if (!saved || typeof saved !== 'object') return {};
    const now = Date.now();
    const fresh = {};
    for (const k in saved) {
      const q = saved[k];
      if (q && typeof q.price === 'number' && (!q.fetchedAt || now - q.fetchedAt < PRICES_MAX_AGE_MS)) fresh[k] = q;
    }
    return fresh;
  });
```
with a one-time seed of the store (runs once at mount, before first paint, like the old initializer):
```js
  // Seed the store's prices slice once from the rehydrated localStorage cache so
  // the app paints real numbers on open. The map now lives in PBStore, not React
  // state — so a batch merge re-renders only store subscribers, not all of App.
  useState(() => {
    const saved = LS.get(PRICES_LS_KEY, null);
    const now = Date.now();
    const fresh = {};
    if (saved && typeof saved === 'object') {
      for (const k in saved) {
        const q = saved[k];
        if (q && typeof q.price === 'number' && (!q.fetchedAt || now - q.fetchedAt < PRICES_MAX_AGE_MS)) fresh[k] = q;
      }
    }
    PBStore.setPricesMap(fresh);
    return null;
  });
```

- [ ] **Step 4: Route every quote write through the store**

In `usePriceFeed`, replace `mergePrices` (~line 1783-1786):
```js
  const mergePrices = useCallback((obj) => {
    if (!obj || !Object.keys(obj).length) return;
    setPrices(prev => { const next = { ...prev, ...obj }; persistPrices(next); return next; });
  }, [persistPrices]);
```
with:
```js
  const mergePrices = useCallback((obj) => {
    if (!obj || !Object.keys(obj).length) return;
    PBStore.mergePrices(obj);
    persistPrices(PBStore.getPrices());
  }, [persistPrices]);
```
Then in `runFetch`, replace the `onBatch` merge (~line 1801-1803):
```js
          onBatch: (partial) => setPrices(prev => {
            const next = { ...prev, ...partial }; persistPrices(next); return next;
          })
```
with:
```js
          onBatch: (partial) => { PBStore.mergePrices(partial); persistPrices(PBStore.getPrices()); }
```

- [ ] **Step 5: Drop `prices` from the return bundle**

In `usePriceFeed` (~line 1854), replace:
```js
  return { prices, loading, lastUpdate, failStreak, refresh, refreshNow, mergePrices };
```
with:
```js
  return { loading, lastUpdate, failStreak, refresh, refreshNow, mergePrices };
```

- [ ] **Step 6: Add the temporary bridge in `App`**

In `App`, at the `usePriceFeed` call (~line 2925), replace:
```js
  const { prices, loading, lastUpdate, failStreak, refreshNow: refreshPricesNow, mergePrices } = usePriceFeed(fetchOrder, fetchKey, toast);
```
with:
```js
  const { loading, lastUpdate, failStreak, refreshNow: refreshPricesNow, mergePrices } = usePriceFeed(fetchOrder, fetchKey, toast);
  // TEMPORARY Phase-3-inc-1 bridge: App still reads the whole map so the existing
  // prop-drilled consumers keep working unchanged. Removed in the next task, where
  // each consumer subscribes to the store directly and App leaves the tick path.
  const prices = PBStore.usePricesMap();
```

- [ ] **Step 7: Run the store + full node suite, then the browser smoke**

Run: `node backend/test/store.test.mjs`
Expected: PASS — anti-drift guards now green.
Run: `node verify-refresh-behavior.mjs`
Expected: PASS — app mounts, prices paint and refresh exactly as before (behavior identical; only storage moved).

- [ ] **Step 8: Commit**

```bash
git add app.js backend/test/store.test.mjs
git commit -m "Phase 3 inc 1: usePriceFeed writes prices into PBStore (App bridge kept)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Remove prop-drilling — consumers subscribe, App leaves the tick path

This is where the perf win lands. Each component that received a `prices` prop now calls `PBStore.usePricesMap()` itself; the `prices:` prop is removed at every call site; `App`'s bridge is removed; `useAlertEngine` subscribes to the store; and `App`'s own render-time reads of `prices` become imperative.

**Files:**
- Modify: `app.js` — `useAlertEngine` (~line 1861-1874) + its call site (~line 3055); every `prices`-prop consumer component + call site; `App` bridge removal (~line 2925); `positionsCached`/`warmStart` (~line 2973-2989); `getPrice` (~line 3176)
- Modify: `backend/test/store.test.mjs` (tighten anti-drift guard)

**Interfaces:**
- Consumes: `PBStore.usePricesMap`, `PBStore.getPrices`, `PBStore.subscribe` from Task 1.
- Produces: `useAlertEngine(alerts, fireNotification)` (no `prices` param). `App` no longer holds a `prices` variable.

- [ ] **Step 1: Convert `useAlertEngine` to subscribe to the store**

Replace the whole function (~line 1861-1874):
```js
function useAlertEngine(alerts, prices, fireNotification) {
  const [triggered, setTriggered] = usePersistedState('pb.triggered.v2', []);
  const [alertSeenMap, setAlertSeenMap] = usePersistedState('pb.alertSeen.v1', {});
  const seenRef = useRef(alertSeenMap);
  useEffect(() => { seenRef.current = alertSeenMap; }, [alertSeenMap]);
  useEffect(() => {
    const { nextSeen, newTriggers, seenChanged } = evaluateTriggers(alerts, prices, seenRef.current);
    if (seenChanged) setAlertSeenMap(nextSeen);
    if (newTriggers.length) {
      setTriggered(prev => [...newTriggers, ...prev].slice(0, MAX_TRIGGER_HISTORY));
      newTriggers.forEach(t => fireNotification(t));
    }
  }, [prices, alerts, fireNotification, setAlertSeenMap, setTriggered]);
  return { triggered, setTriggered, alertSeenMap, setAlertSeenMap };
}
```
with (reads prices from the store; re-runs on every store change via subscription, so App never re-renders for alert eval):
```js
function useAlertEngine(alerts, fireNotification) {
  const [triggered, setTriggered] = usePersistedState('pb.triggered.v2', []);
  const [alertSeenMap, setAlertSeenMap] = usePersistedState('pb.alertSeen.v1', {});
  const seenRef = useRef(alertSeenMap);
  useEffect(() => { seenRef.current = alertSeenMap; }, [alertSeenMap]);
  useEffect(() => {
    const run = () => {
      const { nextSeen, newTriggers, seenChanged } = evaluateTriggers(alerts, PBStore.getPrices(), seenRef.current);
      if (seenChanged) setAlertSeenMap(nextSeen);
      if (newTriggers.length) {
        setTriggered(prev => [...newTriggers, ...prev].slice(0, MAX_TRIGGER_HISTORY));
        newTriggers.forEach(t => fireNotification(t));
      }
    };
    run();                              // evaluate immediately on alerts change
    return PBStore.subscribe(run);      // and on every subsequent price change
  }, [alerts, fireNotification, setAlertSeenMap, setTriggered]);
  return { triggered, setTriggered, alertSeenMap, setAlertSeenMap };
}
```
Then update the call site (~line 3055), replacing:
```js
  const { triggered, setTriggered, alertSeenMap, setAlertSeenMap } = useAlertEngine(alerts, prices, fireNotification);
```
with:
```js
  const { triggered, setTriggered, alertSeenMap, setAlertSeenMap } = useAlertEngine(alerts, fireNotification);
```

- [ ] **Step 2: Fix `App`'s render-time `prices` reads (boot splash + getPrice)**

Replace `positionsCached`/`warmStart` (~line 2973-2989):
```js
  const positionsCached = useMemo(
    () => positions.length > 0 && positions.every(p => {
      const q = prices[priceKey(p.market, p.ticker)];
      return q && typeof q.price === 'number';
    }),
    [positions, prices]
  );
```
with an imperative helper (reads the store; no `prices` dependency, so it does not pull App into the tick path):
```js
  const computePositionsCached = useCallback(() => {
    const pr = PBStore.getPrices();
    return positions.length > 0 && positions.every(p => {
      const q = pr[priceKey(p.market, p.ticker)];
      return q && typeof q.price === 'number';
    });
  }, [positions]);
```
The `warmStart` initializer (~line 2989) already calls it once at mount — change:
```js
  const [warmStart] = useState(() => positionsCached);
```
to:
```js
  const [warmStart] = useState(() => computePositionsCached());
```
In the boot effect (~line 2991-3000), replace the `ready` line and deps:
```js
    const ready = warmStart || lastUpdate || positionsCached || failStreak >= 2 || fetchOrder.length === 0;
```
with:
```js
    const ready = warmStart || lastUpdate || computePositionsCached() || failStreak >= 2 || fetchOrder.length === 0;
```
and change that effect's dependency array from:
```js
  }, [booting, warmStart, lastUpdate, positionsCached, failStreak, fetchOrder.length]);
```
to:
```js
  }, [booting, warmStart, lastUpdate, computePositionsCached, failStreak, fetchOrder.length]);
```
(The effect still re-runs when `lastUpdate` flips as the first quotes land, which is exactly when the cold-start splash should drop.)

Replace `getPrice` (~line 3176) — it reads `prices` at render but has no remaining call sites; rewrite it to read the store so App holds no `prices` variable:
```js
  const getPrice = (ticker, market) => prices[priceKey(market || 'US', ticker)];
```
to:
```js
  const getPrice = (ticker, market) => PBStore.getPrices()[priceKey(market || 'US', ticker)];
```

- [ ] **Step 3: Remove the App bridge**

Delete the bridge line added in Task 3 (~line 2927):
```js
  // TEMPORARY Phase-3-inc-1 bridge: App still reads the whole map so the existing
  // prop-drilled consumers keep working unchanged. Removed in the next task, where
  // each consumer subscribes to the store directly and App leaves the tick path.
  const prices = PBStore.usePricesMap();
```
(After this, `App` has no `prices` identifier. The next step removes every place App passes it down, and converts every consumer.)

- [ ] **Step 4: Convert every `prices`-prop consumer + remove the prop at call sites**

For EACH component below: (a) add `const prices = PBStore.usePricesMap();` as the first line of the function body, (b) remove `prices` from its props destructure, and (c) remove the `prices: prices,` / `prices,` entry from every `React.createElement(<Component>, { ... })` call site. The internal `prices[priceKey(...)]` reads and `useMemo([... prices ...])` deps stay unchanged (the map reference still changes on each merge).

Known components that receive a `prices` prop (verify the full set with the grep in Step 5 — do not rely on this list alone): `DashboardView`, `Hero`, `PortfolioLineChart`, `PortfolioPieChart`, `HoldingsView`, `WatchlistView`, the picks/hedges/overview views, `TFSABalancer`, and the holding-detail modal.

Procedure per component (example — `PortfolioPieChart`, signature at ~line 4199):
- Destructure currently begins `function PortfolioPieChart({ positions, prices, displayCurrency, ... })`. Remove `prices,` from it.
- Add `const prices = PBStore.usePricesMap();` as the first body statement.
- At its call site (~line 4739) `React.createElement(PortfolioPieChart, { positions, prices, displayCurrency, ... })`, remove `prices,`.

Repeat for every consumer. For nested call sites where a parent forwarded `prices` to a child (e.g. `DashboardView` → `PortfolioLineChart`/`PortfolioPieChart`), the child now self-subscribes, so remove `prices` from the forward too.

- [ ] **Step 5: Verify no prop-drilling of `prices` remains**

Run:
```bash
grep -nE "prices: prices|prices,|, prices" app.js | grep -vE "PBStore|usePricesMap|getPrices|mergePrices"
```
Expected: NO lines that pass `prices` as a `React.createElement` prop. Remaining hits should only be: the `usePricesMap()` self-subscriptions, internal `prices[...]` lookups, and `useMemo`/`useEffect` dependency arrays listing `prices`. Manually confirm each remaining hit is a read, not a prop-pass.

Also confirm App holds no stray `prices` identifier:
```bash
grep -nE "\bprices\b" app.js | sed -n '1,40p'
```
Expected: no `const prices =` inside `App` (the bridge is gone); only consumer-local `const prices = PBStore.usePricesMap()` lines and `usePriceFeed`'s internals.

- [ ] **Step 6: Tighten the anti-drift guard**

In `backend/test/store.test.mjs`, add:
```js
test('anti-drift: useAlertEngine no longer takes a prices param', () => {
  assert.ok(/function useAlertEngine\(alerts, fireNotification\)/.test(appSrc),
    'useAlertEngine signature should be (alerts, fireNotification)');
});
```

- [ ] **Step 7: Run the full node suite**

Run each suite: `node backend/test/store.test.mjs` (and the other 14 to ensure no regression — at minimum `alerts-core`, `quote-parsers`, `fetch-plan`).
Expected: all PASS, including the new guard.

- [ ] **Step 8: Browser smoke + App-render probe (the perf claim)**

Run: `node verify-refresh-behavior.mjs`
Expected: PASS — app mounts, prices paint and refresh.

Then verify App is off the per-batch tick path. Add a temporary probe (a `console.count('App render')` at the top of `App`, OR a `window.__appRenders` counter incremented in a `useEffect(() => { window.__appRenders++; })`), run a sweep in the headless smoke, and assert App renders ≈ once per *sweep* (when `lastUpdate`/`loading` flip), NOT ~13× per sweep (once per batch). Remove the probe before committing. Document the observed before/after counts in the commit body.

- [ ] **Step 9: Commit**

```bash
git add app.js backend/test/store.test.mjs
git commit -m "Phase 3 inc 1: consumers subscribe to PBStore; App leaves the per-batch tick path

Removes prices prop-drilling: each view self-subscribes via usePricesMap;
useAlertEngine subscribes to the store; App's boot-splash + getPrice reads go
imperative. App no longer re-renders per price batch (was ~13x/sweep -> ~1x/sweep).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Memoize the single-symbol leaves

Wrap the three single-symbol leaves in `React.memo`. Because App is now off the tick path, the callback/`rates`/`market` props these leaves receive stay reference-stable during price ticks (those refs only change when App itself re-renders, which no longer happens per tick), so default `React.memo` shallow comparison correctly skips rows whose own symbol did not tick.

**Files:**
- Modify: `app.js` — `SessionBadge` (~line 3619), `PriceBlock` (~line 3631), `HoldingRow` (~line 4886)

**Interfaces:**
- Consumes: nothing new. These leaves keep their current props (incl. `quote`), now reference-stable per the store contract.
- Produces: memoized leaf components; no signature change for callers.

- [ ] **Step 1: Wrap the leaves in `React.memo`**

`SessionBadge` (~line 3619) — change:
```js
function SessionBadge({ market, quote }) {
```
to a named function assigned through `React.memo` (keep the name for stack traces):
```js
const SessionBadge = React.memo(function SessionBadge({ market, quote }) {
```
and add the closing `});` in place of the function's closing `}` (at ~line 3630).

`PriceBlock` (~line 3631) — change:
```js
function PriceBlock(_ref5) {
```
to:
```js
const PriceBlock = React.memo(function PriceBlock(_ref5) {
```
and close its body with `});` instead of `}`.

`HoldingRow` (~line 4886) — change:
```js
function HoldingRow(_refHR) {
```
to:
```js
const HoldingRow = React.memo(function HoldingRow(_refHR) {
```
and close its body with `});` instead of `}`.

Note: these three are defined with `function` declarations but are only referenced AFTER their definition (inside `App`/view render bodies that run later), so converting them to `const` assignments does not hit a temporal-dead-zone problem. Verify by checking each has no caller earlier in the file than its definition line (grep below).

- [ ] **Step 2: Verify no earlier-than-definition reference (TDZ safety)**

Run:
```bash
grep -nE "SessionBadge|PriceBlock|HoldingRow" app.js | head -40
```
Expected: for each component, the first occurrence is its definition; every `React.createElement(<Name>, ...)` is at a higher line number. (All three are leaf UI used inside view render functions defined later.)

- [ ] **Step 3: Syntax check**

Run: `node --check app.js`
Expected: no output (exit 0) — confirms the `React.memo(... )` wrapping is balanced.

- [ ] **Step 4: Browser smoke + leaf-render probe**

Run: `node verify-refresh-behavior.mjs`
Expected: PASS — Holdings/watchlist rows and price blocks still render and update.

Then confirm the leaf win: temporarily add a `console.count` keyed by symbol inside `HoldingRow` (e.g. `console.count('HoldingRow ' + p.ticker)`), run a sweep where only one symbol's quote changes in the fixture, and assert only that symbol's row re-renders (other rows' counts stay flat). Remove the probe before committing.

- [ ] **Step 5: Final node suite sweep**

Run every `backend/test/*.test.mjs` (15 suites).
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "Phase 3 inc 1: React.memo on PriceBlock/HoldingRow/SessionBadge (per-symbol leaf skip)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Definition of done

- `pb-store.js` exists, dual-mode, with a pure tested core (`store.test.mjs`, 15th suite green).
- `prices` lives in `PBStore`; `usePriceFeed` is its sole writer; no `useState` for prices remains.
- No component receives `prices` as a prop; each self-subscribes via `usePricesMap()`.
- `useAlertEngine` re-evaluates via a store subscription; `App` no longer re-renders per price batch (~13×/sweep → ~1×/sweep) — verified with a render probe.
- The three single-symbol leaves are `React.memo`'d; a single-symbol tick re-renders only that row — verified with a leaf probe.
- `verify-refresh-behavior.mjs` passes; sw cache is v36; deploy allowlist + guard include `pb-store.js`.
- Out of scope and untouched: settings/portfolio slices, mutator→action conversion, toast-in-data-layer, broader memo sweep (future Phase 3 increments).

## Post-merge housekeeping (not code tasks)
- Branch: `refactor/phase-3-increment-1-prices-store`. Open PR; whole-branch review before merge (per the established flow).
- No worker/wrangler impact (client-only; worker keeps its own inline state).
- Update [[playbook-refactor-priorities]] memory with the Phase 3 inc 1 outcome after merge.
