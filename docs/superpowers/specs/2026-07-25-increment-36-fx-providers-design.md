# Increment 36 — FX providers → `pb-data.js` (design)

## Why

This increment closes **GAPS.md #7, "FX fetching is the last network code still inside app.js."** It is
*not* a Phase 4 bucket move — it is the Phase 2 module-extraction pattern, applied to the one network
block that was explicitly deferred when `pb-data.js` was carved out.

It was chosen after an exhaustive re-audit established that **Phase 4 has no verbatim-move candidate
left**. inc-33, inc-34 and inc-35 each corrected a previous "the bridge has reached its floor" claim, so
that claim was re-tested rather than trusted, this time by enumerating every one of the 38
`window.PBApp` members and counting its real callers in `app.js` / `pb-views.js` / `pb-modals.js`
(comments and the publish line excluded). Result: **the floor at 38 is real.** The four members that
looked movable are not:

| Member | Callers | Why it stays |
|---|---|---|
| `useHotStocks` | pb-views only | needs `poolMap`, which has a second `app.js` caller (`fetchEarningsDateSA` batching) → net-0 swap |
| `buildSuggestions` | pb-views only | reads `DATA.findInfo` / `_sectorLookup` / `HOLDINGS` / `*_SUGGESTIONS` — `DATA`-coupled (inc-30 `resolvePositionSector` precedent) |
| `searchListingsMulti` | pb-modals only | needs `fetchYahooSearch`, which `TickerSearch` also calls → net-0 swap |
| `TickerSearch` | both buckets | needs `ALL_TICKERS` (DATA-derived) **and** `sameUnderlyingExchange` (4 other app.js callers) bridged → net **worse** |

So the remaining refactor value is no longer in the bridge; it is in the ~38 lines of impure network
code still sitting in the monolith. `PROJECT.md` and `SECURITY_ROADMAP.md` both already describe FX as
app.js-resident, and `GAPS.md` #7 had it pre-scoped as "a single task that follows the established
recipe."

## What moves

A contiguous-in-spirit but physically split block, all with **zero** `pb-views.js` / `pb-modals.js` /
`sw.js` / `backend/worker.js` references:

| Thing | Was | Callers |
|---|---|---|
| `FX_PROXIES` (4-entry ladder + its comment) | `app.js:327–333` | only the two FX readers |
| `HISTORICAL_FX_CACHE` | `app.js:1126` | only `fetchHistoricalFx` |
| `fetchHistoricalFx` | `app.js:1127–1150` | 3 `app.js` call sites (deposit / cost-basis date locking) |
| `fetchFxRates` | `app.js:1151–1171` | 1 `app.js` call site (the FX snapshot refresh) |

All four call sites stay in `app.js`, so both functions are **bound back** (`const fetchFxRates =
PBData.fetchFxRates;`) exactly like `fetchQuote` / `fetchHistory` — the call sites are untouched.

## The one seam: `DISPLAY_CURRENCIES`

`fetchFxRates` filters the upstream rate table through `DISPLAY_CURRENCIES`, which lives in
`pb-content.js`. `pb-data.js` must **not** reach for `PBContent` — it is dual-mode and loaded by Node
tests where no such global exists (this is why `cfg`/`configure` exists at all). So it follows the
established `indicatorCatalog` precedent: `app.js` injects it once via

```js
PBData.configure({ indicatorCatalog: RIBBON_CATALOG_MAP, displayCurrencies: DISPLAY_CURRENCIES });
```

and `fetchFxRates` resolves `const DISPLAY_CURRENCIES = cfg.displayCurrencies || [];` as its first
statement, leaving the rest of the body byte-identical. Ordering is safe and asserted: the
`DISPLAY_CURRENCIES` bind is `app.js:317`, the `configure` call `app.js:339`.

## Rule #3: this is money-adjacent code

FX rates feed `convertCcy`, and `fetchHistoricalFx` supplies the **locked landed-USD rate** that deposit
profit depends on — the exact semantics CLAUDE.md rule #3 says must never be "fixed" during a refactor.
So behaviour was pinned **before** the move, not after: a 14-scenario matrix was run against the FX block
sliced verbatim out of `git show HEAD:app.js` (evaluated with an injected `fetch`), then the *same*
matrix was run against `PBData` after the move. **The two digests are byte-identical.**

The matrix deliberately pins the things a rewrite would quietly lose:

- the FX ladder is **direct-first** — entry 0 is the bare url, proxies are only the fallback (this is
  what makes it different from the hardened `fetchViaProxies` chain);
- `fetchFxRates` sends `cache:'no-store'`; `fetchHistoricalFx` sends `cache:'force-cache'`;
- a payload with **no** `result:'success'` is still accepted when `rates` exists;
- `USD` is forced to `1`, and a result needs **≥ 2** rates to count as a hit (a single-rate response
  keeps walking the ladder);
- historical lookups exhaust **all 4 proxies on frankfurter** before trying exchangerate.host;
- zero / negative / non-numeric rates are skipped;
- a **successful** historical rate is cached; a **failed** one is **not** (a retry re-fetches);
- key-insertion order in the returned `rates` object (`{USD,ZAR,GBP}` vs `{ZAR,EUR,USD}`) is preserved.

## What is deliberately NOT in this increment

GAPS #7's fix line also says "route through `pLimit`/de-dupe." That is a **behaviour change**, not a
relocation: the FX ladder is direct-first and the shared `fetchViaProxies` chain is not, and the two
disagree about what counts as a failed response (`looksLikeProxyError` would reject short/HTML bodies
the FX readers currently accept). Bundling it would forfeit the byte-identical guarantee that makes this
move safe. It stays open in GAPS #7 as a follow-up, now with a committed characterization matrix to
guard it — which is the whole point of doing the relocation first.

## Result

`app.js` 5037 → 4999 lines; `pb-data.js` 961 → 1030. `app.js` now contains **no network code**.
The `window.PBApp` bridge is untouched at **38** (FX was never a bridge member — it is app.js-internal
infra, not shared UI).
