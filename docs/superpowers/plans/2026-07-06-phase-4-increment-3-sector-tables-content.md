# Phase 4 increment 3 — Sector reference tables → PBContent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the three pure sector reference tables (`SECTOR_ETF`, `SECTOR_TREND_WINDOWS`, `SECTOR_FWD_PE`) out of `app.js` into `pb-content.js`, binding the app to `PBContent.X` with byte-identical behavior.

**Architecture:** Exact mirror of Phase-4 inc 1/2. `pb-content.js` is a dual-mode classic script (`window.PBContent` + CommonJS) already loaded before `app.js` and precached since inc 1. The three tables move verbatim into it and are added to its `return {…}` export; `app.js` replaces each object-literal definition with `const SECTOR_X = PBContent.SECTOR_X;` at the old def site. The consumer functions (`fetchSectorTrend`, `sectorForwardPE`) and the mutable `SECTOR_TREND_CACHE` stay in `app.js`.

**Tech Stack:** Vanilla ES5-ish browser global scripts, no build step. Node's built-in `node:test` for tests (`.mjs`, run individually). Service worker cache-version bump for deploy.

## Global Constraints

- No build step — `pb-content.js` stays a dual-mode classic script; no new `<script>` tag (already wired since inc 1).
- Extraction is **verbatim** — the moved tables must be byte-identical to the current `app.js` definitions (all ASCII here; no `£`/`€`/`—`, so plain edits are safe).
- **No** change to: `index.html`, `.github/workflows/static.yml` allowlist, verify-`*.mjs` harness shells, `pb-core.js`, `pb-data.js`, `pb-store.js`, `backend/worker.js`, `data.js`.
- Behavior must stay byte-identical — consumer functions unchanged.
- **Commits/PR/merge are Jan's** (standing rule). Build everything in the working tree; do **not** commit. The final step hands off to Jan.
- **Branch base:** this increment stacks on inc-2 tip `a353d70` (branch `refactor/phase-4-increment-2-rules`), **not** `origin/main` `f5cec94` — it edits the same `pb-content.js`/`sw.js` as inc 2.

---

### Task 1: Add the sector tables to `pb-content.js` (+ shape tests)

**Files:**
- Modify: `pb-content.js` (add three `const`s before the `return` at line 165; extend the `return {…}` export)
- Test: `backend/test/content.test.mjs` (add shape tests)

**Interfaces:**
- Produces: `PBContent.SECTOR_ETF` (object: sector name → `{etf: string, name: string}`), `PBContent.SECTOR_TREND_WINDOWS` (array of `{key: string, days: number}`), `PBContent.SECTOR_FWD_PE` (object: lowercased sector name → number). Task 2 binds these in `app.js`.

- [ ] **Step 1: Write the failing shape tests**

Append to `backend/test/content.test.mjs` (after the last RULES test, before the `// ── Anti-drift` block at line 63):

```javascript
test('PBContent.SECTOR_ETF maps sector names to {etf, name}', () => {
  assert.ok(PBContent.SECTOR_ETF && typeof PBContent.SECTOR_ETF === 'object', 'SECTOR_ETF is an object');
  const entries = Object.entries(PBContent.SECTOR_ETF);
  assert.ok(entries.length > 0, 'SECTOR_ETF non-empty');
  for (const [sector, v] of entries) {
    assert.ok(typeof v.etf === 'string' && v.etf.length, `${sector} has a non-empty etf`);
    assert.ok(typeof v.name === 'string' && v.name.length, `${sector} has a non-empty name`);
  }
});

test('PBContent.SECTOR_TREND_WINDOWS is a list of {key, days>0}', () => {
  assert.ok(Array.isArray(PBContent.SECTOR_TREND_WINDOWS), 'SECTOR_TREND_WINDOWS is an array');
  assert.ok(PBContent.SECTOR_TREND_WINDOWS.length > 0, 'non-empty');
  for (const w of PBContent.SECTOR_TREND_WINDOWS) {
    assert.ok(typeof w.key === 'string' && w.key.length, `window has a string key`);
    assert.ok(typeof w.days === 'number' && w.days > 0, `window ${w.key} has days > 0`);
  }
});

test('PBContent.SECTOR_FWD_PE maps lowercased sectors to numbers', () => {
  assert.ok(PBContent.SECTOR_FWD_PE && typeof PBContent.SECTOR_FWD_PE === 'object', 'SECTOR_FWD_PE is an object');
  const entries = Object.entries(PBContent.SECTOR_FWD_PE);
  assert.ok(entries.length > 0, 'non-empty');
  for (const [k, v] of entries) {
    assert.strictEqual(k, k.toLowerCase(), `key "${k}" is lowercase (consumer lowercases the lookup)`);
    assert.ok(typeof v === 'number' && isFinite(v), `${k} maps to a finite number`);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node backend/test/content.test.mjs`
