# Phase 2 Data-Layer Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carve the client-side quote/price/history network layer out of `app.js` into a headless, independently-tested `pb-data.js` module (increment 1), then make the proxy fetch path gentler with an in-flight de-dupe + global concurrency limiter (increment 2).

**Architecture:** New classic `<script>` `pb-data.js` (browser global `PBData` + CommonJS `module.exports`, mirroring `pb-core.js`). It depends only upward on `pb-core.js`; app-specific config (the indicator catalog) is injected via `PBData.configure(...)`. `app.js` keeps its React hooks (`usePriceFeed`, `tickersToFetch`) and binds the moved functions via `const x = PBData.x`, exactly like the Phase-1 `PBCore.x` pattern. The pure `priceKey` helper and a new pure `pLimit` utility move into `pb-core.js`.

**Tech Stack:** Vanilla ES (no build step, no JSX), React 18 UMD (unchanged), Node `.mjs` test files run individually with `node X.test.mjs`, a Cloudflare service worker (`sw.js`) precache, and a GitHub Pages allowlist deploy (`.github/workflows/static.yml`).

## Global Constraints

- **No build step.** Plain classic scripts loaded in order in `index.html`. Each new file ⇒ one `<script>` tag + one `sw.js` precache entry + a cache-version bump + one `static.yml` allowlist+guard entry.
- **`pb-core.js` = pure, side-effect-free, worker-shared.** No network/DOM/`localStorage`. `pb-data.js` = impure, client-only; the Cloudflare worker (`backend/worker.js`) and the service worker (`sw.js`) keep their own inline fetch and must **not** import `pb-data.js`.
- **Dual-mode footer (both new/edited modules):** `if (typeof module !== 'undefined' && module.exports) module.exports = X;` and `if (typeof globalThis !== 'undefined') globalThis.X = X;`.
- **Bind pattern (in `app.js`):** never reintroduce a moved `function`; bind with `const name = PBData.name;` / `const name = PBCore.name;` so existing call sites are untouched.
- **TDD, RED first.** Write the failing test, watch it fail for the right reason, then implement. Commit after each green task.
- **Test runner:** no npm script. Tests live in `backend/test/*.test.mjs`, run with `cd backend/test && node <file>.test.mjs`, use the house `ok(name, cond)` helper + `process.exit(failures ? 1 : 0)`, and `import PBCore from '../../pb-core.js'` / `import PBData from '../../pb-data.js'`.
- **Anti-drift guard:** every extraction test reads `app.js` source and asserts (a) it binds the name from the module and (b) it carries no local `function <name>(` definition — matching `markets-core.test.mjs` / `quote-parsers.test.mjs`.
- **No worker/SW changes, no `wrangler deploy`** this round.
- **Line endings:** `app.js` is CRLF; the Edit tool normalizes CRLF on match, so `\n` old-strings match. New files (`pb-data.js`, tests) are written with `\n`.

---

## Task 1: Move `priceKey` into `pb-core.js`

`priceKey(market, ticker) => market + ':' + ticker` is a pure helper used by both `app.js` (~30 sites) and the about-to-move data layer. Single-source it in `pb-core` so the two layers can't drift.

**Files:**
- Modify: `pb-core.js` (add `priceKey` inside the IIFE + to the `PBCore` export object)
- Modify: `app.js:623` (replace `function priceKey` with a bind)
- Test: `backend/test/markets-core.test.mjs` (extend — `priceKey` is markets/symbol core)

**Interfaces:**
- Produces: `PBCore.priceKey(market: string, ticker: string) => string` (e.g. `priceKey('US','AAPL') === 'US:AAPL'`). Consumed by `app.js` (bound) and by `pb-data.js` in Task 2+.

- [ ] **Step 1: Write the failing test** — append to `backend/test/markets-core.test.mjs` immediately before the `console.log(failures ...)` line:

```js
// ── priceKey: single-sourced market:ticker key (Phase 2 carve) ───────────────
ok('PBCore exports priceKey', typeof PBCore.priceKey === 'function');
ok("priceKey('US','AAPL')", PBCore.priceKey('US', 'AAPL') === 'US:AAPL');
ok("priceKey('JSE','NPN')", PBCore.priceKey('JSE', 'NPN') === 'JSE:NPN');
ok('app.js binds priceKey from PBCore', /const\s+priceKey\s*=\s*PBCore\.priceKey/.test(appSrc));
ok('app.js has no local function priceKey', !/function\s+priceKey\s*\(/.test(appSrc));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/test && node markets-core.test.mjs`
Expected: FAIL — `PBCore exports priceKey` is false (and the app.js bind/guard rows fail).

- [ ] **Step 3: Add `priceKey` to `pb-core.js`** — inside the IIFE, add the function near the other small helpers (e.g. just below `anyMarketOpen`):

```js
  // market:ticker price-map key — shared so app.js and pb-data.js can't drift.
  function priceKey(market, ticker) { return market + ':' + ticker; }
```

Then add `priceKey,` to the `const PBCore = { ... }` object literal (e.g. right after `anyMarketOpen,`).

- [ ] **Step 4: Replace the `app.js` definition with a bind** — at `app.js:623`:

```js
const priceKey = PBCore.priceKey;
```

