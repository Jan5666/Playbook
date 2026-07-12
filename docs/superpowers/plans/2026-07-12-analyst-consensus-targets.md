# Analyst consensus price target — implementation plan

Spec: [2026-07-12-analyst-consensus-targets-design.md](../specs/2026-07-12-analyst-consensus-targets-design.md)
Branch: `fix/fundamentals-stock-cards` (off origin/main a79ef58).

## Task 1 — parser test first (red)

`backend/test/sa-forecast-parse.test.mjs`, zero-framework `ok()` style:

- Build synthetic SvelteKit devalue payloads (flat `data` array, objects are
  key→index maps, `-1` = undefined; include a non-data node and a node
  without forecast keys to mimic the real 3-node shape).
- Cases: US curated targets (USD, no scaling); LSE GBX ÷100; JSE with empty
  curated `targets` (count 0, nulls) falling back to spg `priceTargets` in
  ZAc ÷100; `Strong Buy` → `strong_buy`; both sets empty → null; malformed /
  HTML / null json → null; `updated` date → `targetUpdated` ms.
- `mergeFundamentals([forecastPartial, timeseriesFull])`: analyst fields from
  the partial, ratios from timeseries, `source` joined.
- Source guards (grep app.js): `PBCore.parseSAForecast(` call site;
  `fetchAnalystForecastSA` body contains `fetchViaProxies` AND a
  `Promise.race`/timeout marker; `fetchFundamentalsYahoo` divides target
  fields by `divisor`; `fetchFundamentals` passes the forecast part first.

Run: `node backend/test/sa-forecast-parse.test.mjs` → must FAIL (no export).

## Task 2 — pb-core.js `parseSAForecast` (green)

After `mergeFundamentals`: devalue resolver + extraction per spec, export in
`PBCore`. Sanity: `node -e "console.log(typeof require('./pb-core.js').parseSAForecast)"`
and rerun Task 1 test against the captured real AAPL/NPN/LGEN payloads
(scratchpad, dev-only) — expect 323.07 USD / 1261.5931 ZAR / 2.6442 GBP means.

## Task 3 — app.js wiring

1. `fetchAnalystForecastSA(ticker, market)` next to the other SA fetchers,
   with the why-proxied-here comment (no ACAO on `__data.json`) + 12 s outer
   race.
2. `fetchFundamentals`: `Promise.all([forecast, saProbe, ts])` (non-crypto),
   parts order `[forecast, sa, ts]`.
3. `fetchFundamentalsYahoo`: divide `targetMean/High/Low` by `divisor`.
4. `FundamentalsBlock` analyst card: attribution sub-line
   "Updated {Mon D} · stockanalysis.com" when `f.targetUpdated` present
   (styles: reuse `analyst-range-label` / muted text-xs classes — check
   styles.css for an existing fit before adding CSS).

`node --check app.js` after each edit. Mind BOM/CRLF: use Edit tool on exact
strings, no `\uXXXX` content touched (analyst card copy is plain ASCII).

## Task 4 — sw.js

`CACHE_NAME` `playbook-shell-v54` → `v55`.

## Task 5 — verify

- Full node suite loop (19+1 files) — all green.
- Money gate explicitly: money-math, cost-basis, import-matching,
  ee-ocr-parse.
- `node backend/test/verify-refresh-behavior.mjs` (mount gate).
- Manual-ish check: temporary Node script hits the real endpoint for one US +
  one JSE ticker through the parser to confirm live shape (dev-only, not
  committed).

## Task 6 — hand over

No commits/pushes (Jan lands it). Update memory note
`stockanalysis-api-dead.md` (forecast `__data.json` is the analyst-targets
source now; proxied-but-time-boxed exception documented). Summarise diff for
Jan with the spec path.
