# Phase 4 increment 5 — import parsers (generic-table + EE-OCR) → `pb-import.js` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the holdings-import subsystem's remaining pure core — the generic-table column mapper and the Easy Equities screenshot-OCR text parsers — out of `app.js` into the existing `pb-import.js`, move the shared `parseDecimal` util to `pb-core.js`, and put the previously-untested generic-table parser under test — with zero behavior change.

**Architecture:** Two contiguous verbatim spans move from `app.js` into `pb-import.js` (extended, not new): Span A = the generic-table mapper (`looksLikeHeader`, `matchColumn`, `rowsToHoldings`, `parseImportDate`, `stripListMarker`, `parseHoldingsFromText`); Span B = the pure EE-OCR parsers (`EE_MONEY_RE`…`dedupeEeHoldings`, `parseEasyEquitiesScreenshot`). The shared pure `parseDecimal` moves to `pb-core.js` and `pb-import` reads it from `pb-core`; `app.js` binds it back. Impure file/OCR readers (`parseXlsxFile`/`parsePdfFile`/`ocrImageFile`/`parseImportFile`/`parseCashFlowFile`, `loadScriptOnce`, CDN consts) stay in `app.js` and bind the moved fns — mirrors how `fetchYahooSearch` stayed in inc 4. Extraction is marker-based/scripted to preserve CRLF + unicode.

**Tech Stack:** Vanilla ES5-ish browser global scripts (no build step), Node `.mjs` test runner (plain `node file.test.mjs`, no framework), React 18 UMD (unaffected), Cloudflare Worker (unaffected — bundles `pb-core` but never calls `parseDecimal`).

## Global Constraints

- **No build step.** No new file is created this increment (`pb-import.js`/`pb-core.js`/`app.js` are already wired), so there is **no** `index.html` / `sw.js` `SHELL_ASSETS` / `static.yml` / `verify-*.mjs` harness change — only a `CACHE_NAME` bump (contents changed).
- **CRLF file.** `app.js`, `pb-core.js`, `pb-import.js` use `\r\n`. All slice markers must be single-line substrings (no embedded `\n`). Extraction is scripted (read utf8, write back with moved chunks byte-unmodified) — never retype moved bodies (preserves `£`/`€`/`—`/`≈`/curly-quote unicode and the multi-line regexes `EE_MONEY_RE`/`EE_CHROME_RE`/`EE_NAME_KW_RE`).
- **Behavior-preserving.** No formula/logic change. `parseDecimal` moves verbatim; the parser spans move verbatim. The existing `ee-ocr-parse.test.mjs` assertions must stay green.
- **Untouched:** `pb-data.js`, `pb-content.js`, `pb-store.js`, `backend/worker.js`, `data.js`. No worker/wrangler impact.
- **Commits are Jan's.** Build in the working tree with tests + reviews. Treat each "Commit" step as a **review checkpoint**; leave the actual `git commit`/PR/merge to Jan unless he says otherwise. Branch off latest `origin/main` (3ffa309): `refactor/phase-4-increment-5-import-parsers`.
- **Scratchpad for one-off scripts:** `C:\Users\Jan\AppData\Local\Temp\claude\c--Users-Jan-Documents-Playbook-app-Playbook\c5ce565c-859e-4a0a-9713-2ff087062367\scratchpad` — extraction/rewire scripts are one-off, run from there, **not committed**.

---

## File Structure

- **Modify** `pb-core.js` — add `parseDecimal` (moved verbatim from `app.js`) + list it in the `PBCore` object.
- **Modify** `pb-import.js` — extend the `PBCore` destructure with `parseDecimal`; append Span A + Span B; extend the `api` export with the new public members.
- **Modify** `app.js` — delete `parseDecimal` def + Span A + Span B; add the `parseDecimal` bind + 5 `PBImport.*` binds; keep the impure readers.
- **Modify** `backend/test/ee-ocr-parse.test.mjs` — convert vm-slice → real `import PBImport`; keep assertions.
- **Modify** `backend/test/import-matching.test.mjs` — add generic-table + `parseDecimal` characterization tests + anti-drift guards.
- **Modify** `sw.js` — `CACHE_NAME` `v48` → `v49`.

