# Phase 2 — Consolidate data layer (increments 1+2)

**Date:** 2026-06-26
**Branch base:** `main` (head 5180f6d, post-Phase-1)
**Scope this round:** Increment 1 (extract headless data layer) + Increment 2 (concurrency limiter + in-flight de-dupe). **Increment 3 (fan-out / lazy `tickersToFetch` split) is deferred to its own round.**

Companion to the refactor memory `playbook-refactor-priorities` (Phase 2 = P1 "consolidate data layer") and `playbook-architecture-audit` (findings A5, C2, D1, E1, E4).

## Goal

Extract the client-side price/quote network layer out of the 14k-line `app.js` monolith into a single headless, independently-testable module (`pb-data.js`), mirroring the Phase-1 `pb-core.js` carve-out. Then make the fetch path gentler on the shared CORS proxies (concurrency cap + collapse duplicate in-flight requests) without changing the data the UI sees.

Non-goals this round: reducing the fetch fan-out (the `tickersToFetch` universe), moving providers to per-file modules, introducing a build step, or moving the **FX rate fetchers** (`fetchHistoricalFx`/`fetchFxRates` — they use a distinct `FX_PROXIES` ladder, call `fetch()` directly so they gain nothing from the new de-dupe/limiter, and `fetchFxRates` depends on the app-level `DISPLAY_CURRENCIES` table). FX folds in cheaply later; it stays in `app.js` this round. Those are later increments/phases.

## Constraints (inherited)

- **No build step.** Raw classic `<script>` tags loaded in order. Each new file = one `<script>` tag + sw.js precache entry + cache-version bump + deploy allowlist entry.
- **`pb-core.js` is the pure, worker-shared core.** The data layer is impure (network, proxies, `localStorage`) and client-only — the push Worker has its own inline fetch and must not import `pb-data.js`. So the data layer gets its own file, not `pb-core.js`.
- **Sequencing rule:** never refactor a function without a characterization test pinning current behavior first (especially money + network orchestration). Increment 1 carves with tests written first; behavior is bit-for-bit preserved.
- **Deploy publishes a runtime-asset allowlist only** (Phase-0 hardening). `pb-data.js` must be added to the allowlist + guard, or the deployed site won't load.

## Section 1 — Module boundary

New file `pb-data.js` at repo root. Dual-mode, same pattern as `pb-core.js`:
- Browser: assigns `globalThis.PBData = { ... }`.
- Node tests: `module.exports = PBData` (CommonJS) so `backend/test/*.test.mjs` can `require('../../pb-data.js')` with a mocked `globalThis.fetch`.

### Moves to `pb-data.js` (from `app.js` ~lines 560–1330)

- **Proxy ladder:** `CORS_PROXIES`, `orderedProxies`, `lastGoodProxy`, `looksLikeProxyError`, `fetchViaProxies`. (The separate `FX_PROXIES` ladder + `fetchHistoricalFx`/`fetchFxRates` stay in `app.js` this round — see Goal/non-goals.)
- **Yahoo provider:** `fetchQuote`, `fetchQuoteLight`, `fetchHistory`, `parseHistoryResult`.
- **Stooq provider:** `stooqSymbol`, `parseStooqCsv`.
- **Morningstar unit-trust provider:** `MORNINGSTAR_KEY`, `MORNINGSTAR_UNIVERSE`, `isUnitTrustId`, `unitTrustSearchTerm`, `fetchMorningstarRows`, `searchUnitTrusts`, `morningstarRowToQuote`, `fetchUnitTrustQuote`, `unitTrustRangeStart`, `fetchUnitTrustHistory`.
- **FRED / indicator provider:** `FRED_TTL_MS`, `_fredCache`, `parseFredCsv`, `fetchFredSeries`, `fredAsOf`, `fredTransformSeries`, `rangeCutoffMs`, `indicatorQuoteFromSeries`, `indicatorHistoryFromSeries`, `fetchFredIndicatorQuote`, `fetchFredIndicatorHistory`, `buildGliSeries`, `fetchGliQuote`, `fetchGliHistory`, `vixToMood`, `fetchVixMoodQuote`, `fetchVixMoodHistory`, `fetchIndicatorQuote`, `fetchIndicatorHistory`.
- **Batchers:** `fetchQuoteBatch`, `fetchQuoteBatchLight`.
- **Name cache:** `CURATED_NAMES`, `NAME_CACHE`, `NAME_CACHE_KEY`, `_flushNameCache`, `cacheName`, `cachedName`. It is data-layer state populated from quote responses; it is in `BACKUP_SKIP` (not cloud-backed, no `_backupNotify`), so it persists via `localStorage` directly (guarded with `typeof localStorage !== 'undefined'` so node tests are a no-op persist). Byte-for-byte identical behavior.

