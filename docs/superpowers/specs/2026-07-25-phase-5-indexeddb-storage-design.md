# Phase 5 — IndexedDB behind the `LS` adapter (design + premise check)

**Status: CLOSED 2026-07-26 — Option A, resolved by evidence. Jan's decision.**
**No Phase 5 implementation code was ever written, and none should be.**

> **Why this is closed, in one paragraph.** Phase 5 existed to fix two things: a storage
> size ceiling and Safari eviction. Measurement (§1, independently re-derived 2026-07-26 —
> every figure reproduced exactly) says the app uses **261 KB = 5.1%** of a 5 MB budget today
> and **812 KB = 15.9%** on a 5-year model, with the two churny blobs bounded by construction
> at ~160 KB forever, so **there is no ceiling to lift**. And Safari's ITP evicts *all*
> script-writable storage including IndexedDB, exempting installed home-screen PWAs, so the
> substrate swap **does not address the eviction risk** it was proposed for — the encrypted
> cloud backup already does. The migration was also never as cheap as GAPS #9 implied: the
> "everything goes through `LS`" seam does not exist (§1 Claim C, four bypasses), and the real
> obstacle is that `LS` is **synchronous and read at module-eval time** while IndexedDB is
> async (§2). That is a boot-order rewrite plus edits to `gatherBackup`/`applyBackup` — the
> disaster-recovery path, rule #5 — bought for a benefit measurement says is ~zero.
> **Closing it is the cheap, correct call.** The refactor is done; the next phase is
> [`SECURITY_ROADMAP.md`](../../../SECURITY_ROADMAP.md).
>
> The sections below are retained **as the evidence for the decision**, not as a live plan.
> Options B/C/D were considered and rejected; §3 records why. If anyone reopens this, the
> bar is the appendix script reporting materially more than ~1 MB on Jan's real device.

`REFACTOR_STATUS.md` records that Phase 5 "touches **rule #5**, so it wants a spec + Jan's sign-off on
the approach **before** any code." This is that spec. It does three things: checks the premise against
measurements, maps the seam as it actually is, and puts four options in front of Jan with a
recommendation.

It follows the pattern the last five increments established the hard way, and which
`REFACTOR_STATUS.md` now states outright:

> **this is the third roadmap claim in a row that did not survive being checked. Check before building.**

Phase 5's premise did not survive either. That is the substance of this document.

---

## 1. The premise, and what measurement says about it

Phase 5 is specified in three places, and they do not agree with each other:

| Source | What it says Phase 5 is |
|---|---|
| `PROJECT.md:226` | "IndexedDB behind a cache interface **for churny blobs**." |
| `GAPS.md` #9 (fix line) | "IndexedDB behind the existing **`LS`-shaped adapter** — the seam already exists because everything goes through `LS`." |
| `SECURITY_ROADMAP.md:19` | Roadmap Phase 3's iOS storage work **is** refactor Phase 5 — "do it once, there." |

The first is a narrow cache tier. The second is a wholesale migration of all durable state. Those are
very different amounts of risk, and the difference has never been resolved. GAPS #9 states two
justifications. Both were tested.

### Claim A — "a hard size ceiling as transactions/history grow"

**Not supported at this app's data scale.** The footprint was modelled from the real stored shapes and
the real constituent lists in `data.js` (script:
`docs/superpowers/plans/2026-07-25-phase-5-indexeddb-storage.md` reproduces it):

| Slice | Measured / modelled | Notes |
|---|---|---|
| one persisted quote entry | **289 bytes** | full Yahoo shape incl. the 6 extended-hours fields |
| `pb.prices.v1` | **31.6 KB** | 112 symbols (40 held + 60 watched + 12 indices) |
| `pb.heatmap.lastgood.v1` | **59.2 KB** | worst case: **all 9** exchanges visited, 440 constituents total |
| `pb.rotation.lastgood.v1` | **101.2 KB** | worst case: all 9 exchanges, 48-point downsampled series |
| one transaction record | **159 bytes** | → 155 KB per 1,000 transactions |
| one `nameCache` entry | **30 bytes** | → 59 KB per 2,000 tickers |
| **Total today** (all tabs visited, 300 txns, 500 cached names) | **261 KB** | **5.1%** of a 5 MB budget |
| **Total, 5-year model** (3,000 txns, 5,000 cached names) | **812 KB** | **15.9%** of budget |

