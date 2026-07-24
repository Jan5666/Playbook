# Phase 4 · Increment 33 — `useContainerWidth` → `pb-views.js` (design)

## Why

Phase 4 peels large view/modal components out of the no-build `app.js` UMD monolith into the
browser-only classic-script buckets (`pb-views.js`, `pb-modals.js`), shrinking the render-time
`window.PBApp` bridge toward **only genuinely-shared members** — anything consumed by just one bucket
(and not by root `App`) belongs *in* that bucket, not on the bridge.

inc-32 relocated the Heatmap cluster and, in doing so, explicitly kept `useContainerWidth`
(`app.js:5136–5153`) on the bridge, reasoning it "stays bridged — **shared** (also consumed by two
other `pb-views.js` components)." **That reasoning is a mis-classification.** Being consumed by
multiple components *within one bucket* does not require bridging — it can be a bucket-private helper
those components call directly, exactly how the treemap-layout math, donut-palette helpers, and
growth-chart cluster already live bucket-private in `pb-views.js`. The note conflated "shared across
components in one bucket" with "shared across buckets."

A fresh caller inventory confirms `useContainerWidth` is **pb-views-only**:

- `pb-views.js` `RotationFlowDiagram`, `RotationIntradayChart`, and `HeatmapTreemap` are its only
  consumers.
- **Zero** root-`App` callers, **zero** `pb-modals.js` callers.
- It currently works because `app.js` runs at **global scope** (`"use strict"`, no IIFE wrapper), so
  the top-level `function useContainerWidth()` is a *global*: the bare calls in
  `RotationFlowDiagram`/`RotationIntradayChart` resolve via global lookup, while `HeatmapTreemap`
  redundantly re-reads it from `window.PBApp`.

So this is a clean bridge-shrink, directly correcting inc-32's own note — the same self-correcting
cadence by which inc-32 corrected inc-31's "structural extraction complete" call. It shrinks the
bridge by 1 (**41 → 40**).

## Scope

Move into `pb-views.js` (verbatim): `function useContainerWidth()` (`app.js:4987–5004`, ~18 lines) —
the `ResizeObserver` container-sizing hook, bucket-private after the move (hoisted function
declaration, no lead read needed). Pure display/layout — no money/alert code (rules #3/#4 unaffected).

Stays put in `app.js`: `fetchSectorTrend` + sector-trend infra (the adjacent bridged impure Yahoo
reader, still read by `pb-modals.js` `SectorDetailModal` from `PBApp`).

## Dependency inventory

Move block = `function useContainerWidth()` (4987–5004).

| identifier | classification |
|---|---|
| `useRef`, `useState`, `useEffect` | native React hooks — already IIFE-read at `pb-views.js` top (line 5) |
| `ResizeObserver`, `typeof` | native globals (free) |
| props / return | `[ref, width]` tuple — self-contained |

⇒ **Clean verbatim move. 0 new bridge members, 0 new IIFE reads, 0 injected lead reads** (it uses only
hooks already IIFE-read in `pb-views.js`; as a hoisted bucket-private function its three consumers
call it directly). One lead read *shrinks*: `HeatmapTreemap`'s
`const { Icon, useContainerWidth } = window.PBApp;` → `const { Icon } = window.PBApp;`.

## Bridge / registration

- `window.PBApp` publish line: **remove** `useContainerWidth` (bridge **41 → 40**).
- **Not** registered on `window.PBViews` — nothing outside `pb-views.js` consumes it (the inc-31
  `SectorWeightRows` precedent).
- `pb-views.js` `HeatmapTreemap` lead read drops `useContainerWidth` (now bucket-local). The bare
  calls in `RotationFlowDiagram`/`RotationIntradayChart` are unchanged — they resolved to the app.js
  global before and resolve to the bucket-local function now. `app.js` retains a pointer comment where
  the code was.

## Encoding note

`app.js` and `pb-views.js` are **BOM + LF** (verified 0 CRLF; the CLAUDE.md "BOM + CRLF" note is stale
for these). The moved block carries a literal `—` (em dash) in a comment. Move via a Node slice script
(read/write `utf8`, split/join `\n`, keep the BOM, content-anchored boundaries) — never the Edit tool;
the captured source block is reused byte-for-byte as the insertion so the move is provably verbatim.

## Read-out (measured)

- `node --check` app.js / pb-views.js / sw.js: **OK**.
- Encoding after move: both **BOM + LF**, U+FFFD scan **clean** (0 replacement chars in either file).
- Anti-drift: `function useContainerWidth` = **0** app.js / **1** pb-views.js; `useContainerWidth`
  **absent** from the `window.PBApp` publish line (bridge count **40**); **0** refs in `pb-modals.js`.
- Full node suite (money gate + content guard + deploy-assets): **28/28 pass**.
- Render gate: the committed `verify-refresh-behavior.mjs` mount gate does **not** mount in this remote
  Linux container (it fails identically — "app mounts: false" — on pristine `HEAD`, a container/harness
  setup artifact, not a regression). Validated instead with a standalone throwaway CDP render probe
  (repo files + local React, `--no-sandbox`, `CHROME_PATH=/opt/pw-browsers/chromium`, console +
  `exceptionThrown` capture): **app mounts** (`#root` 8158 chars); the **Heatmap tab** renders its
  treemap (`HeatmapTreemap` → `useContainerWidth`) and the **Rotation tab** renders 35 rotation nodes
  (`RotationFlowDiagram`/`RotationIntradayChart` → `useContainerWidth`) with **zero page exceptions** —
  proving the bucket-local hook resolves for all three consumers.
- app.js: 5232 → 5214 lines (~18 net out); bridge 41 → 40; `sw` `CACHE_NAME` v83 → v84;
  `architecture-map.html` bridge list + count brought current (40).
