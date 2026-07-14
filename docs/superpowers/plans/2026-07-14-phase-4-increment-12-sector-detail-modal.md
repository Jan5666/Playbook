# Phase 4 increment 12 — extract `SectorDetailModal` into `pb-modals.js` — Implementation Plan

**Goal:** Move `SectorDetailModal` verbatim from `app.js` into the existing `pb-modals.js`
bucket, grow the `window.PBApp` bridge by two (`fetchSectorTrend`, `ZoomPanHeatmap`), widen the
bucket IIFE hooks, and bump the sw cache. A cheap add — the new-file tax was paid in inc-11.

**Branch:** `claude/refactor-plan-next-7cr7q5` (stacks on inc-11).

## Global constraints

- **Verbatim move via a Node slice script — never the Edit tool.** BOM + literal non-ASCII
  bytes `▲ ▼ — · …`. Read/write `'utf8'`, split/join `'\n'`.
- **Bridge grows by two.** `window.PBApp` 11 → 13. Both members stay in `app.js`
  (`fetchSectorTrend` uses proxy/cache; `ZoomPanHeatmap` also feeds `HeatmapView`) → TDZ-safe.
- **Globals read directly, internals via the bridge.** The modal reads no
  `PB_DATA`/`PBStore`/`PBContent`; only hooks + bridge members.

## Task 1 — extract the modal + grow the bridge + widen IIFE hooks + bump sw

**Files:** `app.js` (remove `SectorDetailModal` → comment + 1 bind; grow bridge),
`pb-modals.js` (widen IIFE hooks; splice modal + registration), `sw.js` (cache bump).
Throwaway: `scratchpad/inc12-extract.mjs` (the inc-11 script, re-pointed).

Slice-script outline (ASCII markers, unique — verified):
- app.js: slice `[function SectorDetailModal( … )` bounded on the `function HeatmapView(`
  marker (assert the preceding line is `}`).
- Inject `const { Icon, useBodyScrollLock, fetchSectorTrend, ZoomPanHeatmap } = window.PBApp;`
  as the first body statement.
- Replace the app.js span with the pointer comment + `const SectorDetailModal =
  PBModals.SectorDetailModal;`.
- Grow bridge: exact-line replace adding `, fetchSectorTrend, ZoomPanHeatmap`.
- pb-modals.js: widen `{ useState, useRef }` → `{ useState, useRef, useCallback, useEffect,
  useMemo }`; insert the modal before the `window.PBModals = …` block; add the
  `window.PBModals.SectorDetailModal` registration.
- sw.js: `CACHE_NAME` `v59 → v60`.

Then: `node --check app.js && node --check pb-modals.js`.

## Task 2 — docs sync

`architecture-map.html`: bridge note **11 → 13** (add `fetchSectorTrend`, `ZoomPanHeatmap`).

## Task 3 — verify

1. Full node suite green; `deploy-assets` green (asset set unchanged).
2. Anti-drift greps (spec §Verification gate 3).
3. **Mount gate:** `verify-refresh-behavior.mjs` → ALL PASSED.
4. **Render check:** throwaway direct-mount `scratchpad/verify-sectordetail.mjs` (no committed
   harness drives this modal) → panel/title/stats/breadth/heatmap render, no U+FFFD, no
   exception.

> **Container note:** `CHROME_PATH=/opt/pw-browsers/chromium`, `--no-sandbox`, locally-`npm i`'d
> React (unpkg egress-blocked) — baked into the scratchpad render harness; the mount-gate
> harness uses the inc-11 patcher. Committed harnesses untouched.

## Task 4 — measured read-out + docs

Append the measured read-out to the spec (app.js/pb-modals.js deltas, bridge = 13, bucket = 2,
sw v60). Commit code + docs to the branch; push. No PR; never `main`.

## Self-review

- Scope → Task 1.
- Dependency inventory (`fetchSectorTrend`+`ZoomPanHeatmap` stay, bridged; hooks widened) →
  Task 1 injects, Task 3 greps verify.
- Bridge +2 only → exact-line replace + anti-drift grep.
- Wiring (cheap: sw bump only; no new-file tax) → Task 1; `deploy-assets` green confirms.
- Encoding (BOM + literal `▲▼—·…` verbatim) → Global constraints + render-check U+FFFD check.
- Render coverage gap (no committed harness) → throwaway direct-mount check; noted for a
  future committed harness.
- Out-of-scope (other modals, money/alert, portal, Vite) → honored.