The two "churny blobs" are bounded by construction — the heatmap and rotation caches are keyed by
exchange id and there are exactly 9 exchanges, so they cannot grow past ~160 KB combined no matter how
long the app runs. The only genuinely unbounded slices are `pb.transactions.v1` and `pb.nameCache.v1`,
and at 159 and 30 bytes per record they need **roughly 27,000 transactions** to reach even half the
budget.

One structural finding that keeps it small: heatmap quotes **never enter `pb.prices.v1`**. `HeatmapView`
calls `fetchQuoteBatchLight` and writes results only into its own `lastgood` blob — it never calls
`PBStore.mergePrices` (verified: the only `mergePrices` callers are `app.js:1658/1677/3076/3488`). So
the 440 constituents cost one bounded blob, not 440 persisted quote entries.

**Conclusion: there is no size problem to solve, now or on any realistic horizon.**

### Claim B — "iOS can evict storage for uninstalled/rarely-used PWAs"

**True, but IndexedDB does not fix it.** Safari's ITP eviction applies to *all* script-writable
storage — localStorage, **IndexedDB**, Cache API and service-worker registrations alike — after 7 days
without user interaction with the site. Home-screen-installed web apps are exempt from that cap.

So for Playbook's actual usage (an installed home-screen PWA — the premise of the whole push-alert
path and of `SECURITY_ROADMAP.md` §3) the eviction risk largely does not apply; and where it *does*
apply (used in a Safari tab, not installed), **migrating to IndexedDB would not reduce it**. The
existing mitigation is the correct one and already shipped: the encrypted cloud backup.

> ⚠️ This is load-bearing for the decision and is the one claim here I could not verify by measurement
> in this container. Worth Jan confirming against current iOS behaviour before acting on it.

**Conclusion: the stated risk is real but the proposed fix does not address it.**

### Claim C — "the seam already exists because everything goes through `LS`"

**Partially false.** Three code paths bypass the `LS` adapter and talk to `localStorage` directly, and
each is load-bearing:

| Bypass | Why it bypasses | Why it matters for Phase 5 |
|---|---|---|
| `gatherBackup` (`app.js:69–72`) | enumerates `localStorage.length` / `.key(i)` — **`LS` has no `keys()`** | the whole "no hand-maintained field list" backup guarantee depends on enumeration |
| `applyBackup` (`app.js:106`) | writes **raw JSON strings**; `LS.set` would re-`JSON.stringify` them | byte-identical restore is impossible through `LS.set` |
| `pb-data.js:142/154` (`pb.nameCache.v1`) | `pb-data.js` is dual-mode and cannot reach app.js's `LS` | a durable-ish key written outside the adapter entirely |

Plus a fourth, outside the module system: `index.html:33/38` reads and writes `pb.iconTheme.v1` in an
**inline script that runs before any `pb-*.js` loads**, so iOS reads the right home-screen icon at "Add
to Home Screen" time. That writer is synchronous by requirement and can never move to IndexedDB.

So CLAUDE.md rule #5's "all durable state = `pb.*` localStorage keys **through the `LS` adapter**" is
aspirational rather than descriptive. Phase 5 would have to *build* the seam it was told already exists.

### A fourth finding: the key inventory is wrong everywhere

GAPS #9 says "40 `pb.*` keys". `SETTINGS_SCHEMA` + `PORTFOLIO_SCHEMA` cover 22. The true count across
all runtime files is **44**, because `pb-views.js` owns 8 keys that no schema lists, written through
raw `usePersistedState`:

