# Phase 3, Increment 3b — Money portfolio slices → PBStore

**Date:** 2026-06-29
**Branch:** `refactor/phase-3-increment-3b-money-store` (off 3a commit `8873741`, itself off main `212d32f`)
**Companion:** [playbook-refactor-priorities] Phase 3; completes the "portfolio slices" plan item begun in Increment 3a.

## Goal

Migrate the **4 money** slices owned by `usePortfolio` (`app.js` ~2184–2204) off per-key
`usePersistedState` into the existing `portfolio` collections slice on `PBStore`, using the
**identical mechanism and pattern proven in Increment 3a**: `useCollection` reads + `useCallback`
-stable setter wrappers over `setCollection`, with **every mutator body left unchanged**. This
completes the slice-migration half of "portfolio slices + mutator→action"; the mechanism
(`configureCollections`/`getCollection`/`setCollection`/`useCollection`) already exists from 3a
and is **not** modified.

Like 3a, these slices change only on user action (buy/sell/import/log), not per-tick, so the
value is **structural** (single source of truth in the store; completes the `usePortfolio`
de-React-stating), not per-tick throughput.

## Scope

**Migrated (4 money slices):**
| slice | localStorage key | shape | backed up? |
|---|---|---|---|
| `positions` | `pb.positions.v2` | array | yes |
| `contributions` | `pb.contributions.v1` | array | yes |
| `transactions` | `pb.transactions.v1` | array | yes |
| `tfsaDeposits` | `pb.tfsa.deposits.v1` | array | yes |

Added to the existing `PORTFOLIO_SCHEMA` (4 new entries) so `configureCollections` seeds them
from `LS` alongside the 3a slices.

**Mutators re-pointed at the store, bodies unchanged** (still take `toast`/`fxRates`/
`fetchHistoricalFx` exactly as today): `addPosition`, `importPositions`, `sellPosition`,
`updatePosition`, `removePosition`, `removePositions`, `addContribution`, `removeContribution`,
`importContributions`, `addTfsaDeposit`, `updateTfsaDeposit`, `removeTfsaDeposit`,
`removeTfsaDeposits`. Plus the **startup dedup `useEffect`** (~2226, merges duplicate positions
via `mergeCostBasis`) — its `setPositions(prev => …)` now writes the store via the wrapper; the
effect body is otherwise unchanged.

**Explicitly preserved (NOT fixed here):**
- **C4 stale-closure** in `addPosition`'s final `toast(positions.find(...) ? … : …)` (~2305) —
  reads the pre-update `positions` closure. Behavior-preserving refactor: keep it as-is.
- Money math itself (`mergeCostBasis`, `convertCcy`, `positionCostCcy`, `resolvePositionUpdates`,
  the FX-at-cost logic) — already pure in `pb-core.js`; untouched. No formula is edited.

**Out of scope (later increments):** removing `toast` from the data layer; `fxRates` relocation;
the prop-drilling/self-subscription sweep + broader `React.memo`.

## Why this is low-risk despite being "money code"

- **The mechanism is unchanged** — `setCollection` (value-or-updater, write-through, selector-
  stable) was built + unit-tested + browser-verified in 3a. 3b only adds 4 schema entries and
  flips 4 declarations.
- **Mutator bodies are byte-for-byte unchanged** — they keep closing over the reactive hook
  variables and call the setter wrappers, which already accept the `prev => next` updaters every
  money mutator uses. The diff is the 4 declarations + 4 schema lines + sw bump.
- **The money formulas live in `pb-core.js`** and are not touched; this increment changes only
  where the resulting arrays are stored.

## Multiple store writes per mutator (considered, fine)

`addPosition` writes `positions` then `transactions` then (TFSA) `tfsaDeposits`; `importPositions`
writes `positions`, `transactions`, optionally `tfsaDeposits`, optionally `sectorCache`. After 3b
these are all `setCollection` calls, i.e. 2–3 sequential store notifications per user action
instead of one batched React update. This is:
- **Correct** — each `setCollection` fully updates `getState` before the next; reads are
  consistent; no tearing.
