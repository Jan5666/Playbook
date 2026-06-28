# Phase 3, Increment 1 — Prices store (kill the whole-tree re-render)

**Date:** 2026-06-28
**Branch (planned):** `refactor/phase-3-increment-1-prices-store`
**Companion:** [playbook-refactor-priorities] Phase 3; builds on Phase 2 (pb-core.js, pb-data.js).

## Goal

Introduce a tiny hand-rolled state store and migrate the **prices map** into it, so a
price tick no longer re-renders `App()` and its entire subtree. This is the first of
several Phase 3 increments; it deliberately moves **only `prices`** (derived,
network-refetched data — a bug can show a stale number but cannot corrupt durable money
state). Settings, portfolio slices, mutator→action conversion, and toast-out-of-data-layer
are explicitly **out of scope** for this increment.

## Why this approach

- **No build step.** React loads as a UMD global; our own logic lives in dependency-free
  global scripts (`pb-core.js`, `pb-data.js`). Rather than add a CDN store library
  (Zustand's UMD build is being deprecated and adds an offline/precache/pin dependency),
  we hand-roll a ~50-line store and wire it through React 18's built-in
  `useSyncExternalStore`. `pb-store.js` becomes the natural third member of the
  pb-core/pb-data family.
- **Prices first.** It is the churny state (`setPrices` ~13×/sweep), it is threaded to
  ~11 views and read at ~60 sites, and it is the direct cause of the C1 whole-tree
  re-render. It is also the lowest-risk slice to prove the pattern.

## Architecture

### `pb-store.js` (new dual-mode global script)

Same dual-mode pattern as pb-core/pb-data: CommonJS `module.exports` for Node tests +
`globalThis.PBStore` for the browser.

**Pure core (unit-tested in Node, no React):**
```
createStore(initial) → {
  getState()                 // current state object
  setState(patchOrFn)        // shallow-merge a patch, or apply (prev)=>patch; notifies subs
  subscribe(listener)        // returns unsubscribe; listener called after each change
}
```
- `setState` replaces the top-level state reference (new object) so reference-equality
  checks downstream are meaningful.
- Listeners are stored in a `Set`; `subscribe` returns an idempotent unsubscribe.
- No-op guard optional; not required for correctness.

**React bindings (browser-only; guarded so Node require() never touches React):**
- `usePricesMap()` → `useSyncExternalStore(subscribe, () => getState().prices)`.
  Returns the whole prices map; re-renders the caller when the map reference changes.
- `usePrice(key)` → `useSyncExternalStore(subscribe, () => getState().prices[key])`.
  Returns one quote; re-renders only when that symbol's quote reference changes.
- `getPrices()` → non-reactive `getState().prices` for imperative reads (effects, alert eval).
- `setPrices(patchOrFn)` / `mergePrices(obj)` helpers that write the `prices` slice.

The single app store instance holds `{ prices: {} }` for this increment (room to grow in
later increments). Created once at module load.

### Selector-stability contract (the per-symbol memo win)

The existing merge builds `next = { ...prev, ...partial }` — it reuses the existing quote
object for every symbol NOT in `partial`. Therefore `getState().prices[key]` is
reference-stable for unchanged symbols across an update, and `useSyncExternalStore`'s
`Object.is` check correctly skips re-rendering leaves whose symbol did not tick. This
contract MUST be preserved by `mergePrices` (do not deep-clone untouched quotes).

## Data-flow changes in app.js

### `usePriceFeed` (owner/writer)
- Replace the local `const [prices, setPrices] = useState(...)` with store-backed storage.
  The initial rehydrate-from-localStorage logic moves to seed the store's initial `prices`
  (run once at store init or via a one-time effect in `usePriceFeed`).
- All current writers (`mergePrices`, `runFetch`'s `onBatch`, and the post-batch merge)
  write through `PBStore.mergePrices` / `setPrices`. Persistence (`persistPrices`,
  debounced `LS.set`) is unchanged and still fires on every merge.
- `loading`, `lastUpdate`, `failStreak` REMAIN ordinary React state returned to `App`.
  They change once per sweep (not per batch), so they are cheap; the status chip already
  depends on them.
- `usePriceFeed` no longer returns `prices`. It returns
  `{ loading, lastUpdate, failStreak, refresh, refreshNow, mergePrices }`
  (`mergePrices` kept for imperative add-a-holding merges).

### `App()`
- Stops destructuring `prices` from `usePriceFeed`.
- Stops passing `prices` as a prop to any view/chart/modal.
- `getPrice(ticker, market)` helper (used locally) reads via `PBStore.getPrices()` if a
  non-reactive read is enough; if a render-reactive read is needed at a specific call
  site, that site uses `usePricesMap()` instead. Audit each `App`-level `prices` use:
  effects/handlers use `getPrices()`; render-time uses move down into the consuming view.

### `useAlertEngine(alerts, fireNotification)`
- No longer receives `prices` as an argument. Subscribes to the store itself (via
  `PBStore.subscribe` in an effect, reading `getPrices()`), re-running the pure
  `evaluateTriggers` on each price change. This keeps alert evaluation reactive WITHOUT
  re-rendering `App`. `triggered`/`alertSeenMap` outputs are unchanged.

### Consumer views (swap prop → hook)
Each component that received the `prices` prop adds `const prices = PBStore.usePricesMap()`
at its top and drops `prices` from its prop list. Internal `prices[priceKey(...)]` usages
and `useMemo([... prices ...])` deps are unchanged. Affected (verify by grep, not by this
list): PortfolioLineChart, PortfolioPieChart, the Holdings/Watchlist/Picks/Hedges/Overview
views, and any modal that read `prices`.

### Leaf memoization (the agreed extra win)
Single-symbol leaves — **PriceBlock, HoldingRow, SessionBadge** — are wrapped in
`React.memo` and read their quote via `PBStore.usePrice(key)` instead of receiving it from
a parent. Each then re-renders only when its own symbol ticks, not when a sibling row does.
Other components are left for a later increment (scope guard).

## Out of scope (later Phase 3 increments)
- Settings slices into the store.
- Portfolio slices + mutator→action conversion.
- Removing `toast` from the data layer (toast at the edge).
- React.memo sweep of the aggregate views.

## Testing

- **Node:** `backend/test/store.test.mjs` — pure `createStore`: get/set shallow-merge,
  functional `setState`, subscribe fires + unsubscribe stops, untouched-slice reference
  stability (the selector-stability contract), `mergePrices` preserves unchanged quote refs.
  Anti-drift source guard: assert `app.js` no longer holds `const [prices, setPrices] =
  useState` in `usePriceFeed` and that `usePriceFeed` does not return `prices`.
- **Browser smoke:** existing `verify-refresh-behavior.mjs` must still pass (app mounts,
  prices rehydrate and paint, refresh works) — this is the suite that caught the Phase 2
  `NAME_CACHE` ReferenceError; a node-only suite cannot catch a broken browser wiring.
- **Re-render check:** confirm `App` no longer re-renders on a price-batch merge (e.g. a
  render counter / console probe in the smoke run), and that an unrelated leaf does not
  re-render when a different symbol ticks.

## Rollout / housekeeping
- `index.html`: load `pb-store.js` after `pb-core.js`/`pb-data.js`, before `app.js`.
- `sw.js`: precache `pb-store.js`; bump cache version (v35 → v36).
- Deploy allowlist + guard in `static.yml`: add `pb-store.js`.
- No worker/wrangler impact (client-only; worker keeps its own inline state).
- Branch `refactor/phase-3-increment-1-prices-store`; brainstorm→spec→plan→
  subagent-driven-development, per the established flow. Browser smoke is a required gate
  before declaring done.
