# Phase 4 increment 27 — the TFSA tab: `TFSAView` -> `pb-views.js`

**Date:** 2026-07-21
**Branch:** `claude/refactor-plan-continuation-j980on` (off latest `origin/main` @ inc-26/PR #36)
**Status:** executed — all gates green (see measured read-out)

## Goal

Move the Tax-Free Savings Account tab `TFSAView` (`app.js`, ~114 lines) into `pb-views.js`, together
with its **TFSA-private helper cluster**, as a **byte-identical verbatim move**. This is the **last tab
view** and the **last money-tier view** — it carries South Africa's TFSA contribution limits (R46 000
annual / R500 000 lifetime) and the contribution-room math — so CLAUDE.md **rule #3** applies: a
characterization test pinning current behavior came **first**, then the verbatim relocation. With this
increment **every tab view lives in the bucket**.

## The move block — one contiguous 521-line slice (`app.js` 5992–6512)

`TFSAView` (6399) plus the cluster it depends on, each referenced **only** inside the block (verified: no
caller in `pb-views.js` / `pb-modals.js`, and the only non-block app.js references are the `TFSAView` call
site at 3489 + a comment at 4495):

- `fmtShares` (5992) — generic share formatter, **single-caller** (used once, by `TFSABalancer` at 6376).
  Its only other textual match is an unrelated `const fmtShares =` modal-local in `pb-modals.js` (different
  file/binding). Travels with the block.
- `TFSA_ANNUAL_LIMIT` = 46000 (6003), `TFSA_LIFETIME_LIMIT` = 500000 (6004)
- SA tax-year helpers: `tfsaTaxYearStart` (6005), `currentTfsaTaxYearStart` (6012), `tfsaTaxYearLabel`
  (6016), `tfsaTodayStr` (6019)
- `fmtRand` (6023) — app.js-local ZAR formatter (not pb-core)
- `Collapsible` (6029) — generic collapse card, TFSA-private (grep-confirmed, no bucket collision)
- `TFSAContributions` (6054) — the contribution-room panel
- `TFSABalancer` (6246) — the contribution planner
- `TFSAView` (6399) — the tab view

## Why this is (partly) money-tier and how it was pinned

The block owns the contribution-room math, all inline in app.js (no pb-core helper), so it moves verbatim
under a rule-#3 pin rather than a pb-core delegation:
- `TFSAView` body: `totalValue` (live `prices['TFSA:'+ticker]` else `shares*costBasis`), `totalCost`,
  `pnl`, `pnlPct`, and `annualUsed` (deposits bucketed by SA tax year).
- `TFSAContributions`: `annualUsed`/`lifetimeUsed`, `annualPct = annualUsed/46000*100`,
  `lifePct = lifetimeUsed/500000*100`, `annualLeft = 46000-annualUsed`, `lifeLeft = 500000-lifetimeUsed`,
  `yearsLeft = lifeLeft>0 ? ceil(lifeLeft/46000) : 0`, plus the over-limit "40% penalty" line.
- Tax-year boundary: `tfsaTaxYearStart` maps Jan/Feb to the prior-March tax year.

Pinned by a **before/after render probe with an identical digest** (the inc-20/21/22 pattern), not a new
Node characterization test — the math is view-render output, so a render probe captures it directly. Deposit
CRUD (`onAddTfsaDeposit`/…/`onRemoveTfsaDeposits`) and buys stay props to the data layer.

## Dependency inventory (every free identifier classified — verified by reading every component)

Move block = the full 521-line slice. After subtracting locals / natives / props / already-bridged /
already-IIFE-read, the residue is **+0 bridge, +0 IIFE reads**.

### Reaches app.js internals -> bridge (`window.PBApp`) — **+0 (stays 46)**

Union of bridged internals the block reads, all **already published** on the bridge line:
- `Icon` (1458), `PortfolioPieChart` (4112), `HoldingRow` (4512), `HoldingsListHead` (4506) — used by
  `TFSAView`.
- `usePersistedState` (185), `fmt` (1329), `prettyName` (5335) — used by `TFSABalancer`.

`HoldingRow`/`HoldingsListHead` stay in app.js and stay bridged **this increment** even though TFSAView was
their last app.js caller — relocating them is a distinct multi-caller operation (they're shared with the
already-moved `CurrentView`) deferred to inc-28 (a bridge shrink 46 -> 44).

Injected **per-component lead reads** (one per moved component, first body statement):
- `Collapsible`: `const { Icon } = window.PBApp;`
- `TFSAContributions`: `const { Icon } = window.PBApp;`
- `TFSABalancer`: `const { usePersistedState, Icon, fmt, prettyName } = window.PBApp;`
- `TFSAView`: `const { Icon, PortfolioPieChart, HoldingRow, HoldingsListHead } = window.PBApp;`

### Reads module globals -> IIFE — **+0**

`useState` was already IIFE-destructured at `pb-views.js:5`. `PBStore` is a free global
(`PBStore.usePricesMap()` / `PBStore.useSetting('valueHidden')`), already used that way in the bucket. No
`PBCore`/`PBData`/`PBContent` bind is needed — none were added.

### `content.test.mjs` / delegation guards — untouched

No `PBContent`/`PBCore` bind moves out of app.js; the constants moved are TFSA-private literals, not content
data blocks. `content.test.mjs`, `import-matching.test.mjs`, `rotation-core.test.mjs`, `portfolio-fill.test.mjs`
pass unchanged.

## Mechanism

