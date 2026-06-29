# Phase 3, Increment 3a — Non-money portfolio slices → PBStore

**Date:** 2026-06-29
**Branch:** `refactor/phase-3-increment-3a-collections-store` (off main `212d32f`)
**Companion:** [playbook-refactor-priorities] Phase 3; builds on Increment 1 (`pb-store.js` prices) + Increment 2 (settings slice).

## Goal

Migrate the **non-money** slices owned by the `usePortfolio` mega-hook (`app.js`
~2183–2604) out of their per-key `usePersistedState` hooks into a `portfolio` collections
slice on `PBStore`, and re-point their (simple, synchronous) mutators' writes at the store
through **stable setter wrappers** — the mutator bodies stay unchanged. This is
**Increment 3a** of the "portfolio slices + mutator→action" plan item, deliberately split to
keep money-code risk near zero: the 4 money slices and the async FX mutators are
**Increment 3b** (out of scope here).

Like settings (Increment 2), these slices barely churn per-tick — the per-tick re-render win
was already taken in Increment 1 (prices). So 3a's value is **structural**: one source of
truth in the store, plus **stable store-backed setters** that set up 3b and the later
toast-out-of-data-layer increment. It is explicitly **not** a per-tick perf play and **not** a
prop-drilling/self-subscription sweep.

## Scope

**Migrated (5 non-money slices):**
| slice | localStorage key | shape | backed up? |
|---|---|---|---|
| `watchlist` | `pb.watchlist.v2` | array | yes |
| `watchlistGroups` | `pb.watchlistGroups.v1` | array | yes |
| `alerts` | `pb.alerts.v2` | array | yes |
| `sectorCache` | `pb.sectorCache.v1` | object map | **no** (in `BACKUP_SKIP`, refetched) |
| `sectorWeights` | `pb.sectorWeights.v1` | object map | yes |

**Mutators re-pointed at the store, bodies unchanged** (still take `toast`): `addWatch`,
`removeWatch`, `moveWatch`, `toggleWatchList`, `addWatchGroup`, `renameWatchGroup`,
`removeWatchGroup`, `addAlert`, `removeAlert`, `setSectorWeightsFor`. They keep closing over
the reactive hook variables (`watchlist`, `alerts`, …) and call the now-store-backed setter
wrappers (`setWatchlist`, …). Their function-identity stabilization and a `getCollection`-based
stale-closure cleanup are **deferred** to the later React.memo/self-subscription increment (no
memo consumer benefits yet). `getCollection` is added for the unit tests and Increment 3b.

**Explicitly out (→ Increment 3b):**
- `positions` (`pb.positions.v2`), `transactions` (`pb.transactions.v1`),
  `contributions` (`pb.contributions.v1`), `tfsaDeposits` (`pb.tfsa.deposits.v1`).
- The async/money mutators: `addPosition`, `importPositions`, `updatePosition`,
  `sellPosition`, `removePosition`, `removePositions`, `addContribution`,
  `removeContribution`, `importContributions`, `addTfsaDeposit`, `updateTfsaDeposit`,
  `removeTfsaDeposit`, `removeTfsaDeposits`. These stay in `usePortfolio` unchanged.

**Also out (unchanged, as in prior increments):**
- `fxRates` (`pb.fxRates.v1`) — data-layer relocation, a later increment.
- Removing `toast` from the data layer — the next increment after 3b.
- The prop-drilling/self-subscription sweep + broader `React.memo` — folded into the later
  cleanup increment.

## Why this approach

- **Reuse the inc-2 mechanism shape.** A collections slice is the settings mechanism plus
  functional-updater support — the mutators lean on `prev => next` (`setWatchlist(prev => …)`,
  `setAlerts(prev => [...prev, a])`, `setSectorWeights(prev => ({…}))`). One consolidated store.