Expected: the three new tests FAIL (`SECTOR_ETF is an object` etc. — `PBContent.SECTOR_ETF` is `undefined`); the existing tests still pass.

- [ ] **Step 3: Add the three tables to `pb-content.js`**

Insert immediately after the `RULES` const (after line 163 `  ];`) and before the blank line + `return` at line 165. Paste verbatim (copy from `app.js` lines 8015-8037 and 10010-10022 to be exact — the text below must match them byte-for-byte):

```javascript
const SECTOR_ETF = {
  'Technology':              { etf: 'XLK',  name: 'Technology Select Sector' },
  'Communication Services':  { etf: 'XLC',  name: 'Communication Services' },
  'Consumer Cyclical':       { etf: 'XLY',  name: 'Consumer Discretionary' },
  'Consumer Defensive':      { etf: 'XLP',  name: 'Consumer Staples' },
  'Energy':                  { etf: 'XLE',  name: 'Energy Select Sector' },
  'Financial Services':      { etf: 'XLF',  name: 'Financial Select Sector' },
  'Financials':             { etf: 'XLF',  name: 'Financial Select Sector' },
  'Healthcare':              { etf: 'XLV',  name: 'Health Care Select Sector' },
  'Industrials':             { etf: 'XLI',  name: 'Industrial Select Sector' },
  'Basic Materials':         { etf: 'XLB',  name: 'Materials Select Sector' },
  'Materials':               { etf: 'XLB',  name: 'Materials Select Sector' },
  'Real Estate':             { etf: 'XLRE', name: 'Real Estate Select Sector' },
  'Utilities':               { etf: 'XLU',  name: 'Utilities Select Sector' },
};
const SECTOR_TREND_WINDOWS = [
  { key: '1W', days: 7 },
  { key: '1M', days: 30 },
  { key: '1Y', days: 365 },
  { key: '2Y', days: 730 },
  { key: '3Y', days: 1095 },
  { key: '5Y', days: 1825 },
];
const SECTOR_FWD_PE = {
  'technology': 27, 'information technology': 27,
  'communication services': 19, 'communications': 19,
  'consumer cyclical': 22, 'consumer discretionary': 22,
  'consumer defensive': 19, 'consumer staples': 19,
  'healthcare': 17, 'health care': 17,
  'financial services': 15, 'financials': 15, 'financial': 15,
  'industrials': 20, 'industrial': 20,
  'energy': 12,
  'basic materials': 16, 'materials': 16,
  'real estate': 18,
  'utilities': 17,
};
```

Then extend the export line (currently line 165):

```javascript
return { RIBBON_CATALOG, RIBBON_CATALOG_MAP, INDICATOR_INFO, BUILTIN_MACRO_2026, RULES, SECTOR_ETF, SECTOR_TREND_WINDOWS, SECTOR_FWD_PE };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node backend/test/content.test.mjs`
Expected: all tests PASS (existing + three new).

- [ ] **Step 5: Syntax-check the file**

Run: `node --check pb-content.js`
Expected: no output (clean).

---

### Task 2: Bind `app.js` to `PBContent`, add anti-drift guards, bump sw, verify

**Files:**
- Modify: `app.js` (replace 3 object-literal defs with `PBContent.X` binds — at ~lines 8015-8037 and ~10010-10022)
- Modify: `sw.js:2` (`CACHE_NAME` v46 → v47)
- Test: `backend/test/content.test.mjs` (extend the two anti-drift source guards)

