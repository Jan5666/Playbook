# Phase 4 increment 23 — first view beyond modals: `HeatmapView` -> `pb-views.js`

**Date:** 2026-07-21
**Branch:** `claude/refactor-plan-q74cry` (off latest `origin/main` @ inc-22/PR #33)
**Status:** executed — all gates green (see measured read-out)

## Goal

Move the sector-heatmap tab view `HeatmapView` (`app.js`, **260 lines**) plus its single-caller
`HeatmapFullscreen` chrome (**19 lines**) into the `pb-views.js` bucket as a **byte-identical verbatim
move**. Phase 4 modal extraction finished at inc-22; this opens the **non-modal view tier** — the large
tab views still in `app.js` (Dashboard, Current, Watchlist, Heatmap, TFSA). Heatmap is the safest first
pick: a self-contained visualization that **displays** (no money computed, no persistence) and delegates
its sector dive-in to the already-extracted `SectorDetailModal`.

## Why this is a display/delegate move (not money-tier)

The only money the view touches is **display sizing**: `convertCcy(p.shares * p.costBasis,
positionCostCcy(p), displayCurrency, rates)` to size a treemap tile by cost. Both `convertCcy` and
`positionCostCcy` are **pb-core functions that do not move** — they are IIFE-read in the bucket. No
cost-basis is re-derived, no order is placed, no `pb.*` key is written. So rule #3's "characterization
test first" is satisfied by a **before/after render probe** (as with the Dashboard-tier display views),
not a new characterization-test file.

## Dependency inventory (every free identifier classified)

Move block = `HeatmapFullscreen` (app.js 7743–7761) + `HeatmapView` (7768–8027). After subtracting
locals / natives / props / already-bridged, the residue is **+1 bridge, +5 IIFE reads**.

### Reaches app.js internals -> bridge (`window.PBApp`) — **+1 (38 -> 39)**

- **`HeatmapTreemap`** — the one new member. A **multi-caller**: `HeatmapView` (7768→moves) **and**
  `ZoomPanHeatmap` (app.js:7735, **stays** — it is itself bridged for pb-modals `SectorDetailModal`). So
  `HeatmapTreemap` **stays in app.js** and is published on the bridge.
- Already bridged and read at render time: `Icon`, `usePersistedState`, `resolveTickerName`,
  `ZoomPanHeatmap` (used only by the moved `HeatmapFullscreen`).

Injected lead reads:
- `HeatmapFullscreen`: `const { Icon, ZoomPanHeatmap } = window.PBApp;`
- `HeatmapView`: `const { Icon, resolveTickerName, usePersistedState, HeatmapTreemap } = window.PBApp;`

### Reads module globals -> IIFE — **+5** (first PBCore/PBData `const` binds in `pb-views.js`)

`convertCcy`, `positionCostCcy`, `marketCurrency`, `priceKey` (PBCore) + `fetchQuoteBatchLight`
(PBData) — added at the top of the bucket IIFE. `PBCore`/`PBData` load before `pb-views.js`, so these are
safe. (`fetchQuoteBatchLight` had a single app.js caller — the moved `HeatmapView`; its app.js alias at
`app.js:483` is now an unused module-global bind, left in place as harmless.) `useLayoutEffect` was
**absent** from the bucket's React destructure and is now added (line 5) — the moved view uses it.

### `SectorDetailModal` + `DATA` read at render time

`pb-modals.js` loads **after** `pb-views.js`, so the view cannot IIFE-read `PBModals.SectorDetailModal`;
it is read in-body: `const SectorDetailModal = PBModals.SectorDetailModal;` (resolves at render time —
the pb-views load-order pattern). Likewise `const DATA = window.PB_DATA;` (`DATA.HEATMAPS` /
`DATA.findSector` / `DATA.classifySectorByName`). The now-dead app.js `SectorDetailModal` bind (7767, its
only caller was `HeatmapView`) is removed.

### `content.test.mjs` unaffected

No `PBContent` bind moves out of app.js (`SECTOR_ETF`/`SECTOR_TREND_WINDOWS` back the staying
`fetchSectorTrend`/`HeatmapTreemap`); the delegation guard passes with **no test change**.

## Mechanism

Node line-range slice (**never the Edit tool** — BOM + LF; the body carries literal `£ · —`). Blocks
validated in memory against seven content anchors (fs comment/fn/close, sdm bind, hv fn/close, the
following `PicksView` bind) before any write; both files computed and asserted, then written atomically.

Into `pb-views.js` (before the registration block; hoisting makes order moot): the two functions with
their injected lead reads, then `window.PBViews.HeatmapView = HeatmapView;` after the
`MarketRotationView` registration (`HeatmapFullscreen` stays bucket-private — no external caller).

In `app.js`: the whole 7743–8027 span -> a pointer comment + `const HeatmapView = PBViews.HeatmapView;`
(TDZ-safe; the App tab-switch call site at `app.js:3473` is inside a function body). **Add
`HeatmapTreemap`** to the bridge publish line.

## Wiring

- `sw.js` `CACHE_NAME` **v72 -> v73**. Only shipped-file wiring.
- **Zero** edits to index.html / static.yml / SHELL_ASSETS / the harnesses — the bucket is already wired.
- `architecture-map.html` — bridge **38 -> 39** (+`HeatmapTreemap`) in both the count/narrative and the
  literal member list, plus an inc-23 history note.
- `REFACTOR_STATUS.md` — Done + Current-state (bridge **39**, `sw` **v73**, first view-tier increment).

## Verification gate

1. `node --check` app.js + pb-views.js.
2. Full node suite (**27**; money gate unaffected — no pb-core money code moved; content guard;
   deploy-assets).
3. Anti-drift greps: `function HeatmapView`/`function HeatmapFullscreen` = 0 app.js / 1 pb-views.js;
   `HeatmapTreemap`/`ZoomPanHeatmap` still `function` = 1 in app.js (stay); pointer + bind; registration;
   **bridge = 39** with `HeatmapTreemap`; app.js `const SectorDetailModal =` bind = 0 (removed).
4. **Verbatim proof:** the moved bodies are exact substrings of `HEAD:app.js` (aside from the injected
   lead reads) and absent from app.js.
5. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED**.
6. **Render probe** (throwaway, before & after): US + crypto-in-ZAR seed; open the Dashboard tab
   (profit summary + today pill + line chart) and the Heatmap tab (view container renders, no uncaught
   page error, app still alive). **Digest identical** before/after. U+FFFD scan; BOM/NUL/LF integrity.

## Out of scope / deferred

- `HeatmapTreemap`, `ZoomPanHeatmap`, `buildSectorHierarchy`, `fetchSectorTrend` + the
  `SECTOR_ETF`/`SECTOR_TREND_*` trend infra **stay in app.js** (shared with pb-modals via the bridge).
- **`FxSummary`** (`app.js`) remains vestigial dead code — flagged for a separate cleanup, untouched.

## Commit note

Development on `claude/refactor-plan-q74cry`; commit + push to the feature branch. **No PR; `main` never
pushed.** Scratchpad scripts never committed.

## Measured read-out (2026-07-21, on execution)

All gates green — the prediction held exactly.
- **Render probe green before AND after** the move, **byte-identical digest**:
  `{"dashSummary":"OVERALL PROFIT −$1,825.00","todayPill":"▲+$171.25 · +5.70%","hasLine":true,`
  `"svgCount":12,"heatDom":true,"heatErr":null}`. Both runs ALL PASSED; the Heatmap tab renders with no
  uncaught page error and the app stays alive after the switch.
- **Verbatim:** `HeatmapFullscreen` (19 lines) and `HeatmapView` (260 lines) are exact substrings of
  `HEAD:app.js` (aside from the injected lead reads) and absent from the new app.js.
- `node --check` OK (app.js, pb-views.js). Full node suite **27/27** (money gate + content guard +
  deploy-assets). U+FFFD = 0; BOM + LF preserved; app.js NUL 0->0, pb-views.js NUL 2->2; no CRLF.
- Anti-drift: `function HeatmapView`/`function HeatmapFullscreen` **0 app.js / 1 pb-views.js**; pointer +
  `const HeatmapView = PBViews.HeatmapView`; registration after `MarketRotationView`; **bridge 39** with
  `HeatmapTreemap`; `function HeatmapTreemap`/`function ZoomPanHeatmap` **1 in app.js** (unmoved);
  `const SectorDetailModal =` **0 in app.js** (dead bind removed).
- Mount gate `verify-refresh-behavior` **ALL PASSED**.

**Bucketing economics, measured:**
- `app.js` **-280 net** (285-line span -> 5-line pointer + bind), `pb-views.js` **+296** (two blocks + 6
  IIFE-read lines + 3 injected reads + section comment + registration), `sw.js` **v72 -> v73**. Zero
  index/static/harness edits.
- **Bridge 38 -> 39 (+HeatmapTreemap), IIFE +5** (the first PBCore/PBData `const` binds in `pb-views.js`).

**Conclusion:** the sector-heatmap view is extracted; `pb-views.js` now holds **7 views + the Heatmap
fullscreen chrome**; bridge **39**; `sw` `CACHE_NAME` **v73**. The non-modal view tier is underway.