- **Non-money first** (user's chosen split). Smallest possible money-code diff: the only money
  mutator touched is `importPositions`, and only a mechanical setter swap (see below).
- **Defer self-subscription.** App genuinely reads `alerts`+`watchlist` (for `buildFetchPlan`)
  and `sectorCache`/`sectorWeights` (allocation), so a leaf self-subscribe sweep buys little
  here and adds churn; it belongs with the `React.memo` increment.

## Architecture

### `pb-store.js` additions

The app store grows `{ prices, settings }` → `{ prices, settings, portfolio }`. A new
**generic, app-agnostic** persisted-collections mechanism, mirroring `configureSettings` but
accepting a **value OR updater function**:

**Pure core (Node-testable, no React, no direct localStorage):**
```
configureCollections({ schema, storage })   // call once at startup
  // schema:  [{ name, key, default }]                 (app-specific; built in app.js)
  // storage: { get(key, default), set(key, value) }   (injected; browser passes LS)
  // Seeds the portfolio slice: for each entry, storage.get(key, default).
getCollection(name)                 // non-reactive: getState().portfolio[name]
setCollection(name, valueOrFn)      // valueOrFn(prev) when function; write-through then notify
```
- `setCollection` resolves `valueOrFn` against the current slice value
  (`typeof valueOrFn === 'function' ? valueOrFn(prev) : valueOrFn`), looks up the entry's
  `key`, calls `storage.set(key, value)` (persistence + cloud-backup-notify side effect via
  `LS.set`), then `appStore.setState` replaces `portfolio` with
  `{ ...portfolio, [name]: value }` so the slice ref changes but every untouched collection
  keeps its existing reference (selector stability — same contract as `mergePrices`/`setSetting`).
- Unknown `name` is a safe no-op / `undefined`.
- **Namespace isolation:** `portfolio` and `settings` are sibling keys on the store; a
  collection write never touches `settings` and vice-versa.

**React binding (browser-only, same lazy-`R()` guard as `usePricesMap`/`useSetting`):**
```
useCollection(name)   // useSyncExternalStore(subscribe, () => getState().portfolio[name])
```
ref-stable per name: an unchanged collection keeps its stored reference until `setCollection`
replaces it.

### Selector-stability contract
`setCollection` replaces only the changed key inside `portfolio` (spread + overwrite), never
rebuilds siblings — mirrors Increment 1 `mergePrices` and Increment 2 `setSetting`.

## Persistence model (constraint-driven)

Identical reasoning to Increment 2: cloud backup (`gatherBackup()`) enumerates `localStorage`
directly for every `pb.*` key minus `BACKUP_SKIP`, and `LS.set` fires the backup-notify on
each non-skipped `pb.*` write. Each slice **keeps its own `pb.X.vN` key via `LS.set`** — no
combined blob. Satisfied by injecting the existing **`LS` helper as the `storage` adapter**:
- `storage.set` === `LS.set` → same per-key write + same backup-notify, including the
  automatic skip for `pb.sectorCache.v1` (already in `BACKUP_SKIP`, so it is **not** backed up
  — behavior preserved with zero special-casing).
- Seeding via `storage.get(key, default)` === `LS.get` → identical to `usePersistedState`'s
  lazy initializer, including the cloud-restore reload path (restore writes the keys, then
  reloads; `configureCollections` re-seeds from them).

**Default-seeding note (inc-2-consistent):** `usePersistedState` writes the default back to
localStorage on first mount (its effect runs even when unchanged). `setCollection` only writes
on explicit change, so a never-touched default is not eagerly written. Behavior-equivalent for
the user (a brand-new empty install's backup may omit the key → restore re-applies the same
`[]`/`{}` default). Decided: **do not** eagerly write on configure (matches settings).

## Data-flow changes in `app.js`

### Startup wiring
- Build `PORTFOLIO_SCHEMA` (the 5 `{name, key, default}` entries) at module scope, next to
  `SETTINGS_SCHEMA`.
- Call `PBStore.configureCollections({ schema: PORTFOLIO_SCHEMA, storage: LS })` once before
  first render, next to the existing `configureSettings(...)` call.

### `usePortfolio` (`app.js` ~2183)
- Delete the 5 `usePersistedState` declarations for the migrated slices. For each, read the
  slice reactively via `const x = PBStore.useCollection('x')` and define a `useCallback`-stable
  setter wrapper `const setX = useCallback(v => PBStore.setCollection('x', v), [])` (the `v`
  may be a value or a `prev => next` updater — `setCollection` handles both). The 5 explanatory
  comments above the old declarations are preserved.
- The 10 simple mutators are **unchanged in body**; they keep closing over the reactive hook
  variables and call the setter wrappers (now store-backed). `removeWatchGroup` still writes
  both `watchlist` + `watchlistGroups` (both in-scope) via their wrappers.
- The startup dedup `useEffect` (~2221, merges duplicate **positions**) is untouched — that's
  a money slice (3b).
- `usePortfolio` keeps returning the same names (`watchlist`, `setWatchlist`, `addWatch`, …) so
  consumers and the App destructure are unchanged. `setWatchlist`/`setAlerts`/`setSectorCache`/
  `setSectorWeights`/`setWatchlistGroups` become thin wrappers over
  `setCollection(name, valueOrFn)` (preserves the functional-updater call sites that pass
  `prev => …`).

### The one money-mutator touch (flagged for review)
- `importPositions` (stays in `usePortfolio`) writes `setSectorCache(prev => ({...prev,
  ...learned}))` (~2363). Because `setSectorCache` is now the wrapper over
  `setCollection('sectorCache', …)`, this line is unchanged at the call site — the swap is
  entirely inside the wrapper. No money logic is touched.

### `App()` direct uses
- The self-healing sector-fill effect (~2849) and the persist-learned-sector effect (~2875)
  call `setSectorCache(prev => …)`. They keep calling `setSectorCache` (now the wrapper), so
  no change at those call sites. They list `setSectorCache` in deps — its identity is now
  **stable** (module/hook-stable wrapper) rather than a fresh closure each render, which is
  strictly better for those effect dep arrays.
- `App()` reads `alerts`/`watchlist`/`sectorCache`/`sectorWeights` via the hook's returned
  values (now backed by `useCollection`) — prop flow to views is **unchanged** (deferred sweep).

### `useAlertEngine`
- Receives/reads `alerts`. Its source is now the store, but it continues to receive `alerts`
  the same way (via the `usePortfolio` return / existing prop). No reactive-wiring change
  required for 3a; if it already reads from a prop, that prop is now store-backed.

## Out of scope (later Phase 3 increments)
- Money slices + async FX mutators → store (Increment 3b).
- `toast` out of the data layer.
- Prop-drilling/self-subscription sweep + broader `React.memo`.
- `fxRates` relocation.

## Testing

- **Node** (`backend/test/store.test.mjs`, extended): inject a fake `storage` map + `schema`.
  Assert: (1) seeding reads stored value when present, default when absent; (2) `setCollection`
  with a **value** writes through to `storage.set` + updates the slice + notifies; (3)
  `setCollection` with a **function** applies `fn(prev)` and persists the result; (4)
  `getCollection` reflects writes; (5) selector ref-stability — an unchanged collection keeps
  its reference after another collection changes; (6) **namespace isolation** — a collection
  write does not alter `settings`, and a setting write does not alter `portfolio`; (7) unknown
  name is a safe no-op. Anti-drift source guards: `app.js` no longer contains
  `usePersistedState('pb.watchlist.v2'…)` (and the other 4 migrated keys), DOES call
  `configureCollections`, and the 10 migrated mutators reference `setCollection`/the wrappers
  (no direct `usePersistedState`-backed setter remains for these slices).
- **Browser smoke (required gate):** `verify-watchlist.mjs` — add a watch, toggle a list,
  confirm it appears + persists across reload; plus `verify-refresh-behavior.mjs` (app mounts;
  the inc-1/inc-2 lesson that node can't catch a moved-const `ReferenceError`). Spot-check an
  alert add/remove if a harness covers it.

## Rollout / housekeeping
- `sw.js`: bump cache version (current **v38 → v39**) so clients pull the new
  `app.js` + `pb-store.js`.
- No new file → no `index.html` load-order or `static.yml` allowlist change (`pb-store.js`
  already loaded + precached + allowlisted from Increment 1).
- No worker/wrangler impact (client-only; worker keeps its own state).
- **Commits/merge are Jan's** — this session builds + verifies on the branch and stops short of
  commit/push/merge.
- Flow: brainstorm→spec→plan→subagent-driven-development; browser smoke is a required gate
  before declaring done.
