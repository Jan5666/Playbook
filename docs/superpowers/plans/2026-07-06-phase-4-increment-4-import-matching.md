# Phase 4 increment 4 — import-matching engine → `pb-import.js` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the holdings-import subsystem's pure core (ticker/name matching + CSV/market-inference parsers) out of `app.js` into a new dual-mode module `pb-import.js`, and put the previously-untested parsers under test — with zero behavior change.

**Architecture:** `pb-import.js` is a 5th dual-mode global script (`window.PBImport` + CommonJS), structured like `pb-data.js`: it reads `priceKey`/`MARKET_CURRENCY` from `pb-core` at load and takes the `DATA`-derived ticker universe via `PBImport.configure({ allTickers })`. Fifteen definitions move verbatim from `app.js` via a marker-based extraction script (preserves CRLF + unicode); `app.js` binds the 9 it still calls and injects `ALL_TICKERS`. The one internal edit: `rankImportCandidates` reads `cfg.allTickers` instead of the module-global `ALL_TICKERS`.

**Tech Stack:** Vanilla ES5-ish browser global scripts (no build step), Node `.mjs` test runner (plain `node file.test.mjs`, no framework), React 18 UMD (unaffected), Cloudflare Worker (unaffected).

## Global Constraints

- **No build step.** Every new script needs: an `index.html` `<script>` tag, an `sw.js` `SHELL_ASSETS` precache entry + `CACHE_NAME` bump, a `static.yml` deploy-allowlist entry (cp-list + Guard-1 loop), and a tag in every app-mounting `verify-*.mjs` harness shell.
- **CRLF file.** `app.js` uses `\r\n` line endings. All slice markers must be single-line substrings (no embedded `\n`). Extraction is scripted (read as utf8, write back unmodified) — never retype moved bodies (preserves `£`/`€`/`—`/`≈`/curly-quote/`──` unicode).
- **Behavior-preserving.** No formula/logic change except `ALL_TICKERS` → `cfg.allTickers` inside `rankImportCandidates`. The existing `import-matching.test.mjs` assertions must stay green.
- **Untouched:** `pb-core.js`, `pb-content.js`, `pb-store.js`, `pb-data.js`, `backend/worker.js`, `data.js`. No worker/wrangler impact.
- **Commits are Jan's.** Build in the working tree with tests + reviews. Treat each "Commit" step as a **review checkpoint**; leave the actual `git commit`/PR/merge to Jan unless he says otherwise. Branch already created off `origin/main` 044dd49: `refactor/phase-4-increment-4-import-matching`.
- **Scratchpad for one-off scripts:** `C:\Users\Jan\AppData\Local\Temp\claude\c--Users-Jan-Documents-Playbook-app-Playbook\5d16fcdd-3b0c-412f-aca6-c5889d03b6f5\scratchpad` — extraction/rewire scripts are one-off, run from there, **not committed**.

---

## File Structure

- **Create** `pb-import.js` (repo root) — the pure import helpers module. One responsibility: symbol/name matching + CSV/market-inference parsing for holdings import.
- **Modify** `app.js` — delete the 15 moved defs; add 9 binds + `configure` call; keep `INSTRUMENT_ALIASES`/`ALL_TICKERS`.
- **Modify** `backend/test/import-matching.test.mjs` — convert from vm-slice to real import; add parser characterization tests; add anti-drift source guards.
- **Modify** `index.html`, `sw.js`, `.github/workflows/static.yml`, and the 17 `verify-*.mjs` harness shells — wiring.

---

## Task 1: Create `pb-import.js` and convert the existing test to import it

Creates the module by verbatim extraction and proves it behaves identically by keeping the existing matching assertions green. **`app.js` is not touched in this task** — the module is standalone, so this isolates "does the extracted module behave identically."

**Files:**
- Create: `pb-import.js`
- Modify: `backend/test/import-matching.test.mjs`
- One-off (scratchpad, not committed): `scratchpad/extract-pb-import.mjs`

