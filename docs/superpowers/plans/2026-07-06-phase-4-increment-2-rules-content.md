# Phase 4 increment 2 — RulesView prose → `PBContent.RULES` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the three hardcoded prose sections of `RulesView` (Trim rules, Thesis-break triggers, SA tax-year discipline) out of `app.js` into structured data on `PBContent.RULES`, and re-render them from that data with zero behavior change.

**Architecture:** Add a `RULES` array (sections of `{ id, heading, bullets }`) to the existing dual-mode `pb-content.js` (`window.PBContent` + CommonJS, created in increment 1). `app.js` binds `const RULES = PBContent.RULES` and renders each section via a small `ruleSection(section, cardClass)` helper, composing the view in the exact current order with the untouched `DATA.RISKS` "Key risks" grid interleaved. The produced DOM is byte-identical to today's.

**Tech Stack:** Vanilla ES + `React.createElement` (no JSX, no build step); Node's built-in `node:test` runner; service-worker precache + GitHub Pages static deploy.

## Global Constraints

- **No build step.** `pb-content.js` is a classic dual-mode `<script>` (browser global `window.PBContent` + `module.exports`). No JSX — `React.createElement` only.
- **Zero behavior change.** The rendered DOM must be byte-identical. A `{ strong }` bullet renders `<strong>{strong}</strong>{text}`; a plain bullet renders just `{text}`.
- **Em-dashes as ASCII escapes.** Author every em-dash in the `RULES` strings as the JavaScript escape `\u2014` (backslash-u-2014), never a literal `—` character. This keeps `pb-content.js` edits corruption-safe. (The spec code blocks show literal em-dashes only for readability.)
- **Preserve order + margins.** Section order stays: Trim rules → Thesis-break triggers → **Key risks (DATA.RISKS, unchanged)** → SA tax-year discipline. The first two prose cards use `class="card mb-4"`; the final (SA tax) card uses `class="card"` (no `mb-4`). The `DATA.RISKS` block is copied through verbatim.
- **No wiring beyond the cache bump.** `pb-content.js` is already loaded in `index.html`, the `static.yml` allowlist+guard, `sw.js` precache, and every app-mounting `verify-*.mjs` harness shell (increment 1). The only wiring change is `sw.js` v45 → v46.
- **No impact** on `pb-core.js` / `pb-data.js` / `pb-store.js` / `backend/worker.js` / `data.js` / `index.html` / `static.yml`.
- **CRLF:** `app.js` uses CRLF line endings; the Edit tool normalizes CRLF when matching, so `\n`-based `old_string` works. Anti-drift guards use substring search.
- **Commits, PR, and merge are performed by Jan, not the implementer.** Build in the working tree only; do not run `git commit`/`git push`/`git merge`. Each task ends at a green verification, not a commit.
- **Test runner:** no npm script. Run one suite with `node backend/test/<name>.test.mjs`.

---

### Task 1: Add `RULES` to `pb-content.js` (TDD: shape + fidelity tests first)

**Files:**
- Modify/Test: `backend/test/content.test.mjs` (append shape + fidelity tests)
- Modify: `pb-content.js` (insert `RULES` const before the `return {…}`, and add `RULES` to the returned object)

**Interfaces:**
- Produces: `require('../../pb-content.js').RULES` → `Array<{ id: string, heading: string, bullets: Array<{ strong?: string, text: string }> }>`; browser global `window.PBContent.RULES` with the same value.

- [ ] **Step 1: Write the failing shape + fidelity tests**

Append to `backend/test/content.test.mjs` (after the existing `BUILTIN_MACRO_2026` test at line 36, before the anti-drift guards import at line 38):

