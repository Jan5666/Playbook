# Phase 4 increment 18 — extract `AlertsModal` — Implementation Plan

**Goal:** Move the 170-line block `app.js:8567–8736` (`AlertsModal`) into `pb-modals.js`. Bridge
**33 -> 33 (+0)**; **0 new IIFE reads**. Safe display + CRUD move — no rule-#3/#5/MONEY-GATE code.

**Branch:** `claude/refactor-plan-continuation-jrgahr` (off latest `origin/main`).

## Constraints

- **Node slice, never Edit tool.** BOM + LF; literal `· ↑ ↓ … "` + curly quotes. Replacement-fn splice.
- **Bridge +0:** `Icon, fmt, timeAgo, useSwipeDownToClose, useBodyScrollLock` are all already bridged.
- **IIFE +0:** `useRef` already in the bucket React destructure; no PB* module global referenced.
- **1 lead read:** `AlertsModal` — `{ Icon, fmt, timeAgo, useSwipeDownToClose, useBodyScrollLock }`.
- alert eval / `marketOpen` / money math stay in `pb-core`; the modal never touched them.

## Task 1 — move block + inject lead read + register + bump sw

Files: `app.js` (block -> pointer+bind; bridge unchanged), `pb-modals.js` (block + 1 lead read +
header + registration), `sw.js` (v67 -> v68). Throwaway `scratchpad/inc18-extract.mjs`.

Slice: `function AlertsModal(_ref11) {` .. the `}` before `// ContributionModal moved …`. Assert first
line, last line `}`, and the post-block comment. Inject the lead read after line 1 (single-line
signature). Insert the block before `window.PBModals = window.PBModals || {};`; register
`window.PBModals.AlertsModal = AlertsModal;` after the `SettingsModal` registration. `node --check`
both.

## Task 2 — docs

`architecture-map.html`: append inc-18 clause to the bridge-history note (count unchanged). Spec + this
plan under `docs/superpowers/`. Refresh `REFACTOR_STATUS.md` Done/Current-state (7 modals, v68).

## Task 3 — verify

Node suite (money gate + content guard + deploy-assets) green; anti-drift greps; mount gate
`verify-refresh-behavior` ALL PASSED; **Alerts render probe** (seed alerts+triggered, open sheet,
assert modal + perm-box + section counts + alert-item rows + note branch render, no destructive
actions, U+FFFD scan).

## Task 4 — read-out + progress doc + commit

Append read-out to spec. Refresh `REFACTOR_STATUS.md`. Commit + push to the feature branch.
**No PR; never `main`.**

## Self-review

- Scope (`openChart` block-local closure; no onAddAlert/eval; no PB* global) -> verified by inventory.
- Inventory complete (0 bridge + 0 IIFE new; all deps pre-bridged/IIFE-read) -> anti-drift greps.
- Single-line signature -> inject lead read after line 1 (not a multi-line-params case).
- Rule #3/#5 (no alert-eval/money/backup code moves; delegated via props) -> render probe pins render
  without firing remove/clear/permission.
- Encoding (`· ↑ ↓ … "`) -> U+FFFD scan on files + rendered modal.
