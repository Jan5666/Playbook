# Phase 3, Increment 2 — Settings slice → PBStore

**Date:** 2026-06-28
**Branch:** `refactor/phase-3-increment-2-settings-store` (off main e1a13bc)
**Companion:** [playbook-refactor-priorities] Phase 3; builds on Increment 1 (`pb-store.js`).

## Goal

Migrate the App-level **settings (preferences)** out of their per-key `usePersistedState`
hooks in `App()` into a `settings` slice on `PBStore`, killing the prop-drilling of
settings + their `onSetX` callbacks. Unlike prices (Increment 1), settings barely churn, so
the win is **code-cleanliness / prop-drill removal and store consolidation**, not re-render
throughput. This is the second of several Phase 3 increments; portfolio slices,
mutator→action conversion, toast-out-of-data-layer, and the broader `React.memo` sweep remain
**out of scope**.

## Scope

**Migrated** (the App-level cluster, app.js ~2722–2746):
`theme`, `iconTheme`, `displayCurrency`, `donutPalette`, `donutTopN`, `ribbonItems`,
`ribbonMode`, `tabOrder`, `hiddenTabs`, `perplexityKey`, `pushBackend`.

**Explicitly out (by design):**
- `fxRates` (`pb.fxRates.v1`) — network-refreshed data on `BACKUP_SKIP`, not a preference;
  belongs with the data layer in a later increment, not the settings slice.
- Portfolio slices (positions/watchlist/alerts/contributions/transactions/tfsa/sector*) —
  Increment 3.
- Component-local persisted state (heatmap mode/exchange/filter, watchlist `activeList` /
  `showSuggestions`, `valueHidden`, tfsa targets/contribution) — stays as local
  `usePersistedState`; not App-level settings.

## Why this approach

- **Consolidate the store pattern.** Increment 1 proved `PBStore` for `prices`; settings are
  the natural next slice. One owner for shared app state.
- **Hybrid consumer wiring** (chosen): self-subscribe at natural boundaries, keep
  `displayCurrency` as a prop in deep money-math render paths. Avoids a 73-reference
  `displayCurrency` sweep for near-zero perf benefit while still removing the bulk of the
  prop-drill (≈20 props off `SettingsModal` alone).

## Architecture

### `pb-store.js` additions

The single app store grows from `{ prices }` to `{ prices, settings }`. A new **generic,
app-agnostic** persisted-settings mechanism is added (the app-specific schema + storage are
injected from `app.js`, mirroring `PBData.configure({indicatorCatalog})`):

**Pure core (Node-testable, no React, no direct localStorage):**
```
configureSettings({ schema, storage }) // call once at startup
  // schema:  [{ name, key, default }]      (app-specific; built in app.js)
  // storage: { get(key, default), set(key, value) }   (injected; browser passes LS)
  // Seeds the settings slice: for each entry, storage.get(key, default).
getSettings()            // non-reactive: getState().settings
getSetting(name)         // non-reactive: getState().settings[name]
setSetting(name, value)  // write-through: storage.set(key, value) THEN update slice + notify
```
- `setSetting` looks up the entry's `key` from the configured schema, calls
  `storage.set(key, value)` (the persistence + cloud-backup-notify side effect), then
  `appStore.setState` replaces `settings` with `{ ...settings, [name]: value }` so the slice
  ref changes but every untouched setting keeps its existing reference (selector stability).
- Unknown `name` in `setSetting`/`getSetting` is a no-op / `undefined` (defensive; not
  expected in normal flow).

**React bindings (browser-only, same lazy-`R()` guard as `usePricesMap`):**
```
useSettings()       // useSyncExternalStore(subscribe, () => getState().settings)
useSetting(name)    // useSyncExternalStore(subscribe, () => getState().settings[name])
```
- `useSetting(name)` is ref-stable per key: a primitive setting is `Object.is`-stable; an
  array/object setting (`ribbonItems`, `tabOrder`, `hiddenTabs`) keeps its stored reference
  until `setSetting` replaces it. So a change to one setting re-renders only that setting's
  subscribers.

### Selector-stability contract

`setSetting` must replace only the changed key inside `settings` (spread + overwrite), never
rebuild sibling values, so `getState().settings[name]` is reference-stable for unchanged
settings across an update. This mirrors the Increment 1 `mergePrices` contract.

## Persistence model (constraint-driven, not a preference)

Cloud backup (`gatherBackup()`, app.js ~65) enumerates `localStorage` directly for every
`pb.*` key (minus `BACKUP_SKIP`), and `LS.set` fires the backup-notify on each `pb.*` write.
Therefore each setting **must keep being persisted under its own `pb.X.vN` key via `LS.set`**
— a combined `pb.settings.v1` blob would break backup/restore round-tripping.

This is satisfied by injecting the existing **`LS` helper as the `storage` adapter**:
- `storage.set(key, value)` === `LS.set(key, value)` → same per-key write, same backup-notify.
- Seeding via `storage.get(key, default)` === `LS.get(key, default)` → identical to
  `usePersistedState`'s lazy initializer, including the cloud-restore reload path (restore
  writes the `pb.*` keys then reloads; `configureSettings` re-seeds from them at init).
- App-specific defaults (`DEFAULT_RIBBON_ITEMS`, `DEFAULT_TAB_ORDER`) live in the schema built
  in `app.js`, so `pb-store.js` stays generic and Node-testable with a fake storage map.