---

## Task 1: Extend `pb-import.js` + move `parseDecimal` to `pb-core.js`, and convert the EE test to import

Builds the extended module by verbatim extraction and proves it behaves identically by keeping the existing EE assertions green. **`app.js` is not touched in this task** — `parseDecimal` and the parser spans are temporarily duplicated (app.js keeps its copies; the module gets copies), so every other suite and every app.js call site stays green. This isolates "does the extracted code behave identically."

**Files:**
- Modify: `pb-core.js`, `pb-import.js`
- Modify: `backend/test/ee-ocr-parse.test.mjs`
- One-off (scratchpad, not committed): `scratchpad/extract-import-parsers.mjs`

**Interfaces:**
- Consumes: `app.js` source (sliced); the existing `pb-core.js` `PBCore` object (line ~615) and dual-export footer; the existing `pb-import.js` `const { priceKey, MARKET_CURRENCY } = PBCore;` (line 11) and `const api = { … }` (line 245).
- Produces:
  - `PBCore.parseDecimal(raw)→number`.
  - `PBImport` gains public members `rowsToHoldings(rows)→[{query,nameHint,tickerHint,marketHint,shares,costBasis,purchaseDate}]`, `parseHoldingsFromText(text)→[…same…]`, `parseImportDate(raw)→'YYYY-MM-DD'|''`, `stripListMarker(line)→string`, `looksLikeHeader(cells)→bool`, `matchColumn(headers,synonyms,used)→number`, `parseEasyEquitiesScreenshot(text,defaultMarket,opts)→[…]`, `dedupeEeHoldings(list)→[…]`. The `ee*` helpers + `EE_*` regex/table consts stay module-internal.

- [ ] **Step 1: Write the extraction script** (scratchpad). It slices three verbatim chunks out of `app.js`, inserts `parseDecimal` into `pb-core.js`, and inserts Span A + Span B into `pb-import.js`, wiring the destructure + exports. CRLF-safe (single-line markers; moved bytes untouched).

```js
// scratchpad/extract-import-parsers.mjs   (run once; not committed)
import { readFileSync, writeFileSync } from 'node:fs';
const ROOT = 'c:/Users/Jan/Documents/Playbook app/Playbook';
const app = readFileSync(ROOT + '/app.js', 'utf8');

// Each chunk = single-line START marker .. single-line marker of the NEXT thing
// that STAYS in app.js (exclusive). CRLF-safe (no '\n' in markers).
function chunk(startMarker, nextStaysMarker) {
  const s = app.indexOf(startMarker);
  const e = app.indexOf(nextStaysMarker, s);
  if (s < 0 || e < 0) throw new Error('marker not found: ' + startMarker + ' | ' + nextStaysMarker);
  return app.slice(s, e).replace(/\s+$/, '');   // trim trailing blank/CR before next-stays
}
const pd     = chunk('// Parse a possibly comma-decimalled / thousands-separated string to a number.', 'const MAX_TRIGGER_HISTORY = 100;');
const spanA  = chunk('function looksLikeHeader(cells) {', 'async function parseXlsxFile(file) {');
const spanB  = chunk('// Numbers in the Easy Equities UI use a space as the thousands separator and a', '// ── Deposit / withdrawal (cash-flow) import');

// ── pb-core.js: insert parseDecimal def + list it in the PBCore object ──
let core = readFileSync(ROOT + '/pb-core.js', 'utf8');
core = core.replace('  const PBCore = {', pd + '\n\n  const PBCore = {');
core = core.replace('    parseYahooQuote\n  };', '    parseYahooQuote,\n    parseDecimal\n  };');
writeFileSync(ROOT + '/pb-core.js', core);

// ── pb-import.js: destructure parseDecimal, insert spans, extend api ──
let imp = readFileSync(ROOT + '/pb-import.js', 'utf8');
imp = imp.replace('const { priceKey, MARKET_CURRENCY } = PBCore;',
                  'const { priceKey, MARKET_CURRENCY, parseDecimal } = PBCore;');
imp = imp.replace('  const api = { configure, YAHOO_EXCHANGE_MAP',
                  spanA + '\n\n' + spanB + '\n\n  const api = { configure, YAHOO_EXCHANGE_MAP');
imp = imp.replace('splitTickerMarket, inferMarket, splitLine, splitCsvLine };',
                  'splitTickerMarket, inferMarket, splitLine, splitCsvLine,\n'
                + '    looksLikeHeader, matchColumn, rowsToHoldings, parseImportDate, stripListMarker,\n'
                + '    parseHoldingsFromText, parseEasyEquitiesScreenshot, dedupeEeHoldings };');
writeFileSync(ROOT + '/pb-import.js', imp);
console.log('done. pb-core lines:', core.split('\n').length, ' pb-import lines:', imp.split('\n').length);
```