One atomic Node slice script (**never the Edit tool** — BOM + LF; the body carries literal `– ≈ · " '`).
Content-anchored (no line-number literals): open `function fmtShares(n) {`, close the `}` immediately before
`// HotTopicsView is defined in pb-views.js`. Validated in memory: 11 required identifiers present, TFSAView
signature present, brace balance ({ = } = 245). Into `pb-views.js` before the registration block (hoisting
makes order moot) with the 4 lead reads injected; `window.PBViews.TFSAView = TFSAView;` after the
`WatchlistView` registration. In `app.js`: block -> pointer comment + `const TFSAView = PBViews.TFSAView;`
(TDZ-safe — the sole call site at 3489 is inside `App`'s render map). Bridge publish line untouched.

## Wiring

- `sw.js` `CACHE_NAME` **v76 -> v77**. Only shipped-file change.
- **Zero** edits to index.html / static.yml / SHELL_ASSETS / the harnesses — `pb-views.js` already wired.
- `architecture-map.html` — appended an inc-27 clause to the maintained bridge narrative (bridge stays 46).
- `REFACTOR_STATUS.md` — Done + Current-state (bridge **46**, `sw` **v77**, `pb-views.js` **11 views**; every
  tab view now in the bucket; inc-28 flagged as the bridge shrink).
- No test-guard update (no bind moved out of app.js).

## Verification gate

1. `node --check` app.js + pb-views.js + sw.js.
2. Full node suite (**27**; money gate unaffected; content guard; deploy-assets; portfolio-fill).
3. Anti-drift greps: `function TFSAView`/`TFSAContributions`/`TFSABalancer`/`Collapsible`/`fmtRand`/
   `tfsaTaxYearStart` + `function fmtShares` + `const TFSA_ANNUAL_LIMIT` = 0 app.js / 1 pb-views.js; pointer +
   bind; registration after `WatchlistView`; **bridge = 46**; `HoldingRow`/`HoldingsListHead` defs still 1 in
   app.js.
4. **Verbatim proof:** the 521-line moved block minus the 4 injected lead reads is byte-identical to
   `HEAD:app.js`.
5. **Rule-#3 pin (before & after):** the render-probe digest is identical across the move.
6. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED** (full app boot with TFSAView served from the
   bucket).
7. U+FFFD = 0; BOM + LF preserved.

## Out of scope / deferred

- **inc-28:** relocate `HoldingRow`/`HoldingsListHead` into `pb-views.js` (their last app.js caller left with
  TFSAView), rewrite the `CurrentView`/`TFSAView` lead reads, drop them from the bridge (**46 -> 44**).
- **`FxSummary`** (`app.js`) remains vestigial dead code — flagged for a separate cleanup, untouched.

## Commit note

Development on `claude/refactor-plan-continuation-j980on`; commit + push to the feature branch. **No PR;
`main` never pushed.** Scratchpad scripts never committed.

## Measured read-out (2026-07-21, on execution)

All gates green — the prediction held exactly (+0 bridge / +0 IIFE).

- **Rule-#3 pin green before AND after** the move, with a **byte-identical digest**. Baseline
  (`TFSAView source: app.js-global`) and post-move (`TFSAView source: PBViews`) both **ALL PASSED**:
  `stats = [Value=R2,200.00, Cost=R2,000.00, P/L=+R200.00]`, `pnlPct = +10.0%`; annual bar
  `used R55,000 / R46,000`, fill class `tfsa-limit-fill over`, sub "R9,000 over the annual limit (40% penalty
  applies)"; lifetime bar `R75,000 / R500,000`, sub "R425,000 left · ≈ 10 years at the max to fill it";
  tax-year label 2026/27 with the Feb-2026 deposit correctly excluded from the current year; `calls = 0` (no
  mutator fired during render).
- **Verbatim:** the 521-line block (minus the 4 lead reads) is byte-identical to `HEAD:app.js` and absent
  from the new app.js. Diff stat: `app.js -522` net (block -> 3-line pointer+bind), `pb-views.js +527`
  (521-line block + 4 lead reads + blank + registration), `sw.js` v76 -> v77. Zero index/static/harness/
  test-guard edits.
- `node --check` OK on all three. Full node suite **27/27** (money gate + content guard + deploy-assets +
  portfolio-fill, all unchanged). U+FFFD = 0; BOM + LF preserved; no CR.
- Anti-drift: `function fmtShares`/`Collapsible`/`TFSAContributions`/`TFSABalancer`/`TFSAView`/`fmtRand`/
  `tfsaTaxYearStart` **0 app.js / 1 pb-views.js**; `const TFSA_ANNUAL_LIMIT = 46000;` **0 app.js / 1
  pb-views.js**; pointer + `const TFSAView = PBViews.TFSAView` (app.js:5994); call site intact (app.js:3489);
  `window.PBViews.TFSAView = TFSAView;` immediately after `WatchlistView`; **bridge 46** (unchanged, ending
  `…HoldingRow, HoldingsListHead, SessionBadge, useHotStocks, buildSuggestions`); `HoldingsListHead`/
  `HoldingRow` defs still 1 in app.js.
- Mount gate `verify-refresh-behavior` **ALL PASSED** — the full app boots with `TFSAView` served from
  `pb-views.js`; tab navigation (Holdings/Picks) and the holdings-row/session-badge assertions still hold.

**Bucketing economics, measured:**
- **Bridge 46 -> 46 (+0), IIFE +0.** Every cross-boundary read was already bridged/IIFE-read; the entire
  TFSA-private cluster (incl. single-caller `fmtShares`) moved wholesale. The leanest possible view move.

**Conclusion:** the TFSA view is extracted; `pb-views.js` now holds **11 views + the Heatmap fullscreen chrome
+ the growth-chart cluster**; **every tab view lives in the bucket**; bridge **46**; `sw` `CACHE_NAME`
**v77**. Next: inc-28 relocates `HoldingRow`/`HoldingsListHead` into the bucket (bridge shrink **46 -> 44**).