**Default-seeding note:** `usePersistedState` writes the default back to localStorage on first
mount (its effect runs even when the value is unchanged). `setSetting` only writes on explicit
change, so a never-touched default is not eagerly written. This is behavior-equivalent for the
user (backup omits the key → restore re-applies the same default) and avoids redundant writes.
If byte-identical backup contents for an untouched install are desired, `configureSettings`
may optionally `storage.set` each seeded key once; decided during implementation, default is
**not** to eagerly write.

## Data-flow changes in `app.js`

### Startup wiring
- Delete the 11 settings `usePersistedState` declarations in `App()`.
- Build `SETTINGS_SCHEMA` (the 11 `{name, key, default}` entries) at module scope (it
  references `DEFAULT_RIBBON_ITEMS`/`DEFAULT_TAB_ORDER`, already defined there).
- Call `PBStore.configureSettings({ schema: SETTINGS_SCHEMA, storage: LS })` once before
  first render (next to `PBData.configure(...)`).

### `App()` (owns root-level settings)
- `theme` → `const theme = PBStore.useSetting('theme')` (the
  `document.documentElement.dataset.theme = theme` effect at ~2832 stays in App and depends on
  it). `iconTheme` likewise: App reads it via `useSetting('iconTheme')` so its
  `window.applyIconTheme(iconTheme)` effect (~2727) keeps firing; SettingsModal self-subscribes
  to edit it.
- `displayCurrency` → `const displayCurrency = PBStore.useSetting('displayCurrency')`, still
  threaded as a prop to the deep money-math/format components (kept, per hybrid). A stable
  `setDisplayCurrency` via `useCallback(v => PBStore.setSetting('displayCurrency', v), [])` is
  only needed where a setter is passed down; SettingsModal self-serves so most `onSetX` props
  disappear.

### Self-subscribe boundaries (drop the prop chains)
- **`SettingsModal`** — reads every setting it edits via `useSetting`/`useSettings` and writes
  via `PBStore.setSetting(...)`. Removes ~20 props from its signature: `displayCurrency`,
  `onSetDisplayCurrency`, `ribbonItems`, `onSetRibbonItems`, `ribbonMode`, `onSetRibbonMode`,
  `tabOrder`, `hiddenTabs`, `onSetTabOrder`, `onSetHiddenTabs`, `perplexityKey`,
  `onSetPerplexityKey`, `pushBackend`, `iconTheme`, `onSetIconTheme`, `theme`, `onSetTheme`,
  `donutPalette`, `onSetDonutPalette`, `donutTopN`, `onSetDonutTopN`. (Non-settings props —
  `fxRates`, `onRefreshFx`, positions, `onExport`, `cloudBackup`, push status/handlers, etc. —
  are unchanged.)
- **Ribbon component** — `ribbonItems` / `ribbonMode` via `useSetting`; dropped from the App→
  ribbon prop chain.
- **Tab nav** — `tabOrder` / `hiddenTabs` via `useSetting`; dropped from the nav prop chain.
- **`PortfolioPieChart`** — `donutPalette` / `donutTopN` via `useSetting`; removes them from
  the OverviewView / PortfolioView pass-through chain (~3221/3287/4585/9023) and from the
  chart's own prop list.

### Kept as a prop (deep money-math paths)
`displayCurrency` remains a prop into the format/holdings/value components (≈73 refs). App owns
it via the store; SettingsModal still self-subscribes for its own read+write. No 73-ref sweep.

## Out of scope (later Phase 3 increments)
- Portfolio slices into the store + mutator→action conversion (Increment 3).
- Removing `toast` from the data layer (toast at the edge).
- Broader `React.memo` sweep of aggregate views.
- `fxRates` relocation to the data layer.

## Testing

- **Node** (`backend/test/store.test.mjs`, extended): inject a fake `storage` map +
  `schema`. Assert: (1) seeding reads stored value when present, default when absent;
  (2) `setSetting` writes through to `storage.set` AND updates the slice AND notifies
  subscribers; (3) `getSetting`/`getSettings` reflect writes; (4) selector ref-stability —
  an unchanged setting keeps its reference after another setting changes; (5) unknown name is
  a safe no-op. Anti-drift source guard: `app.js` no longer contains
  `usePersistedState('pb.theme.v2'…)` (and the other 10 migrated keys) and DOES call
  `configureSettings`.
- **Browser smoke (required gate):** `verify-settings.mjs` — open Settings, change
  `displayCurrency` and `theme`, confirm the change applies (root `data-theme`, totals
  re-render) and persists across reload; plus `verify-refresh-behavior.mjs` (app mounts).
  A node-only suite cannot catch broken browser wiring (the Phase-2 `NAME_CACHE` /
  Increment-1 lessons).

## Rollout / housekeeping
- `sw.js`: bump cache version (current v37 → v38) so clients pull the new `app.js` + `pb-store.js`.
- No new file → no `index.html` load-order or `static.yml` allowlist change (`pb-store.js`
  already loaded + precached + allowlisted from Increment 1).
- No worker/wrangler impact (client-only; worker keeps its own state).
- Flow: brainstorm→spec→plan→subagent-driven-development; browser smoke is a required gate
  before declaring done.
