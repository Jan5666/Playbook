# Phase 4 increment 6 — markets/currencies content → PBContent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `MARKETS`, `DISPLAY_CURRENCIES`, and `CURRENCY_SYMBOLS` verbatim out of `app.js` into the existing `pb-content.js` content module, binding them back in `app.js` via `const X = PBContent.X` — finishing the Phase-4 pure-content extraction sweep.

**Architecture:** Same mechanism as inc 3 (sector tables). `pb-content.js` is a client-only dual-mode global (`window.PBContent` + CommonJS) already loaded everywhere. The three pure-data consts are copied **byte-verbatim** from `app.js` into `pb-content.js` + its export object; the three inline definitions in `app.js` are replaced with binds at their original positions. `sameUnderlyingExchange` (a function, not content) stays in `app.js`. Behavior-preserving; no consumer call site changes (same local names).

**Tech Stack:** Vanilla ES (no build step), React 18 via global (unaffected), `node:test` for unit tests, headless-Chrome verify harness for the mount smoke.

## Global Constraints

- **Byte-verbatim move via a slice script — never hand-retype the consts.** In `app.js` the symbols `·`, `£`, `€` are authored as ASCII `\uXXXX` escapes (`·`, `£`, `€`). The editing/parameter layer silently turns a typed `£` into the `£` glyph, which would corrupt the source and break `old_string` matches. So the move is done with a small Node script that copies the exact source substrings (Tasks 1 & 2 below). **All hand-written code in this plan is pure ASCII.**
- **Local names unchanged.** After the move, `app.js` still exposes `MARKETS`, `DISPLAY_CURRENCIES`, `CURRENCY_SYMBOLS` as `const` bindings, so all ~27 call sites are untouched.
- **Do not derive** `CURRENCY_SYMBOLS` from `DISPLAY_CURRENCIES` — move it as-is.
- **`pb-content.js` load order is fixed** (index.html loads it before app.js since inc 1). No `index.html`, `static.yml`, or `verify-*.mjs` harness edits — those already include pb-content.js.
- **sw cache bump required:** `CACHE_NAME` `playbook-shell-v49` → `playbook-shell-v50` in `sw.js`.
- **CRLF:** both `app.js` and `pb-content.js` use `\r\n`. The slice scripts are CRLF-aware (`\r?\n` in patterns; reuse the file's own EOL when inserting).
- **No impact** to pb-core / pb-data / pb-store / pb-import / data.js / backend worker. No wrangler deploy.
- **Commits (subagent-driven run):** Each task's implementer commits its own changes locally on this branch — standard SDD per-task commits, as in inc-4/inc-5. Nothing is pushed. Jan does the final PR / merge to main; he does not run the per-task commits.

**Test runner reference:** no npm script — run each suite with `node backend/test/<name>.test.mjs`. Run the whole suite (currently 19 files) from the repo root:
```bash
for f in backend/test/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "ok  $f" || echo "FAIL $f"; done
```

**Reference — the three consts as they currently read in `app.js`** (for understanding only; the scripts copy them verbatim, do not retype):
```js
const MARKETS = [
  { value: 'US',   label: 'US',   country: 'USA',          exchange: 'NYSE / NASDAQ' },
  { value: 'JSE',  label: 'JSE',  country: 'South Africa',  exchange: 'JSE' },
  { value: 'TFSA', label: 'TFSA', country: 'South Africa',  exchange: 'JSE (Tax-Free)' },
  { value: 'LSE', label: 'LSE', country: 'UK',          exchange: 'London (LSE)' },
  { value: 'ASX', label: 'ASX', country: 'Australia',   exchange: 'ASX' },
  { value: 'FRA', label: 'FRA', country: 'Germany',     exchange: 'XETRA Frankfurt' },
  { value: 'PAR', label: 'PAR', country: 'France',      exchange: 'Euronext Paris' },
  { value: 'AMS', label: 'AMS', country: 'Netherlands', exchange: 'Euronext Amsterdam' },
  { value: 'CRYPTO', label: 'Crypto', country: 'Crypto', exchange: 'Spot <MIDDOT> 24/7' },
];
const DISPLAY_CURRENCIES = [
  { code: 'USD', sym: '$',  label: 'US Dollar' },
  { code: 'ZAR', sym: 'R',  label: 'South African Rand' },
  { code: 'GBP', sym: '<POUND>', label: 'British Pound' },
  { code: 'AUD', sym: 'A$', label: 'Australian Dollar' },
  { code: 'EUR', sym: '<EURO>', label: 'Euro' },
];
const CURRENCY_SYMBOLS = { USD: '$', ZAR: 'R', GBP: '<POUND>', AUD: 'A$', EUR: '<EURO>' };
```
(`<MIDDOT>`=`·`, `<POUND>`=`£`, `<EURO>`=`€` in the real source. Placeholders shown here only so this doc stays ASCII.)

---

### Task 1: Copy the three consts verbatim into pb-content.js

**Files:**
- Modify: `pb-content.js` (insert 3 consts before the `return {…}`; extend that return)
- Create (throwaway): `scratchpad/inc6-to-content.mjs` (run once; not committed)
- Test: `backend/test/content.test.mjs` (add 3 shape tests)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PBContent.MARKETS` (`Array<{value,label,country,exchange:string}>`), `PBContent.DISPLAY_CURRENCIES` (`Array<{code,sym,label:string}>`), `PBContent.CURRENCY_SYMBOLS` (`Record<string,string>`). Task 2 relies on these three names existing on the PBContent export.

- [ ] **Step 1: Write the failing shape tests**

Insert into `backend/test/content.test.mjs` immediately after the `SECTOR_FWD_PE` test (before the `// ── Anti-drift source guards` comment). All ASCII — the symbol checks use codepoints, not glyphs:

```js
test('PBContent.MARKETS is a list of {value,label,country,exchange}', () => {
  assert.ok(Array.isArray(PBContent.MARKETS), 'MARKETS is an array');
  assert.ok(PBContent.MARKETS.length > 0, 'MARKETS non-empty');
  const values = PBContent.MARKETS.map(m => m.value);
  assert.strictEqual(new Set(values).size, values.length, 'market values are unique');
  for (const need of ['US', 'JSE', 'TFSA', 'CRYPTO']) {
    assert.ok(values.includes(need), `MARKETS includes ${need}`);
  }
  for (const m of PBContent.MARKETS) {
    for (const f of ['value', 'label', 'country', 'exchange']) {
      assert.ok(typeof m[f] === 'string' && m[f].length, `market ${m.value} has non-empty ${f}`);
    }
  }
});

test('PBContent.DISPLAY_CURRENCIES is a list of {code,sym,label} with intact symbols', () => {
  assert.ok(Array.isArray(PBContent.DISPLAY_CURRENCIES), 'DISPLAY_CURRENCIES is an array');
  const codes = PBContent.DISPLAY_CURRENCIES.map(c => c.code);
  assert.strictEqual(new Set(codes).size, codes.length, 'currency codes are unique');
  for (const need of ['USD', 'ZAR', 'GBP', 'AUD', 'EUR']) {
    assert.ok(codes.includes(need), `DISPLAY_CURRENCIES includes ${need}`);
  }
  for (const c of PBContent.DISPLAY_CURRENCIES) {
    for (const f of ['code', 'sym', 'label']) {
      assert.ok(typeof c[f] === 'string' && c[f].length, `${c.code} has non-empty ${f}`);
    }
  }
  const byCode = Object.fromEntries(PBContent.DISPLAY_CURRENCIES.map(c => [c.code, c.sym]));
  assert.strictEqual(byCode.GBP.length, 1, 'GBP symbol is a single codepoint');
  assert.strictEqual(byCode.GBP.codePointAt(0), 0x00a3, 'GBP symbol is U+00A3 (pound), not mangled');
  assert.strictEqual(byCode.EUR.codePointAt(0), 0x20ac, 'EUR symbol is U+20AC (euro), not mangled');
});

test('PBContent.CURRENCY_SYMBOLS agrees with DISPLAY_CURRENCIES', () => {
  assert.ok(PBContent.CURRENCY_SYMBOLS && typeof PBContent.CURRENCY_SYMBOLS === 'object', 'CURRENCY_SYMBOLS is an object');
  const byCode = Object.fromEntries(PBContent.DISPLAY_CURRENCIES.map(c => [c.code, c.sym]));
  assert.deepStrictEqual(
    new Set(Object.keys(PBContent.CURRENCY_SYMBOLS)),
    new Set(Object.keys(byCode)),
    'CURRENCY_SYMBOLS keys === DISPLAY_CURRENCIES codes');
  for (const [code, sym] of Object.entries(PBContent.CURRENCY_SYMBOLS)) {
    assert.strictEqual(sym, byCode[code], `CURRENCY_SYMBOLS.${code} matches the DISPLAY_CURRENCIES sym`);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node backend/test/content.test.mjs`
Expected: FAIL — the three new tests error because `PBContent.MARKETS` / `.DISPLAY_CURRENCIES` / `.CURRENCY_SYMBOLS` are `undefined`. Pre-existing tests still pass.

- [ ] **Step 3: Write the copy script and run it once**

Create `scratchpad/inc6-to-content.mjs` (run from repo root):

```js
import { readFileSync, writeFileSync } from 'node:fs';

const app = readFileSync('app.js', 'utf8');
const content = readFileSync('pb-content.js', 'utf8');

// Grab each const byte-verbatim from app.js by ASCII anchors (CRLF-aware).
function grab(re, label) {
  const m = app.match(re);
  if (!m) throw new Error('block not found: ' + label);
  return m[0];
}
const markets    = grab(/const MARKETS = \[[\s\S]*?\r?\n\];/, 'MARKETS');
const displayCcy = grab(/const DISPLAY_CURRENCIES = \[[\s\S]*?\r?\n\];/, 'DISPLAY_CURRENCIES');
const currencySy = grab(/const CURRENCY_SYMBOLS = \{[^\n]*\};/, 'CURRENCY_SYMBOLS');

const eol = content.includes('\r\n') ? '\r\n' : '\n';
const header = '// UI config: markets & display currencies (client-only, pure data)';
const insert = [header, markets, displayCcy, currencySy, ''].join(eol);

// Insert immediately before the final "return {" line of the factory.
const marker = eol + 'return {';
const idx = content.lastIndexOf(marker);
if (idx < 0) throw new Error('return marker not found in pb-content.js');
let out = content.slice(0, idx) + eol + insert + content.slice(idx);

// Extend the export object.
if (!out.includes('SECTOR_FWD_PE };')) throw new Error('export line not found');
out = out.replace('SECTOR_FWD_PE };',
  'SECTOR_FWD_PE, MARKETS, DISPLAY_CURRENCIES, CURRENCY_SYMBOLS };');

writeFileSync('pb-content.js', out);
console.log('OK — MARKETS', markets.length, 'chars; DISPLAY', displayCcy.length, '; CURRENCY_SYMBOLS', currencySy.length);
```

Run: `node scratchpad/inc6-to-content.mjs`
Expected: prints `OK — MARKETS <n> chars; …` with all three lengths > 0.

- [ ] **Step 4: Run the tests + syntax check to verify pass**

Run: `node backend/test/content.test.mjs`
Expected: PASS — all tests green (pre-existing + 3 new; the codepoint checks confirm `£`/`€` survived verbatim).
Run: `node --check pb-content.js`
Expected: no output (syntax OK).

Also confirm app.js is unchanged so far (the copy script only wrote pb-content.js):
Run: `node -e "const c=require('./pb-content.js'); if(!(c.MARKETS&&c.DISPLAY_CURRENCIES&&c.CURRENCY_SYMBOLS)) throw new Error('missing export'); console.log('exports ok')"`
Expected: `exports ok`.

- [ ] **Step 5: Commit** *(implementer commits locally on this branch)*

```bash
git add pb-content.js backend/test/content.test.mjs
git commit -m "Copy MARKETS/DISPLAY_CURRENCIES/CURRENCY_SYMBOLS content into pb-content.js"
```

---

### Task 2: Replace the app.js definitions with PBContent binds

**Files:**
- Modify: `app.js` (3 const definitions → 3 one-line binds)
- Create (throwaway): `scratchpad/inc6-rebind.mjs` (run once; not committed)
- Test: `backend/test/content.test.mjs` (extend the two existing anti-drift guard tests)

**Interfaces:**
- Consumes: `PBContent.MARKETS`, `PBContent.DISPLAY_CURRENCIES`, `PBContent.CURRENCY_SYMBOLS` (from Task 1).
- Produces: `app.js` now defines those names only as `const X = PBContent.X;` binds — all downstream call sites unchanged.

- [ ] **Step 1: Extend the anti-drift guard tests (failing)**

In `backend/test/content.test.mjs`, add to the existing test `app.js no longer defines the content blocks inline` (inside its body, after the `SECTOR_FWD_PE` assertion):

```js
  assert.ok(!appSrc.includes('const MARKETS = ['), 'MARKETS not inline');
  assert.ok(!appSrc.includes('const DISPLAY_CURRENCIES = ['), 'DISPLAY_CURRENCIES not inline');
  assert.ok(!appSrc.includes('const CURRENCY_SYMBOLS = {'), 'CURRENCY_SYMBOLS not inline');
```

And add to the existing test `app.js delegates the content blocks to PBContent` (after the `SECTOR_FWD_PE` bind assertion):

```js
  assert.ok(appSrc.includes('const MARKETS = PBContent.MARKETS'), 'binds MARKETS');
  assert.ok(appSrc.includes('const DISPLAY_CURRENCIES = PBContent.DISPLAY_CURRENCIES'), 'binds DISPLAY_CURRENCIES');
  assert.ok(appSrc.includes('const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS'), 'binds CURRENCY_SYMBOLS');
```

- [ ] **Step 2: Run to verify failure**

Run: `node backend/test/content.test.mjs`
Expected: FAIL — `MARKETS not inline` fails (app.js still defines the array) and `binds MARKETS` fails (no bind yet). The Task-1 shape tests still pass.

- [ ] **Step 3: Write the rebind script and run it once**

Create `scratchpad/inc6-rebind.mjs` (from repo root). It removes each const from `app.js` and drops in the bind, then hard-fails if any inline definition survives:

```js
import { readFileSync, writeFileSync } from 'node:fs';

let app = readFileSync('app.js', 'utf8');
const before = app.length;

app = app.replace(/const MARKETS = \[[\s\S]*?\r?\n\];/, 'const MARKETS = PBContent.MARKETS;');
app = app.replace(/const DISPLAY_CURRENCIES = \[[\s\S]*?\r?\n\];/, 'const DISPLAY_CURRENCIES = PBContent.DISPLAY_CURRENCIES;');
app = app.replace(/const CURRENCY_SYMBOLS = \{[^\n]*\};/, 'const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS;');

if (app.includes('const MARKETS = [')) throw new Error('MARKETS not replaced');
if (app.includes('const DISPLAY_CURRENCIES = [')) throw new Error('DISPLAY_CURRENCIES not replaced');
if (/const CURRENCY_SYMBOLS = \{/.test(app)) throw new Error('CURRENCY_SYMBOLS not replaced');
if (!app.includes('const MARKETS = PBContent.MARKETS;')) throw new Error('MARKETS bind missing');
if (!app.includes('const DISPLAY_CURRENCIES = PBContent.DISPLAY_CURRENCIES;')) throw new Error('DISPLAY bind missing');
if (!app.includes('const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS;')) throw new Error('CURRENCY_SYMBOLS bind missing');
if (!app.includes('function sameUnderlyingExchange(')) throw new Error('sameUnderlyingExchange was disturbed');

writeFileSync('app.js', app);
console.log('OK — app.js shrank by', before - app.length, 'chars');
```

Run: `node scratchpad/inc6-rebind.mjs`
Expected: prints `OK — app.js shrank by <n> chars` (n roughly 500–700). Any thrown error means an anchor didn't match — stop and inspect.

- [ ] **Step 4: Run tests + syntax check to verify pass**

Run: `node backend/test/content.test.mjs`
Expected: PASS — shape tests + both anti-drift guards green.
Run: `node --check app.js`
Expected: no output (syntax OK).

- [ ] **Step 5: Commit** *(implementer commits locally on this branch)*

```bash
git add app.js backend/test/content.test.mjs
git commit -m "Bind MARKETS/DISPLAY_CURRENCIES/CURRENCY_SYMBOLS from PBContent in app.js"
```

---

### Task 3: sw cache bump + full verification gate

**Files:**
- Modify: `sw.js:2` (`CACHE_NAME`)

**Interfaces:**
- Consumes: the completed Task 1 + Task 2 changes.
- Produces: bumped shell cache so returning PWAs pick up the changed app.js/pb-content.js. Final deliverable — whole increment verified green.

- [ ] **Step 1: Bump the service-worker cache version**

Edit `sw.js` line 2:

`old_string`:
```js
const CACHE_NAME   = 'playbook-shell-v49';
```
`new_string`:
```js
const CACHE_NAME   = 'playbook-shell-v50';
```

- [ ] **Step 2: Run the full node suite (money gate included)**

Run:
```bash
for f in backend/test/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "ok  $f" || echo "FAIL $f"; done
```
Expected: every line starts `ok ` — **no `FAIL` line**. (money-math, cost-basis, import-matching, ee-ocr-parse unchanged and green; content.test.mjs green with the new assertions.) 19 suite files total.

- [ ] **Step 3: Syntax-check both changed source files**

Run: `node --check app.js && node --check pb-content.js && echo "syntax ok"`
Expected: `syntax ok`.

- [ ] **Step 4: Browser mount smoke test**

Run the headless-Chrome mount harness (the canonical app-mount check used by prior increments):
```bash
node verify-refresh-behavior.mjs
```
Expected: **ALL PASSED** — app mounts with pb-content.js loaded first; no `PBContent` / `MARKETS` / `DISPLAY_CURRENCIES` / `CURRENCY_SYMBOLS` ReferenceError; the "holdings rows have NO SessionBadge" standing guard still holds.

> A pre-existing flaky CDP "Execution context destroyed" race can require one rerun — that is environmental, not this change.

- [ ] **Step 5: Clean up throwaway scripts + commit** *(Jan runs — do not auto-commit)*

```bash
rm -f scratchpad/inc6-to-content.mjs scratchpad/inc6-rebind.mjs
git add sw.js
git commit -m "Bump service worker cache to v50 for markets/currencies content move"
```

---

## Self-Review

**1. Spec coverage:**
- Move MARKETS/DISPLAY_CURRENCIES/CURRENCY_SYMBOLS verbatim → Task 1 (copy into pb-content) + Task 2 (rebind app.js). ✓
- `sameUnderlyingExchange` stays → Task 2 rebind script edits only the three const definitions and asserts `sameUnderlyingExchange(` still present. ✓
- Verbatim (not derived) CURRENCY_SYMBOLS → copied by regex slice, never retyped; Global Constraints. ✓
- Tests: MARKETS/DISPLAY/CURRENCY_SYMBOLS shape + symbol-codepoint intact + anti-drift guards → Task 1 Step 1 + Task 2 Step 1. ✓
- Wiring: only sw v49→v50; no index.html/static.yml/harness → Task 3 Step 1 + Global Constraints. ✓
- No worker/pb-core/pb-data/pb-store/pb-import/data.js change → not touched by any task. ✓
- Verification gate: 19 suites + node --check + verify-refresh-behavior → Task 3 Steps 2–4. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step shows exact code or an exact runnable script. The one non-ASCII display (the reference const block) is explicitly marked reference-only with `<MIDDOT>`/`<POUND>`/`<EURO>` placeholders so the doc stays ASCII and nothing is retyped from it. ✓

**3. Type consistency:** `PBContent.MARKETS` / `.DISPLAY_CURRENCIES` / `.CURRENCY_SYMBOLS` are the only cross-task names — produced in Task 1, consumed in Task 2 with identical spelling. The bind strings written by the Task-2 script (`const MARKETS = PBContent.MARKETS;` etc.) match the anti-drift assertions in Task 2 Step 1 exactly. ✓