- [ ] **Step 2: Run the extraction script**

Run: `node "<scratchpad>/extract-import-parsers.mjs"`
Expected: prints `done. pb-core lines: ~672  pb-import lines: ~680`. Then `node --check pb-core.js` and `node --check pb-import.js` → both clean (exit 0). A `SyntaxError` means a marker matched mid-statement or a `.replace` target string drifted — re-inspect, do not hand-patch.

- [ ] **Step 3: Sanity-check the module loads and exports** (temporary REPL check, not committed)

Run:
```bash
node -e "const C=require('./pb-core.js'); const P=require('./pb-import.js'); P.configure({allTickers:[]}); console.log(C.parseDecimal('1.234,56'), typeof P.rowsToHoldings, typeof P.parseEasyEquitiesScreenshot, JSON.stringify(P.parseHoldingsFromText('AAPL\t10\t150')[0]));"
```
Expected: `1234.56 function function {"query":"AAPL","nameHint":"","tickerHint":"AAPL","marketHint":null,"shares":10,"costBasis":150,"purchaseDate":""}` (verified against the current parsers — the shape + numbers are the gate).

- [ ] **Step 4: Convert `ee-ocr-parse.test.mjs` to import the module.** Replace the vm-slice header (lines 5–27, from `import { readFileSync }` through `const dedupe = ctx.dedupe;`) with a real import. Keep lines 1–4 (retitle) and everything from `let failures = 0;` onward unchanged.

Replace lines 1–27 with:

```js
// Standalone unit test for the Easy Equities screenshot parser. It imports the
// *actual* parsers from pb-import.js (dual-mode CommonJS; default export =
// module.exports) so it can't drift from the shipped code, and runs them against
// realistic, noisy OCR text for the four sample holding screenshots. parseDecimal
// (used internally by the parsers) comes from the real pb-core via pb-import.
// Run: node backend/test/ee-ocr-parse.test.mjs
import PBImport from '../../pb-import.js';

const parse = PBImport.parseEasyEquitiesScreenshot;
const dedupe = PBImport.dedupeEeHoldings;

let failures = 0;
```

Leave the remaining file (from `function approx(` onward) exactly as-is.

- [ ] **Step 5: Run the converted EE test to verify all existing assertions pass**

Run: `cd backend/test && node ee-ocr-parse.test.mjs`
Expected: every line `  ok  …`, final summary reports 0 failures (exit 0). If an assertion shifts, investigate — the extraction must be byte-identical; do not silently edit assertions.

- [ ] **Step 6: Commit (review checkpoint — Jan commits)**

```bash
git add pb-core.js pb-import.js backend/test/ee-ocr-parse.test.mjs
git commit -m "refactor(import): move parseDecimal to pb-core; extract generic-table + EE-OCR parsers to pb-import.js; convert EE test to import"
```

---

## Task 2: Add characterization tests for the newly-extracted parsers

The generic-table mapper (`parseHoldingsFromText`/`rowsToHoldings`/`matchColumn`/`looksLikeHeader`/`parseImportDate`) and `parseDecimal` were pure but under- or un-tested. Pin them now on `PBImport`/`PBCore`. These are the coverage payoff of the increment.

**Files:**
- Modify: `backend/test/import-matching.test.mjs`

