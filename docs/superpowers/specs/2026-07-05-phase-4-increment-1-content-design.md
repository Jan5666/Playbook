# Phase 4 increment 1 — playbook/indicator content → `pb-content.js` — Design

**Date:** 2026-07-05
**Branch:** `refactor/phase-4-increment-1-content` (off `origin/main` `63a2595`)
**Status:** first increment of Phase 4 ("split components by feature"). Phase 3 is complete (inc 5
merged as PR #15). This increment does the **content** half of Phase 4's mandate ("pull playbook/
indicator content to /content/*.json") without yet touching component structure or the build model.

## Problem

`app.js` is 13,303 lines. Phase 4's goal is to split it into feature-scoped units so it becomes
maintainable. The lowest-risk, highest-clarity first slice is the **static content** currently inlined
in `app.js`: pure data and copy that carry no logic, that Jan may want to edit without reading app code,
and that bloat the monolith. Extracting them shrinks `app.js` and establishes the Phase-4 content
pattern before the riskier component-splitting decisions (which is where the deferred build-step
question will finally be forced).

The build-step fork (Vite/esbuild vs. continue no-build) is **explicitly deferred** — this increment
stays no-build and idiomatic to the existing `pb-core.js` / `pb-data.js` / `pb-store.js` global-script
model.

## Goals

- Move the genuine **playbook/indicator content** out of `app.js` into a new dual-mode global script
  `pb-content.js` (`window.PBContent` + CommonJS), loaded before `app.js`.
- Preserve every call site: `app.js` binds `const X = PBContent.X` where the definitions were, exactly
  as it binds pb-core/pb-data values today. Zero behavior change.
- Wire the new file into the three no-build touch points (index.html load order, sw precache + version
  bump, deploy allowlist + guard) with no impact on pb-core / pb-data / pb-store / worker.
- Add a `content.test.mjs` suite (shape assertions + anti-drift source guards), matching the pattern of
  every prior extraction.

## Non-goals / explicitly deferred

- **`RulesView` prose** (trim rules, thesis-break triggers, SA tax discipline) — currently hardcoded in
  `React.createElement`, not data. Extracting it requires making `RulesView` data-driven, which carries
  a (small) render-parity risk. Deferred to **increment 2** so this increment is a pure, zero-behavior-
  risk constant move. (`DATA.RISKS` already lives in `data.js`.)
- **Logic tables**, left in `app.js` as they are not "content": import-matching maps
  (`INSTRUMENT_ALIASES`, `YAHOO_EXCHANGE_MAP`, `IMPORT_SYNONYMS`, `EE_EXCHANGE_MAP`,
  `SUFFIX_TO_MARKET`, `CURRENCY_TO_MARKET`) and sector maps (`SECTOR_ETF`, `SECTOR_FWD_PE`,
  `SECTOR_TREND_WINDOWS`).
- **App config** left in place: `MARKETS`, `DISPLAY_CURRENCIES`, `CURRENCY_SYMBOLS` (small, and not
  playbook/indicator content). Candidates for a later increment.
- No build step; no component splitting; no worker change.

## Scope — content that moves

| Block | Approx lines | Uses in app.js | Consumers |
|---|---|---|---|
| `RIBBON_CATALOG` | ~40 | 7 | ribbon rendering; derives `RIBBON_CATALOG_MAP`; feeds `PBData.configure` |
| `RIBBON_CATALOG_MAP` (derived: `Object.fromEntries(RIBBON_CATALOG.map(...))`) | 1 | 4 | injected via `PBData.configure({ indicatorCatalog: ... })` (app.js:572); indicator lookups |
| `INDICATOR_INFO` | ~38 | 2 | `IndicatorAbout` explanation card |
| `BUILTIN_MACRO_2026` | ~40 | 2 | `HotTopicsView` macro calendar fallback |

Verified: none of these four blocks are referenced in `pb-core.js`, `pb-data.js`, `pb-store.js`,
`backend/worker.js`, or `sw.js` → content-only, no worker/deploy-logic impact.

## Design

### `pb-content.js` (new file)

A dual-mode classic script, structured exactly like the other `pb-*.js` layers:

```js
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node tests
  root.PBContent = api;                                                        // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RIBBON_CATALOG = [ /* … moved verbatim … */ ];
  const RIBBON_CATALOG_MAP = Object.fromEntries(RIBBON_CATALOG.map(r => [r.key, r]));
  const INDICATOR_INFO = { /* … moved verbatim … */ };
  const BUILTIN_MACRO_2026 = [ /* … moved verbatim … */ ];
  return { RIBBON_CATALOG, RIBBON_CATALOG_MAP, INDICATOR_INFO, BUILTIN_MACRO_2026 };
});
```

Content is moved **verbatim** (byte-identical arrays/objects) to guarantee no behavior change. The
`RIBBON_CATALOG_MAP` derivation moves alongside `RIBBON_CATALOG` (it's a pure function of it), so
`app.js` no longer computes it.

### `app.js` bindings

Where each `const` was defined, replace the definition with a binding — the established idiom:

```js
const RIBBON_CATALOG     = PBContent.RIBBON_CATALOG;
const RIBBON_CATALOG_MAP = PBContent.RIBBON_CATALOG_MAP;
const INDICATOR_INFO     = PBContent.INDICATOR_INFO;
const BUILTIN_MACRO_2026 = PBContent.BUILTIN_MACRO_2026;
```

All ~15 call sites (including `PBData.configure({ indicatorCatalog: RIBBON_CATALOG_MAP })` at
app.js:572) are unchanged. `PBContent` must exist when `app.js` runs → guaranteed by load order.

### Wiring (no-build, one-time cost)

- **index.html:** add `<script src="./pb-content.js"></script>` after `pb-store.js` (line 76), before
  `data.js` — keeps the `pb-*` group contiguous. `pb-content` has no dependency on `data.js` and vice
  versa, so position within the pre-`app.js` block is not load-order-critical, only that it precedes
  `app.js`.
- **sw.js:** add `'./pb-content.js'` to `SHELL_ASSETS`; bump `CACHE_NAME` `playbook-shell-v44` →
  `v45`.
- **.github/workflows/static.yml:** add `pb-content.js` to (1) the `cp … _site/` stage list (line 44)
  and (2) the Guard-1 missing-asset `for f in …` loop (line 50). Keeps the "runtime asset present or
  fail the deploy" guarantee intact.

## Testing

- **New `backend/test/content.test.mjs`** (suite 18 → 19):
  - Shape: `RIBBON_CATALOG` non-empty; every entry has `key`; keys unique; `RIBBON_CATALOG_MAP` keys ===
    catalog keys.
  - `INDICATOR_INFO` keys ⊆ `RIBBON_CATALOG` keys (every explanation maps to a real catalog entry).
  - `BUILTIN_MACRO_2026`: non-empty; every `date` matches `^\d{4}-\d{2}-\d{2}$`; every entry has
    `title` + `type`.
  - **Anti-drift source guards:** `app.js` no longer defines `RIBBON_CATALOG`/`INDICATOR_INFO`/
    `BUILTIN_MACRO_2026` inline (`grep` for `const RIBBON_CATALOG = [` etc. → absent); `app.js` contains
    the delegating binds (`const RIBBON_CATALOG = PBContent.RIBBON_CATALOG`).
- **Money gate** (money-math, cost-basis, import-matching, ee-ocr): untouched — no formula changed →
  trivially green.
- **Node:** `node --check pb-content.js` + `node --check app.js` clean; full suite green.
- **Browser smokes:** `verify-refresh-behavior` (app mounts, no `PBContent` ReferenceError) +
  `verify-indicators` (indicator cards render from the moved catalog/info). Both harnesses must load
  `pb-content.js` before `app.js` — add the `<script>` to those harnesses' HTML shells (same fix that
  was applied when pb-data/pb-store were introduced).

## Risks & mitigations

- **Load-order / missing global:** if `app.js` runs before `PBContent` exists → `ReferenceError`, app
  won't mount. Mitigated by index.html order + the browser smoke (node tests alone can't catch this —
  the standing lesson from the pb-data `NAME_CACHE` incident).
- **Verify harnesses stale:** any `verify-*.mjs` that exercises the ribbon/indicators must include the
  new `<script>`; otherwise a false ReferenceError failure. Audit the harness HTML shells.
- **Deploy allowlist drift:** forgetting the `static.yml` entry would 404 `pb-content.js` on the live
  site and break sw precache. Mitigated by adding it to both the `cp` list and the guard loop.

## Side observation (out of scope, flag only)

`demo-data.js` is precached in `sw.js` (SHELL_ASSETS) and loaded by `index.html`, but is **not** in the
`static.yml` deploy allowlist/guard. On the live site this would 404 and could fail sw precache. This
predates and is unrelated to this increment — flagged for Jan to decide separately; not fixed here.

## Definition of done

- `pb-content.js` exists; the four blocks are gone from `app.js` (delegating binds remain); ~118 fewer
  lines in `app.js`.
- 19 node suites green; `node --check` clean on both files.
- Both browser smokes pass (app mounts; indicator cards render).
- index.html / sw.js (v45) / static.yml wired; no pb-core/pb-data/pb-store/worker change.
- Left for Jan: review + commit + PR/merge.