- **Negligible perf** — user-action frequency, not per-tick; identical in spirit to Increment 1's
  `mergePrices` (called ~13×/sweep) which already proved many sequential store writes are fine.

## Architecture / data-flow changes in `app.js`

### Startup schema
Append 4 entries to `PORTFOLIO_SCHEMA` (the array added in 3a, just after the `configureSettings`
call):
```js
  { name: 'positions',     key: 'pb.positions.v2',     default: [] },
  { name: 'transactions',  key: 'pb.transactions.v1',  default: [] },
  { name: 'contributions', key: 'pb.contributions.v1', default: [] },
  { name: 'tfsaDeposits',  key: 'pb.tfsa.deposits.v1', default: [] },
```
The existing `PBStore.configureCollections({ schema: PORTFOLIO_SCHEMA, storage: LS })` call then
seeds all 9 slices. No new `configure*` call.

### `usePortfolio` declarations (mirror 3a exactly)
Replace each of the 4 `const [x, setX] = usePersistedState('pb.X', [])` with:
```js
  const x = PBStore.useCollection('x');
  const setX = useCallback(v => PBStore.setCollection('x', v), []);
```
for `positions`/`setPositions`, `contributions`/`setContributions`, `transactions`/
`setTransactions`, `tfsaDeposits`/`setTfsaDeposits`. The explanatory comment blocks above
`contributions`/`tfsaDeposits` are preserved. All mutator bodies + the dedup effect are unchanged
(they call the wrappers).

### Consumers
`App()` continues to read `positions`/`transactions`/`contributions`/`tfsaDeposits` via the
`usePortfolio` return (now `useCollection`-backed) and prop-drills them exactly as today —
unchanged. The self-healing sector-fill effect, `buildFetchPlan` (positions = fast tier), the
dashboard/TFSA value math, etc. all keep their current prop/closure wiring. (`setSectorCache`,
already a 3a wrapper, is unchanged.)

## Persistence model
Identical to 3a: the injected `LS` adapter keeps each slice on its own `pb.X.vN` key with the
same `LS.set` write + cloud-backup-notify. All 4 money keys are durable (none in `BACKUP_SKIP`),
so each write still fires the backup notifier exactly as `usePersistedState` did. Seed-on-read,
no eager default write-back (inc-2/3a-consistent).

## Testing

- **Node — the money correctness gate (must stay green):**
  `node backend/test/money-math.test.mjs`, `node backend/test/cost-basis.test.mjs`,
  `node backend/test/import-matching.test.mjs`, `node backend/test/ee-ocr-parse.test.mjs`, plus
  the full suite. These pin the cost-basis/FX/import math; since no formula changes, they must
  remain green unchanged.
- **`store.test.mjs` anti-drift (extend the existing 3a guards):** add the 4 money keys to the
  "migrated … no longer use usePersistedState" assertion; **delete** the now-obsolete
  "money slices stay usePersistedState (3b out of scope)" guard from 3a and replace it with a
  guard that the 4 money keys appear in `PORTFOLIO_SCHEMA`. Keep the `pb.fxRates.v1`-stays guard.
- **Browser smoke (required gate):** `verify-refresh-behavior.mjs` — seeds `pb.positions.v2`,
  asserts the portfolio "Today" pill renders and positions are fetched first; this exercises the
  positions slice end-to-end through the store. Plus a holdings-oriented harness if one seeds
  positions (`verify-holdings-redesign.mjs` / `verify-goal-holdings.mjs`) — app must MOUNT and
  render holdings from the seeded store. (Known flaky CDP "Execution context destroyed" race on
  the screenshot harnesses — rerun once; refresh-behavior is the reliable gate.)

## Rollout / housekeeping
- `sw.js`: bump cache version **v39 → v40**.
- No new file → no `index.html`/`static.yml`/precache change.
- No worker/wrangler impact.
- **Commits/merge are Jan's** — build + verify on the branch, stop short of commit/push/merge.
- Flow: spec→plan→executing-plans (inline, no subagents — token-saving); browser smoke is a
  required gate before declaring done.