**Interfaces:**
- Consumes: `PBContent.SECTOR_ETF`, `PBContent.SECTOR_TREND_WINDOWS`, `PBContent.SECTOR_FWD_PE` from Task 1.

- [ ] **Step 1: Extend the anti-drift guard tests (RED)**

In `backend/test/content.test.mjs`, add to the existing `test('app.js no longer defines the content blocks inline', …)` body (after the `Rules prose` assertion at line 73):

```javascript
  assert.ok(!appSrc.includes('const SECTOR_ETF = {'), 'SECTOR_ETF not inline');
  assert.ok(!appSrc.includes('const SECTOR_TREND_WINDOWS = ['), 'SECTOR_TREND_WINDOWS not inline');
  assert.ok(!appSrc.includes('const SECTOR_FWD_PE = {'), 'SECTOR_FWD_PE not inline');
```

And add to the existing `test('app.js delegates the content blocks to PBContent', …)` body (after the `binds RULES` assertion at line 81):

```javascript
  assert.ok(appSrc.includes('const SECTOR_ETF = PBContent.SECTOR_ETF'), 'binds SECTOR_ETF');
  assert.ok(appSrc.includes('const SECTOR_TREND_WINDOWS = PBContent.SECTOR_TREND_WINDOWS'), 'binds SECTOR_TREND_WINDOWS');
  assert.ok(appSrc.includes('const SECTOR_FWD_PE = PBContent.SECTOR_FWD_PE'), 'binds SECTOR_FWD_PE');
```

- [ ] **Step 2: Run to verify the guards fail**

Run: `node backend/test/content.test.mjs`
Expected: the two guard tests FAIL (`SECTOR_ETF not inline` — app.js still defines it inline; `binds SECTOR_ETF` — no bind yet).

- [ ] **Step 3: Replace the `SECTOR_ETF` + `SECTOR_TREND_WINDOWS` block in `app.js` with binds**

At `app.js` ~lines 8015-8037, replace the two object-literal definitions with binds. Keep `const SECTOR_TREND_CACHE = {};` (the line immediately after) unchanged. The block:

```javascript
const SECTOR_ETF = {
  'Technology':              { etf: 'XLK',  name: 'Technology Select Sector' },
  'Communication Services':  { etf: 'XLC',  name: 'Communication Services' },
  'Consumer Cyclical':       { etf: 'XLY',  name: 'Consumer Discretionary' },
  'Consumer Defensive':      { etf: 'XLP',  name: 'Consumer Staples' },
  'Energy':                  { etf: 'XLE',  name: 'Energy Select Sector' },
  'Financial Services':      { etf: 'XLF',  name: 'Financial Select Sector' },
  'Financials':             { etf: 'XLF',  name: 'Financial Select Sector' },
  'Healthcare':              { etf: 'XLV',  name: 'Health Care Select Sector' },
  'Industrials':             { etf: 'XLI',  name: 'Industrial Select Sector' },
  'Basic Materials':         { etf: 'XLB',  name: 'Materials Select Sector' },
  'Materials':               { etf: 'XLB',  name: 'Materials Select Sector' },
  'Real Estate':             { etf: 'XLRE', name: 'Real Estate Select Sector' },
  'Utilities':               { etf: 'XLU',  name: 'Utilities Select Sector' },
};
const SECTOR_TREND_WINDOWS = [
  { key: '1W', days: 7 },
  { key: '1M', days: 30 },
  { key: '1Y', days: 365 },
  { key: '2Y', days: 730 },
  { key: '3Y', days: 1095 },
  { key: '5Y', days: 1825 },
];
```

becomes:

```javascript
const SECTOR_ETF = PBContent.SECTOR_ETF;
const SECTOR_TREND_WINDOWS = PBContent.SECTOR_TREND_WINDOWS;
```

- [ ] **Step 4: Replace the `SECTOR_FWD_PE` block in `app.js` with a bind**

At `app.js` ~lines 10010-10022, replace:

