# Phase 4 increment 1 — content → `pb-content.js` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the static playbook/indicator content (`RIBBON_CATALOG`, `RIBBON_CATALOG_MAP`, `INDICATOR_INFO`, `BUILTIN_MACRO_2026`) out of `app.js` into a new dual-mode global script `pb-content.js`, with zero behavior change.

**Architecture:** A new `pb-content.js` (`window.PBContent` + CommonJS) holds the four blocks verbatim; `app.js` binds `const X = PBContent.X` at each definition site (the same idiom already used for pb-core/pb-data values). Wire the new file into the three no-build touch points (index.html, sw.js precache, deploy allowlist) and the browser-smoke harness shells.

**Tech Stack:** Vanilla ES + `React.createElement` (no JSX, no build step); Node's built-in `node:test` runner; service-worker precache + GitHub Pages static deploy.

## Global Constraints

- **No build step.** `pb-content.js` is a classic `<script>`, dual-mode (browser global `window.PBContent` + `module.exports`), exactly like `pb-core.js`/`pb-data.js`/`pb-store.js`.
- **Verbatim move.** The four content blocks are moved byte-identical (including their inline comments). No edits to their values — this guarantees zero behavior change.
- **Preserve every call site.** `app.js` keeps the same identifiers via `const X = PBContent.X`; the ~15 existing uses (incl. `PBData.configure({ indicatorCatalog: RIBBON_CATALOG_MAP })`) are untouched.
- **Load order:** `PBContent` must exist before `app.js` runs. `pb-content.js` loads after `pb-store.js`, before `app.js`.
- **No impact** on `pb-core.js` / `pb-data.js` / `pb-store.js` / `backend/worker.js` (verified: none reference these blocks).
- **CRLF:** `app.js` uses CRLF line endings; the Edit tool normalizes CRLF when matching, so `\n`-based `old_string` works. Anti-drift guards use substring search (not `$`-anchored regex).
- **Commits, PR, and merge are performed by Jan, not the implementer.** Build in the working tree only; do not run `git commit`/`git push`/`git merge`. Each task ends at a green verification, not a commit.
- **Test runner:** no npm script. Run one suite with `node backend/test/<name>.test.mjs`. Run the full sweep with the loop in Task 4.

---

### Task 1: Create `pb-content.js` and its shape tests

**Files:**
- Create: `pb-content.js` (repo root)
- Create/Test: `backend/test/content.test.mjs`
- Reference (source of the verbatim blocks): `app.js:470-509` (RIBBON_CATALOG + map), `app.js:511-552` (INDICATOR_INFO + its comment), `app.js` BUILTIN_MACRO_2026 comment + `app.js:1033-1072`

**Interfaces:**
- Produces: `require('../../pb-content.js')` → `{ RIBBON_CATALOG: Array, RIBBON_CATALOG_MAP: Object, INDICATOR_INFO: Object, BUILTIN_MACRO_2026: Array }`; browser global `window.PBContent` with the same four keys.

- [ ] **Step 1: Write the failing shape test**

Create `backend/test/content.test.mjs`:

```js
import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PBContent = require('../../pb-content.js');

test('PBContent exposes the four content blocks', () => {
  assert.ok(Array.isArray(PBContent.RIBBON_CATALOG), 'RIBBON_CATALOG is an array');
  assert.ok(PBContent.RIBBON_CATALOG.length > 0, 'RIBBON_CATALOG non-empty');
  assert.ok(PBContent.RIBBON_CATALOG_MAP && typeof PBContent.RIBBON_CATALOG_MAP === 'object', 'RIBBON_CATALOG_MAP is an object');
  assert.ok(PBContent.INDICATOR_INFO && typeof PBContent.INDICATOR_INFO === 'object', 'INDICATOR_INFO is an object');
  assert.ok(Array.isArray(PBContent.BUILTIN_MACRO_2026), 'BUILTIN_MACRO_2026 is an array');
});

test('RIBBON_CATALOG keys are unique and RIBBON_CATALOG_MAP is keyed by them', () => {
  const keys = PBContent.RIBBON_CATALOG.map(r => r.key);
  assert.ok(keys.every(k => typeof k === 'string' && k.length), 'every entry has a string key');
  assert.strictEqual(new Set(keys).size, keys.length, 'keys are unique');
  assert.deepStrictEqual(new Set(Object.keys(PBContent.RIBBON_CATALOG_MAP)), new Set(keys), 'map keys === catalog keys');
});

test('INDICATOR_INFO keys are a subset of RIBBON_CATALOG keys', () => {
  const catalog = new Set(PBContent.RIBBON_CATALOG.map(r => r.key));
  for (const k of Object.keys(PBContent.INDICATOR_INFO)) {
    assert.ok(catalog.has(k), `INDICATOR_INFO key ${k} exists in RIBBON_CATALOG`);
  }
});

test('BUILTIN_MACRO_2026 entries are well-formed', () => {
  assert.ok(PBContent.BUILTIN_MACRO_2026.length > 0, 'non-empty');
  for (const e of PBContent.BUILTIN_MACRO_2026) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, `date ${e.date} is YYYY-MM-DD`);
    assert.ok(typeof e.title === 'string' && e.title.length, 'has title');
    assert.ok(typeof e.type === 'string' && e.type.length, 'has type');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node backend/test/content.test.mjs`
