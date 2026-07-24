# Phase 4 · Increment 32 — plan (turnkey recipe)

Target: move the Heatmap cluster — treemap layout math (`app.js:4984–5135`), `HeatmapTreemap`
(`5195–5270`) and `ZoomPanHeatmap` (`5276–5425`) — from `app.js` into `pb-views.js` beside their only
consumers (`HeatmapView`/`HeatmapFullscreen`), drop `HeatmapTreemap`/`ZoomPanHeatmap` from the
`window.PBApp` bridge, and repoint `pb-modals.js`'s `SectorDetailModal` to read `ZoomPanHeatmap` from
`window.PBViews`. See the design doc for the dependency inventory. `useContainerWidth` (5136–5153)
**stays** in app.js (shared with two other views).

1. **Inventory** — done (design doc). Bridge change: **remove** `ZoomPanHeatmap` + `HeatmapTreemap`
   (43 → 41). 0 new bridge members, 0 new IIFE reads (native hooks + `priceKey` already IIFE-read in
   `pb-views.js`). Two injected lead reads (one per moved component).

2. **Verbatim move** — Node slice script (BOM + LF safe; read `utf8`, split/join `\n`, keep BOM,
   splice by content-anchored line index with boundary assertions). Cut two ranges from `app.js`:
   - Block A: `function heatColor(pct, isLight) {` (4984) → end of `layoutTreemap` `}` (5135).
   - Block B: `function HeatmapTreemap(_ref8c) {` (5195) → end of `ZoomPanHeatmap` `}` (5425)
     (includes the ZoomPanHeatmap doc-comment at 5271–5275).
   Leave 5136–5194 (`useContainerWidth` + `fetchSectorTrend`) in place. Insert Block A + Block B into
   `pb-views.js` just after the `// ─── Heatmap …` section header (before the
   `// Full-screen pinch-to-zoom …` `HeatmapFullscreen` comment).

3. **Lead reads** — inject as each moved function's first body statement (after the params destructure):
   - `HeatmapTreemap`: `const { Icon, useContainerWidth } = window.PBApp;`
   - `ZoomPanHeatmap`: `const { useBodyScrollLock } = window.PBApp;`
   Treemap-math helpers need no lead read (bucket-private, hoisted).

4. **Bridge + callers** — remove `ZoomPanHeatmap` and `HeatmapTreemap` from the `window.PBApp = { … }`
   publish line (keep `useContainerWidth`). **Register** `window.PBViews.HeatmapTreemap` +
   `window.PBViews.ZoomPanHeatmap` (after the `HeatmapView` registration). Drop the moved names from
   `pb-views.js`'s `HeatmapFullscreen` (`{ Icon, ZoomPanHeatmap }` → `{ Icon }`) and `HeatmapView`
   (`{ …, HeatmapTreemap }` → drop it) `window.PBApp` lead reads. Split `pb-modals.js`
   `SectorDetailModal`'s lead read: `{ Icon, useBodyScrollLock, fetchSectorTrend }` from `window.PBApp`
   **plus** `const { ZoomPanHeatmap } = window.PBViews;`. Replace the app.js code with pointer
   comments (and rewrite the stale inc-23 "stay in app.js" note in `pb-views.js`).

5. **Wiring** — `sw.js` `CACHE_NAME` v82 → v83 (only shipped-file change; `pb-views.js` already wired,
   no new runtime file → no `index.html`/`SHELL_ASSETS`/`static.yml`/harness change; `deploy-assets`
   stays green). No `PBContent`/`PBData`/`PBCore` bind left app.js → no delegation/anti-inline guard
   change; no test references the moved names.

6. **Docs** — `REFACTOR_STATUS.md` Done + Current-state + branch header (bridge 43 → 41, `CACHE_NAME`
   v83, Heatmap frontier cleared); this spec+plan pair. (No `architecture-map.html` exists in this
   repo state — `REFACTOR_STATUS.md` is the bridge-count-of-record.)

## Verification (all green before commit)

- `node --check app.js && node --check pb-views.js && node --check pb-modals.js`.
- Full node suite incl. **money gate** (`money-math`, `cost-basis`, `import-matching`, `ee-ocr-parse`):
  `for f in backend/test/*.test.mjs; do node "$f" || break; done` → **28/28**.
- Anti-drift greps: `function HeatmapTreemap`/`function ZoomPanHeatmap` = 0 app.js / 1 pb-views.js;
  treemap-math helpers = 0 app.js / 1 pb-views.js each; both absent from the `window.PBApp` publish
  line; both registered on `window.PBViews`; `SectorDetailModal` reads `ZoomPanHeatmap` from
  `window.PBViews`.
- **Mount gate**: `verify-refresh-behavior.mjs` (scratchpad-patched copy: `ROOT=/home/user/Playbook`,
  local React via `/__react.js`+`/__react-dom.js`, `--no-sandbox`, `CHROME_PATH=/opt/pw-browsers/chromium`).
- **Render probe** (throwaway): mount, open the **Heatmap** tab → assert `.treemap` cells render
  (`HeatmapView` → `HeatmapTreemap`); open a `SectorDetailModal` (sector tap) → assert its
  `.zoompan-stage`/treemap renders (pins the cross-bucket `window.PBViews` read). No money side-effects.
- U+FFFD scan over `app.js` + `pb-views.js` + `pb-modals.js`; `git checkout -- test-screenshots/`.

## Landing

Branch `claude/refactor-plan-xfs6i3` (off latest `origin/main` @ inc-31/PR #40). Commit
`refactor(view): relocate HeatmapTreemap + ZoomPanHeatmap into pb-views.js (inc 32)`; push
`git push -u origin claude/refactor-plan-xfs6i3`. **No PR, never `main`** — Jan reviews and lands.
