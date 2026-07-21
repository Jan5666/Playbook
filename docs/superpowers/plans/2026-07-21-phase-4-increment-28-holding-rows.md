# Phase 4 increment 28 -- relocate `HoldingRow` + `HoldingsListHead` -- Implementation Plan

**Goal:** Move the two shared holding-row components `HoldingsListHead` + `HoldingRow` (`app.js`
4504-4581) into `pb-views.js` and **drop them from the `window.PBApp` bridge (46 -> 44)**. A pure
**bridge shrink**: inc-27 moved `TFSAView`, leaving both rows with **zero app.js callers** -- consumed only
by the bucket's `CurrentView` + `TFSAView`. **Bridge -2**, **IIFE +1** (`isUnitTrustId`). Display-only;
no money/alert code moves.

**Branch:** `claude/refactor-plan-continuation-645imf` (off latest `origin/main` @ inc-27/PR #37).

## Constraints

- **Node slice, never Edit tool** for the body block. BOM + LF; body carries literal `- " '`.
  Content-anchored splice with boundary assertions (open `// row zones:`, close the `});` before
  `// CurrentView is defined in pb-views.js`); both files written atomically.
- **Bridge -2 / IIFE +1:** `positionDisplayName`/`fmtCcy` stay bridged (other bucket readers) via a
  HoldingRow lead read; `valuePositionInCostCcy` already IIFE-read (inc-25); `isUnitTrustId` becomes a new
  `PBData` IIFE read (pb-modals.js reads it the same way).
- **Keep the app.js `const isUnitTrustId = PBData.isUnitTrustId;` bind** even though it goes unused --
  `data-providers.test.mjs` asserts "app.js binds isUnitTrustId from PBData". Annotate it. (No back-bind for
  the rows themselves -- app.js's router never references them.)
- `content.test.mjs` + other delegation guards untouched -- no `PBContent`/`PBCore` bind moves out of app.js.
- **No money/alert semantics touched** -- `HoldingRow` calls pb-core `valuePositionInCostCcy` (unmoved);
  rule #4 (`SessionBadge` absence in `HoldingRow`) preserved because the move is byte-identical.

## Task 1 -- move block + lead read + IIFE read + register + shrink bridge + bump sw

One atomic Node script. `app.js`: remove 4504-4581 -> a one-line pointer comment; keep the `isUnitTrustId`
bind (annotated); remove `, HoldingRow, HoldingsListHead` from the `window.PBApp = { ... }` publish line.
`pb-views.js`: add `const isUnitTrustId = PBData.isUnitTrustId;` beside the inc-26 `parseDecimal` read;
insert the block before `function CurrentView(_ref7) {` with `const { positionDisplayName, fmtCcy } =
window.PBApp;` injected as HoldingRow's first body statement; rewrite the `CurrentView` (drop
`HoldingRow, HoldingsListHead,`) and `TFSAView` (drop `, HoldingRow, HoldingsListHead`) lead reads; register
`window.PBViews.HoldingRow`/`.HoldingsListHead` after `CurrentView`. `sw.js` `CACHE_NAME` v77 -> v78.
`node --check` both files.

## Task 2 -- docs

`architecture-map.html`: bridge 46 -> 44 (three spots), remove the two members from both publish-line
strings, append an inc-28 clause. `REFACTOR_STATUS.md`: Done entry + Current-state (bridge **44**, `sw`
**v78**, rows now in bucket) + mark inc-28 done in the Remaining section. Spec + this plan. No source-guard
update (no PBContent bind moved; the `isUnitTrustId` guard stays satisfied by the kept bind).

## Task 3 -- verify

Full node suite **27/27** (money gate + content + deploy-assets + `data-providers`); anti-drift greps
(`function HoldingRow`/`function HoldingsListHead` 0 app.js / 1 pb-views.js; rows absent from the bridge
line; **bridge 44**; `isUnitTrustId` read+used in pb-views.js + bind kept in app.js); **verbatim proof**
(moved block minus the 1 lead read == `HEAD:app.js`); **mount gate** `verify-refresh-behavior` ALL PASSED
(2 `.holding-row`s render from the bucket, no session badge -- doubles as the CurrentView->HoldingRow render
probe); U+FFFD = 0 + BOM/LF preserved.

## Task 4 -- read-out + commit

Append the measured read-out to the spec. Commit to the feature branch. **No PR; never `main`.** Scratchpad
scripts never committed.

## Self-review

- Pure bridge shrink -- the rows are display-only; the only money is `valuePositionInCostCcy` (pb-core,
  unmoved). Verified byte-identical (verbatim diff vs `HEAD:app.js`), so rule #4 holds automatically.
- Inventory complete via a full read of both components: `positionDisplayName`/`fmtCcy` stay bridged,
  `valuePositionInCostCcy` already IIFE-read, `isUnitTrustId` the one new IIFE read.
- The `isUnitTrustId` asymmetry (bind kept for the delegation guard) is the single deviation from a clean
  single-caller relocation -- called out in code comment + spec; caught by running the full node suite.
- Load order: registrations + the bridge publish are TDZ-safe (render-time reads); the moved `const
  HoldingRow` is IIFE-scoped and initialized before any render.
- Encoding -> U+FFFD scan + BOM/LF preserved + verbatim diff.