```js
test('PBContent.RULES is a well-formed section array', () => {
  assert.ok(Array.isArray(PBContent.RULES), 'RULES is an array');
  assert.ok(PBContent.RULES.length > 0, 'RULES non-empty');
  const ids = PBContent.RULES.map(s => s.id);
  assert.ok(ids.every(id => typeof id === 'string' && id.length), 'every section has a string id');
  assert.strictEqual(new Set(ids).size, ids.length, 'section ids are unique');
  for (const s of PBContent.RULES) {
    assert.ok(typeof s.heading === 'string' && s.heading.length, `section ${s.id} has a heading`);
    assert.ok(Array.isArray(s.bullets) && s.bullets.length, `section ${s.id} has bullets`);
    for (const b of s.bullets) {
      assert.ok(typeof b.text === 'string' && b.text.length, `bullet in ${s.id} has text`);
      if ('strong' in b) assert.ok(typeof b.strong === 'string', `strong in ${s.id} is a string`);
    }
  }
});

test('PBContent.RULES has the three expected sections with the right bullet counts', () => {
  const byId = id => PBContent.RULES.find(s => s.id === id);
  assert.deepStrictEqual(PBContent.RULES.map(s => s.id), ['trim', 'thesisBreak', 'saTax'], 'ids in order');
  assert.strictEqual(byId('trim').bullets.length, 5, 'trim has 5 bullets');
  assert.strictEqual(byId('thesisBreak').bullets.length, 5, 'thesisBreak has 5 bullets');
  assert.strictEqual(byId('saTax').bullets.length, 4, 'saTax has 4 bullets');
  assert.ok(byId('trim').bullets.every(b => typeof b.strong === 'string'), 'every trim bullet has a bold lead-in');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node backend/test/content.test.mjs`
Expected: FAIL — `RULES is an array` fails (`PBContent.RULES` is `undefined`).

- [ ] **Step 3: Insert the `RULES` block into `pb-content.js`**

In `pb-content.js`, the `BUILTIN_MACRO_2026` array closes with `];` on line 137, followed by a blank line and `return { RIBBON_CATALOG, RIBBON_CATALOG_MAP, INDICATOR_INFO, BUILTIN_MACRO_2026 };` on line 139. Replace those lines 137-139:

```js
];

return { RIBBON_CATALOG, RIBBON_CATALOG_MAP, INDICATOR_INFO, BUILTIN_MACRO_2026 };
```

with (note every em-dash is the `\u2014` escape — do not type a literal `—`):

```js
];

  // Rules tab: pre-written trim rules, thesis-break triggers, and SA tax-year
  // discipline. Sections keyed by `id`; a bullet is { text } or { strong, text }
  // (a bold lead-in + text). Rendered by RulesView via the `ruleSection` helper.
  const RULES = [
    { id: 'trim', heading: 'Trim rules', bullets: [
      { strong: '+100% gain',            text: ' \u2014 trim 25% of position, bank profits' },
      { strong: '+150% gain',            text: ' \u2014 trim another 20% of remainder' },
      { strong: '+200% gain',            text: ' \u2014 trim another 20%, let the rest ride' },
      { strong: '-20% from cost',        text: ' \u2014 re-examine thesis, never average down without fresh conviction' },
      { strong: 'Position >12% of book', text: ' \u2014 trim to 10% regardless of gain' },
    ]},
    { id: 'thesisBreak', heading: 'Thesis-break triggers', bullets: [
      { text: 'Hyperscaler capex cut by top-3 player (MSFT, GOOGL, META, AMZN, ORCL)' },
      { text: 'Core CPI above 3.2% for two consecutive prints' },
      { text: 'Brent above $120 \u2014 consumer weakness trigger' },
      { text: 'VOO drawdown >15% from buy-zone \u2014 deploy all cash' },
      { text: 'Any position where CEO reneges on publicly-stated commitment (the MSTR lesson)' },
    ]},
    { id: 'saTax', heading: 'SA tax-year discipline', bullets: [
      { text: 'Tax year ends 28 February. Split disposals across 28 Feb + 1 March for two annual R40k CGT exclusions.' },
      { text: 'Combined shelter: up to R80k of gains untaxed per year.' },
      { text: 'At 40% marginal rate with 40% inclusion, each exclusion = ~R12,800 saved.' },
      { text: 'Keep broker IT3(c) certificates for each tax year.' },
    ]},
  ];

return { RIBBON_CATALOG, RIBBON_CATALOG_MAP, INDICATOR_INFO, BUILTIN_MACRO_2026, RULES };
```

- [ ] **Step 4: Verify the file parses and the tests pass**

Run: `node --check pb-content.js`
Expected: no output (clean).

Run: `node backend/test/content.test.mjs`
Expected: PASS. The two new tests are green; the four pre-existing tests still pass. (The anti-drift guards at the bottom still pass — they only check the four original blocks so far.)

---

### Task 2: Rewire `RulesView` to render from `RULES` + anti-drift guards (TDD: guards first)

**Files:**
- Modify/Test: `backend/test/content.test.mjs` (extend the two anti-drift guard tests)
- Modify: `app.js` (add `const RULES = PBContent.RULES;` after line 473; add `ruleSection` helper + rewrite `RulesView` at app.js:9477-9519)

