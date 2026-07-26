# Phase 5 — IndexedDB behind the `LS` adapter (plan)

Companion to
[`specs/2026-07-25-phase-5-indexeddb-storage-design.md`](../specs/2026-07-25-phase-5-indexeddb-storage-design.md).

**CLOSED 2026-07-26 — Jan chose Option A. Phase 5 will not be built.**

Section 1 (the premise-check measurement) and Section 2 (the backup characterization pin, which
landed and is valuable regardless) are the durable parts of this document. **Section 3 is a build
plan for Option B that was never approved and must not be executed** — it is retained only as the
record of what was scoped and rejected. See the
[design spec](../specs/2026-07-25-phase-5-indexeddb-storage-design.md) for the decision and its
evidence.

---

## 1. Premise check — the measurement script

Run from the repo root. Reproduces every number in §1 of the spec from the real shapes in `data.js` and
the real persisted-quote/transaction/heatmap/rotation record layouts.

```js
// scratchpad/measure-footprint.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
global.window = global; global.document = { getElementById: () => null };
require('/home/user/Playbook/data.js');
const D = global.PB_DATA;
const b = o => JSON.stringify(o).length;
const kb = n => (n / 1024).toFixed(1) + ' KB';

const quote = { price: 123.45, prevClose: 122.1, change: 1.35, changePct: 1.105, currency: 'USD',
  marketState: 'REGULAR', fetchedAt: Date.now(), source: 'yahoo', dayHigh: 124.9, dayLow: 121.8,
  extPrice: null, extChange: null, extChangePct: null, extKind: null, extLive: null, extAsOf: null };
const perQuote = b({ 'US:NVDA': quote }) - 2;

let heat = 0;
for (const e of D.HEATMAPS) {
  const rows = e.constituents.map(c => ({ ticker: c.t, market: e.market, sector: c.s,
    industry: c.i, value: c.m, price: 123.45, changePct: -1.234 }));
  heat += b({ rows, fetchedAt: Date.now() });
}

const SECTORS = 11;
const rotOne = b({
  snapshot: Array.from({ length: SECTORS }, (_, i) => ({ sector: 'Sector' + i, changePct: 1.2, weight: 9.1, count: 40 })),
  classified: Array.from({ length: 150 }, (_, i) => ({ t: 'TICK' + i, s: 'Technology' })),
  flows: { matched: 150, flows: Array.from({ length: 30 }, () => ({ from: 'Energy', to: 'Technology', amount: 1.23 })) },
  series: { t: Array.from({ length: 48 }, (_, i) => 1700000000 + i * 300),
            byS: Object.fromEntries(Array.from({ length: SECTORS }, (_, i) =>
              ['Sector' + i, Array.from({ length: 48 }, () => 0.1234)])) },
  activity: { hi: 3, lo: -2 }, fetchedAt: Date.now() });

const txn = b({ id: 'k3n8fj2a', type: 'buy', ticker: 'NVDA', market: 'US', shares: 12.5,
  price: 123.45, notes: '', date: '2026-07-25', createdAt: new Date().toISOString() });
const nameEntry = b({ 'US:NVDA': 'NVIDIA Corporation' }) - 2;

const prices = perQuote * (40 + 60 + 12);
const today = prices + heat + rotOne * 9 + txn * 300 + nameEntry * 500 + 40 * 200;
const yr5   = prices + heat + rotOne * 9 + txn * 3000 + nameEntry * 5000 + 40 * 200;
console.log('quote', perQuote, '· heatmap', kb(heat), '· rotation', kb(rotOne * 9),
            '· today', kb(today), '· 5yr', kb(yr5));
```

**Measured output (2026-07-25):**

```
per persisted quote entry         289 bytes
pb.heatmap.lastgood.v1 (all 9)    59.2 KB   constituents: 440
pb.rotation.lastgood.v1 (all 9)   101.2 KB  (11.2 KB per exchange)
per transaction record            159 bytes  ->  155.3 KB per 1,000 txns
per nameCache entry               30 bytes   ->   58.6 KB per 2,000 tickers
pb.prices.v1 (112 symbols)        31.6 KB
TODAY  (all tabs, 300 txns, 500 names):  261.1 KB   =  5.1% of a 5 MB budget
5-YEAR (3,000 txns, 5,000 names)      :  812.1 KB   = 15.9% of a 5 MB budget
```

Supporting greps that back the spec's structural claims:

| Claim | Check |
|---|---|
| heatmap quotes never persist per-symbol | `grep -an "mergePrices\|setPricesMap" app.js pb-views.js pb-modals.js` → only `app.js:1600/1658/1677/3076/3488`; zero in `pb-views.js` |
| 44 distinct `pb.*` keys, 8 unschema'd | `grep -aho "'pb\.[a-zA-Z0-9._]*'" app.js pb-*.js index.html data.js demo-data.js \| sort -u` |
| 3 `LS` bypasses | `grep -n localStorage app.js pb-data.js` → `app.js:69–72,106`; `pb-data.js:142,154` |
| 17 synchronous `usePersistedState` reads | `grep -ac "usePersistedState('" app.js pb-views.js` → 6 + 10, plus `app.js:2778` |
| top-level synchronous seeding | `app.js:2673`, `app.js:2692` |