Expected: FAIL — `Cannot find module '../../pb-content.js'`.

- [ ] **Step 3: Create `pb-content.js` with the four blocks moved verbatim**

Create `pb-content.js` at the repo root. Use the dual-mode wrapper below, then paste the **exact** current contents of the blocks from `app.js` (copy the arrays/objects and their inline comments byte-for-byte — do not retype or reformat):

```js
// Playbook static content — the indicator/index catalog, plain-English indicator
// explanations, and the built-in macro calendar. Pure data (no logic, no React,
// no DOM). Dual-mode: browser global `window.PBContent` + CommonJS for Node tests.
// Loaded before app.js; app.js binds each value via `const X = PBContent.X`.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PBContent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ── Indicator / index catalog ──────────────────────────────────────────────
  const RIBBON_CATALOG = [
    /* PASTE app.js lines 470-508 body here VERBATIM (the array elements + the
       "Macro & rates" inline comment block at old lines 487-491). */
  ];
  const RIBBON_CATALOG_MAP = Object.fromEntries(RIBBON_CATALOG.map(r => [r.key, r]));

  // Plain-English deep-dives shown on each indicator's card. Kept short and
  // jargon-light on purpose — the goal is to help a retail investor understand
  // what the number means and how to read it. Keyed by the catalog `key`.
  const INDICATOR_INFO = {
    /* PASTE app.js lines 514-551 body here VERBATIM. */
  };

  // Built-in 2026 central-bank calendar (Fed/BOJ/ECB/BOE/SARB). A stable
  // baseline. Dates are published a year ahead; refresh this list annually. When a
  // Perplexity key is set, live AI events are merged in and take precedence.
  const BUILTIN_MACRO_2026 = [
    /* PASTE app.js lines 1034-1071 body here VERBATIM. */
  ];

  return { RIBBON_CATALOG, RIBBON_CATALOG_MAP, INDICATOR_INFO, BUILTIN_MACRO_2026 };
});
```

Note: `RIBBON_CATALOG_MAP`'s derivation moves here (it is a pure function of `RIBBON_CATALOG`); `DEFAULT_RIBBON_ITEMS` (old app.js:510) does **not** move — it is a settings default, left in `app.js`.

- [ ] **Step 4: Verify the file parses and the tests pass**

Run: `node --check pb-content.js`
Expected: no output (clean).

Run: `node backend/test/content.test.mjs`
Expected: PASS (4 tests). If the `INDICATOR_INFO ⊆ RIBBON_CATALOG` test fails, a paste error dropped a catalog entry — recheck the verbatim copy.

---

### Task 2: Rewire `app.js` to bind from `PBContent` + anti-drift guards

**Files:**
- Modify: `app.js:470-509` (RIBBON_CATALOG + map → binds), `app.js:511-552` (INDICATOR_INFO comment + def → bind), `app.js` BUILTIN_MACRO_2026 comment + `app.js:1033-1072` (→ bind)
- Modify/Test: `backend/test/content.test.mjs` (append anti-drift source guards)

**Interfaces:**
- Consumes: `window.PBContent` (from Task 1). All existing `app.js` uses of the four identifiers stay valid because the identifiers still exist as `const` binds.

- [ ] **Step 1: Replace the `RIBBON_CATALOG` + `RIBBON_CATALOG_MAP` definitions with binds**

In `app.js`, replace the whole block from `const RIBBON_CATALOG = [` through the line `const RIBBON_CATALOG_MAP = Object.fromEntries(RIBBON_CATALOG.map(r => [r.key, r]));` (old lines 470-509, inclusive of the inline "Macro & rates" comment) with exactly:

