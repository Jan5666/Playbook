# Phase 4 increment 5 — import parsers (generic-table + EE-OCR) → `pb-import.js`

**Date:** 2026-07-06
**Branch:** `refactor/phase-4-increment-5-import-parsers` (off `origin/main` 3ffa309)
**Status:** design approved, ready for plan

## Goal

Extract the holdings-import subsystem's **remaining pure core** — the generic-table
column mapper and the Easy Equities screenshot-OCR text parsers — out of the ~12.9k-line
`app.js` and into the existing `pb-import.js` module, and put the currently-untested
generic-table parser under real unit tests. This finishes finding **E5** (fragile,
untested import/parse logic): inc 4 extracted the ticker/name matching + CSV/market
pre-parsers and explicitly deferred "the column-mapper + file parsers + the parseEE\* OCR
fns" to a later increment. This is that increment.

No behavior change is intended. This is a move + rewire, not a rewrite. The one
relocation with app-wide reach is the shared pure numeric parser `parseDecimal`, which
moves to `pb-core.js` and is bound back into `app.js` (all call sites unchanged).

## Non-goals / scope boundaries

**Stays in `app.js` (deliberately out of scope — impure DOM/File/CDN glue):**

- `loadScriptOnce` + the CDN URL consts (`XLSX_CDN`, `PDFJS_CDN`, `PDFJS_WORKER`,
  `TESSERACT_CDN`) — DOM/script-loader concerns.
- `parseXlsxFile`, `parsePdfFile` — File API + lazy-CDN library readers. They call the
  moved pure `rowsToHoldings`.
- `getOcrWorker`, `ocrImageFile` — Tesseract worker + canvas/`document` OCR driver.
- `parseImportFile` — the File-type dispatcher (`.xlsx`/`.pdf`/text). Calls moved
  `parseHoldingsFromText`.
- `parseCashFlowFile` + its cash-flow helpers (`coalesceCashCells`, …) — deposit/withdrawal
  import is a separate subsystem, not holdings-import parsing. It calls the moved
  `stripListMarker` (and the already-bound `splitLine`).

**Untouched files:** `pb-data.js`, `pb-content.js`, `pb-store.js`, `data.js`,
`backend/worker.js`. The worker bundles `pb-core.js` but calls none of the moved code, so
there is **no functional worker change and no `wrangler deploy` needed**.

## Architecture

### `parseDecimal` → `pb-core.js`

`parseDecimal(raw) → number` (app.js:1264) is a pure string→number parser (strips currency
symbols/spaces/letters, resolves EU `1.234,56` vs US `1,234.56` vs lone-comma
thousands/decimal). It is used **~40 times across `app.js`** (alerts, buy/sell/edit modals,
contributions, cash-flow, avg-cost previews) **and** by the parsers being extracted. Since
`pb-import.js` cannot reach `app.js` globals, it needs a shared home.

- **Move it verbatim into `pb-core.js`** and add it to the `PBCore` api export. Precedent:
  `pb-core.js` already holds client-only pure utils (`convertCcy`, `mergeCostBasis`,
  `contribInDisplay`, …) that the worker bundles but never calls.
- **`app.js`** binds `const parseDecimal = PBCore.parseDecimal;` next to the other
  `PBCore.*` binds — all ~40 call sites unchanged.
- **`pb-import.js`** obtains it by extending its existing load-time destructure:
  `const { priceKey, MARKET_CURRENCY } = PBCore;` → `const { priceKey, MARKET_CURRENCY, parseDecimal } = PBCore;`.
  No injection/`configure` change.
- **Worker impact:** `parseDecimal` is client-only; the worker never calls it. The bundle
  gains ~20 dead-weight lines (exactly like `convertCcy`), no behavior change, no deploy.

### `pb-import.js` (extended)

Two contiguous verbatim spans move from `app.js` into the module, appended after the
existing inc-4 members. Both are **pure** and, after the move, depend only on things already
in-module or in `pb-core`:

**Span A — generic-table parse** (~app.js 5516–5705):
`looksLikeHeader`, `matchColumn`, `rowsToHoldings`, `parseImportDate`, `stripListMarker`,
`parseHoldingsFromText`. `rowsToHoldings` uses `IMPORT_SYNONYMS`, `splitTickerMarket`,
`looksLikeTickerToken`, `inferMarket` (all already in `pb-import` from inc 4), `parseDecimal`
(now from `pb-core`), and the local `parseImportDate`. `parseHoldingsFromText` uses
`stripListMarker` + `splitLine` (in-module).

**Span B — EE-OCR parse** (~app.js 5865–6290, i.e. from `EE_MONEY_RE` through
`dedupeEeHoldings`, **excluding** the impure `TESSERACT_CDN`/`getOcrWorker`/`ocrImageFile`
block above it):
`EE_MONEY_RE`, `EE_CHROME_RE`, `EE_NAME_KW_RE`, `EE_EXCHANGE_MAP`, and the self-contained
`ee*` helper set (`eeNumFromLine`, `eeFieldValue`, `isEEDetailScreenshot`,
`isEEEmailScreenshot`, `isEEHistoryScreenshot`, `eeLooksLikeName`, `eeCleanName`,
`eeBestHeaderName`, `eeDetectMarket`, `eeResolveMarket`, `eeExtractNameTicker`, date/normalise
helpers, `codeShape`, …), the four `parseEEDetailScreenshot`/`parseEEListScreenshot`/
`parseEEEmailScreenshot`/`parseEEHistoryScreenshot`, the dispatcher
`parseEasyEquitiesScreenshot`, and `dedupeEeHoldings`. This span's only non-self, non-builtin
call is `parseDecimal` (verified by scanning all `identifier(` tokens in the span).