**Interfaces:**
- Consumes: `PBCore.priceKey(market, ticker)`, `PBCore.MARKET_CURRENCY` (map `market → {code,...}`) from `pb-core.js`.
- Produces: `PBImport` object with `configure({allTickers})` and the 15 members:
  `YAHOO_EXCHANGE_MAP`, `parseYahooSymbol(sym)→{ticker,market}|null`,
  `normaliseCompanyName(s)→string`, `diceSimilarity(a,b)→number`,
  `companyNameScore(query,candidate)→number`, `bestNameScore(query,name,aliases)→number`,
  `looksLikeTickerToken(s)→bool`, `rankImportCandidates(query,tickerHint,chosenMarket,remote)→[{...,score,nameScore}]`,
  `IMPORT_SYNONYMS`, `CURRENCY_TO_MARKET`, `SUFFIX_TO_MARKET`,
  `splitTickerMarket(raw)→{ticker,market}`, `inferMarket(currencyRaw,marketRaw,suffixMarket)→market`,
  `splitLine(line)→[cells]`, `splitCsvLine(line,delim)→[cells]`.

- [ ] **Step 1: Write the extraction script** (scratchpad) — slices the three verbatim chunks out of `app.js`, wraps them in the dual-mode IIFE, applies the single `ALL_TICKERS→cfg.allTickers` edit, and writes `pb-import.js`.

