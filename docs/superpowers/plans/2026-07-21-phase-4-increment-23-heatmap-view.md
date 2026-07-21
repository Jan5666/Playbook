# Phase 4 increment 23 — extract `HeatmapView` — Implementation Plan

**Goal:** Move the 260-line `HeatmapView` + its 19-line single-caller `HeatmapFullscreen` into
`pb-views.js`. Bridge **38 -> 39** (**+`HeatmapTreemap`**, a multi-caller shared with the staying
`ZoomPanHeatmap`); **+5 IIFE reads** (`convertCcy`/`positionCostCcy`/`marketCurrency`/`priceKey` from
PBCore, `fetchQuoteBatchLight` from PBData — the first PBCore/PBData `const` binds in the views bucket).
First move of the **non-modal view tier**. Display + delegate — the sector dive-in is handed to the
already-extracted `SectorDetailModal`; no money computed, no persistence.

**Branch:** `claude/refactor-plan-q74cry` (off latest `origin/main` @ inc-22/PR #33).

## Constraints

- **Node slice, never Edit tool.** BOM + LF; body carries literal `£ · —`. Replacement-array splice;
  seven content anchors validated in memory before any write; both files written atomically.
- **Bridge +1 (`HeatmapTreemap`) / IIFE +5:** `Icon`/`usePersistedState`/`resolveTickerName`/
  `ZoomPanHeatmap` already bridged; add `useLayoutEffect` to the bucket's React destructure (absent
  before); add the five PBCore/PBData `const` binds at the IIFE top.
- **Render-time reads:** `SectorDetailModal` from `PBModals` (pb-modals loads after pb-views) and `DATA`
  from `window.PB_DATA`, injected in-body after each signature.
- Rule #3: the display-sizing `convertCcy(shares*costBasis, …)` is verbatim and pinned by a
  before/after render probe; both `convertCcy` and `positionCostCcy` are pb-core functions that do not
  move.

## Task 0 — baseline (BEFORE any move)

Scratchpad harness tooling (local React routes, `--no-sandbox`, pinned `ROOT`,
`CHROME_PATH=/opt/pw-browsers/chromium`) — committed harnesses never edited. Capture the clean-tree
baseline: node suite **27/27**, `verify-refresh-behavior` ALL PASSED, and `probe-views.mjs` (US +
crypto-in-ZAR seed; Dashboard + Heatmap tabs) digest.

## Task 1 — move block + lead reads + bridge + register + bump sw

Files: `app.js` (span 7743–8027 -> pointer + `const HeatmapView = PBViews.HeatmapView`; **+`HeatmapTreemap`**
on the bridge line; the dead `SectorDetailModal` bind removed), `pb-views.js` (`useLayoutEffect` + 5 IIFE
binds; the two functions with lead reads; `HeatmapView` registration), `sw.js` (v72 -> v73). Throwaway
`scratchpad/inc23-move.mjs`. `node --check` both JS files.

## Task 2 — docs

`architecture-map.html`: bridge **38 -> 39** (+`HeatmapTreemap`) in the count/narrative + the literal
member list, inc-23 history note. `REFACTOR_STATUS.md` Done/Current-state (bridge **39**, `sw` **v73**,
first view-tier increment). Spec + this plan under `docs/superpowers/`.

## Task 3 — verify

Node suite (money gate + content guard + deploy-assets) green; anti-drift greps (function count 0/1 both
functions; `HeatmapTreemap`/`ZoomPanHeatmap` still 1 in app.js; pointer + bind; registration; **bridge
39** with `HeatmapTreemap`; app.js `SectorDetailModal` bind = 0); **verbatim proof** (moved bodies exact
substrings of `HEAD:app.js` aside from the lead reads, absent from app.js); mount gate
`verify-refresh-behavior` ALL PASSED; **render probe re-run AFTER the move** — **digest identical** to
baseline; U+FFFD + BOM/NUL/LF integrity.

## Task 4 — read-out + progress doc + commit

Append the measured read-out to the spec. Refresh `REFACTOR_STATUS.md`. Commit to the feature branch.
**No PR; never `main`.**

## Self-review

- Display-only money (`convertCcy` tile-sizing) -> pinned by a before/after render probe (Dashboard +
  Heatmap tabs, US + crypto-in-ZAR); `convertCcy`/`positionCostCcy` are pb-core, not moved.
- Inventory complete (+1 bridge `HeatmapTreemap` / +5 IIFE; residue after subtracting locals/natives/
  props/already-wired is the one shared multi-caller + the five module globals) -> anti-drift greps +
  verbatim diff.
- Load order: `HeatmapTreemap` + the bridge publish are TDZ-safe (read at render time); `SectorDetailModal`
  + `DATA` are read in-body because pb-modals/data.js load after the bucket.
- Encoding (`£ · —` literals) -> U+FFFD scan + BOM/LF preserved + verbatim diff.
- `content.test.mjs` unaffected (no `PBContent` bind leaves app.js) -> full node suite green.
