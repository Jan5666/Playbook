# Phase 4 increment 18 — seventh modal: `AlertsModal` -> `pb-modals.js`

**Date:** 2026-07-18
**Branch:** `claude/refactor-plan-continuation-jrgahr` (off latest `origin/main`)
**Status:** design approved (plan mode) — cheapest safe modal remaining (senior-dev, no-regression first)

## Goal

Move the alerts sheet `AlertsModal` (`app.js:8567–8736`, 170 lines) into the `pb-modals.js` bucket as
a **byte-identical verbatim move** — the smallest, safest modal left.

**Why this is safe (the overriding constraint: no functional regression).** Read-verified: the modal
is **display + CRUD only**. It lists active alerts and triggered history and delegates every action to
props — `onRemoveAlert`, `onClearTriggered`, `onRequestPerm`, `onOpenDetail`. There is **no
`onAddAlert`, no `evalAlert`/`marketOpen`, no cost-basis / crypto / import-matching** — alert
evaluation and money math live in `pb-core` and are untouched. So the move touches **no rule-#3
(money/alert-eval) and no rule-#5 (backup-format) code**; it relocates a presentational component only.

## Dependency inventory (every free identifier classified, on `app.js` @ post-#29)

Block renders only `Icon` + native HTML (no other app.js component). `openChart` is a **block-local
closure** (calls the `onOpenDetail` prop). No module namespace used directly (no `PBStore`/`PBData`).

### Reaches app.js internals -> bridge (`window.PBApp`) — **0 new (stays 33)**

| Symbol | Kind | Status |
|---|---|---|
| `Icon` | leaf component | already bridged |
| `fmt` | money/price formatter (display) | already bridged |
| `timeAgo` | relative-time formatter | already bridged |
| `useSwipeDownToClose` | hook | already bridged |
| `useBodyScrollLock` | hook | already bridged |

All five are already members of the bridge -> the publish line is unchanged.

### Reads module globals -> IIFE — **0 new**

`useRef` is already in the bucket's React destructure (`const { useState, useRef, … } = React`).
No `PBCore`/`PBContent`/`PBData`/`PBStore` reference in the block, so no new IIFE read.

### Free globals / block-local / props

`React`, `navigator`, `window`, `confirm` — native, verbatim. Block-local: `panelRef`, `openChart`,
`isIOS`, `standalone`, `iOSNeedsInstall`, `recentTriggered`, and the `.map` / event params. Props:
`alerts, triggered, notifPerm, onClose, onRemoveAlert, onClearTriggered, onRequestPerm, onOpenDetail`
(destructured from the Babel-compiled `_ref11`).

Because no `PBContent` bind moves out of app.js, the `content.test.mjs` delegation guard is
**unaffected** — no test change (unlike inc-16's `SECTOR_FWD_PE`).

## Mechanism

Node line-range slice (**never the Edit tool** — BOM + LF; body carries literal `· ↑ ↓ … "` curly
quotes + arrows). Slice `8567–8736`; assert first line `function AlertsModal(_ref11) {`, last line `}`,
and the next app.js line is the `// ContributionModal moved …` comment. Splice with a replacement
function.

Into `pb-modals.js` (inserted before the registration block; hoisting makes order moot):
- **1 render-time lead read** as the first body statement:
  `const { Icon, fmt, timeAgo, useSwipeDownToClose, useBodyScrollLock } = window.PBApp;`
- Register `window.PBModals.AlertsModal`.

In `app.js`: block -> pointer comment + `const AlertsModal = PBModals.AlertsModal;`. Bridge publish
line **unchanged**. The invocation at `app.js` (`showAlerts && React.createElement(AlertsModal, {…})`)
is untouched.

## Wiring

- `sw.js` `CACHE_NAME` **v67 -> v68**. Only shipped-file wiring.
- **Zero** edits to index.html / static.yml / SHELL_ASSETS / the 16 harnesses — bucket already wired;
  `deploy-assets` stays green.
- `architecture-map.html` — append an inc-18 clause to the bridge-history note (count unchanged).

## Verification gate

1. `node --check` app.js + pb-modals.js + sw.js.
2. Full node suite (**27**; **money gate** unaffected — display only; **content guard** unchanged;
   `deploy-assets` green).
3. Anti-drift greps: `function AlertsModal` = 0 app.js / 1 pb-modals.js; lead read present; pointer +
   `const AlertsModal = PBModals.AlertsModal` present; registration present; invocation site intact.
4. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED** (patched scratchpad copy).
5. **Alerts render probe** (throwaway): seed active alerts + a triggered entry, open the sheet via
   `button[aria-label="Alerts"]`; assert `.modal-panel .modal-title` = "Alerts", the perm-box, the
   Active/Triggered section counts, all `.alert-item` rows (bridged `fmt`/`timeAgo` format without
   throwing), the ticker text, and the `a.note` branch render — **without** triggering
   remove/clear/permission side-effects. U+FFFD scan.

## Out of scope / deferred

The rule-#3-gated money/alert modals (Buy/Position/Sell — characterization test first); `ImportModal`
(next, safe-ish); `FxSummary` dead-code cleanup; Vite.

## Commit note

Development on `claude/refactor-plan-continuation-jrgahr`; commit + push to the feature branch.
**No PR; `main` never pushed.** Scratchpad scripts gitignored / never committed.

## Measured read-out (2026-07-18, on execution)

All gates green — the prediction held exactly.
- `node --check` app.js + pb-modals.js + sw.js OK. Full node suite **27/27** (money gate + content
  guard 14/0 + deploy-assets). U+FFFD = 0 on all modified files; BOM preserved.
- Anti-drift: `function AlertsModal` **0 app.js / 1 pb-modals.js**; lead read present; pointer+bind at
  the old def site; registration after `SettingsModal`; the `React.createElement(AlertsModal, …)`
  invocation unchanged.
- Mount gate `verify-refresh-behavior` **ALL PASSED** (app mounts; auto-poll, manual-refresh,
  lazy-tab, session-badge assertions all green) — proves app.js still mounts with the moved modal.
- Alerts render probe **PROBE ALL PASSED** first try: modal-title "Alerts"; perm-box renders;
  eyebrows "Active (2)" / "Triggered (1)"; **3 `.alert-item` rows** (2 active + 1 triggered); tickers
  AAPL/GOOGL render; the `a.note` branch renders; 0 U+FFFD in the rendered modal.

**Bucketing economics, measured:**
- `app.js` **10103 -> 9937 (-166)** (170-line block -> 4-line pointer comment + bind), `pb-modals.js`
  **2308 -> 2483 (+175)** (170-line block + 1 lead read + 3-line header + 1 registration), `sw.js`
  **v67 -> v68**. **Zero** index/static/harness edits.
- **Bridge 33 -> 33 (+0), IIFE +0.** The genuinely cheapest safe modal: every dependency was already
  bridged (`Icon`, `fmt`, `timeAgo`, `useSwipeDownToClose`, `useBodyScrollLock`) or IIFE-read
  (`useRef`). `openChart` confirmed a block-local closure over `onOpenDetail`.
- **Rule #3/#5 honored:** no alert-eval / cost-basis / backup-format code moved — the modal is
  display + prop-delegated CRUD; the probe pins render without firing any destructive action.

**Conclusion:** the alerts sheet is extracted; the bucket holds **7 modals + the detail subtree + the
settings subtree**; bridge unchanged at 33. Remaining Phase-4 modal tier: `ImportModal` (next, safe)
then the rule-#3-gated money modals (Buy/Position/Sell — characterization test first).