```js
// scratchpad/extract-pb-import.mjs   (run once; not committed)
import { readFileSync, writeFileSync } from 'node:fs';
const ROOT = 'c:/Users/Jan/Documents/Playbook app/Playbook';
const src = readFileSync(ROOT + '/app.js', 'utf8');

// Each chunk is bounded by a single-line START marker and the single-line marker
// of the NEXT thing that STAYS in app.js (exclusive). CRLF-safe (no '\n' in markers).
function chunk(startMarker, nextStaysMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(nextStaysMarker, s);
  if (s < 0 || e < 0) throw new Error('marker not found: ' + startMarker + ' | ' + nextStaysMarker);
  return src.slice(s, e).replace(/\s+$/, '') + '\n';   // trim trailing blank/CR before next-stays
}
const m1   = chunk('// Yahoo exchange-suffix', 'async function fetchYahooSearch');
const m2   = chunk('// ── Fuzzy company-name matching', '// Search live listings using several');
const m3m4 = chunk('// Header-name synonyms', 'function looksLikeHeader');

// Sole internal edit: the ticker universe is injected, not a module global.
let body = (m1 + '\n' + m2 + '\n' + m3m4).replace(/\bALL_TICKERS\b/g, 'cfg.allTickers');

const HEADER = `// Playbook import helpers — pure symbol/name matching + CSV/market-inference
// parsers for holdings import. No React/DOM/network. Dual-mode like pb-data.js:
// CommonJS module.exports (Node tests) + globalThis.PBImport (browser <script>
// after pb-core.js, before app.js). Depends only on pb-core (priceKey,
// MARKET_CURRENCY); the DATA-derived ticker universe is injected via
// PBImport.configure({ allTickers }). app.js binds each value via \`const X = PBImport.X\`.
(function () {
  const PBCore = (typeof module !== 'undefined' && module.exports && typeof require !== 'undefined')
    ? require('./pb-core.js')
    : globalThis.PBCore;
  const { priceKey, MARKET_CURRENCY } = PBCore;

  // App-injected config (set once from app.js via PBImport.configure). Kept here
  // so the module never reaches into app.js/data.js globals.
  const cfg = { allTickers: [] };
  function configure(opts) { if (opts && typeof opts === 'object') Object.assign(cfg, opts); }

`;
const FOOTER = `
  const api = { configure, YAHOO_EXCHANGE_MAP, parseYahooSymbol, normaliseCompanyName,
    diceSimilarity, companyNameScore, bestNameScore, looksLikeTickerToken,
    rankImportCandidates, IMPORT_SYNONYMS, CURRENCY_TO_MARKET, SUFFIX_TO_MARKET,
    splitTickerMarket, inferMarket, splitLine, splitCsvLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.PBImport = api;
})();
`;
writeFileSync(ROOT + '/pb-import.js', HEADER + body + FOOTER);
console.log('pb-import.js written:', (HEADER + body + FOOTER).split('\n').length, 'lines');
```

- [ ] **Step 2: Run the extraction script**

Run: `node "<scratchpad>/extract-pb-import.mjs"`
Expected: prints `pb-import.js written: ~330 lines`. Then `node --check pb-import.js` → clean (no output, exit 0).

- [ ] **Step 3: Sanity-check the module loads and exports** (temporary REPL check, not committed)

Run:
```bash
node -e "const P=require('./pb-import.js'); P.configure({allTickers:[]}); console.log(typeof P.rankImportCandidates, P.parseYahooSymbol('NPN.JO'), P.parseYahooSymbol('ASML.VI'));"
```
Expected: `function { ticker: 'NPN', market: 'JSE' } null`

- [ ] **Step 4: Convert `import-matching.test.mjs` to import the module.** Replace the file header (the `readFileSync`/`vm` slice + sandbox block, current lines ~10–49) with a real import + `configure`; keep every assertion below it unchanged.

Replace from the first `import { readFileSync ... }` line through the line `const { parseYahooSymbol, rankImportCandidates, bestNameScore } = sandbox.__x;` with:

```js
// pb-import.js is a dual-mode CommonJS module; import its default export (= module.exports).
// The DATA-derived ticker universe is injected here with the same fixtures the old
// vm-sandbox stubbed, so the assertions below are unchanged and prove the extraction
// is behaviour-preserving. priceKey + MARKET_CURRENCY come from the real pb-core.
import PBImport from '../../pb-import.js';

PBImport.configure({ allTickers: [
  { ticker: 'BRK-B', name: 'Berkshire Hathaway', market: 'US' },
  { ticker: 'STX40',  name: 'Satrix 40 ETF', market: 'JSE', aliases: ['Satrix Top 40 ETF', 'Satrix Top40'] },
  { ticker: 'STXGOV', name: 'Satrix SA Bond ETF', market: 'JSE', aliases: ['Satrix Government Bond ETF', 'Satrix GOVI', 'Satrix Gov Bonds', 'GOVI'] },
  { ticker: 'STXILB', name: 'Satrix Inflation-Linked Bond ETF', market: 'JSE', aliases: ['Satrix ILBI', 'Satrix Inflation Linked Bond ETF', 'ILBI'] },
  { ticker: 'STXEMG', name: 'Satrix MSCI Emerging Markets ETF', market: 'JSE', aliases: ['Satrix Emerging Markets ETF', 'Satrix MSCI EM ETF'] },
  { ticker: 'EEM',    name: 'iShares MSCI Emerging Markets ETF', market: 'US', aliases: ['iShares Emerging Markets'] },
] });

const { parseYahooSymbol, rankImportCandidates, bestNameScore } = PBImport;
```

Leave the remaining file (from `let failures = 0;` onward) exactly as-is.

- [ ] **Step 5: Run the converted test to verify all existing assertions pass**

Run: `cd backend/test && node import-matching.test.mjs`
Expected: every line `  ok  …`, final summary line reports 0 failures (exit 0). If `MARKET_CURRENCY`-dependent ranking assertions shift, investigate — the real pb-core `MARKET_CURRENCY` codes must match the old stub (US→USD, JSE/TFSA→ZAR, LSE→GBP, ASX→AUD, FRA/PAR/AMS→EUR); do not silently edit assertions.

- [ ] **Step 6: Commit (review checkpoint — Jan commits)**

```bash
git add pb-import.js backend/test/import-matching.test.mjs
git commit -m "refactor(import): extract pure matching+parse core to pb-import.js; convert test to import"
```

---

## Task 2: Add characterization tests for the newly-extracted parsers

The delimiter-detection and market-inference logic was pure but **untested** in app.js. Now that it's on `PBImport`, pin it. These are the coverage payoff of the increment.

**Files:**
- Modify: `backend/test/import-matching.test.mjs`

**Interfaces:**
- Consumes: `PBImport.splitLine`, `PBImport.splitCsvLine`, `PBImport.splitTickerMarket`, `PBImport.inferMarket` (from Task 1).

- [ ] **Step 1: Add the parser assertions** just before the final failures/exit block (find the closing summary, e.g. `console.log(...failures...)` / `process.exit(failures ? 1 : 0)`), insert above it:

```js
// ── splitLine: delimiter auto-detection ──────────────────────────────────────
const { splitLine, splitCsvLine, splitTickerMarket, inferMarket } = PBImport;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ok('splitLine tab-delimited', eq(splitLine('AAPL\t10\t150'), ['AAPL', '10', '150']));
ok('splitLine markdown row', eq(splitLine('| AAPL | 10 | 150 |'), ['AAPL', '10', '150']));
ok('splitLine semicolon beats comma', eq(splitLine('a;b,c;d'), ['a', 'b,c', 'd']));
ok('splitLine 2+ spaces (fixed width)', eq(splitLine('AAPL    10    150'), ['AAPL', '10', '150']));
ok('splitLine single-space WITH number → columns', eq(splitLine('AAPL 10 150'), ['AAPL', '10', '150']));
ok('splitLine words only stay one cell', eq(splitLine('Anglo American'), ['Anglo American']));

// ── splitCsvLine: quoted fields ──────────────────────────────────────────────
ok('splitCsvLine respects quoted delimiter', eq(splitCsvLine('"Berkshire, Inc.",BRK-B,10', ','), ['Berkshire, Inc.', 'BRK-B', '10']));
ok('splitCsvLine escaped double-quote', eq(splitCsvLine('"a""b",c', ','), ['a"b', 'c']));

// ── splitTickerMarket: suffix → market ───────────────────────────────────────
ok('splitTickerMarket AGL.JO → JSE', eq(splitTickerMarket('AGL.JO'), { ticker: 'AGL', market: 'JSE' }));
ok('splitTickerMarket BHP:AX → ASX', eq(splitTickerMarket('BHP:AX'), { ticker: 'BHP', market: 'ASX' }));
ok('splitTickerMarket SAP.DE → FRA', eq(splitTickerMarket('SAP.DE'), { ticker: 'SAP', market: 'FRA' }));
ok('splitTickerMarket bare AAPL → null market', splitTickerMarket('AAPL').market === null && splitTickerMarket('AAPL').ticker === 'AAPL');

// ── inferMarket: suffix > market-text > currency > US fallback ────────────────
ok('inferMarket suffix wins', inferMarket('USD', 'NASDAQ', 'JSE') === 'JSE');
ok('inferMarket market-text NASDAQ → US', inferMarket(null, 'NASDAQ', null) === 'US');
ok('inferMarket market-text Johannesburg → JSE', inferMarket(null, 'Johannesburg', null) === 'JSE');
ok('inferMarket currency ZAR → JSE', inferMarket('ZAR', null, null) === 'JSE');
ok('inferMarket currency GBX → LSE', inferMarket('GBX', null, null) === 'LSE');
ok('inferMarket unrecognised → US fallback', inferMarket('', 'Zorg', null) === 'US');
```

- [ ] **Step 2: Run the test to verify the new assertions pass**

Run: `cd backend/test && node import-matching.test.mjs`
Expected: all `  ok  …`, 0 failures. If any fails, the assertion's expected value is wrong (read the actual `splitLine`/`inferMarket` body in `pb-import.js` and correct the expectation — do NOT change the module).

- [ ] **Step 3: Commit (review checkpoint — Jan commits)**

```bash
git add backend/test/import-matching.test.mjs
git commit -m "test(import): pin splitLine/splitCsvLine/splitTickerMarket/inferMarket in pb-import suite"
```

---

## Task 3: Rewire `app.js` (remove moved defs, add binds + configure) and add anti-drift guards

Surgically remove the three moved chunks from `app.js` (scripted, to preserve unchanged bytes) and insert the bind block + `configure` call where M1 was. Then guard against drift.

**Files:**
- Modify: `app.js`
- Modify: `backend/test/import-matching.test.mjs`
- One-off (scratchpad, not committed): `scratchpad/rewire-app.mjs`

**Interfaces:**
- Consumes: `PBImport.*` (Task 1), the app.js-resident `ALL_TICKERS` (built from `DATA`, unchanged).
- Produces: `app.js` with `const parseYahooSymbol = PBImport.parseYahooSymbol;` (and 8 more binds) + `PBImport.configure({ allTickers: ALL_TICKERS });`, and no local definitions of the moved fns.

- [ ] **Step 1: Write the rewire script** (scratchpad) — cuts the same three marker-bounded chunks and inserts the bind block at the M1 site.

```js
// scratchpad/rewire-app.mjs   (run once; not committed)
import { readFileSync, writeFileSync } from 'node:fs';
const ROOT = 'c:/Users/Jan/Documents/Playbook app/Playbook';
let src = readFileSync(ROOT + '/app.js', 'utf8');

const BINDS =
`// Import symbol/name matching + CSV parsing now live in pb-import.js (client-only
// pure helpers). Bound here so app.js call sites are unchanged; the DATA-derived
// ticker universe is injected since the module can't reach app.js/data.js globals.
PBImport.configure({ allTickers: ALL_TICKERS });
const parseYahooSymbol     = PBImport.parseYahooSymbol;
const normaliseCompanyName = PBImport.normaliseCompanyName;
const companyNameScore     = PBImport.companyNameScore;
const looksLikeTickerToken = PBImport.looksLikeTickerToken;
const rankImportCandidates = PBImport.rankImportCandidates;
const splitTickerMarket    = PBImport.splitTickerMarket;
const inferMarket          = PBImport.inferMarket;
const splitLine            = PBImport.splitLine;
const IMPORT_SYNONYMS      = PBImport.IMPORT_SYNONYMS;

`;

function cut(startMarker, nextStaysMarker, replacement) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(nextStaysMarker, s);
  if (s < 0 || e < 0) throw new Error('marker not found: ' + startMarker);
  src = src.slice(0, s) + (replacement || '') + src.slice(e);
}
// Remove the parser + matching chunks (empty), then remove M1 and drop the binds in its place.
cut('// Header-name synonyms', 'function looksLikeHeader', '');
cut('// ── Fuzzy company-name matching', '// Search live listings using several', '');
cut('// Yahoo exchange-suffix', 'async function fetchYahooSearch', BINDS);
writeFileSync(ROOT + '/app.js', src);
console.log('app.js rewired:', src.split('\n').length, 'lines');
```

- [ ] **Step 2: Run the rewire script and node --check**

Run: `node "<scratchpad>/rewire-app.mjs"` then `node --check app.js`
Expected: prints `app.js rewired: ~12866 lines`; `node --check app.js` clean (exit 0). A `SyntaxError` here means a marker cut mid-statement — re-inspect boundaries, do not hand-patch.

- [ ] **Step 3: Verify no moved definition remains and the binds are present** (grep sanity)

Run:
```bash
grep -nE "^(function|const) (parseYahooSymbol|rankImportCandidates|splitLine|inferMarket|normaliseCompanyName|diceSimilarity|companyNameScore|bestNameScore|splitCsvLine|splitTickerMarket|looksLikeTickerToken)\b|^const (YAHOO_EXCHANGE_MAP|IMPORT_SYNONYMS|CURRENCY_TO_MARKET|SUFFIX_TO_MARKET) =" app.js
grep -c "PBImport\." app.js
```
Expected: first grep prints **nothing** (no local defs left). Second prints **10** (9 binds + the `configure` call).

- [ ] **Step 4: Add anti-drift source guards to the test.** Append to `import-matching.test.mjs` (before the failures/exit block):

```js
// ── Anti-drift: the pure import core lives in pb-import.js, not app.js ────────
import { readFileSync as _rf } from 'node:fs';
import { fileURLToPath as _fu } from 'node:url';
import { dirname as _dn, join as _jn } from 'node:path';
const _appSrc = _rf(_jn(_dn(_fu(import.meta.url)), '..', '..', 'app.js'), 'utf8');
ok('app.js no longer defines rankImportCandidates', !/\bfunction rankImportCandidates\b/.test(_appSrc));
ok('app.js no longer defines parseYahooSymbol',    !/\bfunction parseYahooSymbol\b/.test(_appSrc));
ok('app.js no longer defines splitLine',           !/\bfunction splitLine\b/.test(_appSrc));
ok('app.js no longer defines inferMarket',         !/\bfunction inferMarket\b/.test(_appSrc));
ok('app.js binds rankImportCandidates from PBImport', /const rankImportCandidates = PBImport\.rankImportCandidates/.test(_appSrc));
ok('app.js injects the ticker universe',           /PBImport\.configure\(\{ allTickers: ALL_TICKERS \}\)/.test(_appSrc));
```

- [ ] **Step 5: Run the full node suite (money gate + all suites)**

Run (from repo root):
```bash
for f in backend/test/*.test.mjs; do echo "== $f =="; node "$f" || echo "FAILED: $f"; done
```
Expected: all 19 suites report 0 failures; no `FAILED:` line. Money gate (`money-math`, `cost-basis`, `import-matching`, `ee-ocr-parse`) unaffected.

- [ ] **Step 6: Commit (review checkpoint — Jan commits)**

```bash
git add app.js backend/test/import-matching.test.mjs
git commit -m "refactor(import): app.js binds pb-import.js exports + injects ALL_TICKERS; anti-drift guards"
```

---

## Task 4: Wire the deploy/runtime surface and run the browser smoke

`pb-import.js` must load in the browser before `app.js` and ship on the live site, and every app-mounting harness must load it or the app won't mount.

**Files:**
- Modify: `index.html`, `sw.js`, `.github/workflows/static.yml`, and the 17 `verify-*.mjs` harness shells.

**Interfaces:**
- Consumes: `pb-import.js` (Task 1).
- Produces: `window.PBImport` available before `app.js` in the browser and in every harness.

- [ ] **Step 1: index.html — add the script tag after pb-content.js.** Edit `index.html` line 77 area:

```html
<script src="./pb-content.js"></script>
<script src="./pb-import.js"></script>
<script src="./data.js"></script>
```

- [ ] **Step 2: sw.js — bump cache + precache the module.** In `sw.js`:
  - Line 2: `const CACHE_NAME   = 'playbook-shell-v47';` → `'playbook-shell-v48';`
  - After the `'./pb-content.js',` entry in `SHELL_ASSETS` (line ~12): add `  './pb-import.js',`

- [ ] **Step 3: static.yml — add to deploy allowlist (both places).** In `.github/workflows/static.yml`:
  - Line 44 `cp` list: insert `pb-import.js` after `pb-content.js`.
  - Line 50 Guard-1 `for f in …` loop list: insert `pb-import.js` after `pb-content.js`.

- [ ] **Step 4: Add the tag to all 17 harness shells.** Each harness that injects `pb-content.js` builds an HTML shell with the module `<script>`s. Add `pb-import.js` after the `pb-content.js` line in each. Run this scripted edit (scratchpad, not committed):

```js
// scratchpad/wire-harnesses.mjs   (run once; not committed)
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const ROOT = 'c:/Users/Jan/Documents/Playbook app/Playbook';
const files = execSync('grep -rl "pb-content.js" --include=*.mjs .', { cwd: ROOT }).toString().trim().split('\n');
let changed = 0;
for (const rel of files) {
  const p = ROOT + '/' + rel.replace(/^\.\//, '');
  let s = readFileSync(p, 'utf8');
  if (s.includes('pb-import.js')) continue;              // idempotent
  // Insert an import tag immediately after each pb-content.js script tag, matching its exact form/quotes/path.
  const next = s.replace(/(<script src=(['"])[^'"]*pb-content\.js\2><\/script>)/g,
                         (m, tag, q) => tag + '\n' + tag.replace('pb-content.js', 'pb-import.js'));
  if (next !== s) { writeFileSync(p, next); changed++; }
}
console.log('harnesses updated:', changed);
```

Run: `node "<scratchpad>/wire-harnesses.mjs"`
Expected: `harnesses updated: 17`. If a harness uses a different tag form the regex misses, edit it by hand to add the same `pb-import.js` tag after its `pb-content.js` tag.

- [ ] **Step 5: Verify every harness got it**

Run: `grep -rL "pb-import.js" $(grep -rl "pb-content.js" --include=*.mjs .)`
Expected: **no output** (every pb-content.js harness now also references pb-import.js).

- [ ] **Step 6: Run the browser mount smoke**

Run: `node verify-refresh-behavior.mjs` (from repo root; needs local static server per its usual harness — follow the same invocation used for prior increments).
Expected: `ALL PASSED` — app mounts with no `PBImport is not defined` ReferenceError; "holdings rows have NO session badge" guard still holds; baseline-equivalent to `origin/main`. (If it can't reach live data, the offline nulls are known flake — the mount + assertion checks are the gate.)

- [ ] **Step 7: Optional end-to-end import check** (one-off, not committed) — if a headless import harness is feasible, open the Import modal, paste `AGL.JO,10,150` / a small CSV, confirm a row resolves (ticker AGL, market JSE). Otherwise the `import-matching` suite + mount smoke are sufficient.

- [ ] **Step 8: Commit (review checkpoint — Jan commits)**

```bash
git add index.html sw.js .github/workflows/static.yml verify-*.mjs *.mjs
git commit -m "chore(import): wire pb-import.js into index.html, sw v48, deploy allowlist, verify harnesses"
```

---

## Self-Review

**Spec coverage:**
- New `pb-import.js` dual-mode module, pb-core dep, `configure` injection → Task 1 ✓
- 15 items moved; `rankImportCandidates` reads `cfg.allTickers` → Task 1 (extraction + `.replace`) ✓
- `INSTRUMENT_ALIASES`/`ALL_TICKERS` stay; 9 binds + `configure` in app.js → Task 3 ✓
- Test upgraded to real import, existing assertions unchanged → Task 1 ✓
- New parser coverage (splitLine/splitCsvLine/splitTickerMarket/inferMarket) → Task 2 ✓
- Anti-drift guards → Task 3 ✓
- Wiring: index.html, sw v48, static.yml, 17 harnesses → Task 4 ✓
- Verification: node --check, full suite, browser mount smoke → Tasks 1–4 ✓
- Untouched pb-core/content/store/data/worker → no task modifies them ✓

**Placeholder scan:** No TBD/TODO; the only "…" are inside the design's abstract signatures, not execution steps; all scripts are complete and runnable.

**Type consistency:** `configure({allTickers})` / `cfg.allTickers` used identically in module + test + app.js binds. Bind names match the 9 call-site identifiers verified in the spec. `PBImport.*` member names match the `api = {…}` export list.

**One residual risk flagged for the executor:** the converted test now uses the *real* `pb-core` `MARKET_CURRENCY` (not the old stub). Step 1.5 says to confirm the ranking assertions stay green and investigate rather than edit assertions if not.
