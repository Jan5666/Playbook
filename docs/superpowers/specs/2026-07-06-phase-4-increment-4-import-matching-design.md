# Phase 4 increment 4 — import-matching engine → `pb-import.js`

**Date:** 2026-07-06
**Branch:** `refactor/phase-4-increment-4-import-matching` (off `origin/main` 044dd49)
**Status:** design approved, ready for plan

## Goal

Extract the holdings-import subsystem's **pure core** — ticker/name matching plus
CSV/market-inference pre-parsing — out of the 14k-line `app.js` monolith into a new
dual-mode module `pb-import.js`, and put it under real unit tests. This continues the
Phase 4 "decompose app.js into focused, node-testable modules" work (mirrors
pb-core/pb-content/pb-store/pb-data) and addresses finding **E5** (fragile, untested
import/parse logic) for the pure slice of that subsystem.

No behavior change is intended. This is a move + rewire, not a rewrite. The one and
only internal edit is that `rankImportCandidates` reads an injected ticker universe
instead of a module-global.

## Non-goals / scope boundaries

**Stays in `app.js` (deliberately out of scope):**

- `INSTRUMENT_ALIASES` and `ALL_TICKERS` — `ALL_TICKERS` is built from `DATA` (data.js)
  and is also consumed outside the matching block (app.js ~6708, ~6945). It stays in
  app.js and is **injected** into the module via `PBImport.configure({ allTickers })`.
  `INSTRUMENT_ALIASES` is only referenced by the `ALL_TICKERS` builder, so it stays with it.
- `fetchYahooSearch`, `searchListingsMulti` — client-only **network** glue (proxies,
  `cacheName`, unit-trust feed). They bind the moved pure fns.
- `loadScriptOnce`, `XLSX_CDN` / `PDFJS_CDN` / `PDFJS_WORKER` — DOM/loader concerns.
- The column-mapper (`mapColumns`/generic-table parser), file parsers, and the ~15
  `parseEE*` OCR functions — a separate, larger extraction target for a later increment.

**Untouched files:** `pb-core.js`, `pb-content.js`, `pb-store.js`, `pb-data.js`,
`backend/worker.js`, `data.js`. No worker/wrangler impact.

## Architecture

### New module: `pb-import.js`

A 5th dual-mode global script (`window.PBImport` in the browser + CommonJS
`module.exports` for Node tests), structured like **pb-data.js** (it depends on pb-core
and takes an app-injected config):

```
(function () {
  const PBCore = (node) ? require('./pb-core.js') : globalThis.PBCore;
  const { priceKey, MARKET_CURRENCY } = PBCore;

  const cfg = { allTickers: [] };
  function configure(opts) { if (opts && typeof opts === 'object') Object.assign(cfg, opts); }

  // ── moved verbatim from app.js ──
  const YAHOO_EXCHANGE_MAP = { … };
  function parseYahooSymbol(sym) { … }
  function normaliseCompanyName(s) { … }
  function diceSimilarity(a, b) { … }
  function companyNameScore(query, candidate) { … }
  function bestNameScore(query, name, aliases) { … }
  function looksLikeTickerToken(s) { … }
  function rankImportCandidates(query, tickerHint, chosenMarket, remote) { … }  // reads cfg.allTickers
  const IMPORT_SYNONYMS = { … };
  const CURRENCY_TO_MARKET = { … };
  const SUFFIX_TO_MARKET = { … };
  function splitTickerMarket(raw) { … }
  function inferMarket(currencyRaw, marketRaw, suffixMarket) { … }
  function splitLine(line) { … }
  function splitCsvLine(line, delim) { … }

  const api = { configure, YAHOO_EXCHANGE_MAP, parseYahooSymbol, normaliseCompanyName,
    diceSimilarity, companyNameScore, bestNameScore, looksLikeTickerToken,
    rankImportCandidates, IMPORT_SYNONYMS, CURRENCY_TO_MARKET, SUFFIX_TO_MARKET,
    splitTickerMarket, inferMarket, splitLine, splitCsvLine };
  if (node) module.exports = api;
  globalThis.PBImport = api;
})();
```

**Dependencies (all upward):** `pb-core` only — `priceKey` and `MARKET_CURRENCY`,
read once at module load exactly as pb-data reads its pb-core imports. The
`DATA`-derived ticker universe is injected, never reached from a global.

