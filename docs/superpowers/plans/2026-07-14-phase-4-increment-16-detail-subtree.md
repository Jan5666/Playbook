# Phase 4 increment 16 — relocate the detail-card subtree — Implementation Plan

**Goal:** Move the 752-line detail-card subtree (`app.js:8325–9076`: 7 components + 5 private
helpers + `SECTOR_FWD_PE`) into `pb-modals.js`, converting the 7 inc-15 bridge members to in-bucket
siblings. Bridge **29 -> 23** (−7 components, +`watchListIds`). +1 IIFE read (`MARKET_CURRENCY`).

**Branch:** `claude/refactor-plan-continuation-fm72ce` (stacks on inc-15).

## Global constraints

- **Verbatim move via a Node slice — never the Edit tool.** BOM + LF; block carries literal
  `– — · ' "`. Read/write `'utf8'`, split/join `'\n'`, preserve the BOM.
- **7 per-component lead reads** injected (render-time `const {...} = window.PBApp;`): PriceChart
  `{fmtIndicator}`, EarningsBadge `{Icon}`, FundamentalsBlock `{fmt}`, WatchlistControl
  `{Icon, watchListIds}`, HoldingNotesControl `{Icon}`, IndicatorValueBlock `{fmtIndicator}`,
  IndicatorAbout `{Icon}`. Helpers get none.
- **Bridge:** remove 7 components, add `watchListIds` (stays in app.js:6215 — 6+ other callers).
- **IIFE:** add `const MARKET_CURRENCY = PBCore.MARKET_CURRENCY;`. `SECTOR_FWD_PE` rides in-block.
- **DetailModal lead read:** drop the 7 component names (now siblings).

## Task 1 — move the block + inject lead reads + rewire bridge/IIFE/DetailModal + bump sw

**Files:** `app.js` (remove block -> pointer; bridge −7/+1; rewrite inc-15 pointer line 3),
`pb-modals.js` (insert block-with-lead-reads before DetailModal; +MARKET_CURRENCY IIFE read;
trim DetailModal lead read), `sw.js` (v63 -> v64). Throwaway: `scratchpad/inc16-extract.mjs`.

Slice-script outline:
- app.js: slice `function PriceChart(_refChart) {` .. line before `const DetailModal = PBModals.DetailModal;`
  pointer block (i.e. before the inc-15 comment). Assert last line is `}`.
- For each of the 7 component signatures in the extracted array (highest index first), splice in
  its lead read after the signature line.
- Insert the modified block into pb-modals.js before `function DetailModal(`.
- Add the MARKET_CURRENCY IIFE read after the inc-15 IIFE reads.
- Trim DetailModal's `window.PBApp` destructure to the 13 non-component members.
- app.js bridge: replacement-function edits — drop the 7, append `, watchListIds`.
- app.js: replace the block with a 2-line pointer; rewrite the inc-15 pointer's line-3 comment.
- sw.js: `v63 -> v64`.

Then `node --check app.js && node --check pb-modals.js`.

## Task 2 — docs sync

`architecture-map.html`: bridge note **29 -> 23**; member-list edit (remove 7, add watchListIds);
note the detail-card subtree now lives in pb-modals.js.

## Task 3 — verify

1. Full node suite green; `deploy-assets` green.
2. Anti-drift greps (spec gate 3): 7 components + 5 helpers + const = 0 in app.js / present in
   pb-modals.js; bridge has watchListIds & lacks the 7; MARKET_CURRENCY read present; DetailModal
   read trimmed; watchListIds still in app.js.
3. **Mount gate:** `verify-refresh-behavior.mjs` -> ALL PASSED (scratchpad copy: pin ROOT, local
   React, `--no-sandbox`).
4. **Render check:** re-run the inc-15 DetailModal probe — asserts PriceChart + FundamentalsBlock
   P&L + WatchlistControl (watchListIds via bridge) + alert portal + 0 U+FFFD.

## Task 4 — measured read-out + docs

Append read-out to the spec (bridge = 23, pb-modals line count, app.js delta, sw v64). Commit +
push. **No PR; never `main`.**

## Self-review

- Scope (subtree of 7 + 5 helpers + const, all 0-outside-callers) -> Task 1; verified contiguous.
- Complete inventory (only new seams: `watchListIds` bridge, `MARKET_CURRENCY` IIFE) -> Task 3.
- 7 lead reads (mapped per component) -> spliced highest-index-first to avoid shift.
- Bridge shrinks -7/+1 -> anti-drift grep both directions.
- Slice footgun -> replacement-function; BOM+LF preserved; `node --check`.
- Encoding (literal `– — · ' "`) -> render-check U+FFFD scan.
- Rule #3 (display only; money/alert helpers stay) -> probe pins P&L + chart + watchlist render.
