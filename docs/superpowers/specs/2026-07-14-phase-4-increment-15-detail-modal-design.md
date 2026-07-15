# Phase 4 increment 15 — fifth modal: `DetailModal` -> existing `pb-modals.js`

**Date:** 2026-07-14
**Branch:** `claude/refactor-plan-continuation-fm72ce` (off latest `origin/main` `243eb0b`, post-inc-14)
**Status:** design — chosen as the cheapest, lowest-risk remaining modal (see selection note)

## Goal

Move the stock/indicator **detail card** (`DetailModal`, `app.js:9077–9377`, 301 lines) out of
`app.js` into the `pb-modals.js` bucket. It is the app's richest read-only surface: live/opened
quote, position P&L, 52W-high strip, price chart, fundamentals, watchlist controls, notes, news,
and a price-alert popup (rendered through a `ReactDOM.createPortal`). It is **display + delegate
only** — every mutation is a parent callback (`onAddAlert`, `onAddWatch`, `onRemoveAlert`, …) and
**no money math or alert evaluation lives in its body**, so it sits outside CLAUDE.md rule #3
(the money/alert helpers it *calls* stay put and are reached through the bridge / module globals).

### Selection note (why DetailModal, not Position/Settings/Import)

The near-free tier is exhausted; every remaining modal has real cost. Of the **non-gated** ones
(Sell/Buy/Alerts are rule-#3-gated on a characterization test), `DetailModal` is the smallest
(~301 lines) and the only pure-display one — it does no cost-basis math (unlike `PositionModal`)
and touches no import matching (unlike `ImportModal`) — so it is the lowest-risk next step and
keeps the money/alert-shape work deferred behind its characterization gate. It also uses the
**dominant modal shape** whose lifecycle hooks (`useSwipeDownToClose`/`useBodyScrollLock`) are
already bridged.

## Dependency inventory (verified on `app.js` @ `243eb0b`)

Every free identifier in the modal body was enumerated and classified. **Convention:** true
module globals are read directly in the bucket IIFE (`const X = PBxxx.X`); app.js internals are
reached via the render-time `window.PBApp` bridge.

### Read directly (bucket IIFE) — 7 **new** module-global reads

| Symbol | Source | Status |
|---|---|---|
| `parseDecimal` | `PBCore.parseDecimal` | already in IIFE (inc-13) |
| `CURRENCY_SYMBOLS` | `PBContent.CURRENCY_SYMBOLS` | already in IIFE (inc-14) |
| `priceKey` | `PBCore.priceKey` | **new** IIFE read |
| `marketCurrency` | `PBCore.marketCurrency` | **new** IIFE read |
| `convertCcy` | `PBCore.convertCcy` | **new** IIFE read |
| `valuePositionInCostCcy` | `PBCore.valuePositionInCostCcy` | **new** IIFE read (money helper — **stays in PBCore**) |
| `INDICATOR_INFO` | `PBContent.INDICATOR_INFO` | **new** IIFE read |
| `fetchQuote` | `PBData.fetchQuote` | **new** IIFE read — pb-modals.js's **first `PBData` dep** |
| `isUnitTrustId` | `PBData.isUnitTrustId` | **new** IIFE read (PBData) |

`PBData` is a browser-only global loaded before `pb-modals.js` (index.html order:
pb-core→pb-data→pb-store→pb-content→pb-import→pb-views→pb-modals). Reading it in a **browser-only
UI bucket** is allowed — CLAUDE.md rule #6 only forbids `worker.js`/`sw.js` from importing
`pb-data.js`. This is the first PBData read for pb-modals.js (pb-views.js already reads PBStore as
a free global, establishing the browser-global pattern for buckets).

### Reached via the bridge (`window.PBApp`) — 12 **new** members (bridge 17 -> 29)

| Symbol | Kind | app.js callers | Disposition |
|---|---|---|---|
| `Icon`, `PriceBlock`, `fmt`, `timeAgo`, `prettyName`, `useSwipeDownToClose`, `useBodyScrollLock`, `sanitizeDecimalInput` | leaf/hook/helper | many | already bridged |
| `fmtCcy` | money-format fn | **16** | **new** bridge — genuinely shared, stays |
| `fmtCcySigned` | money-format fn | **12** | **new** bridge — genuinely shared, stays |
| `fmtIndicator` | format fn | **7** | **new** bridge — genuinely shared, stays |
| `resolveTickerName` | helper fn | **7** | **new** bridge — genuinely shared, stays |
| `indicatorFor` | helper fn | **3** | **new** bridge — genuinely shared, stays |
| `IndicatorValueBlock` | component | **1 (DetailModal only)** | **new** bridge — see subtree note |
| `IndicatorAbout` | component | **1 (DetailModal only)** | **new** bridge — see subtree note |
| `WatchlistControl` | component | **1 (DetailModal only)** | **new** bridge — see subtree note |
| `HoldingNotesControl` | component | **1 (DetailModal only)** | **new** bridge — see subtree note |
| `EarningsBadge` | component | **1 (DetailModal only)** | **new** bridge — see subtree note |
| `PriceChart` | component (398 lines) | **1 (DetailModal only)** | **new** bridge — see subtree note |
| `FundamentalsBlock` | component | **1 (DetailModal only)** | **new** bridge — see subtree note |

### Free globals kept verbatim (no IIFE change)

`React` / `React.Fragment` / `React.createElement`, `ReactDOM.createPortal` (**first portal in
the bucket**), `document.body`, `PBStore.usePricesMap()` (**first PBStore use in pb-modals.js**;
proven in pb-views.js), plus natives (`parseFloat`, `isFinite`, `Number.toFixed`, `Array`).

## Deviation from strict doctrine: single-caller sub-components are **bridged, not moved**

The inc-10 doctrine says a **single-caller** helper moves *with* its consumer (as `ruleSection`
did with `RulesView`). Seven of the bridged members above (`PriceChart`, `FundamentalsBlock`,
`WatchlistControl`, `EarningsBadge`, `IndicatorValueBlock`, `IndicatorAbout`,
`HoldingNotesControl`) are single-caller — only `DetailModal` uses them (confirmed: 2 refs each =
def + one call; not referenced by pb-views.js/pb-modals.js). Strictly, they should move too.

**They are bridged instead, deliberately**, because they total **745 lines** with their own deep
dependency trees (`PriceChart` alone is 398 lines of chart/SVG code). Moving them would turn a
~300-line one-modal increment into a ~1050-line, multi-component one and blow the cadence the
refactor is built on. `ruleSection` was a 3-line view-local helper; this is a substantial
subtree. Bridging now creates the **explicit render-time seam** that makes relocating the whole
detail-card subtree a mechanical **follow-on increment** (inc-16 candidate: "move the DetailModal
sub-component subtree into pb-modals.js, converting 7 bridge members to in-bucket refs"). This is
recorded debt, not risk — the bridge is a plain end-of-file object literal, and all 12 members
are `function` decls / `const` binds defined long before the publish -> TDZ-safe.

This is the **largest bridge jump** in Phase 4 (+12). By design: `DetailModal` composes seven
sub-components. It is not waste — every member is a real dependency of the moved modal.

## Mechanism

`pb-modals.js` gains `DetailModal`, moved **verbatim** via a Node line-range slice — **never the
Edit tool** (both files are **BOM + LF**; the modal body carries a literal em-dash `—` at the
news-fallback line and `\xB7` escapes). The splice uses a **replacement function** (inc-13/14
`$'`-expansion footgun). Slice anchors: start = the line `function DetailModal(_ref10) {`, end =
the line before `function AlertsModal(_ref11) {` (assert last moved line is `}`). There is **no
doc comment** above `DetailModal` (line 9076 is the prior function's brace), so none moves.

Bucket seam edits:
- IIFE gains the 7 new reads (4×`PBCore`, 1×`PBContent`, 2×`PBData`) after the inc-14
  `CURRENCY_SYMBOLS` line.
- Lead read injected as the modal's first body statement (after the `function DetailModal(_ref10) {`
  line, before `let { …props } = _ref10;`):
  `const { Icon, useSwipeDownToClose, useBodyScrollLock, prettyName, resolveTickerName, fmt,
  fmtCcy, fmtCcySigned, fmtIndicator, indicatorFor, timeAgo, PriceBlock, PriceChart,
  FundamentalsBlock, EarningsBadge, WatchlistControl, HoldingNotesControl, IndicatorValueBlock,
  IndicatorAbout, sanitizeDecimalInput } = window.PBApp;`
- Registration `window.PBModals.DetailModal = DetailModal;` after the inc-14 one.

`app.js`: the modal def becomes a 3-line pointer comment + `const DetailModal =
PBModals.DetailModal;`; the bridge publish (app.js:11685) grows **17 -> 29**. The invocation at
`app.js:3532` (`React.createElement(DetailModal, {…})`) is unchanged.

## Wiring

- `sw.js` `CACHE_NAME` **v62 -> v63**. Only shipped-file wiring.
- **Zero** edits to `index.html` / `static.yml` / `SHELL_ASSETS` / the 16 harnesses — `pb-modals.js`
  already wired (inc-11 paid the new-file tax); `deploy-assets.test.mjs` stays green.
- `architecture-map.html` — docs sync: bridge note **17 -> 29**; note pb-modals.js's new PBData
  dependency + first portal.

## Verification gate

1. `node --check` clean on `app.js` and `pb-modals.js`; `node -e` typeof probes for the 7 module
   reads + the DetailModal bind.
2. Full node suite green (**22** suites; **money gate** unaffected — no money/alert/import code
   moves, only a display component relocates); `deploy-assets` green.
3. Anti-drift greps: `function DetailModal` = 0 in app.js / 1 in pb-modals.js; the
   `const DetailModal = PBModals.DetailModal;` bind present; registration present; bridge carries
   all 12 new members; IIFE has the 7 new reads; the 5 multi-caller helpers + 7 sub-components
   still defined once in app.js (they **stayed**).
4. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED.**
5. **Render check — `verify-modals.mjs`** opens the detail card on a seeded holding (panel/body/
   scroll asserts already present). A **throwaway probe** additionally (a) asserts the "Your
   position" P&L block renders a formatted currency Profit/Loss line — pinning the money-**display**
   path (`valuePositionInCostCcy` + `fmtCcy`/`fmtCcySigned`) across the move, the rule-#3 safety
   net — and (b) clicks the alert bell and asserts the `.alert-popup-panel` mounts to
   `document.body` — pinning the `ReactDOM.createPortal` path (first portal in the bucket). Also
   a U+FFFD scan on the moved bytes (literal `—`/`\xB7`).

## Out of scope / deferred

Relocating the detail-card sub-component subtree (inc-16 candidate); the money/alert-shape modals
(Sell/Buy/Alerts — rule #3, need a characterization test first); ImportModal/PositionModal/
SettingsModal; React Context; Vite (settled — no-build classic-script buckets continue).

## Commit note

Development on `claude/refactor-plan-continuation-fm72ce`; commit + push to that feature branch.
**No PR; `main` never pushed** — Jan reviews and lands. Scratchpad slice/probe scripts are
gitignored.

## Measured read-out (2026-07-14, on execution)

All gates green — 22 node suites (money gate money-math/cost-basis/import-matching/ee-ocr-parse +
`deploy-assets` wiring guard all GREEN), mount gate `verify-refresh-behavior` **ALL PASSED** (the
app **mounts** with the extracted modal — proves the bind + 29-member bridge + 7 IIFE reads all
resolve), render check `verify-modals` **CLEAN** (exit 0, no page exception) after one flaky-race
rerun. The committed `verify-modals` stock-detail step is inconclusive on its own seed
(`(no stock detail)` — its holding-row click doesn't open the card), so a **throwaway probe**
opened DetailModal on a seeded AAPL position and asserted the money-display + portal paths
end-to-end — **PROBE ALL PASSED** first try:
- **Profit / Loss** renders `+$600.00 (+33.3%)` (12×$150 cost -> $200 -> +$600 = +33.3%, exact) —
  pins `valuePositionInCostCcy` (PBCore IIFE read) + `fmtCcySigned` (bridge) across the move.
- **Avg price** `$150.00` — `fmtCcy` (bridge).
- The **alert popup** mounts and **escapes the `.stock-detail-panel` subtree into `document.body`**
  — `ReactDOM.createPortal` works from the bucket (first portal moved).
- **0** U+FFFD in the rendered detail (literal `—`/`\xB7` intact at runtime).

**Bucketing economics, measured:**
- `app.js` **11687 -> 11390 (-297)** (301-line modal -> 4-line pointer+bind; bridge line grew in
  place), `pb-modals.js` **447 -> 760 (+313)** (301 modal + 3-line doc + 1 lead read + 7 IIFE
  reads + 1 registration), `sw.js` **v62 -> v63** (one line). **Zero** index/static/harness edits —
  bucket already wired (`deploy-assets` stayed green). Bucket now holds **5** modals.
- **Bridge:** `window.PBApp` grew **17 -> 29** (+12). Five are genuinely-shared helpers
  (`fmtCcy`×16, `fmtCcySigned`×12, `fmtIndicator`×7, `resolveTickerName`×7, `indicatorFor`×3
  callers — correctly stayed in app.js). Seven are **single-caller** detail-card sub-components
  (`PriceChart`/`FundamentalsBlock`/`WatchlistControl`/`EarningsBadge`/`IndicatorValueBlock`/
  `IndicatorAbout`/`HoldingNotesControl`) **bridged rather than moved** — 745 lines of subtree
  would have blown the one-modal cadence. **inc-16 candidate:** relocate that subtree into the
  bucket, converting the 7 bridge members to in-bucket refs.
- **New bucket deps:** first `PBData` reads (`fetchQuote`, `isUnitTrustId`), first `PBStore` use
  (`usePricesMap`), first `ReactDOM.createPortal` in pb-modals.js — all module/UMD globals loaded
  before it; browser-only, so allowed (rule #6 only gates worker.js/sw.js).
- **Rule #3:** no money/alert code was refactored — the modal that *displays* P&L moved; the math
  (`valuePositionInCostCcy` in PBCore, `fmtCcy`/`fmtCcySigned` in app.js) stayed put. The probe
  pins the display path.

**Environment note:** as in inc-11, the browser harnesses were run from **scratchpad copies**
patched to pin `ROOT`, serve a locally-`npm i`'d React (unpkg is 403-blocked; `registry.npmjs.org`
is in the proxy `noProxy`), and add `--no-sandbox` (`CHROME_PATH=/opt/pw-browsers/chromium`). The
committed harnesses were **not** modified. `test-screenshots/*.png` the harness rewrote were
reverted — not part of the increment.

**Conclusion:** the richest read-only modal is extracted; the bucket holds 5 modals and the bridge
is at 29. The remaining tier is the rule-#3-gated money/alert modals (Sell/Buy/Alerts, need a
characterization test first) plus Import/Position/Settings and the earmarked detail-card subtree
move.