```js
const RIBBON_CATALOG = PBContent.RIBBON_CATALOG;
const RIBBON_CATALOG_MAP = PBContent.RIBBON_CATALOG_MAP;
```

Leave the next line `const DEFAULT_RIBBON_ITEMS = ['US:^SPX', 'US:^VIX'];` in place.

- [ ] **Step 2: Replace the `INDICATOR_INFO` comment + definition with a bind**

In `app.js`, replace the block from the comment `// Plain-English deep-dives shown on each indicator's card.` (old line 511) through the closing `};` of `INDICATOR_INFO` (old line 552) with exactly:

```js
const INDICATOR_INFO = PBContent.INDICATOR_INFO;
```

- [ ] **Step 3: Replace the `BUILTIN_MACRO_2026` comment + definition with a bind**

In `app.js`, replace the leading explanatory comment block immediately above `const BUILTIN_MACRO_2026 = [` (the "Built-in 2026 central-bank calendar…/…take precedence." comment) plus the array through its closing `];` (old lines 1033-1072) with exactly:

```js
const BUILTIN_MACRO_2026 = PBContent.BUILTIN_MACRO_2026;
```

- [ ] **Step 4: Verify `app.js` still parses**

Run: `node --check app.js`
Expected: no output (clean). A `SyntaxError` means a replacement clipped a neighbouring statement — recheck the boundaries.

- [ ] **Step 5: Append anti-drift source guards to `content.test.mjs`**

Add to `backend/test/content.test.mjs`:

```js
import { readFileSync } from 'node:fs';
const appSrc = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');

test('app.js no longer defines the content blocks inline', () => {
  assert.ok(!appSrc.includes('const RIBBON_CATALOG = ['), 'RIBBON_CATALOG not inline');
  assert.ok(!appSrc.includes('const RIBBON_CATALOG_MAP = Object.fromEntries'), 'RIBBON_CATALOG_MAP not inline');
  assert.ok(!appSrc.includes('const INDICATOR_INFO = {'), 'INDICATOR_INFO not inline');
  assert.ok(!appSrc.includes('const BUILTIN_MACRO_2026 = ['), 'BUILTIN_MACRO_2026 not inline');
});

test('app.js delegates the content blocks to PBContent', () => {
  assert.ok(appSrc.includes('const RIBBON_CATALOG = PBContent.RIBBON_CATALOG'), 'binds RIBBON_CATALOG');
  assert.ok(appSrc.includes('const RIBBON_CATALOG_MAP = PBContent.RIBBON_CATALOG_MAP'), 'binds RIBBON_CATALOG_MAP');
  assert.ok(appSrc.includes('const INDICATOR_INFO = PBContent.INDICATOR_INFO'), 'binds INDICATOR_INFO');
  assert.ok(appSrc.includes('const BUILTIN_MACRO_2026 = PBContent.BUILTIN_MACRO_2026'), 'binds BUILTIN_MACRO_2026');
});
```

- [ ] **Step 6: Run the full content suite**

Run: `node backend/test/content.test.mjs`
Expected: PASS (6 tests). If "no longer defines … inline" fails, a definition was left in `app.js`; if "delegates …" fails, a bind is missing or misspelled.

---

### Task 3: Wire `pb-content.js` into index.html, service worker, deploy, and harness shells

**Files:**
- Modify: `index.html:76` (add script tag)
- Modify: `sw.js:2` (bump cache) and `sw.js` `SHELL_ASSETS` list (add asset)
- Modify: `.github/workflows/static.yml:44` (cp list) and `:50` (guard loop)
- Modify: every `backend/test/verify-*.mjs` whose inline shell loads `/app.js` (add `/pb-content.js` script tag)

**Interfaces:**
- Consumes: `pb-content.js` (Task 1). No code interface — this task is wiring only.

- [ ] **Step 1: Add the script tag to `index.html`**

After the `<script src="./pb-store.js"></script>` line (line 76) and before `<script src="./data.js"></script>` (line 77), insert:

```html
<script src="./pb-content.js"></script>
```

- [ ] **Step 2: Add the asset to the service-worker precache and bump the cache version**

In `sw.js`, change line 2 from:

```js
const CACHE_NAME   = 'playbook-shell-v44';
```

to:

```js
const CACHE_NAME   = 'playbook-shell-v45';
```

In `sw.js` `SHELL_ASSETS`, add `'./pb-content.js',` immediately after the `'./pb-store.js',` entry.

- [ ] **Step 3: Add the asset to the deploy allowlist and its guard**