**Interfaces:**
- Consumes: `PBImport.parseHoldingsFromText`, `PBImport.parseImportDate` (Task 1); `PBCore.parseDecimal` (Task 1). The suite already `import PBImport from '../../pb-import.js'` and calls `PBImport.configure({ allTickers: [...] })`; it uses an `ok(label, cond)` helper and an `eq` JSON-compare helper.

- [ ] **Step 1: Add a `PBCore` import for `parseDecimal`.** At the top of `import-matching.test.mjs`, immediately after the existing `import PBImport from '../../pb-import.js';` line, add:

```js
import PBCore from '../../pb-core.js';
```

- [ ] **Step 2: Add the parser assertions** just before the final failures/exit block (the closing `console.log(...failures...)` / `process.exit(failures ? 1 : 0)`), insert above it:

```js
// ── parseDecimal: locale-aware number parsing (moved to pb-core) ─────────────
const { parseDecimal } = PBCore;
ok('parseDecimal US 1,234.56', parseDecimal('1,234.56') === 1234.56);
ok('parseDecimal EU 1.234,56', parseDecimal('1.234,56') === 1234.56);
ok('parseDecimal lone-comma decimal 12,50', parseDecimal('12,50') === 12.5);
ok('parseDecimal lone-comma thousands 1,500', parseDecimal('1,500') === 1500);
ok('parseDecimal strips rand + space "R8 100.69"', parseDecimal('R8 100.69') === 8100.69);
ok('parseDecimal strips £ + thousands', parseDecimal('£1,234.50') === 1234.5);
ok('parseDecimal empty → NaN', Number.isNaN(parseDecimal('')));
ok('parseDecimal null → NaN', Number.isNaN(parseDecimal(null)));

// ── parseImportDate: locale-tolerant date normalisation ──────────────────────
const { parseImportDate } = PBImport;
ok('parseImportDate ISO passthrough', parseImportDate('2024-10-01') === '2024-10-01');
ok('parseImportDate zero-pads ISO', parseImportDate('2024-3-5') === '2024-03-05');
ok('parseImportDate DD/MM (day>12)', parseImportDate('13/02/2024') === '2024-02-13');
ok('parseImportDate MM/DD flip (month>12)', parseImportDate('02/13/2024') === '2024-02-13');
ok('parseImportDate day-first default', parseImportDate('01/02/2024') === '2024-02-01');
ok('parseImportDate junk → empty', parseImportDate('not a date') === '');

// ── parseHoldingsFromText: generic-table mapper (header + headerless) ─────────
const { parseHoldingsFromText } = PBImport;
const one = (rows) => rows.length === 1 ? rows[0] : {};
const hHeader = one(parseHoldingsFromText('Ticker,Shares,Price\nAAPL,10,150'));
ok('header table resolves shares', hHeader.shares === 10);
ok('header table resolves cost from price', hHeader.costBasis === 150);
const hTotal = one(parseHoldingsFromText('Ticker,Shares,Book Cost\nAAPL,10,1500'));
ok('"Book Cost" claimed as total (not per-share) → cost = total / shares', hTotal.costBasis === 150);
const hHeadless = one(parseHoldingsFromText('AAPL\t10\t150'));
ok('headerless: shares from first numeric col', hHeadless.shares === 10);
ok('headerless: cost from second numeric col', hHeadless.costBasis === 150);
ok('headerless: query from the text column', hHeadless.query === 'AAPL');
const hMarkdown = one(parseHoldingsFromText('- **Broadcom** 5 900'));
ok('markdown list marker + emphasis stripped', hMarkdown.query === 'Broadcom');
ok('markdown row shares parsed', hMarkdown.shares === 5);
ok('markdown row cost parsed', hMarkdown.costBasis === 900);
```

- [ ] **Step 3: Run the test to verify the new assertions pass**

Run: `cd backend/test && node import-matching.test.mjs`
Expected: all `  ok  …`, 0 failures. If any fails, the assertion's expected value is wrong (read the actual `parseDecimal`/`parseImportDate`/`rowsToHoldings` body in `pb-core.js`/`pb-import.js` and correct the expectation — do NOT change the module).

