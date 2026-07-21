# Phase 4 increment 28 -- shared holding rows: `HoldingRow` + `HoldingsListHead` -> `pb-views.js`

**Date:** 2026-07-21
**Branch:** `claude/refactor-plan-continuation-645imf` (off latest `origin/main` @ inc-27/PR #37)
**Status:** executed -- all gates green (see measured read-out)

## Goal

Relocate the two shared holding-row components -- `HoldingsListHead` and `HoldingRow` (`app.js`, ~76
lines) -- into `pb-views.js` as a **byte-identical verbatim move**, and **drop them from the
`window.PBApp` bridge (46 -> 44)**. This is a pure **bridge shrink**, not an extraction that grows the
bridge: inc-25 bridged the rows because `CurrentView` (moved) and `TFSAView` (still in app.js) both
consumed them; inc-27 moved `TFSAView`, leaving both rows with **zero app.js callers**. They are now
consumed only by two bucket components, so they belong in the bucket beside them. Display-only presentational
components -- no money/alert math moves (they *call* pb-core's `valuePositionInCostCcy`, which stays put).

## The move block -- `app.js` 4504-4581 (one contiguous slice)

- the shared row-zones header comment (4504-4505)
- `HoldingsListHead` (4506) -- static header row; uses only `React`.
- `HoldingRow` (4512) -- `React.memo` holding card; the last app.js caller of `isUnitTrustId`.

Line 4582-4583 (`// CurrentView is defined in pb-views.js ... const CurrentView = PBViews.CurrentView;`)
stays in app.js.

## Dependency inventory (every free identifier classified)

After subtracting locals / natives, the residue is **-2 bridge, +1 IIFE read**.

### `HoldingsListHead`
Only `React` (IIFE global). **No lead read needed.**

### `HoldingRow`
- `React` / `React.memo` / `React.Fragment` -- IIFE global.
- `valuePositionInCostCcy` -- **already an IIFE read** in the bucket (`PBCore`, added inc-25).
- `positionDisplayName`, `fmtCcy` -- app.js internals with other bucket readers (`CurrentView`'s lead
  read still needs both; `fmtCcy` is bucket-wide). **Stay bridged.** Injected lead read:
  `const { positionDisplayName, fmtCcy } = window.PBApp;` (first body statement, before the param
  destructure).
- `isUnitTrustId` -- a **`PBData` global** (`PBData.isUnitTrustId`, pb-data.js:216). HoldingRow (4523) was
  its **only** app.js caller. Becomes a **new IIFE read** in the bucket:
  `const isUnitTrustId = PBData.isUnitTrustId;` (pb-modals.js already reads it this exact way).

### Bridge (`window.PBApp`) -- **-2 (46 -> 44)**
`HoldingRow`, `HoldingsListHead` removed from the publish line. `positionDisplayName`/`fmtCcy` kept
(other readers).

### The app.js `isUnitTrustId` bind -- **kept, deliberately**
`data-providers.test.mjs` asserts both "app.js has no local function isUnitTrustId" **and** "app.js binds
isUnitTrustId from PBData". Removing the now-unused `const isUnitTrustId = PBData.isUnitTrustId;` (app.js:487)
would fail the second guard. It stays (a harmless one-line delegation bind, annotated), so no test is
weakened. This is the one asymmetry vs. a normal single-caller relocation.

### `content.test.mjs` / other delegation guards -- untouched
No `PBContent`/`PBCore` bind moves out of app.js. The moved-in bucket read is a `PBData` global, guarded
(unchanged) by `data-providers.test.mjs` against `PBData`.

## Mechanism

One atomic Node slice script (**never the Edit tool** -- BOM + LF; the body carries literal `- " '`).
Content-anchored with boundary assertions: block start = `// row zones:`, end = the `});` immediately
before `// CurrentView is defined in pb-views.js`. Into `pb-views.js` before `function CurrentView(_ref7) {`
(hoisting/const-init-before-render makes order moot), with the HoldingRow lead read injected and the new
`isUnitTrustId` IIFE read added beside the inc-26 `parseDecimal` read. `CurrentView`/`TFSAView` lead reads
rewritten to drop the two now-bucket-local names. `window.PBViews.HoldingRow`/`.HoldingsListHead` registered
after `CurrentView`. In `app.js`: block -> one pointer comment (no back-bind -- app.js's router never
references the rows); the `isUnitTrustId` bind kept; the bridge publish line loses the two members.

## Wiring

- `sw.js` `CACHE_NAME` **v77 -> v78**. Only shipped-file change.
- **Zero** edits to index.html / static.yml / SHELL_ASSETS / the harnesses -- `pb-views.js` already wired.
- `architecture-map.html` -- bridge count 46 -> 44 (three spots), the two members removed from both
  publish-line member strings, inc-28 clause appended to the maintained narrative.
- `REFACTOR_STATUS.md` -- Done entry + Current-state (bridge **44**, `sw` **v78**, rows now in bucket).
- No `content.test.mjs` change (no PBContent bind moved).

## Verification gate

1. `node --check` app.js + pb-views.js.
2. Full node suite (**27**; money gate unaffected; content guard; deploy-assets; `data-providers` still
   green with the bind kept).
3. Anti-drift greps: `function HoldingRow`/`function HoldingsListHead` = **0 app.js / 1 pb-views.js**;
   no `HoldingRow`/`HoldingsListHead` in the bridge line; **bridge = 44 members**; `isUnitTrustId` used in
   pb-views.js + bind kept in app.js.
4. **Verbatim proof:** the moved block minus the 1 injected lead read is byte-identical to `HEAD:app.js`.
5. **Mount gate -- `verify-refresh-behavior.mjs` ALL PASSED**: full app boot; the Holdings tab renders
   `.holding-row`s from the bucket `HoldingRow`, none carrying a session badge (rule #4).
6. U+FFFD = 0; BOM + LF preserved.

## Out of scope / deferred

- Remaining Phase-4 candidates are non-view: the large remaining `app.js` section components.
- **`FxSummary`** (`app.js`) remains vestigial dead code -- flagged for a separate cleanup, untouched.

## Commit note

Development on `claude/refactor-plan-continuation-645imf`; commit + push to the feature branch. **No PR;
`main` never pushed.** Scratchpad scripts never committed.

## Measured read-out (2026-07-21, on execution)

All gates green -- the prediction held (-2 bridge / +1 IIFE), with the one anticipated wrinkle (keep the
app.js `isUnitTrustId` bind for the delegation guard).

- **Verbatim:** the moved block minus the injected `const { positionDisplayName, fmtCcy } = window.PBApp;`
  lead read is **byte-identical** to `HEAD:app.js` (verified programmatically) and absent from the new app.js.
  Diff stat: `app.js` net -76 lines (block -> 1-line pointer, `isUnitTrustId` bind kept, 2 members off the
  bridge line), `pb-views.js` +85 (76-line block + lead read + IIFE read + section header + 2 registrations +
  blank), `sw.js` v77 -> v78. Zero index/static/harness edits.
- `node --check` OK on both files. Full node suite **27/27** -- notably `data-providers.test.mjs` green
  because the app.js `isUnitTrustId` bind was kept (the first attempt, which removed it, failed exactly one
  assertion: "app.js binds isUnitTrustId from PBData"). Money gate + content guard + deploy-assets unchanged.
  U+FFFD = 0; BOM + LF preserved.
- Anti-drift: `function HoldingRow`/`function HoldingsListHead` **0 app.js / 1 pb-views.js**; app.js retains
  only the two prose comments + the pointer comment (no def, no bridge member); **bridge 44 members**, ending
  `...PortfolioPieChart, fmtNum, SessionBadge, useHotStocks, buildSuggestions`; `isUnitTrustId` read at
  pb-views.js:24 and called at pb-views.js:1845; app.js bind kept.
- Mount gate `verify-refresh-behavior` **ALL PASSED** -- `app mounts: true`; on the Holdings tab
  `{holdRows:2, holdBadge:null}` (both rows render via the relocated `HoldingRow`; rule #4 pinned). This run
  doubles as the `CurrentView` -> `HoldingRow` render probe; the `isUnitTrustId` binding is exercised (called
  with `p.ticker`, returns false for AAPL/GOOGL) and the unit-trust true branch is unchanged verbatim code.

**Bucketing economics, measured:**
- **Bridge 46 -> 44 (-2), IIFE +1.** The first Phase-4 increment that *shrinks* the bridge -- dead bridge
  weight removed once the rows' last app.js caller (TFSAView) had already moved.

**Conclusion:** the two shared holding rows now live in `pb-views.js` beside their only consumers; bridge
**44**; `sw` `CACHE_NAME` **v78**. Remaining Phase-4 candidates are the large non-view app.js section
components + the `FxSummary` dead-code cleanup.
