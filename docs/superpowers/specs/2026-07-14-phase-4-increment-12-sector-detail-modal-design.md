# Phase 4 increment 12 — second modal: `SectorDetailModal` → existing `pb-modals.js`

**Date:** 2026-07-14
**Branch:** `claude/refactor-plan-next-7cr7q5` (stacks on inc-11, unmerged)
**Status:** design approved by Jan (2026-07-14: `SectorDetailModal` — completes the sector pair)

## Goal

Cash in inc-11's investment: with `pb-modals.js` already seeded and fully wired, extract a
second modal as a **cheap bucket add** — `app.js` + a `pb-modals.js` splice + a one-line
`sw.js` cache bump, exactly as inc 9/10 were cheap adds to `pb-views.js`.

`SectorDetailModal` is the **sibling** of inc-11's `SectorAllocationModal` (both open from the
sector-breakdown / heatmap flow), so this completes the sector modal pair. It is **genuinely
display-only** (stat strip, relative-size bar, multi-window sector trend, a contained
zoom/pan heatmap): zero money/alert code → cleanly outside CLAUDE.md rule #3.

## Dependency inventory (verified on `app.js` @ post-inc-11)

| Dependency | Source | Disposition |
|---|---|---|
| `useState`, `useCallback`, `useEffect`, `useMemo` | React UMD | widen the bucket IIFE destructure (`useState`/`useRef` already present) |
| `useBodyScrollLock` | app.js:230 | **bridge** — already present (inc-11) |
| `Icon` | app.js leaf | **bridge** — already present (inc-8) |
| `fetchSectorTrend` | app.js:7270 | **bridge** (new) — stays: uses `fetchViaProxies` + module caches (`SECTOR_TREND_CACHE`/`SECTOR_ETF`/`SECTOR_TREND_WINDOWS`) |
| `ZoomPanHeatmap` | app.js:7385 | **bridge** (new) — stays: also used by `HeatmapView` (7522/7654) |

No `PB_DATA`/`PBStore`/`PBContent`, no money/alert code. The modal owns its lifecycle
internally (close animation via `closing` state + `setTimeout`, an Escape-key `useEffect`) —
that needs nothing bridged; only `fetchSectorTrend` + `ZoomPanHeatmap` are new bridge members.

## Mechanism

`pb-modals.js` gains `SectorDetailModal` (moved **verbatim** via a Node line-range slice —
never the Edit tool: BOM + literal non-ASCII bytes `▲ ▼ — · …`). The IIFE hook destructure
widens to `{ useState, useRef, useCallback, useEffect, useMemo }`, and one render-time lead
read is injected as the first body statement:

```js
function SectorDetailModal({ sectorName, rows, exchangeLabel, onClose, onOpenDetail }) {
  const { Icon, useBodyScrollLock, fetchSectorTrend, ZoomPanHeatmap } = window.PBApp;
  /* … body verbatim … */
}
```

`app.js`: the modal def (`7531–7666`) becomes a pointer comment + `const SectorDetailModal =
PBModals.SectorDetailModal;`; the bridge (`app.js:12066`, now ~11933) grows **11 → 13**
(`+fetchSectorTrend, +ZoomPanHeatmap`; both TDZ-safe, defined before the publish). The
invocation at `app.js:7918` (`sectorDetail ? …`) is unchanged.

## Wiring (minimal — the inc-11 payoff)

- `sw.js` `CACHE_NAME` **v59 → v60**. That is the only shipped-file wiring.
- **Zero** edits to `index.html` / `static.yml` / `SHELL_ASSETS` / the 16 harnesses —
  `pb-modals.js` is already wired; `deploy-assets.test.mjs` stays green (asset set unchanged).
- `architecture-map.html` — docs sync: bridge note 11 → 13.

## Verification gate

1. `node --check` clean on `app.js` and `pb-modals.js`.
2. Full node suite green (money gate unaffected — display-only move); `deploy-assets` green.
3. Anti-drift greps: `function SectorDetailModal` = 0 in app.js / 1 in pb-modals.js; the bind
   present; bridge carries `fetchSectorTrend`+`ZoomPanHeatmap`; both still defined once in
   app.js (stayed); registration + widened IIFE hooks present.
4. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED.**
5. **Render check — throwaway direct-mount harness** (`scratchpad/verify-sectordetail.mjs`).
   **No committed harness drives `SectorDetailModal`** (it renders only when a heatmap sector
   is tapped) → a broken bind is invisible to the mount gate (inc-10's eager-render trap).
   Mirroring `verify-indicators.mjs`' inert-page + direct-`root.render` pattern, mount the
   modal with mock sector rows and assert: panel renders, title = tapped sector, 4-stat strip,
   breadth up/down, the contained heatmap block (proves `ZoomPanHeatmap` via bridge), **no
   U+FFFD** (glyphs byte-exact), and no page exception.

## Out of scope / deferred

The remaining modals; money/alert code; portals; Vite. The next real cost step remains the
Sell/Buy money modals, which rule #3 gates on a characterization test.

## Commit note

Development on `claude/refactor-plan-next-7cr7q5` (inc-12 stacks on inc-11). Commit + push to
the feature branch; no PR; `main` never pushed — Jan reviews and lands. Scratchpad
slice/harness scripts are gitignored, not committed.

## Measured read-out (2026-07-14, on execution)

All gates green — 22 node suites (money gate + `deploy-assets` included), mount gate
`verify-refresh-behavior` **ALL PASSED**, and the direct-mount render harness **ALL PASSED**
(first try): panel + title "Technology" + 4-stat strip + breadth + contained heatmap render,
zero U+FFFD, `—`/`·` present.

**Bucketing economics, measured:**
- **The cheap add held:** `app.js` **−133 lines** (136-line modal → 3-line pointer+bind),
  `pb-modals.js` **43 → 183**, `sw.js` **v59 → v60** (one line). **Zero** index/static/harness
  edits — the bucket file was already wired (`deploy-assets` stayed green). The bucket now
  holds **2** modals.
- **Bridge:** `window.PBApp` grew **11 → 13** (`+fetchSectorTrend, +ZoomPanHeatmap`, both
  genuinely shared → stayed in app.js behind the bridge). The lifecycle infra bridged in inc-11
  (`useBodyScrollLock`) was reused for free; the IIFE gained 3 hooks
  (`useCallback`/`useEffect`/`useMemo`).
- **Verification friction:** higher than inc-11 — unlike `SectorAllocationModal`,
  `SectorDetailModal` had **no committed harness**, so a throwaway direct-mount render check was
  written (verify-indicators pattern). It is the durable-coverage gap this extraction did not
  create but did surface; a committed harness for the heatmap sector popup would be a
  reasonable future add (out of this increment's scope).

**Conclusion:** the sector modal pair is complete for the price of a splice + a cache bump.
Two of the cheap non-money modals are bucketed; the tier stays cheap up to the Sell/Buy money
step that rule #3 gates.