- [ ] **Step 4: Commit (review checkpoint — Jan commits)**

```bash
git add backend/test/import-matching.test.mjs
git commit -m "test(import): pin parseDecimal + parseImportDate + generic-table mapper in pb-import/pb-core suites"
```

---

## Task 3: Rewire `app.js` (remove moved defs, add binds + configure) and add anti-drift guards

Surgically remove the `parseDecimal` def + the two spans from `app.js` (scripted, preserving unchanged bytes) and insert the `parseDecimal` bind + the 5 `PBImport.*` binds. Then guard against drift.

**Files:**
- Modify: `app.js`
- Modify: `backend/test/import-matching.test.mjs`
- One-off (scratchpad, not committed): `scratchpad/rewire-app-parsers.mjs`

**Interfaces:**
- Consumes: `PBCore.parseDecimal`, `PBImport.rowsToHoldings/parseHoldingsFromText/parseEasyEquitiesScreenshot/dedupeEeHoldings/stripListMarker` (Task 1).
- Produces: `app.js` with `const parseDecimal = PBCore.parseDecimal;` (near the other `PBCore.*` binds) + 5 `PBImport.*` binds (at the Span-A site), and no local definitions of the moved code.

- [ ] **Step 1: Write the rewire script** (scratchpad) — cuts the `parseDecimal` def + the same three marker-bounded chunks and inserts the binds at the right sites.

```js
// scratchpad/rewire-app-parsers.mjs   (run once; not committed)
import { readFileSync, writeFileSync } from 'node:fs';
const ROOT = 'c:/Users/Jan/Documents/Playbook app/Playbook';
let src = readFileSync(ROOT + '/app.js', 'utf8');

const PBIMPORT_BINDS =
`// The generic-table column mapper + Easy Equities OCR-text parsers now live in
// pb-import.js (client-only pure helpers). Bound here so app.js call sites in the
// impure file/OCR readers (parseXlsxFile/parsePdfFile/parseImportFile/ocrImageFile/
// parseCashFlowFile) are unchanged.
const rowsToHoldings             = PBImport.rowsToHoldings;
const parseHoldingsFromText      = PBImport.parseHoldingsFromText;
const stripListMarker            = PBImport.stripListMarker;
const parseEasyEquitiesScreenshot = PBImport.parseEasyEquitiesScreenshot;
const dedupeEeHoldings           = PBImport.dedupeEeHoldings;

`;

function cut(startMarker, nextStaysMarker, replacement) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(nextStaysMarker, s);
  if (s < 0 || e < 0) throw new Error('marker not found: ' + startMarker);
  src = src.slice(0, s) + (replacement || '') + src.slice(e);
}
// Remove Span B (EE) and Span A (generic-table) — Span A's site gets the binds.
cut('// Numbers in the Easy Equities UI use a space as the thousands separator and a', '// ── Deposit / withdrawal (cash-flow) import', '');
cut('function looksLikeHeader(cells) {', 'async function parseXlsxFile(file) {', PBIMPORT_BINDS);
// Remove the parseDecimal definition (now bound from pb-core).
cut('// Parse a possibly comma-decimalled / thousands-separated string to a number.', 'const MAX_TRIGGER_HISTORY = 100;', '');
// Add the parseDecimal bind right after the parseYahooQuote PBCore bind.
src = src.replace('const parseYahooQuote = PBCore.parseYahooQuote;',
                  'const parseYahooQuote = PBCore.parseYahooQuote;\n'
                + '// General numeric parser (currency-symbol / thousands-separator tolerant).\n'
                + '// Moved to pb-core.js (client-only pure util); ~40 call sites below unchanged.\n'
                + 'const parseDecimal = PBCore.parseDecimal;');
writeFileSync(ROOT + '/app.js', src);
console.log('app.js rewired:', src.split('\n').length, 'lines');
```

- [ ] **Step 2: Run the rewire script and node --check**