```javascript
const SECTOR_FWD_PE = {
  'technology': 27, 'information technology': 27,
  'communication services': 19, 'communications': 19,
  'consumer cyclical': 22, 'consumer discretionary': 22,
  'consumer defensive': 19, 'consumer staples': 19,
  'healthcare': 17, 'health care': 17,
  'financial services': 15, 'financials': 15, 'financial': 15,
  'industrials': 20, 'industrial': 20,
  'energy': 12,
  'basic materials': 16, 'materials': 16,
  'real estate': 18,
  'utilities': 17,
};
```

with:

```javascript
const SECTOR_FWD_PE = PBContent.SECTOR_FWD_PE;
```

- [ ] **Step 5: Syntax-check app.js and run the guards (GREEN)**

Run: `node --check app.js`
Expected: clean.

Run: `node backend/test/content.test.mjs`
Expected: all tests PASS (shape + both guards).

- [ ] **Step 6: Bump the service-worker cache version**

In `sw.js:2`, change:

```javascript
const CACHE_NAME   = 'playbook-shell-v46';
```

to:

```javascript
const CACHE_NAME   = 'playbook-shell-v47';
```

- [ ] **Step 7: Run the full node suite**

Run each `.mjs` in `backend/test/` (19 suite files). Expected: all green — money gate untouched, nothing regressed. Example sweep:

```bash
for f in backend/test/*.test.mjs; do echo "== $f =="; node "$f" || echo "FAILED: $f"; done
```

- [ ] **Step 8: Browser smoke — app mounts, no ReferenceError**

Run the app-mount gate:

```bash
node verify-refresh-behavior.mjs
```

Expected: ALL PASSED — app mounts with `pb-content.js` loaded; no `PBContent`/`SECTOR_*` ReferenceError. (The anti-drift `binds SECTOR_X` guards already pin the exact bind name, so a typo'd `PBContent.SECTOR_ETFS` cannot slip through to a runtime `TypeError` in `fetchSectorTrend`.)

- [ ] **Step 9 (optional): Sector render sanity check**

If a heatmap/sector-detail harness exists (check `verify-*.mjs` for one that drives `HeatmapView`/`SectorDetailModal`/`fetchSectorTrend`), run it to confirm the trend path still resolves `SECTOR_ETF[sector]`. If none exists, the shape tests + bind guards + app-mount smoke are sufficient — skip.

- [ ] **Step 10: Hand off to Jan**

Do **not** commit. Report: files changed (`pb-content.js`, `app.js`, `sw.js`, `backend/test/content.test.mjs`), app.js line delta (~−34), all node suites green, browser smoke result. Remind Jan this stacks on `a353d70` (inc 2, unmerged) and to merge inc 2 then inc 3.

---

## Self-Review

**Spec coverage:**
- "What moves" (SECTOR_ETF, SECTOR_TREND_WINDOWS, SECTOR_FWD_PE) → Task 1 Step 3 + Task 2 Steps 3-4. ✅
- "Explicitly NOT moving" (SECTOR_TREND_CACHE, consumer fns) → Task 2 Step 3 keeps `SECTOR_TREND_CACHE`; consumers never touched. ✅
- Mechanism (add consts + export; bind at def sites) → Task 1 Step 3, Task 2 Steps 3-4. ✅
- Wiring (sw v46→v47; no other file changes) → Task 2 Step 6; Global Constraints. ✅
- Tests (shape + anti-drift guards, stays 19 files) → Task 1 Step 1, Task 2 Step 1 (extend existing `content.test.mjs`, no new file). ✅
- Verification (node --check, full suite, verify-refresh-behavior, sector render) → Task 2 Steps 5,7,8,9. ✅
- Sequencing (stack on a353d70) → Global Constraints + Task 2 Step 10. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full content; Step 9 is explicitly optional-with-fallback, not a placeholder. ✅

**Type consistency:** Bind names `PBContent.SECTOR_ETF` / `SECTOR_TREND_WINDOWS` / `SECTOR_FWD_PE` match between the export (Task 1 Step 3), the guards (Task 2 Step 1), and the app.js binds (Task 2 Steps 3-4). Shape assumptions (`{etf,name}`, `{key,days}`, lowercased number map) match the verbatim data. ✅