```
pb.heatmap.exchange.v1   pb.heatmap.mode.v1    pb.heatmap.pf.v1
pb.rotation.exchange.v1  pb.tfsa.targets.v1    pb.tfsa.contribution.v1
pb.watchlist.activeList.v1                     pb.watchlist.showSuggestions.v1
```

Two of these are **not** view-local UI state despite using the view-local idiom: `pb.tfsa.targets.v1`
and `pb.tfsa.contribution.v1` are user-entered TFSA planning data. They are not in `BACKUP_SKIP`, so
they *do* ride cloud backup — correctly, but by accident of the prefix rule rather than by design.

---

## 2. The real engineering problem (if Phase 5 proceeds)

Not size. **`LS` is synchronous and consumed synchronously at module-eval time; IndexedDB is async.**

Three classes of synchronous consumer, all of which run before or during first paint:

1. **Top-level schema seeding.** `app.js:2673` and `app.js:2692` run at classic-script eval time:
   ```js
   PBStore.configureSettings({ schema: SETTINGS_SCHEMA, storage: LS });    // seeds 13 settings
   PBStore.configureCollections({ schema: PORTFOLIO_SCHEMA, storage: LS }); // seeds 9 collections
   ```
   These are plain top-level statements in a no-build classic script. There is no top-level `await`
   available and no module boundary to defer behind.
2. **`usePersistedState`** (`app.js:185`) — `useState(() => LS.get(key, defaultValue))`, a synchronous
   read inside a render. **17 call sites** (7 in `app.js`, 10 in `pb-views.js`).
3. **The `index.html` inline icon-theme script**, which must stay synchronous and must stay on
   localStorage regardless of what else moves.

The only shape that preserves all three is **hydrate-once-at-boot into an in-memory mirror**: read the
whole keyspace from IndexedDB before `app.js` evaluates, serve every `LS.get` synchronously from the
mirror, and write-behind to IndexedDB asynchronously. `LS`'s interface never changes; every call site
stays byte-identical.

Two things make that cheaper here than it sounds:

- **The boot gate already exists.** `index.html` ships a pre-React splash (`#pb-splash`) that fades out
  when React mounts. An async hydration gate hides behind it with **zero new UI**.
- **The write-behind seam already exists.** inc-37's `PBStore.createWriteScheduler` is exactly the
  bounded, flushable, `pagehide`-safe write path an async store needs, and it is already Node-testable.

And one thing makes it more expensive than it sounds: hydration must complete **before `app.js`
evaluates**, which means either a new bootstrap script that loads ahead of `pb-core.js` (a new runtime
file → the full wiring checklist: `index.html`, `sw.js` `SHELL_ASSETS` + cache bump, `static.yml` `cp`
list **and** Guard-1 loop, and **16 `verify-*.mjs` harness shells**), or moving app.js's top-level
statements into a callback (a large, non-verbatim edit to the file the whole refactor has been trying
to shrink safely).

### What Phase 5 would have to touch that is money- or backup-critical

- `gatherBackup` / `applyBackup` — **rule #5**, the disaster-recovery path.
- All 9 money/portfolio collections' seeding path.
- `BACKUP_SKIP` semantics and `_backupNotify` firing (a wrong edit here either spams cloud sync on
  every price merge, or silently stops backing up real data).
- `LEGACY_KEY_MAP` migration, plus a **new** localStorage→IndexedDB migration that must be
  idempotent and reversible.

---

## 3. Options

**Option A — Close Phase 5 as "not needed".** Record the measurements, correct GAPS #9, mark Phase 5
resolved-by-evidence, and move to `SECURITY_ROADMAP.md`.
*For:* the two justifications don't hold; zero risk to rule #5. *Against:* leaves the synchronous
main-thread boot read (~44 keys, ~260 KB parsed before first paint) in place.

