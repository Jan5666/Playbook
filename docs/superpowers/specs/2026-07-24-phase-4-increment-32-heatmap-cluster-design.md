# Phase 4 · Increment 32 — Heatmap cluster (`HeatmapTreemap` + `ZoomPanHeatmap`) → `pb-views.js` (design)

## Why

Phase 4 peels large view/modal components out of the no-build `app.js` UMD monolith into the
browser-only classic-script buckets (`pb-views.js`, `pb-modals.js`). `REFACTOR_STATUS.md` declared
the structural extraction "effectively complete" at inc-31 (bridge 43), on the reasoning that the
remaining bridged components are "genuinely shared across both buckets" and therefore correctly stay
on the `window.PBApp` bridge.

A fresh caller inventory shows that reasoning is too conservative for the Heatmap cluster.
**`HeatmapTreemap` (`app.js:5195–5270`) and `ZoomPanHeatmap` (`app.js:5276–5425`) have no root-`App`
caller.** They are entered only from the buckets:

- `ZoomPanHeatmap` → `pb-views.js` `HeatmapFullscreen` and `pb-modals.js` `SectorDetailModal`.
- `HeatmapTreemap` → `pb-views.js` `HeatmapView` and, internally, `ZoomPanHeatmap` (which travels
  with it — the only `app.js` reference to `HeatmapTreemap` was inside `ZoomPanHeatmap`'s body).

Their whole supporting treemap-layout math (`app.js:4984–5135`: `heatColor`, `squarify`,
`layoutSquarify`, `computeWorst`, `buildSectorHierarchy`, `layoutTreemap`) is Heatmap-private (no
`app.js` or bucket caller outside the cluster). Because the script load order is `pb-views.js` →
`pb-modals.js` → `app.js` and the buckets read each other at **render time** (always after all
scripts load), the cluster moves into `pb-views.js` with `pb-modals.js`'s `SectorDetailModal` reading
`ZoomPanHeatmap` from `window.PBViews` — the mirror of the inc-23 pattern (`pb-views.js` reading
`SectorDetailModal` from `PBModals` at render time). This is the last clean structural extraction:
it clears the Heatmap infra frontier and shrinks the bridge by 2 (**43 → 41**).

## Scope

Move into `pb-views.js` (verbatim):
- Treemap layout math (`app.js:4984–5135`, ~152 lines) — bucket-private, travels with the cluster.
- `HeatmapTreemap` (`app.js:5195–5270`, ~76 lines).
- `ZoomPanHeatmap` (`app.js:5276–5425`, ~150 lines, incl. its doc-comment).

Stays put: `useContainerWidth` (`app.js:5136–5153`) — **shared** (also consumed by two other
`pb-views.js` components), so it stays in `app.js` and stays bridged; `fetchSectorTrend` +
sector-trend infra (`app.js:5154–5194`) — stays (bridged impure reader, `SectorDetailModal` still
reads it from `PBApp`). No money/alert code is involved (pure display + geometry — rules #3/#4
unaffected).

## Dependency inventory

Move block = treemap math (4984–5135) + `HeatmapTreemap`/`ZoomPanHeatmap` (5195–5425).

| identifier | classification |
|---|---|
| `React`, `Math`, `Object`, `isFinite`, `document`, `window`, `requestAnimationFrame`, `cancelAnimationFrame`, `ResizeObserver` | UMD / native globals (free) |
| `useMemo`, `useRef`, `useState`, `useEffect` | native React hooks — already IIFE-read at `pb-views.js` top (line 5) |
| `priceKey` | `PBCore.priceKey` — already IIFE-read in `pb-views.js` (line 10, inc-23) |
| `heatColor`, `squarify`, `layoutSquarify`, `computeWorst`, `buildSectorHierarchy`, `layoutTreemap` | Heatmap-private helpers — **move with the block** (bucket-private, hoisted function declarations) |
| `SECTOR_HEADER`, `INDUSTRY_HEADER` | local `const`s inside `layoutTreemap` — travel with it |
| `Icon` | already bridged → `HeatmapTreemap` lead read `const { Icon, useContainerWidth } = window.PBApp;` |
| `useContainerWidth` | already bridged, **stays bridged** (shared) → part of `HeatmapTreemap`'s lead read |
| `useBodyScrollLock` | already bridged → `ZoomPanHeatmap` lead read `const { useBodyScrollLock } = window.PBApp;` |
| `HeatmapTreemap` (inside `ZoomPanHeatmap`) | bucket-local after the move (hoisted) |
| props (`rows`, `loading`, `onOpenDetail`, `onOpenSector`, …) | props |

⇒ **Clean verbatim move. 0 new bridge members, 0 new IIFE reads** (every native hook + `priceKey`
were already IIFE-read in `pb-views.js` from inc-23/24). Two injected lead reads (one per moved
component). `useContainerWidth` was the one shared-dependency decision — it stays bridged.

## Bridge / registration

- `window.PBApp` publish line: **remove** `ZoomPanHeatmap` and `HeatmapTreemap` (bridge **43 → 41**).
  `useContainerWidth` **stays** (still consumed by two `pb-views.js` components).
- **Register** `window.PBViews.HeatmapTreemap` and `window.PBViews.ZoomPanHeatmap` — both are consumed
  cross-bucket by `pb-modals.js` `SectorDetailModal` (`ZoomPanHeatmap`) at render time.
- `pb-modals.js` `SectorDetailModal` lead read splits: `ZoomPanHeatmap` now comes from
  `window.PBViews` (render-time read), the other three (`Icon`, `useBodyScrollLock`,
  `fetchSectorTrend`) stay on `window.PBApp`.
- `pb-views.js` `HeatmapFullscreen`/`HeatmapView` lead-read destructures lose `ZoomPanHeatmap` /
  `HeatmapTreemap` (now bucket-local). `app.js` retains pointer comments where the code was.

## Encoding note

All three files are **BOM + LF** with **literal glyphs** (e.g. `×` in the zoom badge, `·`/`—` in
comments; the CLAUDE.md "BOM + CRLF" note is stale — verified 0 CRLF, utf8 round-trips losslessly).
Move via a Node slice script (read/write `utf8`, split/join `\n`, keep the BOM, content-anchored
boundary assertions) — never the Edit tool.

## Read-out (measured)

- `node --check` app.js / pb-views.js / pb-modals.js: **OK**.
- Encoding after move: all three **BOM + LF**, U+FFFD scan **clean** (0 replacement chars).
- Anti-drift: `function HeatmapTreemap` / `function ZoomPanHeatmap` = **0** app.js / **1** each
  pb-views.js; treemap-math helpers = **0** app.js / **1** each pb-views.js; `ZoomPanHeatmap` &
  `HeatmapTreemap` **absent** from the `window.PBApp` publish line; both **registered** on
  `window.PBViews`; `SectorDetailModal` reads `ZoomPanHeatmap` from `window.PBViews`.
- Full node suite (money gate + content guard + deploy-assets): **28/28 pass**.
- Mount gate `verify-refresh-behavior` + a Heatmap-tab + `SectorDetailModal` render probe: _recorded at verify step_.
- app.js: 5611 → 5232 lines (~379 net out); bridge 43 → 41; `sw` `CACHE_NAME` v82 → v83.
