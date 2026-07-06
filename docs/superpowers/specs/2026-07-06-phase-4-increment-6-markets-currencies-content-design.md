# Phase 4 increment 6 — markets/currencies content → PBContent

**Date:** 2026-07-06
**Branch:** `refactor/phase-4-increment-6-markets-currencies-content` (off origin/main `20e94b8`)
**Status:** design approved by Jan; awaiting spec review → writing-plans

## Goal

Move the last pure UI-config content out of `app.js` into the existing `pb-content.js`
content module, finishing the Phase-4 content-extraction sweep. After this, `app.js` holds
only logic + components + settings defaults — no standalone pure-content tables.

## Scope (decided with Jan)

**Moves into `pb-content.js` (verbatim):**

| Const | app.js line | What it is | Call sites |
|-------|-------------|------------|-----------|
| `MARKETS` | 442 | UI market list `[{value,label,country,exchange}]` (US/JSE/TFSA/LSE/ASX/FRA/PAR/AMS/CRYPTO) | ~8 |
| `DISPLAY_CURRENCIES` | 462 | UI currency list `[{code,sym,label}]` (USD/ZAR/GBP/AUD/EUR) | 4 |
| `CURRENCY_SYMBOLS` | 469 | code→symbol map `{USD:'$', ZAR:'R', GBP:'£', AUD:'A$', EUR:'€'}` | ~15 |

**Explicitly stays in `app.js`:**

- `sameUnderlyingExchange` (457–461) — a pure *function* (JSE/TFSA equivalence), not content.
  Its 4 call sites are all in the import/search-listings flow. It sits textually between
  MARKETS and DISPLAY_CURRENCIES and is left in place, untouched.
- `MARKET_CURRENCY` — already lives in `pb-core.js` (worker-shared); unrelated to this move.

## Rationale for the target module

`pb-content.js` (client-only `window.PBContent` + CommonJS) already holds the pure content
extracted in incs 1–3: `RIBBON_CATALOG`(+`_MAP`), `INDICATOR_INFO`, `BUILTIN_MACRO_2026`,
`RULES`, `SECTOR_ETF`, `SECTOR_TREND_WINDOWS`, `SECTOR_FWD_PE`. MARKETS / DISPLAY_CURRENCIES /
CURRENCY_SYMBOLS are the same shape of thing — pure, client-only UI config — so they belong
alongside. None are needed by the Worker (which only shares `MARKET_CURRENCY` via pb-core), so
PBContent (never loaded in the worker) is the correct home.

`CURRENCY_SYMBOLS` is technically derivable from `DISPLAY_CURRENCIES`
(`Object.fromEntries(DISPLAY_CURRENCIES.map(d => [d.code, d.sym]))`), but it moves **verbatim**
— deriving it would turn a mechanical move into a behavior change, against the increment's
behavior-preserving discipline.

## Mechanism (identical to inc 3, sector tables)

1. Append the three consts, verbatim, into `pb-content.js` just before the `return {…}` export
   block, and add `MARKETS, DISPLAY_CURRENCIES, CURRENCY_SYMBOLS` to that export list.
2. In `app.js`, replace each definition with a bind at its original line:
   - line 442: `const MARKETS = PBContent.MARKETS;`
   - line 462: `const DISPLAY_CURRENCIES = PBContent.DISPLAY_CURRENCIES;`
   - line 469: `const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS;`

   `sameUnderlyingExchange` (457–461) is left in place between the MARKETS and
   DISPLAY_CURRENCIES binds. All ~25 call sites are unchanged (same local names).

### Unicode safety

Every non-ASCII character in these consts is already authored as a `\uXXXX` escape in source
(`·` ·, `£` £, `€` €). Unlike inc 2 (literal em-dashes that Edit/Write mangle),
there is **no literal non-ASCII** here, so a plain `Edit` move is safe — no line-range splice
script needed. The move must still be byte-verbatim (copy the exact source lines, do not retype
the escapes).

## Wiring

`pb-content.js` has been fully wired since inc 1 — it is in `index.html`, the `static.yml`
deploy allowlist (cp-list + Guard-1 loop), the sw `SHELL_ASSETS` precache list, and all 16
app-mounting `verify-*.mjs` harness shells. Therefore the **only** wiring change is:

- **sw cache bump `v49 → v50`** (`CACHE_NAME` in `sw.js`), because pb-content.js and app.js
  contents change.

No new file. No `index.html`, `static.yml`, or harness edits. No worker/wrangler impact
(worker bundles pb-core, never pb-content). pb-core/pb-data/pb-store/pb-import/data.js untouched.

## Tests

Extend `backend/test/content.test.mjs` (the inc-1→3 shape suite; stays 19 suite files, just
more assertions):

- **MARKETS:** `value`s unique; includes `US`/`JSE`/`TFSA`/`CRYPTO`; every row has
  `value`/`label`/`country`/`exchange` (all non-empty strings).
- **DISPLAY_CURRENCIES:** `code`s unique; `USD`/`ZAR`/`GBP`/`AUD`/`EUR` all present; every row
  has `code`/`sym`/`label`; `£` and `€` symbols intact (`.length === 1`, correct codepoint).
- **CURRENCY_SYMBOLS:** key set === DISPLAY_CURRENCIES codes; each code maps to the matching
  `sym` (cross-check the two consts agree).
- **Anti-drift source guards (extend the existing ones):** assert `app.js` no longer defines
  these consts (no `const MARKETS = [`, no `const DISPLAY_CURRENCIES = [`, no
  `const CURRENCY_SYMBOLS = {`) and instead binds all three from `PBContent`
  (`const MARKETS = PBContent.MARKETS`, etc.).

## Verification gate

1. All **19 node suites green** (`node backend/test/*.test.mjs`), money gate included (unchanged).
2. `node --check` clean on `app.js` and `pb-content.js`.
3. Browser mount smoke `verify-refresh-behavior.mjs` **ALL PASSED** — app mounts with no
   `PBContent`/`MARKETS`/`DISPLAY_CURRENCIES`/`CURRENCY_SYMBOLS` ReferenceError; the
   "holdings rows have NO SessionBadge" standing guard still holds.

## Net effect

- `app.js` ≈ −15 lines (three multi-line/one-line consts → three one-line binds).
- `pb-content.js` gains the three consts + three export names.
- Changed files: `app.js`, `pb-content.js`, `sw.js`, `backend/test/content.test.mjs`.
- Suite count unchanged (19).

## Out of scope / deferred

- `sameUnderlyingExchange` (stays in app.js — a function, not content).
- Deriving `CURRENCY_SYMBOLS` from `DISPLAY_CURRENCIES` (verbatim move only).
- Any component/view split (the remaining Phase-4 goal — a separate future increment; this
  closes the content-extraction half).
- The `demo-data.js` deploy-allowlist gap (pre-existing, tracked separately in postponed tasks).

## Commit note

Per Jan's standing rule (2026-06-29): I build in the working tree; **Jan reviews/commits/PRs**.
The spec doc + plan + code are left uncommitted for Jan.