### Stays in `app.js`

- `usePriceFeed` (React hook) — becomes a thin consumer calling `PBData.fetchQuoteBatch`.
- `tickersToFetch` (React `useMemo`) — increment 3, deferred.
- `RIBBON_CATALOG` / `RIBBON_CATALOG_MAP` — UI/content config (carries display labels + groups). Injected into `pb-data` (see Section 2).
- `priceKey` — moves to `pb-core.js` (see Section 2), bound back into `app.js`.

## Section 2 — Dependencies & load order

`pb-data.js` depends **only upward on `pb-core.js`** — never reaches into `app.js` top-level globals (that would work in-browser via the shared global lexical scope but break node tests and hide coupling).

Uses from `pb-core`: `yahooSymbol`, `centDivisor`, `parseYahooQuote`, `buildDailyBars`, `derivePrevClose`, `deriveIntradayExt`, `MARKET_CURRENCY`, and the newly-moved `priceKey`. In browser it reads `window.PBCore`; in node it `require('../../pb-core.js')`.

Two couplings resolved:

1. **`priceKey` → moves into `pb-core.js`** (pure `market + ':' + ticker`, used by both layers; a duplicated copy is exactly the drift risk Phase 1 fought). `app.js` adds `const priceKey = PBCore.priceKey` next to the other `PBCore.x` binds so its ~30 call sites are unchanged. Anti-drift source guard asserts no `function priceKey` remains in `app.js`/`pb-data.js`.
2. **Indicator routing → injected config.** `app.js` calls `PBData.configure({ indicatorCatalog: RIBBON_CATALOG_MAP })` once at startup (before any fetch). Inside `pb-data`, `fetchQuote`/`fetchHistory` do `const cat = cfg.indicatorCatalog?.[priceKey(market, ticker)]; if (cat && cat.source) return fetchIndicatorQuote(cat)` — identical logic to today, catalog passed by reference. Catalog (with its UI metadata) stays in `app.js`.

**Load order in `index.html`:** `react → react-dom → pb-core.js → pb-data.js → data.js → app.js`. `pb-data` references `PBCore`/`cfg` only inside function bodies (call-time), so load order only needs `pb-core` before `pb-data`, and `PBData.configure(...)` to run before the first fetch (it runs at `app.js` module top, well before any poll).

`app.js` binds the functions it still calls via `const fetchQuoteBatch = PBData.fetchQuoteBatch` (and `fetchQuote`, `fetchHistory`, `fetchQuoteBatchLight`, `searchUnitTrusts`, `cachedName`, `cacheName`, `isUnitTrustId`, etc. — whatever `app.js` references directly), matching the Phase-1 `PBCore.x` binding pattern so call sites are untouched.

**Increment 1 is a pure carve-out: zero behavior change, characterization tests written and green before the move.**

## Section 3 — Increment 2: concurrency limiter + in-flight de-dupe

Both are transparent: identical data out, fewer simultaneous proxy requests. Added after increment 1 lands, each pinned RED-first.

- **In-flight de-dupe.** A module-level `Map<url, Promise<string|null>>` inside `fetchViaProxies`. On entry, if `url` already has an in-flight promise, return it; otherwise start the proxy walk, store the promise, and `delete` the entry when it settles. Collapses concurrent identical upstream requests (e.g. an auto-poll, a manual refresh, and a detail view all wanting the same `^VIX` daily URL). `cacheBust` appends `&_=<Date.now()>` so manually-refreshed URLs are distinct and bypass de-dupe automatically — no special-casing.
- **Global concurrency limiter.** A small pure `pLimit(n)` async-queue helper added to `pb-core.js` (pure, unit-testable, reusable). `fetchViaProxies` runs each real `fetch()` through a shared `pLimit` instance (cap ~6–8) so total concurrent network calls are bounded across *all* sources — `fetchQuoteBatch` (8-wide), `fetchQuoteBatchLight` (16-wide), and ad-hoc detail/history fetches no longer stack into one big burst. The existing batch-size loops stay (they also pace the second-pass retry); the limiter is a backstop across overlapping callers.

