# Phase 4 · Increment 33 — plan (turnkey recipe)

Target: move `function useContainerWidth()` (`app.js:4987–5004`) from `app.js` into `pb-views.js`
beside its only consumers (`RotationFlowDiagram`, `RotationIntradayChart`, `HeatmapTreemap`), and drop
`useContainerWidth` from the `window.PBApp` bridge. It has no root-`App` and no `pb-modals.js` caller,
so this is a clean bridge shrink (**41 → 40**) correcting inc-32's "stays bridged — shared" note. See
the design doc for the dependency inventory.

1. **Inventory** — done (design doc). Bridge change: **remove** `useContainerWidth` (41 → 40). 0 new
   bridge members, 0 new IIFE reads, 0 injected lead reads (uses only `useRef`/`useState`/`useEffect`,
   already IIFE-read at `pb-views.js:5`).

2. **Verbatim move** — Node slice script (BOM + LF safe; read `utf8`, keep BOM, content-anchored
   boundaries). Capture the exact `function useContainerWidth() { … return [ref, width]; }` block from
   `app.js` and reuse it byte-for-byte as the insertion. Cut it from `app.js` (between
   `fetchSectorTrend`'s neighbours) and insert into `pb-views.js` immediately **above**
   `function RotationFlowDiagram(_p) {` (its first consumer), with a bucket-private doc-comment. As a
   hoisted function declaration it needs no lead read; the bare calls in the two rotation components
   resolve to it directly.

3. **Lead read shrink** — `pb-views.js` `HeatmapTreemap`:
   `const { Icon, useContainerWidth } = window.PBApp;` → `const { Icon } = window.PBApp;`.

4. **Bridge + comment** — remove `useContainerWidth` from the `window.PBApp = { … }` publish line
   (`app.js`). **Not** registered on `window.PBViews` (no cross-bucket consumer — the inc-31
   `SectorWeightRows` precedent). Rewrite the adjacent app.js comment (the inc-32 note that said
   "useContainerWidth + fetchSectorTrend stay above (still shared / bridged)") so only `fetchSectorTrend`
   is described as staying, with a pointer that `useContainerWidth` moved to `pb-views.js` (inc 33).

5. **Wiring** — `sw.js` `CACHE_NAME` v83 → v84 (only shipped-file change; `pb-views.js` already wired,
   no new runtime file → no `index.html`/`SHELL_ASSETS`/`static.yml`/harness change; `deploy-assets`
   stays green). No `PBContent`/`PBData`/`PBCore` bind left app.js → no delegation/anti-inline guard
   change; no test references `useContainerWidth`.

6. **Docs** — `architecture-map.html` bridge member list (remove `useContainerWidth`) + count → 40 (the
   map was stale from before inc-32; brought current). `REFACTOR_STATUS.md` Done + Current-state
   (bridge 41 → 40, `CACHE_NAME` v84, correct the inc-32 "useContainerWidth correctly stays bridged"
   line). This spec + plan pair.

## Verification (all green before commit)

- `node --check app.js && node --check pb-views.js && node --check sw.js`.
- Full node suite incl. **money gate** (`money-math`, `cost-basis`, `import-matching`, `ee-ocr-parse`):
  `for f in backend/test/*.test.mjs; do node "$f" || break; done` → **28/28**.
- Anti-drift greps: `function useContainerWidth` = 0 app.js / 1 pb-views.js; absent from the
  `window.PBApp` publish line (bridge count 40); 0 refs in `pb-modals.js`.
- **Render gate** — the committed `verify-refresh-behavior.mjs` mount gate does not mount in this
  remote Linux container (fails identically on pristine `HEAD` — a harness/container artifact, not a
  regression). Validated with a standalone throwaway CDP render probe (scratchpad `probe-inc33.mjs`:
  repo files + local React via `/__react.js`+`/__react-dom.js`, `--no-sandbox`,
  `CHROME_PATH=/opt/pw-browsers/chromium`, `Runtime.exceptionThrown` capture): mount → open the
  **Heatmap** tab (`HeatmapTreemap` → `useContainerWidth`) and the **Rotation** tab
  (`RotationFlowDiagram`/`RotationIntradayChart` → `useContainerWidth`) → assert both render with
  **zero page exceptions**. No money side-effects.
- U+FFFD scan over `app.js` + `pb-views.js`; `git checkout -- test-screenshots/` if touched.

## Landing

Branch `claude/refactor-plan-continuation-w32yim` (off latest `origin/main` @ inc-32/PR #41). Commit
`refactor(view): relocate useContainerWidth into pb-views.js (inc 33)`; push
`git push -u origin claude/refactor-plan-continuation-w32yim`. **No PR, never `main`** — Jan reviews
and lands.
