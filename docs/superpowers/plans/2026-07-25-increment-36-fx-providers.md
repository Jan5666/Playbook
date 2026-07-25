# Increment 36 — plan (turnkey recipe)

Target: move the FX block — `FX_PROXIES` (`app.js:327–333`), `HISTORICAL_FX_CACHE` (`app.js:1126`),
`fetchHistoricalFx` (`app.js:1127–1150`) and `fetchFxRates` (`app.js:1151–1171`) — out of `app.js` into
`pb-data.js`, binding both readers back at the old definition site so the 4 call sites are unchanged.
Closes **GAPS #7**. This is the Phase 2 module-extraction pattern, not a Phase 4 bucket move: the
`window.PBApp` bridge is untouched at 38. See the design doc for the inventory and for the audit that
established Phase 4 has no move candidate left.

Branch: `claude/refactor-plan-continuation-gto2pa` (off latest `origin/main` @ inc-35 / PR #44).

1. **Inventory** — done (design doc). 4 `app.js` call sites (`fetchHistoricalFx` ×3, `fetchFxRates` ×1),
   **zero** `pb-views.js` / `pb-modals.js` / `sw.js` / `backend/worker.js` references. Free identifiers
   of the block: `fetch` (native) and `DISPLAY_CURRENCIES` (the one seam, injected via `configure`).

2. **Characterization FIRST (rule #3 — FX feeds `convertCcy` and the locked deposit rate).** Build a
   14-scenario matrix in a shared module, then run it against the block **sliced out of
   `git show HEAD:app.js`** and evaluated with an injected `fetch` + frozen `Date.now`. Record the
   digest. Only then move.

3. **Verbatim move** — Node slice script (BOM + LF safe; read/write `utf8`, keep the BOM, splice with
   **replacement functions** so `$&`/`$'` never expand). Assert both boundaries by content before
   cutting. Re-indent the captured source by 2 spaces to match the `pb-data.js` IIFE, and **assert the
   indent is reversible** (stripping it reproduces the captured bytes exactly) so "verbatim" stays
   provable. Insert above the `const PBData = {` export object with a section comment explaining why a
   second, simpler ladder exists next to `fetchViaProxies`.

4. **The config seam** — `const cfg = { indicatorCatalog: null };` →
   `{ indicatorCatalog: null, displayCurrencies: null };`; `fetchFxRates` gains
   `const DISPLAY_CURRENCIES = cfg.displayCurrencies || [];` as its first statement (rest of the body
   byte-identical); `app.js` extends its existing single `PBData.configure({ … })` call. Ordering is
   safe: bind at `app.js:317` < configure at `app.js:339`.

5. **Bind back + pointer comments** — `const fetchFxRates = PBData.fetchFxRates;` +
   `const fetchHistoricalFx = PBData.fetchHistoricalFx;` at the old definition site (TDZ-safe: every
   call site is inside a function body). `FX_PROXIES` is **not** bound back — it is module-private to
   `pb-data.js` now. Export both from `PBData`, plus a `_resetFxCache()` test hook (the
   `_setLastGoodProxy` precedent) since `HISTORICAL_FX_CACHE` is module-private.

6. **Post-move characterization** — re-run the *same* matrix against `PBData`; `diff` the digests. Must
   be identical. Then commit it as `backend/test/fx-providers.test.mjs` (35 assertions) including
   anti-drift guards: no `function fetchFxRates` / `fetchHistoricalFx` in `app.js`, both bound from
   `PBData`, both defined in `pb-data.js`, no `FX_PROXIES` / `HISTORICAL_FX_CACHE` left in `app.js`,
   `displayCurrencies` injected, and `pb-data.js` free of any `PBContent.` reference.

7. **Wiring** — bump `sw.js` `CACHE_NAME` v86 → **v87**. No new runtime file, so the 4-point wiring
   checklist does not apply: `pb-data.js` is already in `index.html`, `SHELL_ASSETS`, `static.yml` (both
   the `cp` list and the Guard-1 loop) and every `verify-*.mjs` harness shell.

8. **Docs** — `GAPS.md` #7 marked FIXED, with the `pLimit`/de-dupe half explicitly carried forward as an
   open follow-up (severity dropped to Low-Medium); `PROJECT.md` module table (line count + FX in the
   `pb-data.js` description); `architecture-map.html` FX node (`path` + `notes` → pb-data line numbers);
   `SECURITY_ROADMAP.md` third-party table (`FX_PROXIES`, app.js → pb-data.js);
   `REFACTOR_STATUS.md` Done + Current-state, including the Phase-4-floor audit result.

9. **Verify (all green before commit)** — `node --check app.js` + `node --check pb-data.js`; the full
   node suite (**29/29**, money gate + content guard + deploy-assets); before/after digest `diff`;
   a **load-order probe** that loads the real `pb-core`/`pb-data`/`pb-content` in `index.html` order,
   replays the 4 real `app.js` wiring statements, and asserts the binds resolve, the injection actually
   reaches the provider (JPY filtered out), and 4 call sites remain; U+FFFD / CR / BOM scan on both
   touched files.

10. Commit + push to the feature branch. **No PR, never `main`.**

## Read-out (measured)

- `app.js` **5037 → 4999** lines (−38); `pb-data.js` **961 → 1030** (+69, incl. the section comment,
  the injected-config lines and the test hook). `app.js` now holds **no network code**.
- Bridge **unchanged at 38** (FX was never a bridge member).
- Before/after characterization digests: **identical**, all 14 scenarios.
- Node suite **29/29** (28 pre-existing + the new `fx-providers`), money gate green.
- Load-order probe: `order ok: DISPLAY_CURRENCIES@317 < configure@339 ; binds @1131,1132` →
  `injection ok: rates filtered to USD,ZAR (JPY dropped)` → `call sites intact: 4`.
- `sw.js` `CACHE_NAME` = **playbook-shell-v87**.
- The committed browser mount gate still does not mount in this container (unpkg React is 403-blocked
  from here); it fails identically on pristine `HEAD`, so the load-order probe above stands in for it —
  the same accommodation inc-33/34/35 used.

## Follow-up commit — the `pLimit`/de-dupe half of GAPS #7

Done on the same branch, guarded by the matrix the relocation commit built.

- **`fxFetch(url, cacheMode)`** wraps every FX `fetch()` in the shared `_fetchLimit` (`pLimit(8)`), so FX
  requests can no longer bypass the app-wide concurrency cap.
- **In-flight de-dupe**: `fetchHistoricalFx` becomes a thin wrapper (short-circuits + cache + `_fxInflight`
  keyed on `date:code`) delegating to `_fetchHistoricalFxUncached`; `fetchFxRates` gets a single
  `_fxRatesInflight` slot. Both release on settle, so a *failed* lookup still re-fetches on retry — the
  "failures are not cached" rule is preserved. `_resetFxCache()` clears both maps.
- **Deliberately NOT folded onto `fetchViaProxies`**: it is proxy-only (dropping the direct-first attempt),
  hard-codes `cache:'no-store'`, and returns text. The FX cache directives are load-bearing.
- **Verification**: all **35** original assertions pass **unchanged**; the before/after digest still matches
  the pre-move `app.js` byte-for-byte; **+9** new assertions (concurrent identical lookups collapse to one
  request, different ones don't, the in-flight slot releases on both success and failure, and 20 parallel
  lookups peak at exactly **8** concurrent — unbounded before). Suite **29/29**. No `CACHE_NAME` re-bump:
  v87 has not been deployed yet, so it still uniquely identifies the final shipped content of this branch.
- **Honest read-out**: the original GAPS #7 premise overstated the risk. `fetchHistoricalFx` is called from
  a *sequential* import loop (`app.js:2199`) and from single user actions, and the completed-value cache
  already collapsed sequential repeats — at most ~2 FX fetches were ever concurrent. The cap closes an
  unbounded-by-design path and future-proofs parallelising that loop, but it fixed a **latent** problem.