Interaction: de-dupe wraps the whole proxy walk (keyed by upstream `url`); the limiter wraps the individual `fetch()` calls inside the walk. A de-duped request consumes one limiter slot, not one per caller.

## Section 4 — Testing

Node, in `backend/test/`, run individually with `node X.test.mjs` (no npm script — matches existing 8-suite convention). Mock `globalThis.fetch` to return canned proxy/Yahoo/Stooq/FRED payloads.

Increment 1 (characterization — written first, must pass against current behavior once the carve lands):
- Proxy ladder: `looksLikeProxyError` classification (short body, HTML, rate-limit phrases, `"error":`); `orderedProxies` floats `lastGoodProxy` to front; `fetchViaProxies` falls through failing proxies and returns first clean body / `null` when all fail; sets `lastGoodProxy` on success.
- `fetchQuote`: daily-only happy path; daily+intraday splice when the daily quote looks stale (>30 min); Stooq fallback for US/JSE when Yahoo yields nothing; indicator routing via injected catalog; unit-trust routing via `isUnitTrustId`.
- `parseStooqCsv`: close/prevClose from last two rows, JSE `/100`, currency/marketState/source fields.
- `fetchQuoteBatch`: batches of 8, `onBatch` fires per batch with only that batch's fresh quotes, second pass retries only the symbols still missing.
- Anti-drift source guard: assert `app.js` no longer defines `function fetchViaProxies`/`fetchQuote`/`fetchQuoteBatch`/`parseStooqCsv` etc. and that `pb-data.js` exports them (same guard style as `markets-core`/`quote-parsers`).

Increment 2:
- De-dupe: two concurrent `fetchViaProxies(sameUrl)` calls trigger exactly one underlying `fetch` to the upstream and both resolve to the same body; a `cacheBust` variant is *not* de-duped.
- Limiter: with cap N and M>N concurrent requests held open, peak concurrent `fetch` invocations never exceeds N; all eventually resolve; `pLimit` unit tests (ordering, n=1 serializes, errors don't wedge the queue).

## Section 5 — Mechanical / deploy steps

- `index.html`: add `<script src="./pb-data.js"></script>` between `pb-core.js` and `data.js`.
- `sw.js`: add `pb-data.js` to the precache list; bump cache version (v32 → v33).
- Deploy workflow (`static.yml`): add `pb-data.js` to the runtime-asset allowlist staged into `_site/` and to the leak/missing guards.
- No worker impact (worker keeps its own inline fetch) → **no `wrangler deploy` needed** for this round.

## Section 6 — Increment breakdown (each independently mergeable)

- **Increment 1 — extract.** Write characterization tests → move `priceKey` to `pb-core` (+ guard) → create `pb-data.js` and move the data layer in → add `PBData.configure` + the `app.js` `const x = PBData.x` binds → wire `index.html`/`sw.js`/allowlist → full node sweep green → commit.
- **Increment 2 — de-dupe + limiter.** Add `pLimit` to `pb-core` (RED-first unit tests) → add URL-keyed de-dupe + limiter to `fetchViaProxies` (RED-first) → sweep green → commit.

## Open items / risks

- `pb-data.js` must exist as `window.PBData` before `app.js`'s top-level binds run (same invariant as `window.PBCore` today). A missing/failed `pb-data.js` tag breaks the app — the deploy guard already fails on a missing runtime asset.
- `app.js` ships CRLF; `pb-data.js`/`pb-core.js` edits use `\n` (the Edit tool normalizes CRLF on match). vm-slice test markers (if any) must avoid `\n` — but these suites `require` the module rather than vm-slice, so this is moot.
- Name-cache `localStorage` access in `pb-data` must be guarded for node (no `localStorage` global) so tests don't throw.
- Update the `playbook-refactor-priorities` and `playbook-architecture-audit` memories on completion (Phase 2 progress + drifted line numbers).
