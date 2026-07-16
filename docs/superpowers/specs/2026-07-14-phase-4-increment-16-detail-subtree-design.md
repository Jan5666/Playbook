# Phase 4 increment 16 — relocate the detail-card sub-component subtree into `pb-modals.js`

**Date:** 2026-07-14
**Branch:** `claude/refactor-plan-continuation-fm72ce` (stacks on inc-15)
**Status:** design — the inc-15 earmarked follow-on (move the single-caller subtree DetailModal bridges)

## Goal

Inc-15 moved `DetailModal` into the bucket but **bridged** its seven single-caller sub-components
(745 lines) to keep that increment small. This increment finishes the job: move the whole
**detail-card subtree** — `PriceChart`, `EarningsBadge`, `FundamentalsBlock`, `WatchlistControl`,
`HoldingNotesControl`, `IndicatorValueBlock`, `IndicatorAbout` **and their five private helpers**
(`fmtLarge`, `fmtPct`, `sectorForwardPE`, `baseCurrency`, `fmtIndicatorAsOf`) + the
`SECTOR_FWD_PE` const — from `app.js` into `pb-modals.js`, converting the 7 bridge members into
in-bucket sibling references. **The payoff: the bridge shrinks 29 -> 23.**

Pure display components; no money math or alert eval moves (the money helpers they *call* —
`fmt`, `valuePositionInCostCcy`, etc. — stay in app.js/PBCore, reached via the bridge / IIFE).
Outside rule #3.

## The block (verified contiguous on `app.js` @ post-inc-15)

`app.js:8325–9076` is a single contiguous 752-line span containing **exactly**: the 7 components,
5 private helpers, and `const SECTOR_FWD_PE = PBContent.SECTOR_FWD_PE;` — interleaved, no
unrelated declarations. Every one has **zero callers outside the block** (each component's only
non-def app.js refs are the bridge line + the inc-15 pointer comment; the 5 helpers + the const
are 0-outside). So the whole span moves as a unit.

## Dependency inventory (every free identifier classified)

The subtree is component-light and helper-light: `React.createElement` targets are only `Icon` +
native HTML; the only module namespace touched is `PBContent` (the in-block `SECTOR_FWD_PE`).

### Reaches these app.js internals -> bridge (render-time `window.PBApp` reads)

| Symbol | Used by (in-block) | Bridge status |
|---|---|---|
| `Icon` | EarningsBadge, WatchlistControl, HoldingNotesControl, IndicatorAbout | already bridged — **stays** |
| `fmt` | FundamentalsBlock | already bridged — **stays** |
| `fmtIndicator` | PriceChart, IndicatorValueBlock | already bridged (inc-15) — **stays** |
| `watchListIds` | WatchlistControl | **NEW** bridge member — app.js:6215, 6+ other app.js callers (2518/2520/2549/2579/6307/6308), genuinely shared -> stays in app.js, bridged |

### Reads module globals directly -> IIFE

| Symbol | Source | Disposition |
|---|---|---|
| `MARKET_CURRENCY` | `PBCore.MARKET_CURRENCY` | **NEW** IIFE read (used by `baseCurrency` + `FundamentalsBlock`) |
| `SECTOR_FWD_PE` | `PBContent.SECTOR_FWD_PE` | rides **in the block** as `const SECTOR_FWD_PE = PBContent.SECTOR_FWD_PE;` (PBContent is a global) |

### Everything else

React hooks (`useState`/`useRef`/`useEffect` — IIFE), `React`/`ReactDOM`(none here)/`document`/
`Math`/`Intl`/`isFinite`/`isNaN` natives, the 5 private helpers (move together), and each
component's own closures (`vfmt`, `segPath`, `xFor`/`yFor`, `idxFromX`, `closePanel`, `submitNew`,
`hpush`, `schedule`, `tone`, `signed`, `fmtSpan`, …) all defined in-block. Verified non-deps:
`watchlist`/`watchlistGroups` are WatchlistControl **props**; `prices` appears only in a comment;
`translateX`/`url` are CSS-in-strings.

## Mechanism

Node line-range slice (**never the Edit tool** — BOM + LF; the block carries literal `–`/`—`/`·`
and curly quotes in analyst/label copy). Slice `8325–9076`; assert the last line is `IndicatorAbout`'s
closing `}` and the next app.js line is the inc-15 `DetailModal` pointer.

Into `pb-modals.js` (inserted **before** the existing `DetailModal`, so the subtree it composes is
defined above it — though function-decl hoisting makes order moot):
- **7 per-component render-time lead reads** injected as each component's first body statement:
  `PriceChart`→`{ fmtIndicator }`, `EarningsBadge`→`{ Icon }`, `FundamentalsBlock`→`{ fmt }`,
  `WatchlistControl`→`{ Icon, watchListIds }`, `HoldingNotesControl`→`{ Icon }`,
  `IndicatorValueBlock`→`{ fmtIndicator }`, `IndicatorAbout`→`{ Icon }`. The 5 helpers + the const
  get **no** lead read (pure / module-global only).
- IIFE gains `const MARKET_CURRENCY = PBCore.MARKET_CURRENCY;`.

In `app.js`:
- Block span -> a 2-line pointer comment.
- Bridge publish: **remove** the 7 components, **add** `watchListIds` -> **29 -> 23**.
- The inc-15 `DetailModal` pointer comment's line 3 ("sub-components … stay here, bridged") is
  rewritten to record that inc-16 moved them.

