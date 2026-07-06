# Phase 4 increment 3 — sector reference tables → PBContent

**Date:** 2026-07-06
**Branch base:** stacks on inc-2 tip `a353d70` (branch `refactor/phase-4-increment-2-rules`), **not** `origin/main` `f5cec94` — see Sequencing.
**Type:** content lift (pure-data extraction), no behavior change.

## Goal

Continue the Phase-4 no-build content carve-out (inc 1 = RIBBON_CATALOG/INDICATOR_INFO/BUILTIN_MACRO_2026; inc 2 = RULES) by lifting the pure **sector reference tables** out of `app.js` into `pb-content.js`. This is the genuinely clean inc-1/2 mirror — single contiguous object literals, one nearby consumer each, referenced by zero existing tests.

Chosen over the import-matching tables (the originally-considered target) because those are logic-adjacent and interleaved with the matching algorithm, `import-matching.test.mjs` vm-slices them, and moving them would force a test rework + locality hit. Sector tables have none of those problems.

## What moves (verbatim, `app.js` → `pb-content.js`)

| Table | Current line | Shape | Consumer (stays in app.js) |
|---|---|---|---|
| `SECTOR_ETF` | @8015 | sector name → `{etf, name}` (13 entries) | `fetchSectorTrend` @8039 |
| `SECTOR_TREND_WINDOWS` | @8030 | `{key, days}[]` (6 chart windows) | `fetchSectorTrend` / trend chart |
| `SECTOR_FWD_PE` | @10010 | sector name (lowercased) → forward P/E number (~17 keys) | `sectorForwardPE` @10024 |

All three are pure, ASCII-only data (no `£`/`€`/`—` — so plain Edit works, no inc-2 splice-script needed).

## Explicitly NOT moving (stays in app.js)

- `SECTOR_TREND_CACHE` @8038 — mutable runtime cache, not content.
- `fetchSectorTrend` / `sectorForwardPE` — consumer logic (impure: `fetchSectorTrend` does network). Same content/logic split already accepted for RULES in inc 2.

## Mechanism (exact mirror of inc 1/2)

1. In `pb-content.js`: add `SECTOR_ETF`, `SECTOR_TREND_WINDOWS`, `SECTOR_FWD_PE` as top-level `const`s (lifted verbatim) before the `return { … }` at [pb-content.js:165](../../../pb-content.js#L165), and add the three names to that export object.
2. In `app.js`: replace each `const SECTOR_X = { … }` definition with a bind `const SECTOR_X = PBContent.SECTOR_X;` at the old def site (mirrors the existing `const RULES = PBContent.RULES` / `const RIBBON_CATALOG = PBContent.RIBBON_CATALOG` binds).
3. Consumers (`fetchSectorTrend`, `sectorForwardPE`) are **unchanged** — they reference the same local names → byte-identical behavior.

`pb-content.js` is a dual-mode classic script (`window.PBContent` + CommonJS `module.exports`); it is already loaded in index.html and precached since inc 1, so no new script tag is introduced.

## Wiring / scope

- `sw.js` `CACHE_NAME` v46 → **v47** (pb-content.js + app.js contents changed).
- **No** change to: `index.html`, `.github/workflows/static.yml` allowlist, the verify-`*.mjs` harness shells (pb-content.js already wired everywhere since inc 1).
- **No** change to: `pb-core.js`, `pb-data.js`, `pb-store.js`, `backend/worker.js`, `data.js`.

## Tests

Extend `backend/test/content.test.mjs` (no new suite file; stays 19 suite files):

- **Shape checks:**
  - `SECTOR_ETF` — every value is `{etf, name}` with non-empty string `etf` and `name`.
  - `SECTOR_FWD_PE` — every value is a finite number; every key is its own `.toLowerCase()` (the consumer lowercases the lookup, so upper-case keys would be dead).
  - `SECTOR_TREND_WINDOWS` — array of `{key: string, days: number>0}`.
- **Anti-drift source guards (extend the existing two):**
  - `app.js` no longer contains an object-literal definition `const SECTOR_ETF = {` / `SECTOR_TREND_WINDOWS = [` / `SECTOR_FWD_PE = {`.
  - `app.js` binds each via `const SECTOR_X = PBContent.SECTOR_X`.

## Verification (leave commit/PR/merge to Jan)

1. `node --check app.js` and `node --check pb-content.js` clean.
2. `node backend/test/content.test.mjs` green, then the full node suite (19) green — money gate untouched but confirm nothing regressed.
3. Browser smoke `verify-refresh-behavior.mjs` — app mounts, no `PBContent`/`SECTOR_*` ReferenceError.
4. One sector-touching render check to confirm the trend path still reads the tables (e.g. drive the sector-detail/heatmap trend render, or a one-off headless check that `fetchSectorTrend`/`sectorForwardPE` resolve their maps). Pick the existing harness that exercises this at implementation time; if none does, a scratch one-off is fine (not committed).

## Sequencing (important)

`origin/main` is `f5cec94` (Phase-4 inc 1). Inc 2 (RULES) is committed as `a353d70` and pushed on branch `refactor/phase-4-increment-2-rules` but **not yet merged to main**. Inc 3 edits the same two files (`pb-content.js`, `sw.js`) as inc 2, so it **must stack on `a353d70`**, not branch off `origin/main` — otherwise it would be missing `RULES` and collide on merge. When Jan merges: inc 2 then inc 3 (or squashed), off latest main each time per the standing "branch off latest origin/main, never revert Jan's between-increment tweaks" rule.

## Trade-offs accepted

- Small app.js shrink (~30 lines) — this is the honest low-risk lift, not a big win.
- Content/logic split: the sector tables are now separated from their consumer functions (`fetchSectorTrend`/`sectorForwardPE`). Same trade-off already accepted for RULES↔RulesView in inc 2. Acceptable because the tables are stable reference data and the consumers are few and named.
- Semantic note: these are reference/config tables rather than user-facing prose. They live in `pb-content.js` for consistency with the established "pure data lifted out of app.js" pattern and because it is dual-mode/node-testable; if a dedicated `pb-config.js` home is ever wanted, that is a separate future decision, not this increment.