(replacing the existing `function priceKey(market, ticker) { return market + ':' + ticker; }`)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend/test && node markets-core.test.mjs`
Expected: PASS — `All markets-core tests passed`.

- [ ] **Step 6: Sanity-check the modules parse**

Run: `node --check pb-core.js && node --check app.js`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add pb-core.js app.js backend/test/markets-core.test.mjs
git commit -m "Move priceKey into pb-core.js (Phase 2 prep — single-source the price-map key)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Scaffold `pb-data.js` + move the CORS proxy ladder

Create the new module and move the leaf the whole data layer sits on: the CORS proxy chain. Providers stay in `app.js` for now; they (and the ~half-dozen other `app.js` callers) reach the moved chain via a bind.

**Files:**
- Create: `pb-data.js` (repo root)
- Modify: `index.html:74` (add `<script>`), `sw.js:2` + `sw.js:9` (precache + cache bump), `.github/workflows/static.yml:44` + `:50` (allowlist + guard)
- Modify: `app.js` — remove `CORS_PROXIES`/`orderedProxies`/`lastGoodProxy`/`looksLikeProxyError`/`fetchViaProxies` (≈ lines 566–611); add binds
- Test: `backend/test/data-proxy.test.mjs` (new)

**Interfaces:**
- Consumes: `PBCore` (none of its members yet, but the require/global pull is established here).
- Produces:
  - `PBData.fetchViaProxies(url: string, opts?: { timeoutMs?: number }) => Promise<string|null>` — returns the upstream body text from the first proxy that yields a clean response, else `null`; sets `PBData._lastGoodProxy` (test seam) on success.
  - `PBData.looksLikeProxyError(body: string) => boolean`
  - `PBData.orderedProxies() => Array<{name,build,unwrap}>`
  - `PBData.configure(opts: object) => void` — merges into internal config (used in Task 3).
  - `PBData._setLastGoodProxy(name|null)` / `PBData._lastGoodProxy` — test-only accessors.

- [ ] **Step 1: Write the failing test** — create `backend/test/data-proxy.test.mjs`:

```js
// Characterization tests for the CORS proxy ladder moved into pb-data.js
// (fetchViaProxies + looksLikeProxyError + orderedProxies / lastGoodProxy float).
//   cd backend/test && node data-proxy.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBData from '../../pb-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };

// Minimal fetch mock: each entry maps a substring → { ok, body }. Records calls.
function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (proxiedUrl) => {
    calls.push(proxiedUrl);
    for (const r of routes) {
      if (proxiedUrl.includes(r.match)) {
        if (r.throw) throw new Error('network');
        return { ok: r.ok !== false, text: async () => r.body, json: async () => JSON.parse(r.body) };
      }
    }
    return { ok: false, text: async () => '', json: async () => ({}) };
  };
  return calls;
}

// looksLikeProxyError classification
ok('exports looksLikeProxyError', typeof PBData.looksLikeProxyError === 'function');
ok('short body is error', PBData.looksLikeProxyError('x') === true);
ok('html body is error', PBData.looksLikeProxyError('<!DOCTYPE html><html>...</html>') === true);
ok('rate-limit phrase is error', PBData.looksLikeProxyError('xxxxxxxxxxxxxxxxxxxxxx Too Many Requests xxxxx') === true);
ok('clean json body is ok', PBData.looksLikeProxyError('{"chart":{"result":[{"meta":{"x":1}}]}}') === false);

// fetchViaProxies returns the first clean body and floats lastGoodProxy
PBData._setLastGoodProxy(null);
let calls = installFetch([{ match: 'finance.yahoo.com', body: '{"ok":true,"padding":"aaaaaaaaaaaaaaaaaaaa"}' }]);
let body = await PBData.fetchViaProxies('https://query1.finance.yahoo.com/v8/finance/chart/AAPL');
ok('fetchViaProxies returns clean body', body === '{"ok":true,"padding":"aaaaaaaaaaaaaaaaaaaa"}');
ok('fetchViaProxies set lastGoodProxy', PBData._lastGoodProxy != null);

// First proxy returns an error body → falls through to the next proxy
PBData._setLastGoodProxy(null);
let n = 0;
globalThis.fetch = async (u) => {
  n++;
  // first call: rate-limited error body; second call: clean body
  return { ok: true, text: async () => (n === 1 ? 'Too Many Requests ........................' : '{"good":true,"padding":"aaaaaaaaaaaaaaaaaaaa"}') };
};
body = await PBData.fetchViaProxies('https://query1.finance.yahoo.com/x');
ok('fetchViaProxies falls through error body to next proxy', body === '{"good":true,"padding":"aaaaaaaaaaaaaaaaaaaa"}' && n === 2);

// All proxies fail → null
globalThis.fetch = async () => ({ ok: false, text: async () => '' });
body = await PBData.fetchViaProxies('https://query1.finance.yahoo.com/y');
ok('fetchViaProxies all-fail → null', body === null);