**Interfaces:**
- Consumes: `window.PBContent.RULES` (Task 1). All existing `app.js` behavior is preserved because the rendered DOM is unchanged.

- [ ] **Step 1: Extend the anti-drift guard tests to cover `RULES`**

In `backend/test/content.test.mjs`, add two assertions to the existing `'app.js no longer defines the content blocks inline'` test (currently lines 42-47) — add these lines inside its body, after the `BUILTIN_MACRO_2026` assertion:

```js
  assert.ok(!appSrc.includes('Thesis-break triggers'), 'Rules headings not inline');
  assert.ok(!appSrc.includes('bank profits') && !appSrc.includes('R80k of gains untaxed'), 'Rules prose not inline');
```

And add one assertion to the existing `'app.js delegates the content blocks to PBContent'` test (currently lines 49-54) — after the `BUILTIN_MACRO_2026` bind assertion:

```js
  assert.ok(appSrc.includes('const RULES = PBContent.RULES'), 'binds RULES');
```

- [ ] **Step 2: Run the guards to verify they fail**

Run: `node backend/test/content.test.mjs`
Expected: FAIL — `Rules headings not inline` (and/or `Rules prose not inline`) fails because `app.js` still contains the literal prose; `binds RULES` fails because the bind is not there yet.

- [ ] **Step 3: Add the `RULES` bind in `app.js`**

In `app.js`, the content binds sit at lines 470-473. Line 473 is `const INDICATOR_INFO = PBContent.INDICATOR_INFO;`. Insert a new line immediately after it:

```js
const RULES = PBContent.RULES;
```

so the block reads:

```js
const RIBBON_CATALOG = PBContent.RIBBON_CATALOG;
const RIBBON_CATALOG_MAP = PBContent.RIBBON_CATALOG_MAP;
const DEFAULT_RIBBON_ITEMS = ['US:^SPX', 'US:^VIX'];
const INDICATOR_INFO = PBContent.INDICATOR_INFO;
const RULES = PBContent.RULES;
```

- [ ] **Step 4: Replace `RulesView` with the `ruleSection` helper + data-driven view**

In `app.js`, replace the **entire** current `RulesView` function — from `function RulesView() {` (app.js:9477) through its closing `}` immediately before `function OverviewView(_ref1) {` (app.js:9520) — with the following. The `ruleSection` helper is added directly above it, and the `DATA.RISKS` "Key risks" block is preserved verbatim:

```js
function ruleSection(section, cardClass) {
  return [React.createElement("div", {
    key: section.id + '-eyebrow',
    className: "eyebrow"
  }, section.heading), React.createElement("div", {
    key: section.id + '-card',
    className: cardClass
  }, React.createElement("ul", {
    className: "bullet-list"
  }, section.bullets.map((b, i) => React.createElement("li", {
    key: i
  }, React.createElement("span", null, b.strong ? React.createElement("strong", null, b.strong) : null, b.text)))))];
}
function RulesView() {
  const byId = id => RULES.find(s => s.id === id);
  return React.createElement("div", null, ...ruleSection(byId('trim'), "card mb-4"), ...ruleSection(byId('thesisBreak'), "card mb-4"), React.createElement("div", {
    className: "eyebrow"
  }, "Key risks"), React.createElement("div", {
    className: "grid grid-2 mb-4"
  }, DATA.RISKS.map((r, i) => React.createElement("div", {
    key: i,
    className: "card"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-2",
    style: {
      gap: 8
    }
  }, React.createElement("div", {
    className: "font-semibold",
    style: {
      fontSize: 14,
      lineHeight: 1.3
    }
  }, r.title), React.createElement("span", {
    className: `pill ${r.probability === 'HIGH' ? 'pill-danger' : 'pill-warn'}`
  }, r.probability)), React.createElement("div", {
    className: "text-sm text-muted"
  }, r.impact)))), ...ruleSection(byId('saTax'), "card"));
}
```

- [ ] **Step 5: Verify `app.js` still parses**

Run: `node --check app.js`
Expected: no output (clean). A `SyntaxError` means the replacement clipped a neighbouring statement — recheck that the boundary is exactly the `RulesView` closing `}` before `function OverviewView`.

- [ ] **Step 6: Run the full content suite**

Run: `node backend/test/content.test.mjs`
Expected: PASS (all tests, incl. the extended guards). If `Rules prose not inline` still fails, a prose string survived in `app.js`; if `binds RULES` fails, the bind is missing or misspelled.

---

### Task 3: Cache bump + full verification

**Files:**
- Modify: `sw.js:2` (cache version)