In `pb-modals.js` **`DetailModal`'s lead read**: drop the 7 component names (now in-bucket
siblings referenced directly); keep the 13 remaining bridge members
(`Icon, useSwipeDownToClose, useBodyScrollLock, prettyName, resolveTickerName, fmt, fmtCcy,
fmtCcySigned, fmtIndicator, indicatorFor, timeAgo, PriceBlock, sanitizeDecimalInput`).

## Wiring

- `sw.js` `CACHE_NAME` **v63 -> v64**. Only shipped-file wiring.
- **Zero** edits to `index.html`/`static.yml`/`SHELL_ASSETS`/the 16 harnesses — bucket already
  wired; `deploy-assets` stays green.
- `architecture-map.html` — bridge note **29 -> 23** + member-list edit; note the subtree now
  lives in pb-modals.js.

## Verification gate

1. `node --check` clean on `app.js` and `pb-modals.js`.
2. Full node suite green (**22**; money gate unaffected — display components only);
   `deploy-assets` green.
3. Anti-drift greps: the 7 `function <Component>` = 0 in app.js / 1 in pb-modals.js each; the 5
   helpers + `SECTOR_FWD_PE` = 0 in app.js / present in pb-modals.js; bridge **has**
   `watchListIds`, **lacks** all 7 components; `MARKET_CURRENCY` IIFE read present; DetailModal's
   lead read no longer names the 7 components; `watchListIds` still defined once in app.js (stayed).
4. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED** (the subtree renders on the holdings
   view; the detail card is reachable).
5. **Render check — the inc-15 DetailModal probe re-run**: opens the card on a seeded position and
   asserts the P&L block (`FundamentalsBlock`/position math), the price chart (`PriceChart`), the
   watchlist control (`WatchlistControl` -> `watchListIds` via the new bridge member), the alert
   portal, and a U+FFFD scan — proving every moved component still renders through the new seams.

## Out of scope / deferred

The rule-#3-gated money/alert modals (Sell/Buy/Alerts — characterization test first);
Import/Position/Settings modals; React Context; Vite.

## Commit note

Development on `claude/refactor-plan-continuation-fm72ce`; commit + push to the feature branch.
**No PR; `main` never pushed.** Scratchpad scripts gitignored.

## Measured read-out (2026-07-14, on execution)

All gates green — 22 node suites (money gate + `deploy-assets`), mount gate
`verify-refresh-behavior` **ALL PASSED** (the app mounts with the whole subtree relocated), render
probe **PROBE ALL PASSED** first try. The probe (seeded AAPL position) proved every new seam:
- **PriceChart** renders (`.chart-block`) — moved, reaches `fmtIndicator` via its injected lead read.
- **WatchlistControl** renders (`.wl-control`) — exercises **`watchListIds`, the new bridge
  member**; had it been unwired the component would have thrown and the panel not rendered.
- Position **P&L** `+$600.00 (+33.3%)` + **Avg price** `$150.00` still exact (DetailModal's own
  money-display, unaffected); **alert portal** still escapes to `document.body`; **0** U+FFFD.

**One guard followed the code:** `content.test.mjs`'s "app.js delegates … to PBContent" asserted
*app.js* binds `SECTOR_FWD_PE`. Its sole consumer (`FundamentalsBlock`→`sectorForwardPE`) moved to
pb-modals.js, taking the `const SECTOR_FWD_PE = PBContent.SECTOR_FWD_PE;` bind with it. The guard
was updated to check the bind in **either shipped file** (`appSrc + modSrc`) — the anti-inline
invariant is preserved, not weakened; the "not inline" guard (app.js has no `SECTOR_FWD_PE = {`)
still holds. This was the only suite that moved.

**Bucketing economics, measured:**
- `app.js` **11390 -> 10640 (-750)** (752-line subtree -> 2-line pointer), `pb-modals.js`
  **760 -> 1523 (+763)** (752 block + 7 lead reads + 3-line header + 1 IIFE read; DetailModal read
  trimmed in place), `sw.js` **v63 -> v64**. **Zero** index/static/harness edits. The bucket now
  holds **5 modals + the 7 detail-card sub-components + their 5 private helpers**.
- **Bridge SHRANK: 29 -> 23** (−7 now-in-bucket components, +`watchListIds` — genuinely shared,
  6+ app.js callers, stays in app.js:6215). This is the payoff the inc-15 read-out earmarked: the
  single-caller subtree no longer crosses the seam, so the bridge went *down* for the first time
  in Phase 4. `MARKET_CURRENCY` added as a `PBCore` IIFE read; `SECTOR_FWD_PE` rides in the block
  (still `PBContent`-delegated). `fmt`/`fmtIndicator`/`Icon` stay bridged (used by both the moved
  components and DetailModal).
- **Seam mechanics:** the 7 components each got a minimal render-time `window.PBApp` lead read
  (only what each uses: `Icon` / `fmt` / `fmtIndicator` / `watchListIds`); the 5 helpers needed
  none (pure or module-global only).

**Environment note:** browser harnesses run from scratchpad copies (pin ROOT, local React,
`--no-sandbox`, `CHROME_PATH=/opt/pw-browsers/chromium`); committed harnesses untouched.

**Conclusion:** the detail-card subtree is fully in the bucket and the bridge shrank 29 -> 23 — the
inc-15 debt is cleared. Remaining Phase-4 modal work: the rule-#3-gated money/alert modals
(Sell/Buy/Alerts, characterization test first) and Import/Position/Settings.