// Anti-drift guard
ok('app.js binds fetchViaProxies from PBData', /const\s+fetchViaProxies\s*=\s*PBData\.fetchViaProxies/.test(appSrc));
ok('app.js has no local function fetchViaProxies', !/function\s+fetchViaProxies\s*\(/.test(appSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll data-proxy tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/test && node data-proxy.test.mjs`
Expected: FAIL — `Cannot find module '../../pb-data.js'`.

- [ ] **Step 3: Create `pb-data.js` with the proxy ladder.** Cut `CORS_PROXIES`, `lastGoodProxy`, `orderedProxies`, `looksLikeProxyError`, `fetchViaProxies` **verbatim** from `app.js` (≈ lines 566–611) into the new file. Full file:

```js
// ─── Playbook data layer ─────────────────────────────────────────────────────
// The client-only network layer carved out of app.js: the rotating CORS-proxy
// chain plus every quote/price/history provider (Yahoo, Stooq, Morningstar unit
// trusts, FRED/indicator) and the ticker→name cache. It is IMPURE (network,
// localStorage) and is loaded only in the browser — the Cloudflare worker
// (backend/worker.js) and the service worker (sw.js) keep their own inline fetch
// and must NOT import this. It depends only upward on pb-core.js (pure helpers).
//
// Dual-mode footer like pb-core.js: CommonJS module.exports (Node tests) +
// globalThis.PBData (browser <script> before app.js).
"use strict";
(function () {
  const PBCore = (typeof module !== 'undefined' && module.exports && typeof require !== 'undefined')
    ? require('./pb-core.js')
    : globalThis.PBCore;
  // These core helpers are used by the providers added in Task 3; pulled here so
  // the destructure is established once. (priceKey is the only one the proxy
  // ladder itself could need; the rest are forward-looking.)
  const { yahooSymbol, centDivisor, parseYahooQuote, buildDailyBars, derivePrevClose,
          deriveIntradayExt, MARKET_CURRENCY, priceKey } = PBCore;

  // App-injected config (set once from app.js via PBData.configure). Kept here so
  // pb-data never reaches into app.js globals (which would break the Node tests).
  const cfg = { indicatorCatalog: null };
  function configure(opts) { if (opts && typeof opts === 'object') Object.assign(cfg, opts); }

  // ─── Rotating CORS proxy chain ──────────────────────────────────────────────
  // <MOVE VERBATIM from app.js: the CORS_PROXIES comment block + const, lastGoodProxy,
  //  orderedProxies, looksLikeProxyError, fetchViaProxies (app.js ~566–611).>

  // Test seams (Node only; harmless in browser).
  function _setLastGoodProxy(v) { lastGoodProxy = v; }

  const PBData = {
    configure,
    fetchViaProxies,
    looksLikeProxyError,
    orderedProxies,
    _setLastGoodProxy,
    get _lastGoodProxy() { return lastGoodProxy; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PBData;
  if (typeof globalThis !== 'undefined') globalThis.PBData = PBData;
})();
```

Note: `parseHistoryResult` is a pb-data-internal function (it arrives in Task 3) — it must **not** appear in this `PBCore` destructure. Destructuring a member that doesn't exist on `PBCore` yields `undefined` (no error), but keep the list to the eight real core members shown above.

- [ ] **Step 4: Remove the moved code from `app.js` and add the bind.** Delete the `CORS_PROXIES` comment+const through the end of `fetchViaProxies` (≈ 566–611). In its place (so the ~half-dozen other callers — e.g. crypto search, FRED, unit trusts — keep resolving the name), add:

```js
// The CORS proxy ladder now lives in pb-data.js (client-only network layer).
// Bound here so app.js call sites are unchanged. PBData is loaded before app.js.
const fetchViaProxies = PBData.fetchViaProxies;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend/test && node data-proxy.test.mjs`
Expected: PASS — `All data-proxy tests passed`.

- [ ] **Step 6: Wire the new script into the shell.** Three edits:

`index.html` — add between `pb-core.js` (line 74) and `data.js` (line 75):
```html
<script src="./pb-data.js"></script>
```

`sw.js` line 2 — bump the cache version:
```js
const CACHE_NAME   = 'playbook-shell-v33';
```
`sw.js` — add `'./pb-data.js',` to the precache array immediately after `'./pb-core.js',` (line 9).

`.github/workflows/static.yml` — add `pb-data.js` to BOTH the `cp` stage line (~44) and the missing-asset guard loop list (~50). After the edit the `cp` line reads:
```
cp index.html sw.js app.js data.js pb-core.js pb-data.js styles.css \
```
and the guard `for f in ...` list likewise includes `pb-data.js`.

- [ ] **Step 7: Verify parse + no stragglers**

Run:
```bash
node --check pb-data.js && node --check app.js
grep -nE "function fetchViaProxies|const CORS_PROXIES" app.js   # expect: no matches
grep -n "pb-data.js" index.html sw.js .github/workflows/static.yml   # expect 4 hits (1 html, 1 sw, 2 yml)
```
Expected: parses clean; first grep empty; second grep shows the wiring.

- [ ] **Step 8: Commit**

```bash
git add pb-data.js app.js index.html sw.js .github/workflows/static.yml backend/test/data-proxy.test.mjs
git commit -m "Carve CORS proxy ladder into pb-data.js + wire the new script (Phase 2 inc 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Move the providers, batchers, and name cache into `pb-data.js`

Move the rest of the quote/price/history layer. These functions are deeply interdependent (`fetchQuote` → indicator/unit-trust routing → Stooq fallback → name cache), so they move as one connected block.

**Files:**
- Modify: `pb-data.js` (receive the moved functions; add them to the `PBData` export)
- Modify: `app.js` — remove the moved definitions; add binds; call `PBData.configure(...)`
- Test: `backend/test/data-providers.test.mjs` (new)

**Move verbatim from `app.js` into the `pb-data.js` IIFE (before the `PBData` object literal), unchanged except the three edits in Steps 4–6:**

- Name cache: `CURATED_NAMES`, `NAME_CACHE_KEY`, `NAME_CACHE`, `_nameCacheDirty`, `_flushNameCache`, `cacheName`, `cachedName` (≈ 634–687)
- Stooq: `stooqSymbol`, `parseStooqCsv` (≈ 701–742)
- Morningstar unit trusts: `MORNINGSTAR_KEY`, `MORNINGSTAR_UNIVERSE`, `isUnitTrustId`, `unitTrustSearchTerm`, `fetchMorningstarRows`, `searchUnitTrusts`, `morningstarRowToQuote`, `fetchUnitTrustQuote`, `unitTrustRangeStart`, `fetchUnitTrustHistory` (≈ 754–853)
- FRED / indicators: `FRED_TTL_MS`, `_fredCache`, `parseFredCsv`, `fetchFredSeries`, `fredAsOf`, `fredTransformSeries`, `rangeCutoffMs`, `indicatorQuoteFromSeries`, `indicatorHistoryFromSeries`, `fetchFredIndicatorQuote`, `fetchFredIndicatorHistory`, `buildGliSeries`, `fetchGliQuote`, `fetchGliHistory`, `vixToMood`, `fetchVixMoodQuote`, `fetchVixMoodHistory`, `fetchIndicatorQuote`, `fetchIndicatorHistory` (≈ 864–1042)
- Yahoo quote/history: `fetchQuote`, `fetchQuoteBatch`, `fetchQuoteLight`, `fetchQuoteBatchLight`, `parseHistoryResult`, `fetchHistory` (≈ 1043–1330; move the whole `fetchHistory` body too)

**Do NOT move** (stay in `app.js`): `RIBBON_CATALOG`/`RIBBON_CATALOG_MAP`, `priceKey` (already core), the FX block, `usePriceFeed`, `tickersToFetch`.

**Interfaces:**
- Consumes (from `pb-core`, via the Task-2 destructure): `yahooSymbol`, `centDivisor`, `parseYahooQuote`, `buildDailyBars`, `derivePrevClose`, `deriveIntradayExt`, `MARKET_CURRENCY`, `priceKey`.
- Consumes (injected): `cfg.indicatorCatalog` — an object keyed by `priceKey(market,ticker)` whose values may carry `{ source, fredSeries, fredTransform }` (this is `RIBBON_CATALOG_MAP`).
- Produces on `PBData`: `fetchQuote(ticker, market, opts?) => Promise<quote|null>`, `fetchQuoteBatch(items, opts?) => Promise<Record<priceKey, quote>>`, `fetchQuoteLight(ticker, market)`, `fetchQuoteBatchLight(items, onProgress?)`, `fetchHistory(ticker, market, range)`, `searchUnitTrusts(query, market)`, `isUnitTrustId(t) => boolean`, `cacheName(market, ticker, name)`, `cachedName(market, ticker) => string|null`.

- [ ] **Step 1: Write the failing test** — create `backend/test/data-providers.test.mjs`:

```js
// Characterization tests for the quote/price providers + batcher + name cache
// moved into pb-data.js. Mocks globalThis.fetch with canned Yahoo/Stooq payloads.
//   cd backend/test && node data-providers.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBData from '../../pb-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;

// A fresh Yahoo 5d/1d chart payload (regularMarketTime ~ now → not "stale", so
// fetchQuote takes the daily-only path and makes exactly one proxied call).
function yahooChart(symbol, price, prev, name) {
  const nowSec = Math.floor(Date.now() / 1000);
  return JSON.stringify({ chart: { result: [{
    meta: { regularMarketPrice: price, regularMarketPreviousClose: prev, currency: 'USD',
            shortName: name, longName: name, marketState: 'REGULAR', regularMarketTime: nowSec },
    timestamp: [nowSec], indicators: { quote: [{ close: [price] }] }
  }] } });
}

// Route fetch by the upstream symbol embedded in the proxied URL. Counts calls.
let fetchCalls = [];
function installYahoo(map /* symbol -> chart json | null */) {
  fetchCalls = [];
  globalThis.fetch = async (proxiedUrl) => {
    fetchCalls.push(proxiedUrl);
    const dec = decodeURIComponent(proxiedUrl);
    for (const sym of Object.keys(map)) {
      if (dec.includes(`/chart/${sym}?`) || dec.includes(`/chart/${sym}&`) || dec.includes(`/chart/${sym}`)) {
        const body = map[sym];
        return { ok: body != null, text: async () => (body == null ? '' : body) };
      }
    }
    return { ok: false, text: async () => '' };
  };
}

PBData.configure({ indicatorCatalog: {} }); // no indicators routed in these tests

// fetchQuote happy path + name cache populated
installYahoo({ AAPL: yahooChart('AAPL', 150, 145, 'Apple') });
let q = await PBData.fetchQuote('AAPL', 'US');
ok('fetchQuote returns parsed price', q && q.price === 150);
ok('fetchQuote computes change vs prevClose', q && near(q.change, 5));
ok('fetchQuote daily-only path = 1 fetch', fetchCalls.length === 1);
ok('fetchQuote populates name cache', PBData.cachedName('US', 'AAPL') === 'Apple');

// parseStooqCsv via the Stooq fallback is tested directly on the moved function
// only if exported; otherwise exercise it through fetchQuote with Yahoo null.
// Here: assert the indicator/unit-trust routing predicates.
ok('isUnitTrustId true for SecId shape', PBData.isUnitTrustId('F000002CRJ') === true);
ok('isUnitTrustId false for normal ticker', PBData.isUnitTrustId('AAPL') === false);

// fetchQuoteBatch: keys by priceKey, fires onBatch, second pass retries missing.
installYahoo({ AAPL: yahooChart('AAPL', 150, 145, 'Apple'), MSFT: yahooChart('MSFT', 400, 390, 'Microsoft') });
const seen = [];
let res = await PBData.fetchQuoteBatch(
  [{ ticker: 'AAPL', market: 'US' }, { ticker: 'MSFT', market: 'US' }],
  { onBatch: (fresh) => seen.push(Object.keys(fresh)) }
);
ok('fetchQuoteBatch keys results by priceKey', res['US:AAPL'] && res['US:MSFT'] && res['US:AAPL'].price === 150);
ok('fetchQuoteBatch fired onBatch with fresh keys', seen.length >= 1 && seen.flat().includes('US:AAPL'));

// second pass: MSFT null on first sweep, present on retry
let msftCalls = 0;
globalThis.fetch = async (proxiedUrl) => {
  const dec = decodeURIComponent(proxiedUrl);
  if (dec.includes('/chart/AAPL')) return { ok: true, text: async () => yahooChart('AAPL', 150, 145, 'Apple') };
  if (dec.includes('/chart/MSFT')) { msftCalls++; return { ok: true, text: async () => (msftCalls === 1 ? '' : yahooChart('MSFT', 400, 390, 'Microsoft')) }; }
  return { ok: false, text: async () => '' };
};
res = await PBData.fetchQuoteBatch([{ ticker: 'AAPL', market: 'US' }, { ticker: 'MSFT', market: 'US' }]);
ok('fetchQuoteBatch second pass recovers a missing symbol', res['US:MSFT'] && res['US:MSFT'].price === 400 && msftCalls >= 2);

// Anti-drift guard: app.js binds these from PBData and has no local definitions.
for (const fn of ['fetchQuote', 'fetchQuoteBatch', 'fetchQuoteBatchLight', 'fetchHistory', 'searchUnitTrusts', 'isUnitTrustId', 'cacheName', 'cachedName', 'parseStooqCsv']) {
  ok(`app.js has no local function ${fn}`, !new RegExp(`function\\s+${fn}\\s*\\(`).test(appSrc));
}
for (const fn of ['fetchQuote', 'fetchQuoteBatch', 'fetchHistory', 'searchUnitTrusts', 'isUnitTrustId', 'cachedName']) {
  ok(`app.js binds ${fn} from PBData`, new RegExp(`const\\s+${fn}\\s*=\\s*PBData\\.${fn}`).test(appSrc));
}
ok('app.js injects the indicator catalog', /PBData\.configure\(\s*\{[^}]*indicatorCatalog/.test(appSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll data-providers tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/test && node data-providers.test.mjs`
Expected: FAIL — `PBData.fetchQuote is not a function` (and binds/guards fail).

- [ ] **Step 3: Move the provider block into `pb-data.js`.** Cut the functions listed in the task header **verbatim** from `app.js` into the `pb-data.js` IIFE, placed after the proxy ladder and before the `PBData` object literal. Keep their relative order so internal calls resolve.

- [ ] **Step 4: Edit the name-cache persistence to use `localStorage` directly** (it was on the backup-skip list, so this is behavior-identical). In the moved `NAME_CACHE` initializer, replace the `LS.get` line:

```js
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(NAME_CACHE_KEY) : null;
    if (raw) Object.assign(seed, JSON.parse(raw) || {});
  } catch (_e) {}
```

and in the moved `_flushNameCache`, replace the `LS.set` line:

```js
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(NAME_CACHE_KEY, JSON.stringify(learned)); } catch (_e) {}
```

- [ ] **Step 5: Edit the indicator routing to read injected config.** In the moved `fetchQuote` and `fetchHistory`, replace each `RIBBON_CATALOG_MAP[priceKey(market, ticker)]` lookup with `cfg.indicatorCatalog` (passed by reference from `app.js`):

```js
  const _indCat = cfg.indicatorCatalog && cfg.indicatorCatalog[priceKey(market, ticker)];
```

- [ ] **Step 6: Add the moved functions to the `PBData` export object.** Extend the `const PBData = { ... }` literal:

```js
  const PBData = {
    configure,
    fetchViaProxies, looksLikeProxyError, orderedProxies,
    fetchQuote, fetchQuoteBatch, fetchQuoteLight, fetchQuoteBatchLight, fetchHistory,
    parseStooqCsv, stooqSymbol,
    isUnitTrustId, searchUnitTrusts, fetchUnitTrustQuote, fetchUnitTrustHistory,
    fetchIndicatorQuote, fetchIndicatorHistory,
    cacheName, cachedName,
    _setLastGoodProxy,
    get _lastGoodProxy() { return lastGoodProxy; }
  };
```

- [ ] **Step 7: Remove the moved definitions from `app.js` and add binds.** Delete the cut blocks. Where the data layer used to begin (right after the `RIBBON_CATALOG_MAP` definition is in scope, e.g. just above where `cacheName`/`stooqSymbol` were), add the bind block + the config injection:

```js
// The quote/price/history providers, batchers, and ticker→name cache now live in
// pb-data.js (client-only network layer). Bound here so app.js call sites are
// unchanged; the indicator catalog (UI/content config) is injected once.
PBData.configure({ indicatorCatalog: RIBBON_CATALOG_MAP });
const fetchQuote = PBData.fetchQuote;
const fetchQuoteBatch = PBData.fetchQuoteBatch;
const fetchQuoteBatchLight = PBData.fetchQuoteBatchLight;
const fetchHistory = PBData.fetchHistory;
const searchUnitTrusts = PBData.searchUnitTrusts;
const isUnitTrustId = PBData.isUnitTrustId;
const cacheName = PBData.cacheName;
const cachedName = PBData.cachedName;
```

(Place this so `RIBBON_CATALOG_MAP` — defined at ~line 509 — is already evaluated. The binds are top-level `const`; every call site is inside a function/component, so runtime resolution is fine.)

- [ ] **Step 8: Find any straggler references and bind them too.** Some provider names may be referenced by other `app.js` code not listed above.

Run:
```bash
for fn in fetchQuoteLight stooqSymbol parseStooqCsv fetchUnitTrustQuote fetchUnitTrustHistory fetchIndicatorQuote fetchIndicatorHistory looksLikeProxyError orderedProxies; do
  echo "== $fn =="; grep -nE "\\b$fn\\s*\\(" app.js;
done
```
For every name that still appears (a call site that wasn't moved), add a `const <fn> = PBData.<fn>;` bind next to the block in Step 7. Expected from current code: none of these have surviving `app.js` call sites, but verify — if `grep` shows a hit outside a comment, bind it.

- [ ] **Step 9: Run test to verify it passes**

Run: `cd backend/test && node data-providers.test.mjs`
Expected: PASS — `All data-providers tests passed`.

- [ ] **Step 10: Run the FULL node suite + parse checks** (nothing else regressed)

Run:
```bash
node --check pb-data.js && node --check app.js && node --check pb-core.js
cd backend/test && for t in *.test.mjs; do echo "== $t =="; node "$t" || break; done
```
Expected: all 10 suites end with `All ... passed` / `tests passed`; no `FAIL` rows.

- [ ] **Step 11: Commit**

```bash
git add pb-data.js app.js backend/test/data-providers.test.mjs
git commit -m "Move quote providers + batchers + name cache into pb-data.js (Phase 2 inc 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Add a pure `pLimit` concurrency limiter to `pb-core.js`

Increment 2 needs a global cap on simultaneous `fetch()` calls. The limiter itself is a pure async utility — it belongs in `pb-core` and is unit-testable in isolation.

**Files:**
- Modify: `pb-core.js` (add `pLimit` inside the IIFE + to the export)
- Test: `backend/test/plimit.test.mjs` (new)

**Interfaces:**
- Produces: `PBCore.pLimit(concurrency: number) => (fn: () => Promise<T>) => Promise<T>` — returns a `limited(fn)` that queues `fn` and runs at most `concurrency` at once, resolving/rejecting with `fn`'s result; a rejecting `fn` frees its slot and does not wedge the queue.

- [ ] **Step 1: Write the failing test** — create `backend/test/plimit.test.mjs`:

```js
// Unit tests for the pure pLimit concurrency limiter in pb-core.js.
//   cd backend/test && node plimit.test.mjs
import PBCore from '../../pb-core.js';
const { pLimit } = PBCore;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const delay = (ms) => new Promise(r => setTimeout(r, ms));

ok('PBCore exports pLimit', typeof pLimit === 'function');

// Peak concurrency never exceeds the cap.
async function peakUnder(cap, total) {
  const limit = pLimit(cap);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: total }, () => limit(async () => {
    active++; peak = Math.max(peak, active);
    await delay(10);
    active--;
  })));
  return peak;
}
ok('cap=1 serializes (peak 1)', (await peakUnder(1, 5)) === 1);
ok('cap=3 over 9 tasks → peak ≤ 3', (await peakUnder(3, 9)) <= 3);

// All results resolve in order of completion with correct values.
const limit = pLimit(2);
const vals = await Promise.all([1, 2, 3, 4].map(n => limit(async () => { await delay(5); return n * 10; })));
ok('returns each fn result', vals.join(',') === '10,20,30,40');

// A rejecting task frees its slot; later tasks still run.
const lim2 = pLimit(1);
let ran = false;
const p1 = lim2(async () => { throw new Error('boom'); }).catch(e => e.message);
const p2 = lim2(async () => { ran = true; return 'ok'; });
ok('rejecting task surfaces error', (await p1) === 'boom');
ok('queue not wedged by rejection', (await p2) === 'ok' && ran === true);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll pLimit tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/test && node plimit.test.mjs`
Expected: FAIL — `PBCore exports pLimit` is false.

- [ ] **Step 3: Implement `pLimit` in `pb-core.js`** — add inside the IIFE (near the other utilities):

```js
  // Minimal promise concurrency limiter: returns limited(fn) that runs at most
  // `concurrency` fns at once. Pure (no globals) — pb-data uses it to cap
  // simultaneous fetch() calls across all proxied requests.
  function pLimit(concurrency) {
    const queue = [];
    let active = 0;
    const next = () => {
      while (active < concurrency && queue.length) {
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve().then(fn).then(
          (v) => { active--; resolve(v); next(); },
          (e) => { active--; reject(e); next(); }
        );
      }
    };
    return function limited(fn) {
      return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
    };
  }
```

Then add `pLimit,` to the `PBCore` export object.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend/test && node plimit.test.mjs`
Expected: PASS — `All pLimit tests passed`.

- [ ] **Step 5: Commit**

```bash
git add pb-core.js backend/test/plimit.test.mjs
git commit -m "Add pure pLimit concurrency limiter to pb-core.js (Phase 2 inc 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Wire in-flight de-dupe + the limiter into `fetchViaProxies`

Make the proxy path collapse concurrent identical requests and cap total simultaneous `fetch()` calls. Transparent: same body out, fewer/queued network calls.

**Files:**
- Modify: `pb-data.js` (`fetchViaProxies` + add `pLimit` to the `PBCore` destructure + a module-level limiter/map)
- Test: `backend/test/data-proxy.test.mjs` (extend)

**Interfaces:**
- Consumes: `PBCore.pLimit` (Task 4).
- `fetchViaProxies` signature unchanged. New behavior: concurrent calls with the **same `url`** share one promise (deleted on settle); each real `fetch()` runs through a shared `pLimit(7)`.

- [ ] **Step 1: Write the failing tests** — append to `backend/test/data-proxy.test.mjs` before the anti-drift guard block:

```js
// ── in-flight de-dupe: two concurrent same-url calls → one underlying fetch ──
PBData._setLastGoodProxy(null);
let hits = 0;
globalThis.fetch = async () => { hits++; await new Promise(r => setTimeout(r, 15)); return { ok: true, text: async () => '{"x":1,"padding":"aaaaaaaaaaaaaaaaaaaa"}' }; };
let [a, b] = await Promise.all([
  PBData.fetchViaProxies('https://query1.finance.yahoo.com/dedupe'),
  PBData.fetchViaProxies('https://query1.finance.yahoo.com/dedupe')
]);
ok('de-dupe: both callers get the same body', a === b && a === '{"x":1,"padding":"aaaaaaaaaaaaaaaaaaaa"}');
ok('de-dupe: only one underlying fetch', hits === 1);

// different urls (e.g. cacheBust) are NOT de-duped
hits = 0;
await Promise.all([
  PBData.fetchViaProxies('https://query1.finance.yahoo.com/x?_=1'),
  PBData.fetchViaProxies('https://query1.finance.yahoo.com/x?_=2')
]);
ok('de-dupe: distinct urls each fetch', hits === 2);

// after settle the entry is freed (a later call refetches)
hits = 0;
await PBData.fetchViaProxies('https://query1.finance.yahoo.com/again');
await PBData.fetchViaProxies('https://query1.finance.yahoo.com/again');
ok('de-dupe: map cleared after settle', hits === 2);

// ── limiter: peak concurrent fetch() never exceeds the cap ───────────────────
let active = 0, peak = 0;
globalThis.fetch = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); active--; return { ok: true, text: async () => '{"ok":1,"padding":"aaaaaaaaaaaaaaaaaaaa"}' }; };
await Promise.all(Array.from({ length: 20 }, (_, i) => PBData.fetchViaProxies('https://query1.finance.yahoo.com/cap' + i)));
ok('limiter: peak concurrent fetch ≤ 8', peak <= 8 && peak > 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/test && node data-proxy.test.mjs`
Expected: FAIL — `de-dupe: only one underlying fetch` (hits === 2, no de-dupe yet) and/or the limiter peak row.

- [ ] **Step 3: Implement de-dupe + limiter in `pb-data.js`.** Add `pLimit` to the `PBCore` destructure at the top of the IIFE. Above `fetchViaProxies`, add module-level state; then replace the whole `fetchViaProxies` function:

```js
  // Collapse concurrent identical upstream requests, and cap total simultaneous
  // fetch() calls across every provider, so an auto-poll + a manual refresh + a
  // detail view don't stack into one proxy-tripping burst. cacheBust appends a
  // unique &_=<ts> so manual refreshes are distinct urls and bypass de-dupe.
  const _inflight = new Map();
  const _fetchLimit = pLimit(8);
  function fetchViaProxies(url, { timeoutMs = 8000 } = {}) {
    const existing = _inflight.get(url);
    if (existing) return existing;
    const run = (async () => {
      for (const px of orderedProxies()) {
        try {
          const res = await _fetchLimit(async () => {
            const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
            try { return await fetch(px.build(url), { cache: 'no-store', signal: ctrl?.signal }); }
            finally { if (t) clearTimeout(t); }
          });
          if (!res.ok) continue;
          const text = await res.text();
          const body = px.unwrap(text);
          if (looksLikeProxyError(body)) continue;
          lastGoodProxy = px.name;
          return body;
        } catch (e) {}
      }
      return null;
    })();
    _inflight.set(url, run);
    run.finally(() => _inflight.delete(url));
    return run;
  }
```

(The abort timer now lives inside the limited fn so the timeout covers the actual `fetch`, not queue-wait. Body unwrap/error-check stay outside the slot — same data, slot freed as soon as headers return.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend/test && node data-proxy.test.mjs`
Expected: PASS — `All data-proxy tests passed`.

- [ ] **Step 5: Full suite + parse check** (de-dupe must not break the providers)

Run:
```bash
node --check pb-data.js
cd backend/test && for t in *.test.mjs; do echo "== $t =="; node "$t" || break; done
```
Expected: all suites pass (`data-providers` still green — its sequential per-symbol fetches are unaffected by an 8-wide cap).

- [ ] **Step 6: Commit**

```bash
git add pb-data.js backend/test/data-proxy.test.mjs
git commit -m "Add in-flight de-dupe + global fetch concurrency limiter to fetchViaProxies (Phase 2 inc 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Verify in a real browser + update the memory

The node suite proves the logic; this confirms the app still boots with the new script and that nothing referenced a now-moved global.

**Files:**
- No code changes unless a defect is found.
- Update: the `playbook-refactor-priorities` and `playbook-architecture-audit` memory files (Phase 2 progress, new `pb-data.js`, drifted line numbers).

- [ ] **Step 1: Serve the static app and load it headless.** From the repo root, serve and open the page, watching the console for `ReferenceError` (a missed straggler bind) or a failed `pb-data.js` load.

Run (pick whichever server is available):
```bash
npx --yes http-server -p 8099 . >/dev/null 2>&1 &   # or: python -m http.server 8099
# then drive a headless check (the repo already uses headless Chrome for verify-*.mjs)
node backend/test/verify-refresh-behavior.mjs   # exercises the price feed end-to-end
```
Expected: the verify script completes without console errors; prices render. (If `verify-refresh-behavior.mjs` needs a base URL/flag, follow its header comment.)

- [ ] **Step 2: Confirm the deploy allowlist is internally consistent.**

Run: `grep -c "pb-data.js" .github/workflows/static.yml`
Expected: `2` (the `cp` stage line + the missing-asset guard list).

- [ ] **Step 3: Update the memory.** In `playbook-refactor-priorities.md`, add a Phase 2 progress entry (increments 1+2 done; `pb-data.js` now holds the proxy ladder + Yahoo/Stooq/Morningstar/FRED providers + batchers + name cache; `priceKey`+`pLimit` added to `pb-core`; FX deferred; increment 3 = `tickersToFetch` fan-out split still open). In `playbook-architecture-audit.md`, note the new `pb-data.js` layer and that A5/D1 are partially addressed (de-dupe + limiter), C2 (fan-out) still open. Re-flag line numbers as drifted.

- [ ] **Step 4: Final commit (if memory/docs lived in-repo) or note completion.** The memory files are outside the repo; no commit needed for them. Confirm the branch is clean:

Run: `git status --porcelain`
Expected: empty (all task commits made).

---

## Self-Review

**Spec coverage:**
- Section 1 (module boundary): proxy ladder → Task 2; providers + batchers + name cache → Task 3; `usePriceFeed`/`tickersToFetch`/`RIBBON_CATALOG` stay (not moved — confirmed in Task 3 "Do NOT move"). ✓
- Section 2 (deps & load order): `priceKey`→`pb-core` Task 1; `pb-data`→`pb-core` destructure Task 2/3; `configure(indicatorCatalog)` Task 3; `index.html` order Task 2 Step 6. ✓
- Section 3 (de-dupe + limiter): `pLimit` Task 4; de-dupe + limiter wired Task 5. ✓
- Section 4 (testing): proxy (data-proxy), providers (data-providers), pLimit, de-dupe/limiter, anti-drift guards in each — all present. ✓
- Section 5 (mechanical/deploy): `index.html` + `sw.js` v33 + `static.yml` — Task 2 Step 6. ✓
- Section 6 (increment breakdown): Tasks 1–3 = inc 1, Tasks 4–5 = inc 2, Task 6 = verify. ✓
- FX deferral (spec non-goals): honored — FX block explicitly excluded in Task 3. ✓

**Placeholder scan:** the one `<MOVE VERBATIM ...>` marker in Task 2 Step 3 is a deliberate instruction to relocate existing, unchanged code (the full source is in `app.js:566–611`), not a stubbed implementation — every *new* line of code (footer, configure, binds, the localStorage/indicatorCatalog edits, pLimit, fetchViaProxies rewrite) is shown in full. No "TBD"/"add error handling"/"write tests for the above". ✓

**Type consistency:** `fetchViaProxies(url, {timeoutMs})=>Promise<string|null>`, `fetchQuote(ticker,market,opts)`, `fetchQuoteBatch(items,{onBatch,cacheBust})`, `priceKey(market,ticker)`, `pLimit(n)=>(fn)=>Promise`, `configure({indicatorCatalog})`, `cachedName(market,ticker)` — names/signatures match across the tasks that define and consume them. `PBData` exported member list in Task 3 Step 6 is a superset of every `const x = PBData.x` bind in Step 7 and every `PBData.x` test call. ✓