- [ ] **Step 1: Bump the service-worker cache version**

In `sw.js`, change line 2 from:

```js
const CACHE_NAME   = 'playbook-shell-v45';
```

to:

```js
const CACHE_NAME   = 'playbook-shell-v46';
```

(No `SHELL_ASSETS` change — `pb-content.js` is already precached from increment 1. Only its contents, and `app.js`'s, changed.)

Run: `grep -c 'playbook-shell-v46' sw.js`
Expected: `1`.

- [ ] **Step 2: Run the whole node test suite**

Run:
```bash
for f in backend/test/*.test.mjs; do echo "== $f =="; node "$f" || echo "FAILED: $f"; done
```
Expected: every suite passes, including `content.test.mjs`. Suite count stays 19 (content.test.mjs gained tests, no new file). No `FAILED:` lines.

- [ ] **Step 3: Money gate spot-check (should be unchanged)**

Run:
```bash
node backend/test/money-math.test.mjs && node backend/test/cost-basis.test.mjs && node backend/test/import-matching.test.mjs && node backend/test/ee-ocr-parse.test.mjs
```
Expected: all PASS (no formula changed — this is a content move).

- [ ] **Step 4: Browser smoke — app mounts (no `PBContent`/`RULES` ReferenceError)**

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: ALL PASSED (the app mounts; the "Today" P/L pill and refresh chip render). A `ReferenceError: RULES is not defined` or `PBContent is not defined` here means the bind (Task 2 Step 3) or the file wiring is wrong.

- [ ] **Step 5: Manual spot check of the Rules tab**

Open the app, go to the **Rules** tab, and confirm the four sections render **in this order**: Trim rules (5 bullets, each with a **bold** lead-in and an em-dash), Thesis-break triggers (5 plain bullets), Key risks (grid of risk cards with HIGH/MEDIUM pills), SA tax-year discipline (4 plain bullets). The final SA tax card has no bottom margin (it sits flush at the end). This matches the current appearance exactly.
*(No existing browser harness drives the Rules tab; the node shape/fidelity + anti-drift tests plus the app-mount smoke are the automated gate — this manual check confirms the visual render.)*

- [ ] **Step 6: Record the `app.js` line count**

Run: `wc -l app.js`
Expected: at or slightly below the 13,182 baseline. The prose strings move to `pb-content.js`, but the removed `createElement` scaffolding is replaced by the `ruleSection` helper + preserved RISKS block, so the net delta is small (roughly flat to a few lines down). This is informational, not a gate — the gate is `node --check`, the test suite, and the app-mount smoke.

---

## Definition of done

- `PBContent.RULES` exists; the three prose blocks are gone from `app.js` (delegating bind + `ruleSection` helper remain); the `DATA.RISKS` "Key risks" section is unchanged.
- `content.test.mjs` covers `RULES` shape + fidelity (5/5/4) + anti-drift guards.
- 19 node suites green; `node --check` clean on `pb-content.js` and `app.js`.
- `sw.js` at v46; no other wiring changed.
- App mounts under the smoke harness; Rules tab renders identically (manual spot check).
- No change to `pb-core.js` / `pb-data.js` / `pb-store.js` / `worker.js` / `data.js` / `index.html` / `static.yml`.
- **Left for Jan:** review + commit + PR/merge.

## Self-review notes

- **Spec coverage:** every spec item maps to a task — data shape + `RULES` in `pb-content.js` (T1), `app.js` bind + `ruleSection` render + anti-drift guards (T2), `sw.js` cache bump + full verification incl. money gate + app-mount smoke + manual Rules-tab check (T3). Out-of-scope items (DATA.RISKS/PILLARS, other views, other tables) correctly get no task.
- **Type consistency:** `RULES` is `Array<{ id, heading, bullets: Array<{ strong?, text }> }>` in T1 (produce), the same shape is consumed by `ruleSection`/`RulesView` in T2, and the guards/tests reference the same `id`s (`trim`/`thesisBreak`/`saTax`) and counts (5/5/4) throughout.
- **Placeholder scan:** no TODO/TBD. The only comment-in-code is the deliberate "Key risks block preserved verbatim" (shown in full, not elided) and the `—`-escape note.
- **Fidelity:** `ruleSection` produces `<div class="eyebrow">heading</div><div class="{cardClass}"><ul class="bullet-list"><li><span>[<strong>strong</strong>]text</span></li>…</ul></div>` — identical to the current literal `createElement` output (a plain bullet passes `null` as the first span child, which React drops).
