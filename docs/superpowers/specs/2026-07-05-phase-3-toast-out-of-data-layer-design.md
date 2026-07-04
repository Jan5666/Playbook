# Phase 3 — Toast out of the data layer (design)

**Date:** 2026-07-05
**Phase:** 3 (store / kill prop-drilling), the "REMOVE toast from data layer — toast at the edge" item.
**Predecessor:** Phase 3 inc 3a/3b (all 9 portfolio slices + prices + settings now in PBStore, merged to main via PR #11).

## Goal

Remove all user-facing `toast()` calls from the state/mutation hooks so the data layer no
longer depends on the toast UI. Mutators report **outcomes**; a single edge (the `App`
component) owns every user-facing string and renders the toast. Fix the C4 stale-closure in
`addPosition` and rationalize inconsistent message wording along the way.

**Scope decision (agreed):** decouple **+ rationalize** — move toast to the edge, fix C4, and
tidy inconsistent copy. **Mechanism (agreed):** return-values / outcome objects (not an emitter).
**Price-feed (agreed):** rationalize the two status toasts down to one edge-derived toast.

## Context: current toast usage

There are 79 occurrences of the `toast` token in `app.js` (incl. `useToast` / `ToastContext` /
`setToast` / comments) and **49 actual `toast(...)` call sites**; none live in `pb-data.js`.
`toast` is a React context callback (`ToastContext` / `useToast`, defined ~L2679) obtained once
in `App` (`const toast = useToast()`) and **injected as a parameter** into three hooks:

- `usePriceFeed(order, fetchKey, toast)` — L1751
- `usePushBackend(pushBackend, setPushBackend, alerts, notifPerm, toast)` — L2105
- `usePortfolio(fxRates, toast)` — L2194

### In scope (~37 calls — the "data layer")

| Location | Count | Kind |
|---|---|---|
| `usePortfolio` mutators (add/sell/import/update/remove positions, contributions, TFSA deposits, watch, groups, alerts) | ~23 | success confirmations + a few validation guards |
| `usePortfolio` preview paths (`guardPreview` readonly ~L2274; demo-load-failed ~L2260) | 2 | reject/error |
| `usePushBackend` (`connectPush`/`testPush`/`disconnectPush`) | ~9 | validation + async connect/test flow |
| `usePriceFeed` (feed-unreachable ~L1813, refresh-failed ~L1820) | 2 | background status |
| `downloadBackup` helper (~L181, free fn taking `toast`) | 1 | success |

### Out of scope (~12 calls — already at the edge, left untouched)

`App`-level handlers (notification permission flow, backup restore, `fireNotification` in-app
alert, import `onError`) and `HotTopicsView`'s `'Refreshing Hot Topics…'` prop-toast. These
already fire from the UI edge, not the data layer.

## Design

### 1. The outcome contract

Every mutator/action returns a plain object instead of calling `toast`:

```js
{ ok: boolean, code: string, ...data }
```

- `ok` — `true` = succeeded; `false` = rejected / guard / no-op.
- `code` — a semantic identifier the edge maps to copy (e.g. `'position-added'`,
  `'shares-added'`, `'preview-readonly'`, `'deposit-missing-fields'`, `'positions-imported'`).
- extra fields — data for dynamic copy (`added`, `merged`, `ticker`, `list`, `count`,
  `existed`, `status`, `detail`…).

No message strings remain in the data layer.

### 2. The edge — one place for all copy

- **`describeOutcome(outcome) → string | null`** — a pure, top-level fn in `app.js`
  (vm-slice testable). Maps `code` (+ data) to the user-facing string; returns `null` for
  outcomes that should not toast (silent successes, no-ops).
- **`withToast(fn)`** — a small `App`-level wrapper:
  `async (...a) => { const r = await fn(...a); const m = describeOutcome(r); if (m) toast(m); return r; }`.
  `App` wraps each raw mutator once and passes the wrapped fn as the **existing prop**
  (`onAddPosition`, `onSell`, …). Child components are **unchanged**.
- `withToast` returns the outcome `r`, so any caller that already used a mutator's return value
  keeps working (the wrapped fn is a superset). Per-mutator, the plan must confirm no existing
  caller depends on a previous non-outcome return value; where one does, adapt that call site.

### 3. Per-hook changes

- **`usePortfolio`** — drop the `toast` param. `guardPreview` returns
  `{ ok:false, code:'preview-readonly' }` instead of toasting. The demo-load-`onerror` path runs
  inside an effect (not a called mutator), so it cannot return an outcome: instead `usePortfolio`
  exposes a `previewLoadError` counter that the effect bumps on failure, and an `App` effect
  toasts `'Couldn't load the demo portfolio…'` when it changes (mirroring the `failStreak`
  pattern). Every mutator returns an outcome. `App` wraps all mutators with `withToast`.
- **`usePushBackend`** — drop the `toast` param. `connectPush`/`testPush`/`disconnectPush`
  return outcomes (`connectPush` success/failure still readable off `ok`). `App` wraps them the
  same way; `SettingsModal` keeps calling the (now wrapped) props unchanged.
- **`usePriceFeed`** — drop the `toast` param. The two status toasts are **rationalized to one**:
  an `App` effect watching the exposed `failStreak` toasts
  `'Price feed unreachable — showing last known prices'` when `failStreak` crosses to `2`. The
  separate `'Price refresh failed'` toast is dropped (the refresh-confidence status chip +
  `failStreak` already communicate outright failure; exceptions also bump `failStreak`).
- **`downloadBackup`** — drop the `toast` param, return `{ ok:true, code:'backup-saved' }`; its
  `App` caller toasts.

### 4. C4 stale-closure fix

`addPosition` currently does `toast(positions.find(...) ? 'Shares added…' : 'Position added')`,
reading the **stale** `positions` closure. The refactor computes `existed` **inside the state
updater** (from `prev`) and returns `{ ok:true, code: existed ? 'shares-added' : 'position-added' }`.
The edge picks copy from `code` — no stale read. C4 resolved.

### 5. Rationalized copy

All strings move into `describeOutcome`, where inconsistent phrasing is unified (e.g. the
`'Removed <ticker>'` / `'Removed from list'` / `'Holding deleted'` family, consistent
capitalization and punctuation). Copy is now tunable in one place with no data-layer edits.

## Testing

- **Unit** — new suite for `describeOutcome`: every `code` yields non-empty copy (or an
  intentional `null`); dynamic codes format correctly (`positions-imported` with `added`/`merged`
  counts); both C4 branches (`position-added` vs `shares-added`).
- **Anti-drift source guards** (matching prior increments): assert `usePortfolio`,
  `usePriceFeed`, `usePushBackend`, and `downloadBackup` contain no `toast(` calls and their
  signatures no longer take a `toast` param.
- **Browser smokes** — extend `verify-holdings-redesign` (toast appears after add-position) and
  `verify-settings` (toast appears after a settings action). `verify-refresh-behavior` should be
  unaffected. Run the full node suite + the reliable assertion-based smokes; treat the known
  flaky CDP "Execution context destroyed" race as environmental.

## Delivery / non-goals

- Everything lands in `app.js`. `pb-core.js`, `pb-data.js`, `pb-store.js` are **untouched**
  (`describeOutcome` is app UI copy, not shared core logic — it stays in `app.js`).
- `sw.js` cache version bumped by one (read the current value at implementation time; do not
  assume v40).
- **No** `index.html` / deploy-allowlist change (no new file). **No** worker / `wrangler` impact.
- Non-goal: the broader `React.memo` / self-subscription / mutator-identity-stabilization sweep
  (the next Phase 3 increment). Non-goal: touching the ~12 edge toasts already outside the hooks.

## Operational notes

- Branch off the latest `origin/main`. The current `feature/seven-item-update` working-tree
  changes must be landed or stashed first so this increment starts clean.
- Per standing rule: build + verify in the working tree; **Jan reviews, commits, and merges** —
  the implementation does not commit or merge.

## Risks

- **Call-site churn (~25–30 sites):** mechanical but broad. Mitigated by wrapping at `App`
  (children unchanged) and by the anti-drift guards catching any missed in-hook `toast`.
- **Async awaits:** `addPosition`/`importPositions`/push fns are async; `withToast` awaits, so
  the toast still fires after the mutation resolves (same ordering as today).
- **Return-value collisions:** a mutator whose old return value a caller relied on must be
  checked per-mutator (plan checklist item).
- **Nested mutator calls:** confirm no mutator invokes another mutator (double-toast). Current
  `addPosition` writes sibling slices via raw setters, not via `addTfsaDeposit`, so no nesting
  today — the plan re-verifies.
