# Phase 4 increment 19 — eighth modal: `ImportModal` -> `pb-modals.js`

**Date:** 2026-07-18
**Branch:** `claude/refactoring-plan-fs89s3` (off latest `origin/main` @ inc-18/PR #30)
**Status:** executed — all gates green (see measured read-out)

## Goal

Move the holdings-import sheet `ImportModal` (`app.js:8578–9189`, **612 lines**) into the
`pb-modals.js` bucket as a **byte-identical verbatim move** — the largest single modal in Phase 4, but
a **display + delegate** component: it parses/matches/reviews holdings and hands the confirmed rows to
the `onImport` prop. The import-matching logic itself stays put (pb-import.js pure helpers + app.js
impure readers).

**Why this is safe (the overriding constraint: no functional regression).** Read-verified: the modal
contains **no inline matching/money logic that must be pinned first**. The ranking/scoring
(`rankImportCandidates`, `companyNameScore`, `looksLikeTickerToken`, `normaliseCompanyName`) lives in
`pb-import.js`; the impure readers (`parseImportFile`, `ocrImageFile`, `searchListingsMulti`) and the
`TickerSearch` component stay in `app.js` and are reached via the bridge; the OCR/screenshot parsers
(`parseEasyEquitiesScreenshot`, `dedupeEeHoldings`) are pure `pb-import.js` helpers. The realized-gain /
proceeds math is **not** in this modal — `doImport` only maps review rows to a plain payload and awaits
the `onImport` prop (the mutator lives in the data layer). So the move touches **no rule-#3
(money/alert-eval) and no rule-#5 (backup-format) code**; it relocates a presentational + delegating
component only. (This is why `ImportModal` is a *safe* move, not a money-tier modal — unlike
Buy/Position/Sell, which recompute cost basis in-body and need a characterization test first.)

## Dependency inventory (every free identifier classified, on `app.js` @ post-#30)

237 unique identifiers scanned (spread-aware). After subtracting locals / natives / DOM-prop keys /
already-bridged / already-IIFE-read, the residue is exactly: `DATA`, the 4 app.js internals below, and
the 7 `PBImport` globals below.

### Reaches app.js internals -> bridge (`window.PBApp`) — **+4 (33 -> 37)**

| Symbol | Kind | Why bridged (not moved) |
|---|---|---|
| `TickerSearch` | component (`app.js:6019`) | **multi-caller** — also used at app.js 7089 & 9365 (outside the block) |
| `parseImportFile` | async file reader (`app.js:5697`) | single-caller, but pulls in `parseXlsxFile`/`parsePdfFile`/`loadScriptOnce` + CDN consts — cascading move; **bridge per the inc-14 precedent** (`parseCashFlowFile`) |
| `ocrImageFile` | async OCR reader (`app.js:5795`) | single-caller, but pulls in `getOcrWorker`/`_eeLoadBitmap`/`_eeHeaderCanvas` + module-level mutable state (`_eeOcrWorker`,`_eeOcrProgress`) — cascading; bridge |
| `searchListingsMulti` | async search (`app.js:5591`) | single-caller, but pulls in `fetchYahooSearch`/`searchUnitTrusts` — cascading; bridge |

Already bridged and reused (no change): `Icon`, `fmt`, `uid`, `sanitizeDecimalInput`,
`resolveTickerName`, `useSwipeDownToClose`, `useBodyScrollLock`.

**Recipe note — "single-caller moves with the block" is a guideline for *clean* subtree moves (inc-16's
pure helpers), not a mandate to drag impure I/O infrastructure + module-level mutable state into a
browser bucket.** The three readers are single-caller yet each roots a cluster of stays-put app.js
infra; bridging them keeps the move verbatim and matches how inc-14 handled `parseCashFlowFile`. Their
app.js definitions are untouched (still defined exactly once each) and their app.js `PBImport` binds
stay (still used by `parseXlsxFile`/`parsePdfFile`/`searchListingsMulti`).

### Reads module globals -> IIFE — **+7 (all `PBImport.*`)**

`parseHoldingsFromText`, `rankImportCandidates`, `companyNameScore`, `looksLikeTickerToken`,
`normaliseCompanyName`, `parseEasyEquitiesScreenshot`, `dedupeEeHoldings`. **First `PBImport` reads in
the bucket** — `pb-import.js` loads at index.html line 78, before `pb-modals.js` (line 80), so these are
safe as top-of-IIFE `const X = PBImport.X;` reads. All 7 confirmed `typeof === 'function'`.
React destructure (`useState`, `useRef`) and the PBCore/PBContent/PBData reads
(`parseDecimal`, `priceKey`, `MARKET_CURRENCY`, `MARKETS`, `fetchQuote`, `isUnitTrustId`) the modal uses
are **already** in the bucket IIFE — no new PBCore/PBContent/PBData read.

### `DATA` — data.js free global, **render-time read (not bridge, not top-of-IIFE)**

`ImportModal` uses `DATA.findSector`, `DATA.classifySectorByName`, `DATA.SECTOR_CANON` (sector chip).
`data.js` (`window.PB_DATA`) loads at index.html line **81 — after** `pb-modals.js` (line 80), so a
top-of-IIFE `const DATA = window.PB_DATA;` would bind `undefined`. Follow the established `pb-views.js`
pattern (lines 162/228/…): read it **at render time** as a lead statement inside the body —
`const DATA = window.PB_DATA;`. Resolves when the modal renders (all scripts loaded by then).

Because no `PBContent` bind moves out of app.js, the `content.test.mjs` delegation guard is
**unaffected** — no test change.

## Mechanism

Node line-range slice (**never the Edit tool** — BOM + LF; body carries literal `→ — … " " · ×`).
Slice `8578–9189`; assert first line `function ImportModal({ onClose, onImport, defaultMarket }) {`,
last line `}`, and the next app.js line `function PositionModal(_ref12) {`. Splice with a replacement
array (avoids `$'`/`$&` expansion).

Into `pb-modals.js` (inserted before the registration block; hoisting makes order moot):
- **2 render-time lead reads** as the first body statements (single-line signature -> after line 1):
  `const { Icon, fmt, uid, sanitizeDecimalInput, resolveTickerName, useSwipeDownToClose,
  useBodyScrollLock, TickerSearch, parseImportFile, ocrImageFile, searchListingsMulti } = window.PBApp;`
  then `const DATA = window.PB_DATA;`.
- **7 new IIFE reads** near the top (after the `RIBBON_CATALOG` read).
- Register `window.PBModals.ImportModal` after the `AlertsModal` registration.

In `app.js`: block -> pointer comment + `const ImportModal = PBModals.ImportModal;`. Bridge publish line
grows **+4**. The invocation at `app.js:3656` (`React.createElement(ImportModal, {…})`) is untouched
(TDZ-safe: the bind runs at load, the call site is inside a render body).

## Wiring

- `sw.js` `CACHE_NAME` **v68 -> v69**. Only shipped-file wiring.
- **Zero** edits to index.html / static.yml / SHELL_ASSETS / the 16 harnesses — bucket already wired;
  `deploy-assets` stays green.
- `architecture-map.html` — bridge count 31→37 in the history note + count blurb; append the inc-19
  clause; refresh the published member list; update the `import-ui` node (ImportModal now in
  pb-modals.js, TickerSearch stays in app.js).

## Verification gate

1. `node --check` app.js + pb-modals.js + sw.js.
2. Full node suite (**27**; **money gate** unaffected — no cost-basis/import-matching code moved;
   **content guard** 14/14; `deploy-assets` green).
3. Anti-drift greps: `function ImportModal` = 0 app.js / 1 pb-modals.js; 4 stays-put helpers still
   defined once in app.js; lead reads present; pointer + `const ImportModal = PBModals.ImportModal`
   present; registration present; bridge = 37.
4. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED** (patched scratchpad copy).
5. **Import render probe** (throwaway): render `PBModals.ImportModal` directly with a mocked Yahoo
   search+quote; assert the 4 new bridge members + registration + `window.PB_DATA` are wired; input
   stage (market picker / paste / drop / ee-scan, 9 chips); paste -> **review stage with 2 matched
   rows** (exercises `parseHoldingsFromText` + `searchListingsMulti` + the 4 PBImport matchers +
   `fetchQuote`); the `DATA`-driven sector field; the `fmt` amount line; toggle the manual matcher ->
   bridged `TickerSearch` subtree — **without** clicking the final Import (no `onImport` side-effect).
   U+FFFD scan.

## Out of scope / deferred

The rule-#3-gated money modals (Buy/Position/Sell — **characterization test first**); the app.js impure
readers stay put (bridged); `FxSummary` dead-code cleanup; Vite.

## Commit note

Development on `claude/refactoring-plan-fs89s3`; commit + push to the feature branch.
**No PR; `main` never pushed.** Scratchpad scripts gitignored / never committed.

## Measured read-out (2026-07-18, on execution)

All gates green — the prediction held exactly.
- `node --check` app.js + pb-modals.js + sw.js OK. Full node suite **27/27** (money gate + content
  guard **14/0** + deploy-assets). U+FFFD = 0 on all modified files; BOM + LF preserved; the moved
  body's 7 distinct non-ASCII glyphs (`→ — … " " · ×`) match the original counts byte-for-byte.
- Anti-drift: `function ImportModal` **0 app.js / 1 pb-modals.js**; `TickerSearch`/`parseImportFile`/
  `ocrImageFile`/`searchListingsMulti` still **defined once each in app.js**; 2 lead reads present;
  pointer+bind at the old def site (app.js:8585); registration after `AlertsModal` (pb-modals.js:3103);
  bridge **37** members; the `React.createElement(ImportModal, …)` invocation (app.js:3656) unchanged.
- Mount gate `verify-refresh-behavior` **ALL PASSED** (app mounts; auto-poll, manual-refresh, lazy-tab,
  session-badge assertions all green) — proves app.js still mounts with the moved modal.
- Import render probe **PROBE PASSED** first try: 4 new bridge members all `function`; `PBModals.
  ImportModal` registered; `window.PB_DATA` populated; input stage renders (9 market chips ==
  `MARKETS.length`); "Match holdings" -> **2 review cards, both matched (`.import-status.ok` × 2)** via
  the mocked search+quote; **2 `.import-sector-field`** render (the render-time `DATA` read works); 2
  `.import-amount-line` (`fmt`); the manual matcher renders the bridged `TickerSearch`; **0 page
  errors**; `onImport` never fired.

**Bucketing economics, measured:**
- `app.js` **9936 -> 9332 (-604)** (612-line block -> 8-line pointer comment + bind), `pb-modals.js`
  **2482 -> 3104 (+622)** (612-line block + 2 lead reads + 7 IIFE reads + 1 registration), `sw.js`
  **v68 -> v69**. **Zero** index/static/harness edits.
- **Bridge 33 -> 37 (+4), IIFE +7.** The +4 are the multi-caller `TickerSearch` and the three impure
  reader clusters (`parseImportFile`/`ocrImageFile`/`searchListingsMulti`) kept in app.js per the
  inc-14 precedent; the +7 are the pb-import.js matching helpers, read directly from the `PBImport`
  global (which loads before the bucket). `DATA` is the first render-time `window.PB_DATA` read in
  pb-modals.js (data.js loads after the bucket) — the `pb-views.js` pattern.
- **Rule #3/#5 honored:** no cost-basis / import-matching / backup-format code moved — the modal parses
  + reviews + delegates via `onImport`; the probe pins render (incl. a matched row) without firing the
  import.

**Conclusion:** the holdings-import sheet is extracted; the bucket holds **8 modals + the detail
subtree + the settings subtree**; bridge **37**; `sw` `CACHE_NAME` **v69**. Remaining Phase-4 modal
tier is now only the **rule-#3-gated money modals** (Buy/Position/Sell — characterization test first).
The safe verbatim-move tier is exhausted.