In `.github/workflows/static.yml`, in the `cp … _site/` command (line 44) add `pb-content.js` to the file list (e.g. after `pb-store.js`). In the Guard-1 `for f in …` loop (line 50) add `pb-content.js` to the same position so a missing file fails the deploy.

- [ ] **Step 4: Enumerate the harnesses that mount app.js**

Run: `grep -l 'src="/app.js"' backend/test/verify-*.mjs`
Expected: a list of harness files (the ones whose inline `__verify.html` shell loads `/app.js`). These each already load `/pb-core.js`, `/pb-data.js`, `/pb-store.js`.

- [ ] **Step 5: Add `/pb-content.js` to each enumerated harness shell**

In each file from Step 4, in the inline HTML shell add the line

```html
<script src="/pb-content.js"></script>
```

immediately after the `<script src="/pb-store.js"></script>` line and before `<script src="/app.js"></script>`. Without this, the app throws `ReferenceError: PBContent is not defined` and never mounts under that harness.

- [ ] **Step 6: Verify the wiring with greps**

Run: `grep -n 'pb-content.js' index.html sw.js .github/workflows/static.yml`
Expected: index.html has the script tag; sw.js lists `'./pb-content.js'`; static.yml shows it in both the `cp` list and the guard loop.

Run: `grep -c 'playbook-shell-v45' sw.js`
Expected: `1`.

Run: `for f in $(grep -l 'src="/app.js"' backend/test/verify-*.mjs); do grep -q 'pb-content.js' "$f" || echo "MISSING: $f"; done`
Expected: no output (every app-mounting harness now loads pb-content.js).

---

### Task 4: Full verification (node suite + browser smokes)

**Files:** none modified — verification only.

- [ ] **Step 1: Run the whole node test suite**

Run:
```bash
for f in backend/test/*.test.mjs; do echo "== $f =="; node "$f" || echo "FAILED: $f"; done
```
Expected: every suite passes, including the new `content.test.mjs`. Suite count is now 19. No `FAILED:` lines.

- [ ] **Step 2: Money gate spot-check (should be unchanged)**

Run:
```bash
node backend/test/money-math.test.mjs && node backend/test/cost-basis.test.mjs && node backend/test/import-matching.test.mjs && node backend/test/ee-ocr-parse.test.mjs
```
Expected: all PASS (no formula changed — this is a content move).

- [ ] **Step 3: Browser smoke — app mounts (no PBContent ReferenceError)**

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: ALL PASSED (the app mounts; the "Today" P/L pill and refresh chip render). A `ReferenceError: PBContent is not defined` here means Step 5 of Task 3 missed this harness.

- [ ] **Step 4: Browser smoke — indicator cards render from the moved catalog/info**

Run: `node backend/test/verify-indicators.mjs`
Expected: indicator cards render (catalog labels + `INDICATOR_INFO` explanation card present). Note: some indicator checks depend on live macro data and may be flaky offline (pre-existing) — the render/mount assertions are the gate; a flaky live-data null is not a regression from this increment.

- [ ] **Step 5: Confirm the app.js shrink**

Run: `wc -l app.js`
Expected: ~118 fewer lines than the 13,303 baseline (≈ 13,185).

---

## Definition of done

- `pb-content.js` exists; the four blocks are gone from `app.js` (delegating binds remain).
- 19 node suites green; `node --check` clean on `pb-content.js` and `app.js`.
- Both browser smokes pass (app mounts; indicator cards render).
- index.html / sw.js (v45) / static.yml / verify-harness shells all wired.
- No change to pb-core.js / pb-data.js / pb-store.js / worker.js.
- **Left for Jan:** review + commit + PR/merge.

## Self-review notes

- **Spec coverage:** every spec scope item has a task — content move (T1), app.js binds + anti-drift (T2), no-build wiring + harness shells (T3), verification incl. money gate + browser smokes (T4). `RulesView`/logic-tables/config are spec non-goals → no task, correctly.
- **Type consistency:** the four exported names (`RIBBON_CATALOG`, `RIBBON_CATALOG_MAP`, `INDICATOR_INFO`, `BUILTIN_MACRO_2026`) are identical in T1 (produce), T2 (consume/bind), and the guards. `PBData.configure` still receives `RIBBON_CATALOG_MAP` (now the bound value) — unchanged.
- **Placeholder scan:** the only `/* PASTE … */` markers are deliberate verbatim-copy instructions with exact source line ranges, not vague TODOs.
