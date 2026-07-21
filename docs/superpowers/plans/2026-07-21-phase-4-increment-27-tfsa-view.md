# Phase 4 increment 27 — extract `TFSAView` — Implementation Plan

**Goal:** Move the TFSA tab `TFSAView` (`app.js`) + its TFSA-private cluster (`fmtShares`, `Collapsible`,
`TFSAContributions`, `TFSABalancer`, `fmtRand`, the `TFSA_ANNUAL_LIMIT`/`TFSA_LIFETIME_LIMIT` constants and
the `tfsaTaxYearStart`/`currentTfsaTaxYearStart`/`tfsaTaxYearLabel`/`tfsaTodayStr` helpers) into `pb-views.js`
— one contiguous 521-line slice (`app.js` 5992–6512). **Bridge 46 -> 46 (+0)**, **IIFE +0**. The last tab
view and the last money-tier view (R46k/R500k contribution-room). Display + delegate; deposit CRUD + buys are
props.

**Branch:** `claude/refactor-plan-continuation-j980on` (off latest `origin/main` @ inc-26/PR #36).

## Constraints

- **Node slice, never Edit tool.** BOM + LF; body carries literal `– ≈ · " '`. Content-anchored splice
  (open `function fmtShares(n) {`, close the `}` before `// HotTopicsView is defined in pb-views.js`);
  validate identifier presence + brace balance in memory; both files written atomically.
- **Bridge +0 / IIFE +0:** `Icon`/`PortfolioPieChart`/`HoldingRow`/`HoldingsListHead`/`usePersistedState`/
  `fmt`/`prettyName` all already bridged; `useState` already IIFE-read; `PBStore` a free global. **4
  per-component lead reads** (Collapsible/TFSAContributions/TFSABalancer/TFSAView).
- **Multi-caller rule:** `HoldingRow`/`HoldingsListHead` stay in app.js + bridged this increment (shared with
  the moved `CurrentView`); their relocation is inc-28 (a bridge shrink 46 -> 44).
- **Rule #3:** the contribution-room + P/L math (all inline app.js, no pb-core helper) is verbatim, pinned by
  a **before/after render probe with an identical digest**.
- `content.test.mjs` + delegation guards untouched — no `PBContent`/`PBCore` bind moves out of app.js.

## Task 1 — characterization probe (before the move)

`scratchpad/inc27-probe.mjs` (patched harness: `ROOT=/home/user/Playbook`, local React, `--no-sandbox`,
`CHROME_PATH=/opt/pw-browsers/chromium`). Mount `TFSAView` (resolved from `window.TFSAView` pre-move) with 2
TFSA positions (one live quote, one cost fallback) + deposits crossing the SA tax-year boundary and summing
over R46k; expand the collapsibles; digest Value/Cost/P/L + the annual/lifetime bars + penalty/years-left.
Assert 0 mutators fire. Record the baseline digest.

## Task 2 — move block + 4 lead reads + register + bump sw

Files: `app.js` (5992–6512 span -> pointer + `const TFSAView = PBViews.TFSAView`; bridge line untouched),
`pb-views.js` (block before the registration block, 4 lead reads injected, `window.PBViews.TFSAView` after
`WatchlistView`), `sw.js` (v76 -> v77). Throwaway `scratchpad/inc27-surgery.mjs`. `node --check` both.

## Task 3 — docs

`architecture-map.html`: append inc-27 clause (bridge stays 46). `REFACTOR_STATUS.md` Done/Current-state
(bridge **46**, `sw` **v77**, `pb-views.js` **11 views**; every tab view in the bucket; flag inc-28). Spec +
this plan. No source-guard update (no bind moved out of app.js).

## Task 4 — verify

Node suite (money gate + content + deploy-assets + portfolio-fill, unchanged) green; anti-drift greps
(`function TFSAView`/… + `function fmtShares` + `const TFSA_ANNUAL_LIMIT` 0/1; pointer + bind; registration;
bridge 46; `HoldingRow`/`HoldingsListHead` still 1 in app.js); **verbatim proof** (521-line block minus the 4
lead reads == `HEAD:app.js`); **rule-#3 pin** (probe re-run post-move, identical digest, source=PBViews);
mount gate `verify-refresh-behavior` ALL PASSED; U+FFFD + BOM/LF.

## Task 5 — read-out + progress doc + commit

Append the measured read-out to the spec. Refresh `REFACTOR_STATUS.md`. Commit to the feature branch. **No
PR; never `main`.**

## Self-review

- Contribution-room + P/L math -> pinned by a before/after render probe with a byte-identical digest and a
  source-identity verbatim proof; the math stays inline (moved verbatim), not re-implemented.
- Inventory complete via exhaustive per-component read (+0 bridge / +0 IIFE) -> anti-drift greps + verbatim
  diff. `fmtShares` (single-caller) + the whole private cluster travel with the view.
- Load order: the bridged rows + the bridge publish are TDZ-safe (render-time reads); the moved functions are
  IIFE-scoped in the bucket.
- Encoding (`– ≈ ·`) -> U+FFFD scan + BOM/LF preserved + verbatim diff.
- Shared rows: `HoldingRow`/`HoldingsListHead` bridged (not moved) — they now have no app.js caller and
  relocate into the bucket in inc-28 (a bridge shrink).