Run: `node "<scratchpad>/rewire-app-parsers.mjs"` then `node --check app.js`
Expected: prints `app.js rewired: ~12505 lines`; `node --check app.js` clean (exit 0). A `SyntaxError` means a marker cut mid-statement — re-inspect boundaries, do not hand-patch.

- [ ] **Step 3: Verify no moved definition remains and the binds are present** (grep sanity)

Run:
```bash
grep -nE "^function (parseDecimal|looksLikeHeader|matchColumn|rowsToHoldings|parseImportDate|stripListMarker|parseHoldingsFromText|parseEasyEquitiesScreenshot|dedupeEeHoldings)\b" app.js
grep -nE "const (parseDecimal = PBCore|rowsToHoldings = PBImport|parseHoldingsFromText = PBImport|parseEasyEquitiesScreenshot = PBImport|dedupeEeHoldings = PBImport|stripListMarker = PBImport)" app.js
```
Expected: first grep prints **nothing** (no local defs left). Second prints **6** lines (the parseDecimal bind + the 5 PBImport binds).

- [ ] **Step 4: Add anti-drift source guards to the test.** Append to `import-matching.test.mjs` (before the failures/exit block). The suite already reads `app.js` into a var for the inc-4 guards — reuse that read if present; otherwise this adds one:

```js
// ── Anti-drift: the import parsers live in pb-import.js / pb-core.js, not app.js ─
import { readFileSync as _rf2 } from 'node:fs';
import { fileURLToPath as _fu2 } from 'node:url';
import { dirname as _dn2, join as _jn2 } from 'node:path';
const _appSrc2 = _rf2(_jn2(_dn2(_fu2(import.meta.url)), '..', '..', 'app.js'), 'utf8');
ok('app.js no longer defines parseDecimal',              !/\bfunction parseDecimal\b/.test(_appSrc2));
ok('app.js no longer defines rowsToHoldings',            !/\bfunction rowsToHoldings\b/.test(_appSrc2));
ok('app.js no longer defines parseHoldingsFromText',     !/\bfunction parseHoldingsFromText\b/.test(_appSrc2));
ok('app.js no longer defines parseEasyEquitiesScreenshot', !/\bfunction parseEasyEquitiesScreenshot\b/.test(_appSrc2));
ok('app.js binds parseDecimal from PBCore',              /const parseDecimal = PBCore\.parseDecimal/.test(_appSrc2));
ok('app.js binds rowsToHoldings from PBImport',          /const rowsToHoldings\s*=\s*PBImport\.rowsToHoldings/.test(_appSrc2));
```

> If the suite already declares `_appSrc`/`_rf`/etc. from inc 4, drop the duplicate `import`/`readFileSync` lines here and reuse the existing `_appSrc` variable (a repeated `import { readFileSync as _rf }` alias in the same module is a SyntaxError). Keep only the six `ok(...)` assertions, retargeted to the existing var name.

- [ ] **Step 5: Run the full node suite (money gate + all suites)**

Run (from repo root):
```bash
for f in backend/test/*.test.mjs; do echo "== $f =="; node "$f" >/dev/null 2>&1 && echo ok || echo "FAILED: $f"; done
```
Expected: every suite prints `ok`; no `FAILED:` line. Money gate (`money-math`, `cost-basis`, `import-matching`, `ee-ocr-parse`) unaffected.

- [ ] **Step 6: Commit (review checkpoint — Jan commits)**

```bash
git add app.js backend/test/import-matching.test.mjs
git commit -m "refactor(import): app.js binds pb-import parsers + pb-core parseDecimal; remove local defs; anti-drift guards"
```

---

## Task 4: Bump the cache and run the browser smoke

`pb-core.js`, `pb-import.js`, and `app.js` all changed content, so the service-worker shell cache must be revved; and because a private const/fn moved out of `app.js`, the app must be smoke-tested in a real browser (node suites never load `app.js` in a browser).

**Files:**
- Modify: `sw.js`

**Interfaces:**
- Consumes: the rewired `app.js` (Task 3), the extended `pb-import.js` + `pb-core.js` (Task 1).
- Produces: `CACHE_NAME = 'playbook-shell-v49'`.

