# Phase 4 · Increment 30 — `PortfolioPieChart` + `SectorHoldingsPopup` → `pb-views.js` (design)

## Why

Phase 4 peels large view/modal components out of the no-build `app.js` UMD monolith into the
browser-only classic-script buckets (`pb-views.js`, `pb-modals.js`). After inc-27/28 every tab
view lives in `pb-views.js` and the two shared holding rows moved with them; inc-29 removed dead
`FxSummary`. The remaining large `app.js` section components are the shared-infra cluster. The
allocation-donut chart is the biggest self-contained one: `PortfolioPieChart` (~303 lines) and its
single-caller child `SectorHoldingsPopup` (~79 lines). Both consumers of `PortfolioPieChart`
(`DashboardView`, `TFSAView`) already live in the bucket, so the chart can join them there.

## Scope

Move into `pb-views.js` (verbatim):
- `PortfolioPieChart` (`app.js:4114–4416`)
- `SectorHoldingsPopup` (`app.js:4417–4495`, single-caller child, only call site inside PPC)
- The **pure** donut-palette helper cluster (`app.js:4050–4111`): `_donutHexToRgb`,
  `_donutRgbToHex`, `_donutHslToHex`, `DONUT_INDIGO_ANCHORS`, `donutIndigoPalette`,
  `DONUT_SPECTRUM_BASE`, `donutSpectrumPalette`, `donutPaletteColors`, `DONUT_OTHER_COLOR` —
  bucket-private (Math-only; the broad `donut` hits in the buckets are the `donutPalette`/
  `donutTopN` *setting keys*, not these helpers).

Stays in `app.js`: `SectorWeightRows` (shared with the position editor), `MARKET_LABELS` (used in
both buckets), and **`resolvePositionSector`** — see below.

## The one non-obvious decision: `resolvePositionSector` cannot move

`resolvePositionSector` reads `DATA` (`DATA.normalizeSector`/`findSector`/`classifySectorByName`).
The bucket only has `DATA` at **render time inside component bodies** (`const DATA = window.PB_DATA;`
— data.js loads after the bucket), never at IIFE module scope. A standalone helper moved into the
IIFE would have no `DATA` in scope, and adding a `DATA` parameter would break the verbatim rule and
change `PortfolioPieChart`'s call. So `resolvePositionSector` **stays in app.js and is bridged**
(`PortfolioPieChart` was its only, co-located caller). Precedent: the inc-19 impure readers
(`parseImportFile`/`ocrImageFile`/`searchListingsMulti`) stay in app.js and are bridged.

## Bridge accounting — a lateral swap, not a shrink

- **−1** `PortfolioPieChart` (leaves the bridge; bucket callers read it bucket-local)
- **+1** `resolvePositionSector` (joins the bridge)
- **Net 0 → stays 44.** 0 new IIFE reads (`useCallback`/`convertCcy`/`marketCurrency`/`priceKey`/
  `CURRENCY_SYMBOLS` already read). ~440 lines leave `app.js`.

Lead reads injected:
- `PortfolioPieChart`: `const { Icon, positionDisplayName, MARKET_LABELS, resolvePositionSector } =
  window.PBApp;` + `const SectorAllocationModal = PBModals.SectorAllocationModal;` (render-time
  PBModals read — the inc-23 `HeatmapView`→`SectorDetailModal` precedent).
- `SectorHoldingsPopup`: `const { Icon, useBodyScrollLock } = window.PBApp;`

## No money/alert code moved

The chart's only money is display formatting of pb-core helpers (`convertCcy`, unmoved). Rule #3
does not bite (no cost-basis / alert-eval math relocated). No test guard references any moved
identifier (checked `backend/test/`).

## Measured read-out

- `node --check app.js` / `pb-views.js`: **OK**.
- Full node suite: **28/28 pass** (money gate: money-math, cost-basis, import-matching, ee-ocr-parse;
  content guard; deploy-assets — all green).
- Anti-drift: `function PortfolioPieChart`/`SectorHoldingsPopup`/`donutPaletteColors` = 0 in app.js,
  1 in pb-views.js; bridge count 44, `PortfolioPieChart` absent, `resolvePositionSector` present.
- U+FFFD scan: 0. BOM preserved on both files.
- Mount gate + render probe: see the plan file.
- `sw.js` `CACHE_NAME` v80 → **v81**.
