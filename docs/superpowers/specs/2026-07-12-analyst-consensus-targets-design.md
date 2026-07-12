# Analyst consensus price target on stock cards — design

**Date:** 2026-07-12
**Goal:** the stock card shows an analyst consensus price target underneath the
fundamentals data, derived from a credible source.

## Problem

The fundamentals block already contains a fully built "Analyst targets" card
(mean target, upside vs. current price, consensus rating, low–high range —
app.js `FundamentalsBlock`, rendered *after* the stats grids, i.e. exactly
"underneath the fundamentals data"). It renders only when `f.targetMean` is
set, and no live source sets it anymore:

- **stockanalysis.com `/api/symbol`** (the old supplier of `targetMean` /
  `recommendation`) went 404-dead on 2026-07-12. The probe remains but returns
  null.
- **Yahoo fundamentals-timeseries** (the live keyless source) is statement
  data only — it hard-codes `targetMean: null`.
- **Yahoo quoteSummary** carries a true consensus (`targetMeanPrice` etc.) but
  is crumb-gated (401 "Invalid Crumb") and only tried when *every* other
  source failed — which never happens while timeseries works.
- **Perplexity** is key-gated and gated behind the same "everything else
  failed" condition.

Net effect: ratios render, the analyst card never does.

## Source decision

Verified live on 2026-07-12 (curl, response shapes captured):

1. **stockanalysis.com forecast page-data — CHOSEN.**
   `https://stockanalysis.com/stocks/{ticker}/forecast/__data.json` (US) and
   `https://stockanalysis.com/quote/{exchange}/{TICKER}/forecast/__data.json`
   (JSE/LON/ASX/…) is the SvelteKit data endpoint behind their public
   forecast page. It carries an S&P Global Market Intelligence consensus
   (`priceTargets`: avg / median / low / high / analyst count, tagged
   `source: "spg"`), a ratings consensus (`currentRatings`: Buy/Hold/…,
   count, breakdown), and stockanalysis's own curated target set (`targets`,
   with an `updated` date). Confirmed working for AAPL (USD), Naspers NPN
   (JSE, prices in **ZAc** rand-cents) and Legal & General LGEN (LSE, prices
   in **GBX** pence). Credible: S&P Global data via a reputable aggregator,
   the same numbers stockanalysis.com publishes on its forecast pages.
2. Yahoo quoteSummary `financialData` — true consensus but crumb-gated;
   unusable keyless. Stays as the existing last-chance fallback (with a
   latent unit bug fixed, see below).
3. Yahoo insights (`ws/insights`) — keyless but a *single* research
   provider's target (Argus/Trading Central), not a consensus, and a ~300 KB
   payload. Rejected.
4. Keyed APIs (Finnhub, FMP, Alpha Vantage) — price targets are behind paid
   tiers and the app is keyless by design (Perplexity excepted). Rejected.

## Transport: proxied, but time-boxed — and why that's allowed

`__data.json` sends **no `Access-Control-Allow-Origin` header** (verified
with an explicit `Origin:` request header), so a direct browser fetch can
never read it — it must ride `fetchViaProxies`. This deliberately differs
from the "SA fetchers stay direct, never proxied" guard in
`fundamentals-parse.test.mjs`, whose rationale was a *dead* URL burning the
serial proxy cascade (~25 s) inside the `Promise.all` that gates the stats
render. Distinctions here:

- the forecast endpoint is alive (HTTP 200, JSON), not a dead 404 tree;
- direct fetch is not an option (no ACAO), so "direct + time-boxed" cannot
  work at all;
- the fetch gets an **outer 12 s time-box** (`Promise.race`) so even a
  pathological proxy-chain crawl can never hold the stats render hostage —
  worst case the card ships without targets for that 6 h TTL cycle, which is
  exactly today's behaviour.

The old `/api/symbol` probe and its direct-only source guard stay untouched.

## Design

