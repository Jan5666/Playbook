# Phase 4 increment 13 — extract `ContributionModal` into `pb-modals.js` — Implementation Plan

**Goal:** Move `ContributionModal` verbatim from `app.js` into the existing `pb-modals.js`
bucket, grow the `window.PBApp` bridge by one (`sanitizeDecimalInput`), add a `PBCore`
IIFE read (`parseDecimal`), and bump the sw cache. A cheap add — the new-file tax was paid in
inc-11.

**Branch:** `claude/refactor-plan-next-7cr7q5` (stacks on inc-12).

## Global constraints

- **Verbatim move via a Node slice script — never the Edit tool.** BOM + literal non-ASCII
  bytes (a literal `—`). Read/write `'utf8'`, split/join `'\n'`. **Use a replacement
  *function* for the modal splice** — the body contains `'$';`, and a string replacement would
  let `$'` expand.
- **Bridge grows by one.** `window.PBApp` 13 -> 14 (`+sanitizeDecimalInput`); it stays in
  app.js (shared decimal-input helper) -> TDZ-safe (defined before the publish).
- **Globals read directly, internals via the bridge.** `parseDecimal` is a `PBCore` global
  (IIFE read); `sanitizeDecimalInput` is an app.js internal (bridge).

## Task 1 — extract the modal + grow the bridge + add the IIFE PBCore read + bump sw

**Files:** `app.js` (remove `ContributionModal` -> comment + 1 bind; grow bridge),
`pb-modals.js` (add `const parseDecimal = PBCore.parseDecimal;`; splice modal + registration),
`sw.js` (cache bump). Throwaway: `scratchpad/inc13-extract.mjs`.

Slice-script outline:
- app.js: slice `[function ContributionModal( ... )` bounded on the next top-level
  `function `, rewound past the leading comment block for `ContributionImportModal` (assert the
  preceding line is `}`).
- Inject `const { Icon, useSwipeDownToClose, useBodyScrollLock, sanitizeDecimalInput } =
  window.PBApp;` as the first body statement.
- Replace the app.js span with the pointer comment + `const ContributionModal =
  PBModals.ContributionModal;`.
- Grow bridge: exact-line replace adding `, sanitizeDecimalInput`.
- pb-modals.js: add the `PBCore.parseDecimal` read after the IIFE hook line; insert the modal
  before the `window.PBModals = ...` block (replacement **function** form); add the
  `window.PBModals.ContributionModal` registration after the `SectorDetailModal` one.
- sw.js: `CACHE_NAME` `v60 -> v61`.

Then: `node --check app.js && node --check pb-modals.js`.

## Task 2 — docs sync

`architecture-map.html`: bridge note **13 -> 14** (add `sanitizeDecimalInput`).

## Task 3 — verify

1. Full node suite green; `deploy-assets` green (asset set unchanged).
2. Anti-drift greps (spec Verification gate 3).
3. **Mount gate:** `verify-refresh-behavior.mjs` -> ALL PASSED.
4. **Render check:** `verify-modals.mjs` (committed) — deposit + import panels render, no page
   exception; rerun on the known flaky CDP race.

> **Container note:** `CHROME_PATH=/opt/pw-browsers/chromium`, `--no-sandbox`, locally-`npm i`'d
> React (unpkg egress-blocked) — baked into `scratchpad/patch-harness.mjs`. Committed harnesses
> untouched.

## Task 4 — measured read-out + docs

Append the measured read-out to the spec (app.js/pb-modals.js deltas, bridge = 14, bucket = 3,
sw v61). Commit code + docs to the branch; push. No PR; never `main`.

## Self-review

- Scope -> Task 1.
- Dependency inventory (`sanitizeDecimalInput` bridged; `parseDecimal` IIFE PBCore read) ->
  Task 1 injects, Task 3 greps verify.
- Bridge +1 only -> exact-line replace + anti-drift grep.
- Slice footgun (`$'` in the body) -> replacement-function form; `node --check` confirms.
- Wiring (cheap: sw bump only; no new-file tax) -> Task 1; `deploy-assets` green confirms.
- Encoding (BOM + literal `—` verbatim) -> Global constraints + render-check U+FFFD check.
- Render coverage (committed `verify-modals` drives both contribution modals) -> Task 3.
- Out-of-scope (`ContributionImportModal`/inc-14, money/alert, portal, Vite) -> honored.
