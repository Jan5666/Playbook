# Refactor status — Phase 4 modal/view extraction (living roadmap)

**Purpose:** the single doc a fresh chat reads to resume the refactor without re-deriving context.
Keep it current at the end of each increment. Canonical detail lives in
`docs/superpowers/{specs,plans}/`.

**Branch:** `claude/refactor-plan-continuation-gto2pa` (inc-36, off latest `origin/main` @ inc-35/PR #44).
**Jan reviews + lands; never push `main`, never open a PR.** Last landed on `main`: inc-34
`useSwipeDownToClose` (PR #43); before it inc-33 `useContainerWidth` (PR #42); before it inc-32 Heatmap
cluster (PR #41); before it inc-31 `SectorWeightRows`
(PR #40); before it inc-30 `PortfolioPieChart`
(PR #39); before it inc-29 dead-`FxSummary` cleanup + inc-28 `HoldingRow`/`HoldingsListHead` (PR #38),
inc-27 `TFSAView` (PR #37), inc-26 `WatchlistView` (PR #36), inc-25 `CurrentView`
(PR #35), inc 23–24 `HeatmapView`/`DashboardView` (PR #34), inc-22 `PositionModal` (PR #33), inc 20–21
Buy/`SellModal` (PR #32), inc-19 `ImportModal` (PR #31), inc-18 `AlertsModal` (PR #30), inc 15–17 (PR #26)
and feature PRs #27–#29 (rotation tab, watchlist suggestions), which had bumped `sw` `CACHE_NAME` to v67
and the bridge to 33 members without a refactor increment.

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
- **inc-20** `BuyModal` (~92 lines) -> bucket; **+1 IIFE read (`positionCostCcy`) / +0 bridge**. First
  rule-#3 money-tier move: the in-body average cost-basis re-blend
  (`(shares*costBasis + n*price)/newTotalShares`) + the `onBuy(..., costCcy)` payload are byte-identical
  (verbatim), pinned by a before/after render probe (US + crypto-in-ZAR). `Icon`/`useSwipeDownToClose`/
  `useBodyScrollLock`/`sanitizeDecimalInput` already bridged; the buy mutator stays in the data layer.
- **inc-21** `SellModal` (~138 lines) -> bucket; **+0 IIFE / +0 bridge** (all deps already wired). The
  %<->shares sync (both directions + chip), `pnl = (price - costBasis) * shares` (sign + format), the
  validity cap (shares <= holding), and the 6-arg `onSell` payload (**no** costCcy) are byte-identical
  (verbatim), pinned by a before/after render probe (sell + loss + over-holding). Realized
  gain/proceeds stay in the `onSell` mutator (data layer).

- **inc-22** `PositionModal` (~326 lines) -> bucket; **+1 bridge (`MarketPicker`) / +0 IIFE reads**. Third
  and final money-tier move; **completes Phase 4 modal extraction**. `perUnitCost` (crypto total/shares),
  the save payload (incl. the `costCurrency`-persist-only-when-differs rule), and `diffChanges` are
  byte-identical (verbatim), pinned by a before/after render probe (Add/US + Add/crypto-ZAR + Edit-diff +
  no-op) with an **identical result digest**. `MarketPicker` is a multi-caller shared with `WatchlistView`
  (stays in app.js, bridged); `DATA` read at render time; every module dep was already IIFE-read. The
  add/update persistence stays in the `addPosition`/`updatePosition` mutators (data layer).

- **inc-23** `HeatmapView` (~260 lines) + its single-caller `HeatmapFullscreen` (~19 lines) -> `pb-views.js`;
  **+1 bridge (`HeatmapTreemap`) / +5 IIFE reads** (`convertCcy`/`positionCostCcy`/`marketCurrency`/`priceKey`
  from PBCore, `fetchQuoteBatchLight` from PBData — the first PBCore/PBData `const` binds in the views bucket;
  `useLayoutEffect` also added). First **non-modal view** move. Display + delegate: the only money is the
  treemap tile-sizing `convertCcy(shares*costBasis, …)` (pb-core, unmoved), pinned by a before/after render
  probe with an **identical digest**. `HeatmapTreemap`/`ZoomPanHeatmap` + the sector-trend infra stay in
  app.js (bridged); `SectorDetailModal` is read from `PBModals` at render time (pb-modals loads after us).

- **inc-24** `DashboardView` (~299 lines) + its single-caller growth-chart cluster (`CHART_MONTHS`/
  `chartDayLabel`/`buildTimeAxisTicks`/`PortfolioLineChart`, ~406 lines) -> `pb-views.js`; **+2 bridge
  (`PortfolioPieChart` — shared with `TFSAView` — and `fmtNum` — 14 callers) / +5 IIFE reads**
  (`CURRENCY_SYMBOLS` from PBContent, `MARKET_CURRENCY`/`contribInDisplay`/`quoteTradedToday` from PBCore,
  `fetchHistory` from PBData). Display + delegate: the overall-profit/growth aggregation formats pb-core
  helpers (unmoved), pinned by a before/after render probe with an **identical digest**. The two contribution
  modals read from `PBModals` at render time; the cluster is bucket-private (no lead read). The
  `portfolio-fill.test.mjs` delegation guard followed `PBCore.forwardFillPortfolio(` into the bucket
  (now spans app.js + pb-views.js).

- **inc-25** `CurrentView` (~207 lines, the Holdings tab) -> `pb-views.js`; **+2 bridge
  (`HoldingRow`/`HoldingsListHead` — multi-callers shared with `TFSAView`, so they stay in app.js and are
  bridged, the inc-22 `MarketPicker` precedent) / +2 IIFE reads (`MARKETS` from PBContent,
  `valuePositionInCostCcy` from PBCore)**. Display + per-market aggregation: `computeMarketSummary`/
  `renderSummary` format pb-core helpers (`convertCcy`/`positionCostCcy`/`valuePositionInCostCcy`, unmoved);
  buy/sell/edit/import are props (data layer). Byte-identical (verbatim), pinned by a **source-identity
  proof** (vs `HEAD:app.js`) + a render probe (US same-ccy + crypto-in-ZAR cost-ccy, `marketFilter` US &
  CRYPTO). `content.test.mjs` untouched — `MARKETS` stays a bind in app.js (not the inline array). Lays the
  two row bridges the later `TFSAView` move reuses.

- **inc-26** `WatchlistView` (~860 lines) -> `pb-views.js`; **+3 bridge / +1 IIFE read (`parseDecimal`)**. Fourth
  non-modal view move; display + delegate (CRUD + the alert-add popup go out through props — the popup only
  validates with `parseDecimal` then calls `onAddAlert`; alert eval + money math stay in pb-core). The +3 bridge
  members are all **stays-put** app.js code: `SessionBadge` (a multi-caller shared with `PriceBlock`) and the
  single-caller `useHotStocks`/`buildSuggestions`, which root app.js infra clusters (`PBData.fetchHotStocks`/
  `poolMap`/`fetchQuoteLight`; `DATA` read at render time + `readSearchHist`/`cachedName`) — bridged, not moved
  (the inc-19 impure-reader precedent). Byte-identical (verbatim), pinned by a source-identity proof + a render
  probe (Watchlist tab with a seeded watchlist + position + alert: cards, add-form/`TickerSearch`, alert popup).

- **inc-27** `TFSAView` (~114 lines) + its **TFSA-private cluster** (`fmtShares`, `Collapsible`,
  `TFSAContributions`, `TFSABalancer`, `fmtRand`, the `TFSA_ANNUAL_LIMIT`/`TFSA_LIFETIME_LIMIT` constants and
  the `tfsaTaxYearStart`/`currentTfsaTaxYearStart`/`tfsaTaxYearLabel`/`tfsaTodayStr` SA tax-year helpers, a
  single 521-line contiguous slice `app.js` 5992–6512) -> `pb-views.js`; **+0 bridge / +0 IIFE reads**. The
  last tab view and the last money-tier view (R46k annual / R500k lifetime contribution-room math). Display +
  delegate: `Icon`/`PortfolioPieChart`/`HoldingRow`/`HoldingsListHead`/`usePersistedState`/`fmt`/`prettyName`
  were **all already bridged** (a **4-component lead read** — one per moved component — resolves them);
  `useState` already IIFE-read; `PBStore` a free global; the whole private cluster travels with the view
  (single-caller `fmtShares` included). Byte-identical (verbatim), pinned by a **before/after render probe with
  an identical digest** (2 TFSA positions incl. a cost-fallback, deposits crossing the SA tax-year boundary and
  summing over R46k: `Value R2,200 / Cost R2,000 / P/L +R200 +10.0%`; annual `R55,000/R46,000` **over** →
  "R9,000 over the annual limit (40% penalty applies)"; lifetime `R75,000/R500,000` → "R425,000 left · ≈ 10
  years"; 0 mutators fired). Deposit CRUD + buy stay props (data layer). `HoldingRow`/`HoldingsListHead` **stay
  bridged this increment** — TFSAView was their last app.js caller, so they relocate into the bucket next
  (inc-28, a bridge shrink 46 -> 44).

- **inc-28** `HoldingRow` + `HoldingsListHead` (the two shared holding-row components, ~76 lines) ->
  `pb-views.js`; **-2 bridge (46 -> 44) / +1 IIFE read (`isUnitTrustId`)**. A pure **bridge shrink**: inc-27
  moved `TFSAView`, leaving both rows with **zero app.js callers** (consumed only by the bucket's
  `CurrentView` + `TFSAView`). Verbatim move (BOM-safe slice script): `HoldingRow`'s deps
  `positionDisplayName`/`fmtCcy` stay bridged (other readers) via a lead read, `valuePositionInCostCcy` was
  already an IIFE read, and `isUnitTrustId` (a `PBData` global; HoldingRow was its only app.js caller) is the
  bucket's new PBData row-read -- the **app.js `const isUnitTrustId = PBData.isUnitTrustId;` bind stays**
  (now unused, but the `data-providers.test.mjs` delegation guard asserts it). No money/alert code moved
  (rule #4 `SessionBadge`-absence unaffected -- byte-identical). Pinned by the **mount gate**
  (`verify-refresh-behavior`: 2 `.holding-row`s render on the Holdings tab, none with a session badge),
  which doubles as the `CurrentView` -> `HoldingRow` render probe. Both rows registered on `window.PBViews`.

- **inc-29** removed the vestigial dead `FxSummary` (no callers). **inc-30** `PortfolioPieChart` (~303 lines)
  + its single-caller child `SectorHoldingsPopup` (~79 lines) + the private donut-palette helper cluster
  (`_donutHexToRgb`/`_donutRgbToHex`/`_donutHslToHex`/`donutIndigoPalette`/`donutSpectrumPalette`/
  `donutPaletteColors` + `DONUT_INDIGO_ANCHORS`/`DONUT_SPECTRUM_BASE`/`DONUT_OTHER_COLOR`) -> `pb-views.js`;
  **bridge net 0 (44 -> 44) / 0 new IIFE reads**. A **lateral swap, not a shrink**: `PortfolioPieChart` left
  the bridge (its only callers, `DashboardView`/`TFSAView`, already live in the bucket and now read it
  bucket-local) while `resolvePositionSector` **joined** it — the sector resolver reads `DATA`
  (`normalizeSector`/`findSector`/`classifySectorByName`), and the bucket only has `DATA` at render time
  inside components, so a verbatim move was impossible; it stays in app.js and is bridged. The donut helpers
  are pure (Math only) so they travel as bucket-private code; `MARKET_LABELS` stays bridged (used in both
  buckets). `SectorAllocationModal` is read from `PBModals` at render time (the inc-23 precedent). `Icon`/
  `positionDisplayName`/`useBodyScrollLock`/`CURRENCY_SYMBOLS`/`convertCcy`/`marketCurrency`/`priceKey` were
  all already bridged or IIFE-read; `useCallback` was already IIFE-read. Verbatim move (BOM-safe slice
  script), pinned by `node --check` + the full node suite (money gate green) + the mount gate. ~440 lines
  leave app.js. **Completes the shared-infra frontier for the allocation-donut cluster.**

- **inc-31** `SectorWeightRows` (~41 lines, the ETF/fund sector-split editor) -> `pb-modals.js`; **-1 bridge
  (44 -> 43) / +1 IIFE-style render read (`DATA`)**. A clean **bridge shrink**: the two consumers
  (`SectorAllocationModal` + `PositionModal`) already lived in the bucket and `SectorWeightRows` had **zero
  app.js / zero pb-views callers** — it was on the bridge only because it predated its modals' move. Verbatim
  move (BOM-safe slice script): `Icon` stays bridged (lead read), `DATA` (`window.PB_DATA`, for
  `SECTOR_CANON`) is read **at render time** (the bucket's established pattern — data.js loads after it), and
  the component dropped from both consumers' `window.PBApp` lead-read destructures. No money/alert code
  (rules #3/#4 unaffected — pure form UI). Pinned by `node --check` + the full node suite (money gate green) +
  the mount gate + a render probe (open `SectorAllocationModal`: `.sector-split-*` rows, "Add sector" button,
  `DATA.SECTOR_CANON` options populate). Nothing outside the bucket consumes it, so it is **not** registered
  on `window.PBModals`.

- **inc-32** Heatmap cluster — `HeatmapTreemap` + `ZoomPanHeatmap` (~226 lines) + their Heatmap-private
  treemap-layout math (`heatColor`/`squarify`/`layoutSquarify`/`computeWorst`/`buildSectorHierarchy`/
  `layoutTreemap`, ~152 lines) -> `pb-views.js`; **-2 bridge (43 -> 41) / +0 IIFE reads**. Corrects the
  inc-31 "structural extraction complete" call: both components had **zero root-`App` caller** (entered only
  from the buckets — `HeatmapView`/`HeatmapFullscreen` + pb-modals `SectorDetailModal`; the sole app.js
  `HeatmapTreemap` reference lived inside `ZoomPanHeatmap`, which travels with it). Verbatim move (BOM-safe
  slice script, boundary-asserted): two injected lead reads (`HeatmapTreemap` -> `{ Icon, useContainerWidth }`,
  `ZoomPanHeatmap` -> `{ useBodyScrollLock }`); every native hook + `priceKey` were **already IIFE-read** in
  `pb-views.js` (inc-23/24), so **0 new IIFE reads**. `useContainerWidth` **stays bridged** — the one shared
  dependency (also consumed by two other `pb-views.js` components), so it stays in app.js. `pb-modals.js`
  `SectorDetailModal` now reads `ZoomPanHeatmap` from **`window.PBViews`** at render time (the mirror of the
  inc-23 `PBModals` render-time read). No money/alert code (pure display + geometry — rules #3/#4 unaffected).
  Both registered on `window.PBViews`. Pinned by `node --check` + the full node suite (**28/28**, money gate
  green) + anti-drift greps + the mount gate + a render probe (Heatmap tab treemap + `SectorDetailModal`
  contained zoom heatmap). **Clears the Heatmap infra frontier** — the remaining bridged shared components are
  now all legitimately shared with root-`App` and/or both buckets (`Icon`, `PriceBlock`, `SessionBadge`,
  `TickerSearch`, `MarketPicker`, `useContainerWidth`, plus impure readers).

- **inc-33** `useContainerWidth` (~18 lines, the `ResizeObserver` container-sizing hook) -> `pb-views.js`;
  **-1 bridge (41 -> 40) / +0 IIFE reads / +0 registrations**. **Corrects the inc-32 call** that
  `useContainerWidth` "stays bridged — shared": it is **pb-views-only** (`RotationFlowDiagram`,
  `RotationIntradayChart`, `HeatmapTreemap`), with **zero root-`App`** and **zero pb-modals** callers —
  "shared across two views *within one bucket*" never required the bridge (the inc-30 growth-chart /
  donut-helper bucket-private precedent). It worked pre-move only because `app.js` runs at global scope,
  so the top-level `function useContainerWidth()` was a global the rotation components called bare while
  `HeatmapTreemap` redundantly re-read it from `PBApp`. Verbatim move (BOM-safe slice script, captured
  block reused byte-for-byte): a hoisted bucket-private function (no lead read); the two rotation
  components' bare calls now resolve bucket-local, and `HeatmapTreemap`'s lead read shrinks
  (`{ Icon, useContainerWidth }` -> `{ Icon }`). **Not** registered on `window.PBViews` (no cross-bucket
  consumer — the inc-31 `SectorWeightRows` precedent). No money/alert code (pure layout — rules #3/#4
  unaffected). Pinned by `node --check` + the full node suite (**28/28**, money gate green) + anti-drift
  greps + a standalone render probe (the committed mount gate does not mount in this container — it fails
  identically on pristine `HEAD`; the probe opens the Heatmap + Rotation tabs and asserts all three
  consumers render with zero page exceptions).

- **inc-34** `useSwipeDownToClose` (~138 lines, the iOS-sheet swipe-to-dismiss touch-drag hook) ->
  `pb-modals.js`; **-1 bridge (40 -> 39) / +0 IIFE reads / +0 registrations**. **Corrects the inc-33 call**
  that the bridge "now holds only genuinely-shared members": `useSwipeDownToClose` was **pb-modals-only**
  (consumed by 9 modals — `ContributionModal`/`ContributionImportModal`/`SettingsModal`/`DetailModal`/
  `AlertsModal`/`ImportModal`/`BuyModal`/`SellModal`/`PositionModal`), with **zero root-`App`** and **zero
  pb-views** callers — it rode the bridge only because it was authored in `app.js` before the modal bucket
  existed and bridged wholesale at inc-15/16, never re-examined when its modals moved out. It worked pre-move
  only because `app.js` runs at global scope, so the top-level `function useSwipeDownToClose()` was a global
  the modals also redundantly re-read from `PBApp`. Verbatim move (BOM-safe slice script, captured block
  reused byte-for-byte): a hoisted bucket-private function (no lead read); native `useRef`/`useEffect` were
  **already IIFE-read** at `pb-modals.js:5`, so **0 new IIFE reads**; the 9 lead reads each drop
  `useSwipeDownToClose` and their bare calls now resolve bucket-local. **Not** registered on `window.PBModals`
  (no cross-bucket consumer — the inc-31 `SectorWeightRows` / inc-33 `useContainerWidth` precedent). No
  money/alert code (pure gesture UI — rules #3/#4 unaffected). Pinned by `node --check` + the full node suite
  (**28/28**, money gate green) + anti-drift greps + a standalone render probe (the committed mount gate does
  not mount in this container — it fails identically on pristine `HEAD`; the probe renders `ContributionModal`
  + `SellModal` into detached roots and asserts both produce their `.modal-panel` with zero page exceptions,
  and `'useSwipeDownToClose' in window.PBApp` is `false`).

- **inc-35** `fetchSectorTrend` (~34 lines, the sector-ETF multi-horizon trend reader) + its module-private
  `SECTOR_TREND_CACHE` -> `pb-modals.js`; **-1 bridge (39 -> 38) / +3 IIFE reads / +0 registrations**.
  **Corrects the inc-34 call** that the bridge "now holds only genuinely-shared members" — and **reaches the
  bridge floor**. `fetchSectorTrend` carried a deliberate author annotation ("impure Yahoo reader, bridged for
  pb-modals SectorDetailModal"), but the "impure readers must stay" rule exists for readers coupled to root-`App`
  state or `DATA` infra (`parseImportFile`/`ocrImageFile`/`searchListingsMulti`/`useHotStocks`/`buildSuggestions`/
  `resolvePositionSector`) — `fetchSectorTrend` reads **neither**: its only free identifiers are `PBContent`/
  `PBData` module globals the bucket already reads directly, plus its own cache. Impure in the I/O sense but
  **app-state-uncoupled** -> a clean verbatim move (**pb-modals-only**: sole consumer `SectorDetailModal`, zero
  root-`App` / zero pb-views callers). Verbatim move (BOM-safe slice script): the two `PBContent` aliases
  (`SECTOR_ETF`/`SECTOR_TREND_WINDOWS`, which had **zero** other app.js consumer) + `PBData.fetchViaProxies`
  (app.js alias stays — used app-wide) become the bucket's **new IIFE reads**; `SECTOR_TREND_CACHE` travels with
  the hoisted function (no lead read). `SectorDetailModal`'s lead read drops `fetchSectorTrend`; its bare call
  resolves bucket-local. **Content guard** followed the two `PBContent` binds into the bucket
  (`content.test.mjs` now checks `appSrc + modSrc` for `SECTOR_ETF`/`SECTOR_TREND_WINDOWS` — the inc-16
  `SECTOR_FWD_PE` precedent). No money/alert code (pure display-tier network read — rules #3/#4 unaffected).
  **Not** registered on `window.PBModals` (no cross-bucket consumer — inc-31/33/34 precedent). Pinned by
  `node --check` + the full node suite (**28/28**, money gate + content guard green) + anti-drift greps + two
  standalone probes (the committed mount gate does not mount in this container — fails identically on pristine
  `HEAD`): a **load-time smoke** (the `pb-modals.js` IIFE runs under `React`/`PB*` stubs → all 11 modals register,
  proving the new IIFE-top reads don't throw) and a **function probe** (invoke `fetchSectorTrend` with a stubbed
  `fetchViaProxies` → unsupported branch, `+10.0%` 1m trend, 6-hour cache-hit reference identity — all four
  in-scope deps resolve bucket-local).

- **inc-36** the **FX provider block** — `FX_PROXIES` + `HISTORICAL_FX_CACHE` + `fetchHistoricalFx` +
  `fetchFxRates` (~38 lines) -> **`pb-data.js`**; **bridge unchanged (38) / +1 injected config key**.
  **Not a Phase 4 bucket move** — this is the Phase 2 module-extraction pattern applied to the one network
  block deferred when `pb-data.js` was carved out, and it closes **GAPS #7 ("FX fetching is the last network
  code still inside app.js")**. Chosen because a **full 38-member bridge audit** (see below) established that
  Phase 4 genuinely has no verbatim-move candidate left, so the remaining refactor value had moved out of the
  bridge and into the monolith's leftover impure code. Zero `pb-views`/`pb-modals`/`sw.js`/`worker.js`
  references; all 4 `app.js` call sites stay put and both readers are **bound back**
  (`const fetchFxRates = PBData.fetchFxRates;`) exactly like `fetchQuote`/`fetchHistory`, so no call site
  changed. The one seam is `DISPLAY_CURRENCIES` (a `PBContent` value `pb-data` must never reach for, being
  dual-mode): injected via `PBData.configure({ …, displayCurrencies: DISPLAY_CURRENCIES })` following the
  `indicatorCatalog` precedent, resolved as `fetchFxRates`'s first statement so the rest of the body is
  byte-identical. **Rule #3 applies** — FX feeds `convertCcy` and supplies the locked landed-USD deposit rate
  — so a **14-scenario characterization matrix was run BEFORE the move** against the block sliced out of
  `git show HEAD:app.js`, then re-run against `PBData` after: **byte-identical digests**. It pins
  direct-first ladder order, `no-store` vs `force-cache`, the `result`-less-but-`rates`-present acceptance,
  USD forced to 1, the **>=2-rate threshold**, frankfurter-then-exchangerate.host endpoint order, and that a
  **successful** historical rate is cached while a **failed** one is not. Committed as
  `backend/test/fx-providers.test.mjs` (**35 assertions** incl. anti-drift guards) + a `_resetFxCache()` test
  hook (the `_setLastGoodProxy` precedent). The `pLimit`/de-dupe re-routing in GAPS #7's fix line is
  **deliberately excluded** — it is a behaviour change (the FX ladder is direct-first; `looksLikeProxyError`
  would reject bodies the FX readers accept), so it stays open as a follow-up, now guarded by this matrix.
  `app.js` **5037 -> 4999** lines and now contains **no network code**; `pb-data.js` 961 -> 1030.
  `CACHE_NAME` -> **v87**. Pinned by `node --check` (both files) + the full node suite (**29/29**, money gate
  green) + the before/after digest diff + a **load-order probe** (real `pb-core`/`pb-data`/`pb-content` in
  `index.html` order, replaying the 4 real `app.js` wiring statements: binds resolve, the injection reaches
  the provider — JPY filtered out — and 4 call sites remain).

**Bridge-floor audit (inc-36, the verification inc-33/34/35 each lacked):** the "floor reached" claim was
re-tested rather than trusted, by enumerating **all 38** `window.PBApp` members and counting real callers in
`app.js` / `pb-views.js` / `pb-modals.js` (excluding comments and the publish line). **The floor at 38 is
real.** The four members that *look* movable are not: `useHotStocks` (pb-views-only, but needs `poolMap`,
which has a second `app.js` caller -> net-0 swap); `buildSuggestions` (pb-views-only, but `DATA`-coupled via
`findInfo`/`_sectorLookup`/`HOLDINGS` — the inc-30 `resolvePositionSector` precedent); `searchListingsMulti`
(pb-modals-only, but needs `fetchYahooSearch`, which `TickerSearch` also calls -> net-0 swap); and
`TickerSearch` (zero `app.js` callers and used by **both** buckets, so inc-32's cross-bucket
`window.PBViews` read would apply — but it needs `ALL_TICKERS`, which is `DATA`-derived, **and**
`sameUnderlyingExchange`, which has 4 other `app.js` callers, bridged -> net **worse**). Two `app.js`
"occurrences" that made members look consumed are only **comments** (`searchListingsMulti` at
`app.js:4890`, `resolvePositionSector` at `app.js:3876`) — worth knowing before anyone re-audits.

**Current state:** `pb-modals.js` holds **11 modals + the detail subtree + the settings subtree + the shared
`SectorWeightRows` sector-split editor + the `useSwipeDownToClose` gesture hook + the `fetchSectorTrend`
sector-ETF trend reader**;
`window.PBApp` bridge = **38** members (33 after feature PRs #27–#29; inc-19 added 4, inc-22 added 1, inc-23 added 1, inc-24 added 2, inc-25 added 2, inc-26 added 3; inc-27 added 0; **inc-28 removed 2**; inc-30 net 0; **inc-31 removed 1**; **inc-32 removed 2**; **inc-33 removed 1**; **inc-34 removed 1**; **inc-35 removed 1**);
`sw.js` `CACHE_NAME` = **playbook-shell-v87** (inc-36 moved the FX providers into `pb-data.js`, bridge unchanged; inc-29 removed dead `FxSummary`; inc-30 moved `PortfolioPieChart`/`SectorHoldingsPopup` into `pb-views.js`, bridge net 0; inc-31 moved `SectorWeightRows` into `pb-modals.js`, bridge 44 -> 43; inc-32 moved the Heatmap cluster `HeatmapTreemap`/`ZoomPanHeatmap` + treemap-layout math into `pb-views.js`, bridge 43 -> 41; inc-33 moved `useContainerWidth` into `pb-views.js`, bridge 41 -> 40; inc-34 moved `useSwipeDownToClose` into `pb-modals.js`, bridge 40 -> 39; inc-35 moved `fetchSectorTrend` + `SECTOR_TREND_CACHE` into `pb-modals.js`, bridge 39 -> 38). `HoldingRow`/`HoldingsListHead` now live in `pb-views.js` beside their only consumers. **Phase 4 modal extraction is COMPLETE** — every modal
(and all three money modals) lives in the bucket. **The non-modal view tier is also complete** — `pb-views.js`
now holds **11 views + the Heatmap fullscreen chrome + the Heatmap cluster (`HeatmapTreemap`/`ZoomPanHeatmap` +
treemap math) + the growth-chart cluster** (inc-23 `HeatmapView`, inc-24
`DashboardView`, inc-25 `CurrentView`, inc-26 `WatchlistView`, inc-27 `TFSAView`, inc-32 Heatmap cluster);
**every tab view now lives in the bucket.**

**Phase 4 structural extraction is COMPLETE — the bridge has reached its floor (38).** After inc-35 there is
no remaining verbatim-move candidate: every one of the 38 `window.PBApp` members is either (a) genuinely shared
across **both** buckets (`Icon`, `PriceBlock`, `fmt`, `timeAgo`, `prettyName`, `useBodyScrollLock`,
`sanitizeDecimalInput`, `fmtCcy`/`fmtCcySigned`, `resolveTickerName`, `watchListIds`, `computeFxSnapshot`,
`positionDisplayName`, `MARKET_LABELS`, `TickerSearch`, `MarketPicker`), (b) consumed by the root `App`
(`hotToDate`/`hotDayDiff`, `THESIS_SNAPSHOT`, `usePersistedState`, `fmtNum`, `SessionBadge`, `uid`,
`fmtIndicator`, `indicatorFor`, `formatCode`/`normalizeCode`, `DEFAULT_TAB_ORDER`/`TAB_ALWAYS_VISIBLE`/
`TAB_LABELS`), or (c) an impure/anchored reader coupled to `DATA` or root infra (`parseImportFile`,
`ocrImageFile`, `searchListingsMulti`, `useHotStocks`, `buildSuggestions`, `resolvePositionSector`, and the
`parseCashFlowsFromText`/`parseCashFlowFile` cash-flow parsers blocked by the shared `loadScriptOnce` CDN
loader). This was **verified member-by-member in inc-36**, not assumed — see the bridge-floor audit above.

**What "continue the refactor" means from here.** With Phase 4 closed and GAPS #7 done (inc-36), the
remaining documented refactor work is, in order of increasing size:

1. **The `pLimit`/de-dupe half of GAPS #7** — fold the FX readers onto `fetchViaProxies`. A behaviour
   change, so it needs its own increment; `backend/test/fx-providers.test.mjs` is now the guard that makes
   it safe. Smallest real next step.
2. **The GAPS #9 interim task** — debounce/throttle the `pb.prices.v1` write (it is in `BACKUP_SKIP`, so
   nothing downstream cares about write timing). Small, pure perf.
3. **Phase 5 — IndexedDB behind the existing `LS`-shaped adapter** (`PROJECT.md:224`, GAPS #9). This is the
   real next *phase* and the only one still listed as "not started". It touches **rule #5** (cloud-backup
   byte-compatibility, `LEGACY_KEY_MAP` migrations), so it wants a spec + Jan's sign-off on the approach
   **before** any code. Note `SECURITY_ROADMAP.md` says its own Phase 3 iOS-storage work *is* refactor
   Phase 5 — "do it once, there", with the refactor task as the canonical home.

**Then** the next phase is [`SECURITY_ROADMAP.md`](../../SECURITY_ROADMAP.md) (the post-refactor
security/platform plan) — start it only when Jan calls the refactor phase done. Note that roadmap's own
sequencing rule points back here: refactor Phase 5 is a prerequisite for its storage work. The section below
is retained as the historical record of how the modal tier was prioritized and cleared.

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

**DONE — inc-20: `BuyModal`** (~92 lines) — first money-tier move; the rule-#3 pin (avg re-blend +
`onBuy` payload, US + crypto-in-ZAR) was green **before & after** the verbatim move. +1 IIFE read
(`positionCostCcy`), 0 new bridge.

**DONE — inc-21: `SellModal`** (~138 lines) — the %<->shares sync (both directions + chip), `pnl =
(price - costBasis) * shares` (sign + format), the validity cap, and the 6-arg `onSell` payload (no
costCcy) were pinned by a before/after render probe (sell + loss + over-holding), green both sides.
**0 new bridge / 0 new IIFE reads** — verbatim. Realized gain/proceeds stay in the `onSell` mutator.

**DONE — inc-22: `PositionModal`** (~326 lines) — the last money modal. Built the cost-basis save payload
(cost mode / currency / crypto total-vs-per-unit -> `perUnitCost`) + `diffChanges`; pinned by a
before/after render probe (identical digest) and moved verbatim. **+1 bridge (`MarketPicker`, the shared
multi-caller with `WatchlistView`) / +0 IIFE reads**; `DATA` read at render time; `SectorWeightRows`
already bridged. **Phase 4 modal extraction is now COMPLETE.**

**NEXT -> the non-modal view tier is COMPLETE.** inc-23 extracted `HeatmapView`; inc-24 extracted `DashboardView` (+ its `PortfolioLineChart` growth-chart cluster); inc-25 extracted `CurrentView` (the Holdings tab — `HoldingRow`/`HoldingsListHead` bridged, shared with TFSA); inc-26 extracted `WatchlistView` (delegate-only; `SessionBadge`/`useHotStocks`/`buildSuggestions` bridged as stays-put app.js code); **inc-27 extracted `TFSAView`** (the last tab view — R46k/R500k + contribution-room math, pinned by a before/after render probe with an identical digest; its TFSA-private cluster moved with it; +0 bridge / +0 IIFE). **Every tab view now lives in `pb-views.js`.** The two shared rows `HoldingRow`/`HoldingsListHead` are now bridged with **no app.js caller left** (TFSAView was the last), so **inc-28** (DONE) was a clean **bridge shrink**: both rows moved into `pb-views.js` (the `CurrentView`/`TFSAView` lead reads now read them bucket-local) and dropped from the bridge (**46 -> 44**, +1 IIFE read `isUnitTrustId`). inc-29 removed the dead `FxSummary`; inc-30 moved
`PortfolioPieChart` into `pb-views.js` (lateral swap, bridge net 0); **inc-31 (DONE)** relocated
`SectorWeightRows` into `pb-modals.js` (a clean **bridge shrink**, **44 -> 43**); **inc-32 (DONE)** relocated
the Heatmap cluster (`HeatmapTreemap` + `ZoomPanHeatmap` + the Heatmap-private treemap-layout math) into
`pb-views.js` (**43 -> 41**), correcting the earlier "correctly stays bridged" call — both had **zero
root-`App` caller** (`HeatmapTreemap`'s only app.js reference lived inside `ZoomPanHeatmap`, which travels with
it), and pb-modals `SectorDetailModal` now reads `ZoomPanHeatmap` from `window.PBViews` at render time.
**The structural extraction is now effectively complete** — the "large remaining app.js section components"
the earlier roadmap gestured at are all either the root `App`, genuinely shared across **both** buckets
(`PriceBlock`, `TickerSearch`, `MarketPicker`), shared with app.js + a bucket (`SessionBadge`), or impure
readers that must stay in app.js — so they correctly stay bridged. **inc-33** then corrected the one
remaining mis-classification: `useContainerWidth` was pb-views-only (not shared across buckets) and moved
into `pb-views.js` (bridge 41 -> 40). The Heatmap infra frontier is cleared (inc-32) and the bridge now
holds only genuinely-shared members. The post-refactor plan is `SECURITY_ROADMAP.md` (do not start before
the refactor phases are called done).

**Roadmap correction (2026-07-14, confirmed 2026-07-18):** an earlier version of this file lumped
`AlertsModal` into the rule-#3-gated tier. On re-reading, Alerts is display + CRUD only (no eval, no
money) -> a safe move. Borne out by inc-18 (Alerts) and inc-19 (Import): both were safe verbatim
moves. The safe verbatim-move tier was exhausted after Import; the money tier — Buy (inc-20), Sell
(inc-21), Position (inc-22) — is now **also complete**, each pinned by a characterization test first.

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

- **`FxSummary`** (`app.js`) — REMOVED in **inc-29** (had no callers; `computeFxSnapshot` it used stays live via pb-modals). Historic note: was vestigial dead code, flagged for a
  separate cleanup; left untouched by inc-17.
