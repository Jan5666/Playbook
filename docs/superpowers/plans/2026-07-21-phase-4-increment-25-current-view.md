# Phase 4 increment 25 — extract `CurrentView` — Implementation Plan

**Goal:** Move the 207-line `CurrentView` (the Holdings tab, `app.js` 4582–4788) into `pb-views.js`.
Bridge **41 -> 43** (**+`HoldingRow` +`HoldingsListHead`** — multi-callers shared with `TFSAView`, so they
stay in app.js and are bridged); **+2 IIFE reads** (`MARKETS` from PBContent, `valuePositionInCostCcy` from
PBCore). Third view-tier move. Display + per-market aggregation — the value/cost/gain sums format pb-core
helpers that do not move; buy/sell/edit/import are props to the data layer.

**Branch:** `claude/refactor-plan-continuation-yywg24` (off latest `origin/main` @ inc-24/PR #34).

## Constraints

- **Node slice, never Edit tool.** BOM + LF; body carries literal `£ · — −`. Replacement-array splice;
  content anchors validated in memory; both files written atomically.
- **Bridge +2 / IIFE +2:** `Icon`/`fmtCcy`/`fmtCcySigned`/`MARKET_LABELS`/`positionDisplayName` already
  bridged (inc-24); `priceKey`/`convertCcy`/`positionCostCcy`/`marketCurrency` (inc-23) + `quoteTradedToday`
  (inc-24) + `useState` already IIFE-read. Add `MARKETS` + `valuePositionInCostCcy` at the bucket top.
- **Multi-caller rule:** `HoldingRow`/`HoldingsListHead` are used by both `CurrentView` and the staying
  `TFSAView` -> they stay in app.js and are bridged (inc-22 `MarketPicker` precedent), keeping their own
  bindings. No render-time `PBModals`/`DATA` read is needed (CurrentView uses neither).
- Rule #3: the display aggregation (`computeMarketSummary`/`renderSummary`, using `convertCcy`/
  `positionCostCcy`/`valuePositionInCostCcy`) is verbatim and pinned by a render probe; all the math stays
  in pb-core.
- `content.test.mjs` guard is **untouched** — `MARKETS` stays a bind in app.js (not the inline array), so
  the anti-inline invariant holds; the bucket's parallel bind is not the forbidden literal.

## Task 1 — move block + lead read + bridge + register + bump sw

Files: `app.js` (CurrentView span -> pointer + `const CurrentView = PBViews.CurrentView`; **+`HoldingRow,
HoldingsListHead`** on the bridge line), `pb-views.js` (2 IIFE binds; CurrentView with lead read;
CurrentView registration after `DashboardView`), `sw.js` (v74 -> v75). Throwaway
`scratchpad/inc25-surgery.mjs`. `node --check` both.

## Task 2 — docs

`architecture-map.html`: bridge **41 -> 43** + member list + inc-25 note. `REFACTOR_STATUS.md`
Done/Current-state (bridge **43**, `sw` **v75**, `pb-views.js` **9 views**). Spec + this plan under
`docs/superpowers/`. No source-guard update (no bind moved out of app.js).

## Task 3 — verify

Node suite (money gate + content guard + deploy-assets + portfolio-fill, all unchanged) green; anti-drift
greps (`function CurrentView` 0/1; `HoldingRow`/`HoldingsListHead` still 1 in app.js; pointer + bind;
registration; **bridge 43**); **verbatim proof** (CurrentView body an exact match of `HEAD:app.js` aside
from the lead read, absent from app.js); mount gate `verify-refresh-behavior` ALL PASSED (its current-tab
assertion exercises the moved view); **render probe** (standalone-mount CurrentView, US same-ccy +
crypto-in-ZAR cost-ccy, marketFilter US & CRYPTO — summary/rows/tabs correct); U+FFFD + BOM/LF integrity.

## Task 4 — read-out + progress doc + commit

Append the measured read-out to the spec. Refresh `REFACTOR_STATUS.md`. Commit to the feature branch.
**No PR; never `main`.**

## Self-review

- Display aggregation (per-market value/cost/gain/today) -> pinned by a render probe (US + crypto-in-ZAR)
  and a source-identity verbatim proof; every math helper (`convertCcy`/`positionCostCcy`/
  `valuePositionInCostCcy`) stays in pb-core.
- Inventory complete via exhaustive residue analysis (+2 bridge / +2 IIFE) -> anti-drift greps + verbatim
  diff. Lean because inc-24 pre-bridged the shared formatters.
- Load order: `HoldingRow`/`HoldingsListHead` + the bridge publish are TDZ-safe (render-time reads); the
  view's helpers are all body-local (no subtree extraction).
- Encoding (`£ · —`, `−`) -> U+FFFD scan + BOM/LF preserved + verbatim diff.
- Shared rows: `HoldingRow`/`HoldingsListHead` bridged (not moved) while `TFSAView` still calls them —
  they relocate into the bucket only once `TFSAView` moves (a future bridge shrink).