**Option B — Narrow to `PROJECT.md`'s actual wording: churny blobs only.** Move `pb.heatmap.lastgood.v1`,
`pb.rotation.lastgood.v1`, `pb.prices.v1` and `pb.nameCache.v1` — all four already in `BACKUP_SKIP` — to
an async IndexedDB cache tier with a localStorage fallback. Durable/money state stays exactly where it is.
*For:* **rule #5 is untouched by construction** (nothing that rides cloud backup moves); removes ~190 KB
from the synchronous boot read; the async-read tolerance already exists, since all four are re-derivable
caches whose consumers already handle a cold start. *Against:* delivers the smaller half of the win;
still needs a real IDB wrapper.

**Option C — Full migration behind a hydrated mirror.** All 44 keys; `LS` keeps its synchronous
interface over an in-memory mirror hydrated at boot.
*For:* the "real" Phase 5; single storage substrate; lifts the size ceiling that was never near.
*Against:* highest risk to rule #5; needs the new bootstrap file (full wiring checklist ×16 harnesses);
solves a problem measurement says does not exist.

**Option D — Keep localStorage authoritative, add IndexedDB as a durable shadow.** Every `LS.set` also
write-behinds to IDB; on boot, if localStorage is empty but IDB is not, restore from IDB.
*For:* directly targets Claim B (the only real risk), and reads stay synchronous forever.
*Against:* two substrates to keep coherent; and per Claim B, ITP evicts both together, so the recovery
case it buys is narrow (quota eviction, not ITP) and overlaps the cloud backup that already exists.

### Recommendation — and the decision taken

> **DECIDED 2026-07-26: Option A.** Jan closed Phase 5 outright. Options B, C and D are
> **not** to be built; they are retained below only as the record of what was weighed.
> Option B's boot-cost win (~190 KB less synchronous parsing at startup) was judged not
> worth an IndexedDB wrapper and a migration while app-open performance is acceptable.
> The one durable action item from this spec — folding the unschema'd TFSA planning keys
> into a schema (§5 Q4) — was accepted and is being done separately; it is a correctness
> fix independent of the storage substrate.

**Original recommendation (for the record): Option B, and only if Jan wants the boot-cost win; otherwise Option A.**

B is the only version whose benefit survived measurement (a smaller synchronous boot read) at a cost
that does not put rule #5 at risk — the four keys it moves are precisely the four the backup path is
already contractually indifferent to. C spends the most risk on the least-supported justification. D
buys a recovery path the encrypted cloud backup already covers.

Either way, **GAPS #9 and `PROJECT.md:226` should be corrected to match the measurements**, so the next
agent doesn't re-derive a size ceiling that isn't there — the same failure mode inc-37 hit.

---

## 4. What has already landed for this (safe under any option)

`backend/test/backup-roundtrip.test.mjs` — **21 tests**, node suite **30 → 31**. This is GAPS #13's
scoped task, and it is a prerequisite for Options B/C/D: `gatherBackup`/`applyBackup` are two of the
three `LS` bypasses, so they are exactly the code an async swap must rewrite, and until now they had
**no** unit coverage.

It slices the real backup block out of `app.js` by source marker and runs it in a `vm` over a fake
localStorage — Node suites never load `app.js`, so this is the only way to test the shipped code rather
than a copy. It pins: the envelope shape; raw-string (byte-identical) capture; skip-set exclusion;
prefix filtering; wiped-device round-trip; overwrite-not-merge; **all 8 `LEGACY_KEY_MAP` fields**;
partial legacy exports; envelope-wins-over-legacy precedence; `-1` rejection paths; that a backup file
cannot write foreign keys; `LS.get` corrupt-JSON fallback; `_backupNotify` firing only for durable
`pb.*` keys; and quota-failure returning `false` rather than throwing.