- [ ] **Step 1: sw.js — bump the cache version.** In `sw.js` line 2: `const CACHE_NAME   = 'playbook-shell-v48';` → `'playbook-shell-v49';`. **No `SHELL_ASSETS` change** (all three files are already precached; no new file).

- [ ] **Step 2: Confirm no new-file wiring is needed** (sanity)

Run:
```bash
grep -c "pb-import.js" index.html; grep -c "pb-import.js" sw.js; grep -c "pb-import.js" .github/workflows/static.yml
```
Expected: `1`, `1`, `2` (unchanged from inc 4 — this increment adds no new script, so index.html/sw SHELL_ASSETS/static.yml are already correct).

- [ ] **Step 3: Run the browser mount smoke**

Run: `node backend/test/verify-refresh-behavior.mjs` (from repo root; self-contained — spins its own static server + headless Chrome, network mocked).
Expected: `ALL PASSED` — app mounts with no `PBImport`/`parseDecimal` ReferenceError; "holdings rows have NO session badge" guard still holds; baseline-equivalent to `origin/main`.

- [ ] **Step 4: Optional end-to-end import check** (one-off, not committed) — if a headless harness is feasible, open the Import modal, paste `AAPL 10 150` (and/or a small EE screenshot text), confirm a row resolves (query `AAPL`, shares 10, cost 150). Otherwise the `import-matching` + `ee-ocr-parse` suites + the mount smoke are sufficient.

- [ ] **Step 5: Commit (review checkpoint — Jan commits)**

```bash
git add sw.js
git commit -m "chore(import): bump service-worker cache to v49 for pb-import/pb-core/app changes"
```

---

## Self-Review

**Spec coverage:**
- `parseDecimal` → `pb-core.js`, bound in app.js, destructured in pb-import → Task 1 (extraction) + Task 3 (bind) ✓
- Span A (generic-table) + Span B (EE-OCR) moved verbatim into `pb-import.js` → Task 1 ✓
- Impure readers stay + bind the 5 called fns → Task 3 ✓
- EE test converted vm-slice → import, assertions unchanged (behavior-preserving proof) → Task 1 ✓
- New coverage: generic-table mapper + `parseImportDate` + `parseDecimal` → Task 2 ✓
- Anti-drift guards → Task 3 ✓
- Wiring: sw v48→v49, no new file → no index.html/static.yml/harness change → Task 4 ✓
- Verification: node --check (3 files), full suite, browser mount smoke → Tasks 1–4 ✓
- Untouched pb-data/pb-content/pb-store/data/worker → no task modifies them ✓

**Placeholder scan:** No TBD/TODO; all scripts + test code are complete and runnable. The `~` line-count figures are expected-output estimates, not placeholders.

**Type consistency:** The 5 PBImport bind names (`rowsToHoldings`, `parseHoldingsFromText`, `stripListMarker`, `parseEasyEquitiesScreenshot`, `dedupeEeHoldings`) match the `api` export list added in Task 1 and the anti-drift grep in Task 3. `parseDecimal` is `PBCore.parseDecimal` everywhere (pb-core object, pb-import destructure, app.js bind, test import). The `.replace` targets in the scripts (`'    parseYahooQuote\n  };'`, `'const { priceKey, MARKET_CURRENCY } = PBCore;'`, `'  const api = { configure, YAHOO_EXCHANGE_MAP'`, `'const parseYahooQuote = PBCore.parseYahooQuote;'`) are verbatim from the current files.

**Two residual risks flagged for the executor:**
1. The Task 3 anti-drift block adds `import { readFileSync as _rf2 }` aliases to avoid colliding with inc 4's `_rf`/`_appSrc` — if inc-4's guards already loaded `app.js`, prefer reusing that var and dropping the duplicate imports (a repeated aliased `import` in one module is a SyntaxError).
2. `parseDecimal` has ~40 call sites; the bind must land at module scope before any runtime call (it's placed with the other `PBCore.*` binds ~line 527, well before any function runs). A missed reference passes `node --check` but throws at mount — the Task 4 browser smoke is the catch.