---

## 2. DONE — the rule-#5 characterization pin (safe under every option)

**Landed this session.** `backend/test/backup-roundtrip.test.mjs`, 21 tests, node suite **30 → 31**.
Closes GAPS #13's scoped task and is a prerequisite for Options B/C/D.

| Step | Outcome |
|---|---|
| Slice the real backup block from `app.js` by source marker (`const BACKUP_PREFIX` → the column-0 `}` closing `applyBackup`) and run it in `node:vm` over a fake `localStorage` | Tests the shipped code, not a copy. Marker-bounded so it survives line drift. |
| Characterize `gatherBackup` | envelope shape; **raw-string** capture (byte-identical); all 9 `BACKUP_SKIP` keys excluded; non-`pb.` keys ignored; enumerates storage rather than a field list |
| Characterize `applyBackup` | wiped-device round-trip; overwrite-not-merge; untouched local keys survive; **all 8 `LEGACY_KEY_MAP` fields**; partial legacy exports; envelope-beats-legacy precedence; `-1` on 6 unrecognisable payload shapes; foreign keys in a backup file are dropped |
| Characterize the `LS` adapter | corrupt-JSON fallback; `_backupNotify` fires for durable `pb.*` only (not `BACKUP_SKIP`, not foreign keys), on `set` **and** `remove`; quota failure returns `false` instead of throwing |
| Anti-drift source guards | the seam still lives in `app.js`; `gatherBackup` still enumerates; no money/durable key may enter `BACKUP_SKIP`; **the mirrored skip set in `verify-cloud-backup.mjs` must equal app.js's** |

**Drift found and fixed:** `verify-cloud-backup.mjs` hand-mirrors both functions and had drifted —
its `BACKUP_SKIP` listed 7 keys vs app.js's 9 (missing `pb.rotation.lastgood.v1`, `pb.hotStocks.v1`),
and its `applyBackup` omitted the entire legacy branch. The skip set is corrected and now guarded; the
legacy branch is covered by the new suite. `verify-cloud-backup.mjs` remains the authority on the
AES-GCM/PBKDF2 crypto, which is its real subject.

**Verification:** `node backend/test/backup-roundtrip.test.mjs` → 21/21; full suite **31/31**; money
gate (money-math, cost-basis, import-matching, ee-ocr-parse, fx-providers) green;
`node backend/test/verify-cloud-backup.mjs` → all checks passed. Test-only change, so **no
`CACHE_NAME` bump** (`sw.js` stays `playbook-shell-v88`).

---

## 3. REJECTED — Option B build plan (churny blobs only) — DO NOT EXECUTE

**Jan chose Option A on 2026-07-26; this plan was never approved and is now dead.** It is kept
verbatim as the record of what Option B would have cost, so that anyone reopening the question
starts from the real scope instead of re-deriving it. The bar for reopening is in the spec's
appendix: the footprint script reporting materially more than ~1 MB on Jan's actual device.

Scope: the four `BACKUP_SKIP` caches — `pb.prices.v1`, `pb.nameCache.v1`, `pb.heatmap.lastgood.v1`,
`pb.rotation.lastgood.v1`. Rule #5 is untouched **by construction**: none of them ride cloud backup, so
`gatherBackup`/`applyBackup` and the backup envelope cannot change. The §2 suite is the proof of that,
and must stay green unmodified throughout.

1. **`PBStore.createBlobCache`** in `pb-store.js` (dual-mode, Node-testable, no new runtime file — the
   inc-37 precedent). `{ get(key), set(key, val), hydrate(), flush() }` over IndexedDB with a
   localStorage fallback when IDB is unavailable (private mode, older WebKit).
2. **Write path first, reads unchanged.** Route the four keys' writes through `createBlobCache`, still
   mirroring to localStorage. Behaviour-neutral; both stores stay coherent. Reuse
   `createWriteScheduler` for the bounded/flushable write — it already handles `pagehide`.
3. **Characterization before any read moves** (`blob-cache.test.mjs`, fake-clock + fake-IDB): identical
   write traces vs today, `BACKUP_SKIP` membership unchanged, `_backupNotify` never fires for these
   four keys, and a cold read with an empty IDB returns the localStorage value.
4. **Cut reads over, one key at a time**, starting with `pb.nameCache.v1` (smallest blast radius,
   already outside `LS`) and ending with `pb.prices.v1` (largest win, guarded by the mount gate
   `verify-refresh-behavior`, which actually drives the price feed).
5. **Migration:** on first boot, copy each key from localStorage into IDB, then delete the localStorage
   copy only after a successful IDB read-back. Idempotent and reversible.
6. **Wiring:** `CACHE_NAME` bump only (no new runtime file). Confirm `deploy-assets.test.mjs` stays
   green.
7. **Verify:** `node --check`; full node suite incl. the §2 backup suite **unmodified**; money gate;
   mount gate `verify-refresh-behavior`; anti-drift greps.

**Explicitly out of scope for Option B:** all 9 money/portfolio collections, all 13 settings, the
`index.html` inline icon-theme writer, `gatherBackup`/`applyBackup`, and the 8 unschema'd `pb-views.js`
keys. Those are Option C, which the spec does not recommend.