**The single internal change:** inside `rankImportCandidates`, the two references to the
free variable `ALL_TICKERS` (app.js ~5554, ~5568) become `cfg.allTickers`. Read lazily
at call time, so `configure` only has to run before the first `rankImportCandidates`
call. All other moved code is byte-identical (verbatim slice — preserve unicode: the
name-normalisation regex contains `'`/`` ` ``/curly quotes).

### `app.js` rewiring

1. Delete the 15 moved definitions.
2. Keep `INSTRUMENT_ALIASES` + `ALL_TICKERS`. Immediately after `ALL_TICKERS` is built,
   add: `PBImport.configure({ allTickers: ALL_TICKERS });`
3. Add **9 binds** where the definitions were (the names app.js still calls at its own
   sites): `parseYahooSymbol`, `normaliseCompanyName`, `companyNameScore`,
   `looksLikeTickerToken`, `rankImportCandidates`, `splitTickerMarket`, `inferMarket`,
   `splitLine`, `IMPORT_SYNONYMS` — each `const X = PBImport.X;`.
   The other 6 exports (`YAHOO_EXCHANGE_MAP`, `diceSimilarity`, `bestNameScore`,
   `CURRENCY_TO_MARKET`, `SUFFIX_TO_MARKET`, `splitCsvLine`) are module-internal only —
   no bind.

**TDZ safety:** binds are `const` (not hoisted), but every remaining call site in app.js
is inside a function body (runtime), and module load completes before any runtime call —
identical to how the pb-core/pb-content binds were placed. `configure` runs at module
scope right after `ALL_TICKERS`, before any import UI can call `rankImportCandidates`.

Net: app.js ≈ **−280 lines** (13146 → ~12866).

## Wiring (no-build surface)

- **index.html:** add `<script src="./pb-import.js"></script>` after `pb-content.js`
  (line 77), before `data.js`. It only depends on pb-core (loaded first); the
  `configure` injection happens later inside app.js after data.js has defined `DATA`.
- **sw.js:** bump `CACHE_NAME` `playbook-shell-v47` → `v48`; add `'./pb-import.js'` to
  `SHELL_ASSETS` (after the pb-content.js entry).
- **.github/workflows/static.yml:** add `pb-import.js` to the `cp …` allowlist (line 44)
  and to the Guard-1 existence loop (line 50).
- **verify-*.mjs harness shells (the 17 that inject pb-content.js):** each adds
  `<script src="/pb-import.js">` after the pb-content.js tag. Required — app.js
  references `PBImport.*` at module scope, so a missing global throws a ReferenceError
  at load and the app never mounts (every app-mounting harness would fail).

## Testing

### Upgrade `backend/test/import-matching.test.mjs` (behavior-preserving proof)

- Replace the `readFileSync` + `vm.runInContext` slice with
  `import PBImport from '../../pb-import.js'` (default export = `module.exports`).
- Call `PBImport.configure({ allTickers: <the existing in-file ALL_TICKERS fixtures> })`
  before the assertions; destructure the fns off `PBImport`.
- Keep **all existing assertions unchanged** (parseYahooSymbol supported/dropped markets;
  rankImportCandidates primary-vs-cross-listing; Satrix alias resolution; iShares EEM) —
  green here proves the extraction is byte-for-byte behavior-preserving.

### Add new coverage (the payoff — these parsers are currently untested)

In the same suite file:

- `splitLine`: tab-delimited; markdown `| a | b |`; semicolon-vs-comma preference;
  2+-space fixed-width; single-space line **with** a numeric token → columns; single-space
  line of only words ("Anglo American") → stays one cell.
- `splitCsvLine`: quoted field containing a delimiter; escaped `""` inside quotes.
- `splitTickerMarket`: `AGL.JO`→JSE, `BHP:AX`→ASX, `SAP.DE`→FRA, bare `AAPL`→`{market:null}`.
- `inferMarket`: precedence suffix > market-text (`NASDAQ`→US, `JOHANNESBURG`→JSE) >
  currency (`ZAR`→JSE, `GBX`→LSE) > `US` fallback for unrecognised.

### Anti-drift source guards

Mirror the `content.test.mjs` guards: assert `app.js` **no longer** declares
`function rankImportCandidates` / `function parseYahooSymbol` / `function splitLine`
(etc.), and **does** carry `const rankImportCandidates = PBImport.rankImportCandidates`
and `PBImport.configure({ allTickers`.

## Verification

- `node --check app.js` and `node --check pb-import.js` clean.
- Full node suite (19 files) green — including the money gate (money-math, cost-basis,
  import-matching, ee-ocr-parse) which must be unaffected.
- Browser smoke `verify-refresh-behavior.mjs`: app mounts (no `PBImport` ReferenceError),
  baseline-equivalent — the reliable mount gate (per the standing lesson: node suites
  never load app.js in a browser, so a private-const/fn move must be smoke-tested).
- If feasible, a one-off headless check that opens the Import modal and pastes a small CSV
  to confirm the end-to-end import path still resolves rows (not committed).

## Handoff

Per standing agreement: build in the working tree with tests + reviews; **Jan reviews,
commits, and PRs/merges.** Branch off latest `origin/main` (done: 044dd49). Do not revert
any tweaks Jan has landed on main between increments.