**Exported (added to the `api` object):** the members `app.js` binds plus those the tests
assert on — `rowsToHoldings`, `parseHoldingsFromText`, `parseEasyEquitiesScreenshot`,
`dedupeEeHoldings`, `stripListMarker`, `parseImportDate`, `matchColumn`, `looksLikeHeader`.
The remaining `ee*` helpers and regex/table consts stay module-internal (not exported).

### `app.js` rewiring

1. Delete the `parseDecimal` def and the two moved spans.
2. Add `const parseDecimal = PBCore.parseDecimal;` with the other `PBCore.*` binds.
3. Add **5 `PBImport.*` binds** at the Span-A site — the moved fns still called from
   stay-behind code:
   - `rowsToHoldings` (called by `parseXlsxFile`, `parsePdfFile`)
   - `parseHoldingsFromText` (called by `parseImportFile` and the paste handler ~10937)
   - `parseEasyEquitiesScreenshot` (called by the OCR modal handler)
   - `dedupeEeHoldings` (called ~10920)
   - `stripListMarker` (called by `parseCashFlowFile` ~6417)

   `parseImportDate`, `looksLikeHeader`, `matchColumn` are called **only** from moved code
   (module-internal) → no bind. The four `parseEE*Screenshot` are called only by
   `parseEasyEquitiesScreenshot` → no bind.

**TDZ safety:** binds are `const` (not hoisted), but every remaining call site is inside a
function body (runtime); module load completes before any runtime call — identical to the
inc-4 pattern.

Net: `app.js` ≈ **−430 lines** (~12936 → ~12500).

## Wiring (no-build surface)

- **No new file** → **no** `index.html`, `static.yml`, or `verify-*.mjs` harness change
  (`pb-import.js`, `pb-core.js`, `app.js` are all already loaded/precached/allowlisted).
- **sw.js:** bump `CACHE_NAME` `playbook-shell-v48` → `v49` (the contents of `pb-core.js`,
  `pb-import.js`, `app.js` change). No `SHELL_ASSETS` edit.

## Testing

### Convert `backend/test/ee-ocr-parse.test.mjs` (behavior-preserving proof)

- Replace the `readFileSync` + `vm.runInContext` slices (currently slices `parseDecimal` and
  the EE block out of `app.js`) with real imports:
  `import PBImport from '../../pb-import.js'` and `import PBCore from '../../pb-core.js'`
  (for `parseDecimal`, if any assertion needs it directly).
- Destructure `parse = PBImport.parseEasyEquitiesScreenshot`, `dedupe = PBImport.dedupeEeHoldings`.
- **Keep every existing assertion unchanged** — green here proves the EE extraction is
  byte-for-byte behavior-preserving.

### Add new coverage (the payoff — the generic-table mapper is currently untested)

New assertions (in `ee-ocr-parse.test.mjs` or a small sibling suite, whichever the plan
picks) over the Span-A parsers:

- `parseHoldingsFromText` / `rowsToHoldings`: a header-row table resolves ticker/shares/cost
  columns; a headerless table resolves roles by column classification
  (`"AAPL, 10, 150"` and `"2024-10-01, Apple, 10, 150.25"` both work); cost derived from
  `total ÷ shares` when no per-share column; markdown list rows (`- **Broadcom**`) strip to
  a clean query.
- `matchColumn`: specificity — a "Book Cost" total isn't stolen by a generic "cost" synonym.
- `parseImportDate`: `YYYY-MM-DD` passthrough; `DD/MM/YYYY` day-first; ambiguous `MM/DD` flip.
- `looksLikeHeader`: a synonym-bearing row is a header; a data row is not.

### `parseDecimal` characterization (pb-core)

Add to a pb-core suite (e.g. `money-math.test.mjs` or a small new file): EU `1.234,56`,
US `1,234.56`, lone-comma decimal `12,50`, lone-comma thousands `1,500`, currency-symbol
stripping (`R2 950`, `£1,234.50`), empty/null → `NaN`.

### Anti-drift source guards

Assert `app.js` **no longer** declares `function parseDecimal` / `function rowsToHoldings` /
`function parseEasyEquitiesScreenshot` / `function parseHoldingsFromText`, and **does** carry
`const parseDecimal = PBCore.parseDecimal` and
`const rowsToHoldings = PBImport.rowsToHoldings`.

## Verification

- `node --check` clean on `app.js`, `pb-import.js`, and `pb-core.js`.
- Full node suite green — including the money gate (money-math, cost-basis, import-matching,
  ee-ocr-parse), which must stay unaffected.
- Browser smoke `verify-refresh-behavior.mjs`: app mounts (no `PBImport`/`parseDecimal`
  ReferenceError), baseline-equivalent — the reliable gate, since node suites never load
  `app.js` in a browser (standing lesson: private-const/fn moves out of `app.js` must be
  smoke-tested).
- If feasible, a one-off headless check that pastes a small table into the Import modal and
  confirms rows resolve (not committed).

## Risks

- **Large, helper-dense EE-OCR block.** Extraction must be **marker-based/scripted**
  (read utf8, slice by single-line CRLF-safe markers, write back unmodified) — never
  retyped. The block contains multi-line regexes and `£`/`€`/`—`/`≈` unicode that a manual
  edit would corrupt. Same discipline as inc 4's three-chunk slice.
- **`parseDecimal` reach.** 40+ call sites; the bind must land before any runtime call
  (module scope, with the other `PBCore.*` binds). A missed site would be a `node --check`
  pass but a runtime `ReferenceError` — the browser smoke is the catch.

## Handoff

Per standing agreement: build in the working tree with tests + reviews; **Jan reviews,
commits, and PRs/merges.** Branch off latest `origin/main` (3ffa309). Do not revert any
tweaks Jan has landed on main between increments.