### pb-core.js — `parseSAForecast(json, market)` (pure, unit-tested)

1. Resolve the SvelteKit "devalue" flat-array nodes (objects are key→index
   maps into the node's `data` array; `-1` = undefined). Small internal
   resolver, cycle-safe.
2. Find the node whose root has `targets` / `priceTargets`.
3. Pick the target set: stockanalysis's curated `targets` when `count > 0`
   (it is what their public page headlines, and has an `updated` date),
   else S&P Global `priceTargets` when `numPriceTargets > 0` (covers JSE
   names the curated set skips). Neither → null.
4. Scale prices to natural units with the block's own currency code:
   `centDivisor(market, currency)` already maps ZAc/ZAX/GBX/GBp → 100.
   Result matches `quote.price` units, so the card's upside math is correct.
5. Consensus rating from `currentRatings.consensus` mapped to the existing
   `recommendationKey` vocabulary (`Strong Buy` → `strong_buy`, …).
6. Return a **partial** fundamentals object — analyst fields only:
   `{ targetMean, targetHigh, targetLow, analystCount, recommendation,
   targetUpdated, fetchedAt, source: 'sa-forecast' }` (nulls allowed per
   field), or `null` when nothing usable. `mergeFundamentals` already merges
   partials with different key sets (earlier part wins per field).

### app.js

- `fetchAnalystForecastSA(ticker, market)`: build the URL (US path vs
  `/quote/{ex}/` path from the existing `SA_EXCHANGE` map, lowercase
  exchange), `fetchViaProxies`, `JSON.parse`, delegate to
  `PBCore.parseSAForecast`. Outer 12 s `Promise.race` time-box.
- `fetchFundamentals`: for non-crypto, add the forecast fetch to the existing
  parallel `Promise.all` and put its result **first** in `parts[]` so its
  analyst fields win the merge.
- **quoteSummary unit fix:** `fetchFundamentalsYahoo` returns
  `targetMean/High/Low` raw while dividing `bookValue` by the pence/cents
  divisor — a latent 100× bug for LSE/JSE names whenever that path fires.
  Divide the three target fields by the same `divisor`.
- **Analyst card sub-line:** when `targetUpdated`/`source` indicate the new
  source, render a small attribution line in the existing analyst card:
  "Updated {date} · stockanalysis.com". No other UI change — the card and
  its placement already satisfy the goal.

### sw.js

`CACHE_NAME` v54 → v55 (shipped files change). No new runtime file — the
parser extends pb-core.js precisely to avoid the 4-step new-file wiring.

## Out of scope (YAGNI)

Ratings-breakdown bars, the 1–5-month filtered target sets, the forecast
price chart, median target display, Worker changes, Perplexity prompt
changes.

## Error handling

Any failure (proxy chain exhausted, Cloudflare challenge HTML, shape change,
count 0, timeout) → the part is null → merge proceeds without analyst fields
→ card renders exactly as today. `looksLikeProxyError` is safe for this
payload (body head starts `{"type":"data"`, no `"error":` in the first 200
chars).

## Testing

- New `backend/test/sa-forecast-parse.test.mjs` (zero-framework, same
  conventions): synthetic devalue payloads pin — US pass-through (USD,
  divisor 1); GBX pence scaling ÷100; ZAc + empty curated `targets` → spg
  fallback ÷100; consensus label mapping; count-0 / garbage / HTML / null →
  null; merge with the partial first keeps analyst fields and fills the rest
  from timeseries. Source guards: app.js calls `PBCore.parseSAForecast(`,
  the new fetcher rides `fetchViaProxies` **and** contains the outer
  time-box, and `fetchFundamentalsYahoo` divides targets by the divisor.
- Existing suites must stay green, incl. the money gate (untouched but run:
  money-math, cost-basis, import-matching, ee-ocr-parse) and
  `verify-refresh-behavior.mjs` (the mount gate) since module boundaries are
  touched.