**It also found and fixed a live drift.** `verify-cloud-backup.mjs` hand-mirrors both functions ("kept
identical on purpose") and had drifted from `app.js` in two ways:

1. its `BACKUP_SKIP` listed **7** keys against app.js's **9** — `pb.rotation.lastgood.v1` and
   `pb.hotStocks.v1` were missing, so it could not have caught either volatile blob starting to ride
   cloud backups;
2. its `applyBackup` handles only the new envelope — **the entire legacy v3 branch was untested**,
   i.e. the path that exists so Jan's older backup files still restore.

(1) is fixed and now pinned by a guard that fails if the mirrored set ever diverges from `app.js` again.
(2) is covered properly by the new suite against the real source.

No shipped file changed — test-only — so **no `CACHE_NAME` bump is owed** (`sw.js` stays at
`playbook-shell-v88`).

---

## 5. Decisions needed from Jan — ANSWERED 2026-07-26

1. **Which option (A / B / C / D)?** → **A. Phase 5 is closed, resolved by evidence.** No
   IndexedDB migration, in any scope. The refactor is complete.
2. **Is a new bootstrap runtime file acceptable?** → **Moot under A.** No new runtime file, so
   the wiring checklist (and all 16 `verify-*.mjs` harness shells) is untouched.
3. **Claim B sanity-check — installed home-screen PWA?** → **Not needed to decide.** Option A
   holds either way: if it *is* installed, ITP exempts it and the risk is moot; if it is *not*,
   ITP evicts IndexedDB too, so migrating would not have helped. The mitigation stays the
   encrypted cloud backup, which is already shipped. (The ITP behaviour remains the one claim
   in this spec not verified by measurement here — but the decision no longer rests on it.)
4. **Fold the 8 unschema'd `pb-views.js` keys into a schema?** → **Yes for the two that matter,
   now.** `pb.tfsa.targets.v1` and `pb.tfsa.contribution.v1` are user-entered planning data and
   are moving into `PORTFOLIO_SCHEMA` beside `tfsaDeposits` (2026-07-26). This is a **correctness
   fix, independent of Phase 5**: they ride cloud backup today only by accident of the `pb.`
   prefix rule, one rename away from silently not being backed up. `PORTFOLIO_SCHEMA` rather than
   `SETTINGS_SCHEMA` because `setTargets` is called with an **updater function**
   (`pb-views.js:3660`) and only `setCollection` accepts one. The other **six** keys
   (`pb.heatmap.{exchange,mode,pf}.v1`, `pb.rotation.exchange.v1`,
   `pb.watchlist.{activeList,showSuggestions}.v1`) are genuinely view-local UI state and
   correctly stay on raw `usePersistedState` — no change.
5. **Write up the GAPS #9 / `PROJECT.md:226` corrections now?** → **Yes, done 2026-07-26**,
   together with `REFACTOR_STATUS.md`, `CLAUDE.md`, and the four `SECURITY_ROADMAP.md`
   references that treated refactor Phase 5 as a live prerequisite (`:19`, `:311`, `:363`,
   `:476`). Roadmap Phase 3 now **owns** its storage work outright rather than waiting on a
   phase that will never run — without this, the security roadmap would have started blocked
   on a dead dependency.

---

## Appendix — measuring the real device

The numbers in §1 are modelled from repo data shapes. To check them against Jan's actual device, paste
into DevTools on the live site:

```js
(() => {
  const rows = Object.keys(localStorage).filter(k => k.startsWith('pb.'))
    .map(k => ({ key: k, bytes: (localStorage.getItem(k) || '').length }))
    .sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((a, r) => a + r.bytes, 0);
  console.table(rows);
  console.log('keys:', rows.length, '· total:', (total / 1024).toFixed(1), 'KB',
              '·', (total / (5 * 1024 * 1024) * 100).toFixed(2) + '% of a 5 MB budget');
})();
```

If that reports a total materially above ~1 MB, §1's conclusion changes and Option C deserves
re-opening.
