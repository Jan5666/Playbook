# Refactor status — Phase 4 modal/view extraction (living roadmap)

**Purpose:** the single doc a fresh chat reads to resume the refactor without re-deriving context.
Keep it current at the end of each increment. Canonical detail lives in
`docs/superpowers/{specs,plans}/`.

**Branch:** `claude/refactoring-plan-fs89s3` (off latest `origin/main`). **Jan reviews +
lands; never push `main`, never open a PR.** Last landed on `main`: inc-18 `AlertsModal` (PR #30);
before it inc 15–17 (PR #26) and feature PRs #27–#29 (rotation tab, watchlist suggestions), which had
bumped `sw` `CACHE_NAME` to v67 and the bridge to 33 members without a refactor increment.

## The refactor in one paragraph

`app.js` is a no-build, no-JSX React UMD monolith. Phase 4 peels large view/modal components out
into **browser-only classic-script buckets** — `pb-views.js` (views) and `pb-modals.js` (modals) —
that read shared `app.js` internals through a **render-time `window.PBApp` bridge** and read PB*
module globals directly in the bucket IIFE. Each increment moves one component (or a single-caller
subtree) **verbatim**, keeping behavior byte-identical. The bridge grows when a bucket needs a new
shared app.js internal, and shrinks when a single-caller helper is relocated into the bucket.

## Done

- **Phase 0–3** complete; **Phase 4 content extraction** inc 1–6 (`pb-content.js`).
- **Views** (inc 7–10): HotTopics, Picks, Hedges, Rules, Overview -> `pb-views.js`.
- **Modals** (inc 11–14): SectorAllocation, SectorDetail, Contribution, ContributionImport ->
  `pb-modals.js` (merged in PR #25).
- **inc-15** `DetailModal` -> `pb-modals.js` (bridge 17->29).
- **inc-16** DetailModal sub-component **subtree** (PriceChart/FundamentalsBlock/WatchlistControl/
  EarningsBadge/IndicatorValueBlock/IndicatorAbout/HoldingNotesControl + 5 helpers) -> bucket;
  **bridge shrank 29->23**; `content.test.mjs` guard followed `SECTOR_FWD_PE` to the bucket.
- **inc-17** `SettingsModal` + single-caller `TabReorderList` -> bucket; **bridge 23->31**; +4 IIFE
  reads (`useLayoutEffect` + PBContent `DISPLAY_CURRENCIES`/`MARKETS`/`RIBBON_CATALOG`).
- **inc-18** `AlertsModal` -> bucket; **safe verbatim move, 0 new bridge members / 0 new IIFE reads**
  (`Icon`, `fmt`, `timeAgo`, `useSwipeDownToClose`, `useBodyScrollLock` already bridged; `useRef`
  already IIFE-read). Display + CRUD only — alert eval + money math stay in pb-core, untouched.
- **inc-19** `ImportModal` (~612 lines) -> bucket; **+4 bridge / +7 IIFE reads**. Display + delegate:
  the multi-caller `TickerSearch` and the impure readers `parseImportFile`/`ocrImageFile`/
  `searchListingsMulti` stay in app.js (bridged, per the inc-14 `parseCashFlowFile` precedent); the 7
  pb-import.js matchers are the **first `PBImport` IIFE reads** in the bucket; `DATA` (`window.PB_DATA`)
  is read **at render time** (data.js loads after the bucket — the `pb-views.js` pattern). No
  cost-basis / import-matching / backup code moved — the import mutator lives in the data layer (via
  the `onImport` prop).

**Current state:** `pb-modals.js` holds **8 modals + the detail subtree + the settings subtree**;
`window.PBApp` bridge = **37** members (33 after feature PRs #27–#29; inc-19 added 4); `sw.js`
`CACHE_NAME` = **playbook-shell-v69**.

## Remaining modals — prioritized (senior-dev, no-regression first)

Re-verified by reading each modal body — the split is **display/delegate (safe verbatim move)** vs
**contains money/alert math (characterization test first)**:

**DONE — inc-18: `AlertsModal`** — SAFE verbatim move completed. As predicted: 0 new bridge members,
0 new IIFE reads (`openChart` confirmed a local closure; all deps already bridged/IIFE-read). Mount
gate + a dedicated render probe (active alerts + triggered history + note branch + perm box) green.

**DONE — inc-19: `ImportModal`** (~612 lines) — SAFE display + delegate move completed. +4 bridge
(`TickerSearch` multi-caller; the impure readers `parseImportFile`/`ocrImageFile`/`searchListingsMulti`
kept in app.js — each roots a stays-put app.js infra cluster) / +7 `PBImport` IIFE reads (the
matchers). `DATA` read at render time. No inline matching/money logic — confirmed rows are delegated to
`onImport` (the mutator is data-layer). Mount gate + a render probe (input stage; paste -> 2 matched
review cards; DATA sector field; TickerSearch subtree; no import fired) green.

**NEXT -> the money tier — characterization test REQUIRED first (rule #3):**
- **`BuyModal`** (~358) — recomputes **average cost basis** in-body
  (`(shares*costBasis + n*price)/total`). Pin the averaging + buy payload, then move.
- **`PositionModal`** (~326) — builds the cost-basis save payload (cost mode / currency /
  crypto total-vs-per-unit). Pin the payload, then move. Uses already-bridged `SectorWeightRows`.
- **`SellModal`** (~141) — share-quantity math (`shares * pct`); realized-gain/proceeds happen in the
  `onSell` mutator (data layer), not the modal. Light characterization test, then move.

**Roadmap correction (2026-07-14, confirmed 2026-07-18):** an earlier version of this file lumped
`AlertsModal` into the rule-#3-gated tier. On re-reading, Alerts is display + CRUD only (no eval, no
money) -> a safe move. Borne out by inc-18 (Alerts) and inc-19 (Import): both were safe verbatim
moves. **The safe verbatim-move tier is now exhausted** — only the rule-#3-gated Buy/Position/Sell
money modals remain, each needing a characterization test first.

## The mechanical recipe (turnkey — every increment 15–17 followed this)

1. **Exhaustive dependency inventory** of the move block: extract to scratchpad, enumerate every free
   identifier, classify each — already-in-IIFE / already-bridged / **new bridge** (app.js internal
   with callers *outside* the block) / **new IIFE read** (`PBxxx.X` module global) / native / prop /
   **subtree-local** (single-caller -> moves with the block). `PBStore.*` is a free global (no bridge).
2. **Verbatim move via a Node slice script — NEVER the Edit tool** (files are **BOM + LF**; bodies
   carry literal `£ € · – — " '`). Read/write `utf8`, split/join `\n`, keep the BOM, splice with a
   **replacement function** (avoids `$'`/`$&` expansion).
3. **Inject a minimal render-time lead read** per moved component: `const { …only-what-it-uses… } =
   window.PBApp;` as the first body statement (for a multi-line signature, after the params `) {`).
4. **Grow/shrink the bridge** publish line (`window.PBApp = { … }`, end of app.js) — all members
   defined before it (TDZ-safe). Add new **IIFE reads** near the top of `pb-modals.js`. Register
   `window.PBModals.<Modal>`; replace the app.js def with a pointer comment + `const X =
   PBModals.X;`.
5. **Wiring:** bump `sw.js` `CACHE_NAME` (only shipped-file change — bucket already wired; the
   `deploy-assets` suite guards index/sw/static consistency). **If a `PBContent` bind moves out of
   app.js** (single-caller like inc-16's `SECTOR_FWD_PE`), update the `content.test.mjs` delegation
   guard to check `appSrc + modSrc` (preserve the anti-inline invariant; don't weaken).
6. **Docs:** `architecture-map.html` bridge count + member list.
7. **Verify (all green before commit):** `node --check`; full node suite (**money gate** +
   **content guard** + **deploy-assets**); anti-drift greps (`function <Modal>` = 0 app.js / 1 bucket;
   moved-out helpers gone / stayed helpers still once; bridge membership); **mount gate**
   `verify-refresh-behavior`; a **throwaway render probe** that opens the modal and asserts it +
   subtree render (never trigger destructive/money side-effects); U+FFFD scan.
8. Spec + plan under `docs/superpowers/`; append a measured read-out to the spec. Commit + push to the
   feature branch. **No PR, never `main`.** Update this file's Done/Current-state.

## Environment notes (remote Linux container)

- Browser harnesses assume Windows Chrome + unpkg. Run them from **scratchpad copies** patched to:
  pin `ROOT=/home/user/Playbook`, serve a locally `npm i`'d React (unpkg is 403-blocked;
  `registry.npmjs.org` is in the proxy `noProxy`) via `/__react.js` + `/__react-dom.js` routes, and
  add `--no-sandbox`. `CHROME_PATH=/opt/pw-browsers/chromium`. **Do not modify committed harnesses.**
  A ready patcher + probe scaffold live in the session scratchpad (`patch-harness.mjs`,
  `probe-*.mjs`) — re-createable from the recipe.
- `verify-modals` / screenshot harnesses have a **pre-existing flaky CDP "Execution context
  destroyed" race** — rerun before blaming a change. Screenshot writes to `test-screenshots/` are
  incidental; `git checkout -- test-screenshots/` before committing.

## Observations / cleanup candidates (out of scope for the moves)

- **`FxSummary`** (`app.js`, ~9736 pre-inc-17) has **no callers** — vestigial dead code. Flag for a
  separate cleanup; left untouched by inc-17.
