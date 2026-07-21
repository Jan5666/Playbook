# Phase 4 increment 24 — extract `DashboardView` — Implementation Plan

**Goal:** Move the 299-line `DashboardView` + its 406-line single-caller growth-chart cluster
(`CHART_MONTHS`/`chartDayLabel`/`buildTimeAxisTicks`/`PortfolioLineChart`) into `pb-views.js`. Bridge
**39 -> 41** (**+`PortfolioPieChart`** — multi-caller shared with `TFSAView` — **+`fmtNum`**, the shared
number formatter); **+5 IIFE reads** (`CURRENCY_SYMBOLS` from PBContent, `MARKET_CURRENCY`/
`contribInDisplay`/`quoteTradedToday` from PBCore, `fetchHistory` from PBData). Second view-tier move.
Display + delegate — the overall-profit aggregation formats pb-core helpers that do not move; the
contribution flow is handed to the already-extracted `ContributionModal`/`ContributionImportModal`.

**Branch:** `claude/refactor-plan-q74cry` (off latest `origin/main` @ inc-22/PR #33; follows inc-23).

## Constraints

- **Node slice, never Edit tool.** BOM + LF; body carries literal `£ · —` and the `−` escape.
  Replacement-array splice; seven content anchors validated in memory; both files written atomically.
- **Bridge +2 / IIFE +5:** `Icon`/`fmt`/`fmtCcy`/`fmtCcySigned`/`computeFxSnapshot` already bridged;
  `convertCcy`/`positionCostCcy`/`marketCurrency`/`priceKey` already IIFE-read (inc-23). Add the five new
  IIFE reads at the bucket top.
- **Render-time reads:** `ContributionModal` + `ContributionImportModal` from `PBModals` (loads after
  the bucket), injected into `DashboardView`. **No `DATA`** (the view doesn't use it). The cluster needs
  **no** lead read (self-sufficient).
- Rule #3: the display aggregation (`computeFxSnapshot`/`contribInDisplay`/`convertCcy`/`forwardFill`) is
  verbatim and pinned by a before/after render probe; all the math stays in pb-core.

## Task 1 — move blocks + lead read + bridge + register + bump sw

Files: `app.js` (cluster span -> comment; DashboardView span -> pointer + `const DashboardView =
PBViews.DashboardView`; **+`PortfolioPieChart, fmtNum`** on the bridge line), `pb-views.js` (5 IIFE binds;
cluster + DashboardView with lead reads; DashboardView registration), `sw.js` (v73 -> v74). Throwaway
`scratchpad/inc24-move.mjs`. `node --check` both.

## Task 2 — source-guard follow + docs

`backend/test/portfolio-fill.test.mjs`: the `PBCore.forwardFillPortfolio(` delegation guard + the
anti-inline invariant now span `app.js + pb-views.js` (the chart moved buckets — inc-16 precedent).
`architecture-map.html`: bridge **39 -> 41** + member list + inc-24 note. `REFACTOR_STATUS.md`
Done/Current-state (bridge **41**, `sw` **v74**). Spec + this plan under `docs/superpowers/`.

## Task 3 — verify

Node suite (money gate + content guard + deploy-assets + **updated portfolio-fill guard**) green;
anti-drift greps (function/const count 0/1; `PortfolioPieChart`/`fmtNum`/`resolvePositionSector` still 1
in app.js; pointer + bind; registration; **bridge 41**; no app.js `PortfolioLineChart` bind); **verbatim
proof** (both bodies exact substrings of `HEAD:app.js` aside from lead reads, absent from app.js); mount
gate `verify-refresh-behavior` ALL PASSED; **render probe re-run AFTER the move** — **digest identical**;
U+FFFD + BOM/NUL/LF integrity.

## Task 4 — read-out + progress doc + commit

Append the measured read-out to the spec. Refresh `REFACTOR_STATUS.md`. Commit to the feature branch.
**No PR; never `main`.**

## Self-review

- Display aggregation (profit / growth / contribution valuation) -> pinned by a before/after render probe
  (Dashboard digest); every math helper (`computeFxSnapshot`/`contribInDisplay`/`convertCcy`/
  `forwardFillPortfolio`) stays in pb-core.
- Inventory complete via exhaustive residue analysis (+2 bridge / +5 IIFE; the estimate under-counted —
  the dashboard pulls growth-history + contribution helpers) -> anti-drift greps + verbatim diff.
- Load order: `PortfolioPieChart`/`fmtNum` + the bridge publish are TDZ-safe (render-time); the two
  contribution modals read in-body because pb-modals loads after the bucket; the cluster is self-sufficient.
- Encoding (`£ · —`, `−`) -> U+FFFD scan + BOM/LF preserved + verbatim diff.
- Source guard: the chart carried `PBCore.forwardFillPortfolio(` out of app.js -> the portfolio-fill guard
  follows it to `app.js + pb-views.js` (don't weaken the anti-inline invariant).
