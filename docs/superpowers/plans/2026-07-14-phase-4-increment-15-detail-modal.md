# Phase 4 increment 15 — extract `DetailModal` into `pb-modals.js` — Implementation Plan

**Goal:** Move `DetailModal` (app.js:9077–9377, 301 lines) verbatim into `pb-modals.js`, grow the
`window.PBApp` bridge by 12 (17 -> 29), add 7 module-global IIFE reads (PBCore×4, PBContent×1,
PBData×2), register it, and bump the sw cache. The richest read-only modal; display + delegate
only, so outside rule #3.

**Branch:** `claude/refactor-plan-continuation-fm72ce` (off `origin/main` `243eb0b`).

## Global constraints

- **Verbatim move via a Node slice script — never the Edit tool.** Both files are **BOM + LF**
  (measured: 0 CRLF). Read/write `'utf8'`, split/join `'\n'`, preserve the leading `﻿`.
  Modal body carries a literal `—` and `\xB7` escapes. Splice via a **replacement function**.
- **Bridge grows by 12** (`fmtCcy, fmtCcySigned, fmtIndicator, resolveTickerName, indicatorFor,
  IndicatorValueBlock, IndicatorAbout, WatchlistControl, HoldingNotesControl, EarningsBadge,
  PriceChart, FundamentalsBlock`); all stay in app.js, all defined before the publish -> TDZ-safe.
- **Module globals read directly, app.js internals via the bridge.** 7 new IIFE reads:
  `priceKey, marketCurrency, convertCcy, valuePositionInCostCcy` (PBCore), `INDICATOR_INFO`
  (PBContent), `fetchQuote, isUnitTrustId` (PBData). `ReactDOM.createPortal`/`document`/`PBStore`
  stay as free globals.
- **7 single-caller sub-components are bridged, not moved** (745 lines / deep trees would blow the
  cadence) — recorded as inc-16 debt, not risk. See spec.

## Task 1 — extract the modal + grow the bridge + add IIFE reads + register + bump sw

**Files:** `app.js` (remove modal -> 3-line pointer+bind; grow bridge line 11685), `pb-modals.js`
(7 IIFE reads after the inc-14 `CURRENCY_SYMBOLS` line; splice modal + lead read before the
`window.PBModals = …` block; registration after the `ContributionImportModal` one), `sw.js` (cache
bump). Throwaway: `scratchpad/inc15-extract.mjs`.

Slice-script outline:
- app.js: find index of `function DetailModal(_ref10) {`; end = index of `function AlertsModal(_ref11) {`;
  assert the last moved line is `}`. No leading doc comment.
- Inject the 20-member lead read as the first body statement (after the signature line).
- Replace the span in app.js with the pointer comment + `const DetailModal = PBModals.DetailModal;`.
- Grow bridge: exact-line replacement-function adding the 12 members.
- pb-modals.js: insert the 7 IIFE reads; insert the modal (with lead read) before
  `  window.PBModals = window.PBModals || {};`; add `window.PBModals.DetailModal = DetailModal;`.
- sw.js: `CACHE_NAME` `v62 -> v63`.

Then: `node --check app.js && node --check pb-modals.js`.

## Task 2 — docs sync

`architecture-map.html`: bridge note **17 -> 29**; note pb-modals.js's new PBData dependency +
first `ReactDOM.createPortal`.

## Task 3 — verify

1. Full node suite green; `deploy-assets` green; `node -e` typeof probes.
2. Anti-drift greps (spec Verification gate 3).
3. **Mount gate:** `verify-refresh-behavior.mjs` -> ALL PASSED (patched scratchpad copy: pin ROOT,
   local React, `--no-sandbox` — the inc-11 container recipe).
4. **Render check:** `verify-modals.mjs` opens the detail card; throwaway probe asserts the P&L
   Profit/Loss line (money-display path) + the portal `.alert-popup-panel` (first bucket portal);
   U+FFFD scan. Rerun on the flaky CDP race.

## Task 4 — measured read-out + docs

Append the read-out to the spec (line deltas, bridge = 29, bucket = 5 modals, sw v63, PBData
first-dep). Commit + push to the feature branch. **No PR; never `main`.**

## Self-review

- Scope (DetailModal alone) -> Task 1; sub-component subtree deferred to inc-16.
- Complete dependency inventory (every free identifier classified) -> Task 3 greps + typeof probes.
- Bridge +12 (5 shared helpers + 7 single-caller components) -> exact-line replace + anti-drift grep;
  debt documented.
- Slice footgun -> replacement-function form; BOM+LF preserved; `node --check` confirms.
- Wiring (cheap: sw bump only; bucket already wired) -> `deploy-assets` green confirms.
- Rule #3 (money-**display** only, no math moves) -> render-probe pins the P&L path.
- Encoding (literal `—`/`\xB7` verbatim) -> render-check U+FFFD scan.
- Out-of-scope (money/alert modals, portal-as-refactor, Vite) -> honored.
