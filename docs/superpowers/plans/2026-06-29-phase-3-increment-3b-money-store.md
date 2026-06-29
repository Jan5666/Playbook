# Phase 3 Increment 3b — Money portfolio slices → PBStore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline; no subagents per Jan's token-saving directive). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 4 money `usePortfolio` slices (`positions`, `transactions`, `contributions`, `tfsaDeposits`) off `usePersistedState` into the existing `portfolio` collections slice on `PBStore`, behavior-identical — completing the slice migration begun in 3a.

**Architecture:** Reuse the 3a `configureCollections`/`setCollection`/`useCollection` mechanism unchanged. Append 4 entries to `PORTFOLIO_SCHEMA`; replace the 4 slice declarations in `usePortfolio` with `useCollection` reads + `useCallback`-stable setter wrappers. Every mutator body and the startup dedup effect stay unchanged.

**Tech Stack:** Vanilla ES (no build step), React 18 UMD, `useSyncExternalStore`, `node:test`, headless-Chrome verify harnesses.

## Global Constraints

- **No `pb-store.js` change.** The collections mechanism already exists + is unit-tested from 3a. Do not modify it.
- **Mutator bodies stay byte-for-byte unchanged** — only the 4 slice declarations + 4 schema lines change in `app.js`. No money formula is edited (those live in `pb-core.js`).
- **Preserve C4 as-is:** `addPosition`'s final `toast(positions.find(...) ? … : …)` keeps reading the pre-update closure. Do NOT "fix" it here.
- **Persistence byte-identical:** all 4 keys are durable (none in `BACKUP_SKIP`); the injected `LS` adapter keeps each on its own `pb.X.vN` key with the same backup-notify.
- **This session does NOT commit/push/merge.** Jan does that. Where a step says "leave for Jan," stop short of `git commit`. Run all verifications regardless.
- **Test runner:** no npm script; `node backend/test/<file>.test.mjs`. app.js ships CRLF; the Edit tool normalizes CRLF so `\n`-based edits match.

---

### Task 1: Update anti-drift guards (RED)

**Files:**
- Test: `backend/test/store.test.mjs` — modify the 3a guard at "anti-drift: migrated non-money slices…" and replace the "money slices stay usePersistedState (3b out of scope)" guard.

**Interfaces:**
- Consumes: `appSrc` (the `app.js` source string already read at the top of the file).
- Produces: guards that fail until Task 2 migrates the 4 money slices.

- [ ] **Step 1: Broaden the "migrated" guard + replace the out-of-scope guard**

In `backend/test/store.test.mjs`, change the migrated-slices guard to include the 4 money keys:

```js
test('anti-drift: migrated portfolio slices no longer use usePersistedState', () => {
  for (const k of ['pb.watchlist.v2','pb.watchlistGroups.v1','pb.alerts.v2',
    'pb.sectorCache.v1','pb.sectorWeights.v1',
    'pb.positions.v2','pb.transactions.v1','pb.contributions.v1','pb.tfsa.deposits.v1']) {
    const re = new RegExp("usePersistedState\\('" + k.replace(/\./g, '\\.') + "'");
    assert.ok(!re.test(appSrc), `${k} should be migrated off usePersistedState into PBStore`);
  }
});
```

Replace the entire `test('anti-drift: money slices stay usePersistedState (3b out of scope)', …)` block with a schema-membership guard:

```js
test('anti-drift: money slices are registered in PORTFOLIO_SCHEMA', () => {
  for (const k of ['pb.positions.v2','pb.transactions.v1','pb.contributions.v1','pb.tfsa.deposits.v1']) {
    const re = new RegExp("key:\\s*'" + k.replace(/\./g, '\\.') + "'");
    assert.ok(re.test(appSrc), `${k} must be a PORTFOLIO_SCHEMA entry after 3b`);
  }
});
```

(The `pb.fxRates.v1`-stays-usePersistedState guard is left as-is — fxRates remains out of scope.)

- [ ] **Step 2: Run to verify the migrated guard fails**

Run: `node backend/test/store.test.mjs 2>&1 | grep -E "migrated portfolio|registered in PORTFOLIO"`
Expected: `✖ anti-drift: migrated portfolio slices no longer use usePersistedState` (the 4 money keys still match `usePersistedState`); the schema-membership guard also FAILS (keys not yet in `PORTFOLIO_SCHEMA`).

---

### Task 2: Migrate the 4 money slices + schema + SW bump (GREEN)

**Files:**
- Modify: `app.js` — money slice decls (`2184`, `2196`, `2197`, `2204`); `PORTFOLIO_SCHEMA` (append 4 entries after the 3a entries)
- Modify: `sw.js` (cache version bump)
- Test: `backend/test/store.test.mjs` (guards from Task 1); money node suites; browser smokes

**Interfaces:**
- Consumes: `PBStore.useCollection`, `PBStore.setCollection`, `PORTFOLIO_SCHEMA` (all from 3a).
- Produces: `usePortfolio` returns the same names (`positions`/`setPositions`/`transactions`/`setTransactions`/`contributions`/`setContributions`/`tfsaDeposits`/`setTfsaDeposits` + all mutators), now store-backed. No consumer signature changes.

- [ ] **Step 1: Migrate the 4 declarations in `usePortfolio`**

In `app.js`, replace line 2184:
```js
  const [positions, setPositions] = usePersistedState('pb.positions.v2', []);
```
with:
```js
  const positions = PBStore.useCollection('positions');
  const setPositions = useCallback(v => PBStore.setCollection('positions', v), []);
```

Replace line 2196 (keep the preceding comment block intact):
```js
  const [contributions, setContributions] = usePersistedState('pb.contributions.v1', []);
```
with:
```js
  const contributions = PBStore.useCollection('contributions');
  const setContributions = useCallback(v => PBStore.setCollection('contributions', v), []);
```

Replace line 2197:
```js
  const [transactions, setTransactions] = usePersistedState('pb.transactions.v1', []);
```
with:
```js
  const transactions = PBStore.useCollection('transactions');
  const setTransactions = useCallback(v => PBStore.setCollection('transactions', v), []);
```

Replace line 2204 (keep the preceding comment block intact):
```js
  const [tfsaDeposits, setTfsaDeposits] = usePersistedState('pb.tfsa.deposits.v1', []);
```
with:
```js
  const tfsaDeposits = PBStore.useCollection('tfsaDeposits');
  const setTfsaDeposits = useCallback(v => PBStore.setCollection('tfsaDeposits', v), []);
```

Leave every mutator body (`addPosition`, `importPositions`, `sellPosition`, `updatePosition`, `removePosition(s)`, `addContribution`, `removeContribution`, `importContributions`, `addTfsaDeposit`, `updateTfsaDeposit`, `removeTfsaDeposit(s)`) and the startup dedup `useEffect` UNCHANGED — they call these wrappers.

- [ ] **Step 2: Append the 4 money entries to `PORTFOLIO_SCHEMA`**

In `app.js`, in the `PORTFOLIO_SCHEMA` array (added in 3a, just after `PBStore.configureSettings(...)`), add the 4 money entries after the `sectorWeights` line, before the closing `];`:

```js
  { name: 'positions',     key: 'pb.positions.v2',     default: [] },
  { name: 'transactions',  key: 'pb.transactions.v1',  default: [] },
  { name: 'contributions', key: 'pb.contributions.v1', default: [] },
  { name: 'tfsaDeposits',  key: 'pb.tfsa.deposits.v1', default: [] },
```

- [ ] **Step 3: Verify app.js parses + anti-drift guards pass**

Run: `node --check app.js`
Expected: no output.

Run: `node backend/test/store.test.mjs 2>&1 | grep -E "migrated portfolio|registered in PORTFOLIO|tests |pass |fail "`
Expected: both guards PASS; `fail 0`.

- [ ] **Step 4: Run the money correctness gate + full node suite**

Run the money suites explicitly:
`node backend/test/money-math.test.mjs && node backend/test/cost-basis.test.mjs && node backend/test/import-matching.test.mjs && node backend/test/ee-ocr-parse.test.mjs`
Expected: all PASS unchanged (no formula changed).

Run the full suite:
`for f in backend/test/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "PASS $(basename $f)" || echo "FAIL $(basename $f)"; done`
Expected: every suite PASS, no `FAIL` lines.

- [ ] **Step 5: Bump the SW cache version**

In `sw.js`, change `playbook-shell-v39` → `playbook-shell-v40` (single occurrence).
Run: `node --check sw.js`
Expected: no output.

- [ ] **Step 6: Browser smoke — required gate**

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: app MOUNTS (no `useCollection` ReferenceError); the "Today" pill renders and positions are fetched first — i.e. the seeded `pb.positions.v2` flows through `configureCollections` → `useCollection`. The standing "holdings rows deliberately have NO session badge" assertion holds. ALL PASSED.

Run a holdings-seeding harness for extra coverage (rerun once if it hits the flaky CDP "Execution context destroyed" race):
`node backend/test/verify-holdings-redesign.mjs` (or `verify-goal-holdings.mjs`)
Expected: app MOUNTS and renders holdings from the seeded positions.

If `verify-refresh-behavior` fails to MOUNT, that's a real wiring regression — debug before proceeding (node suites can't catch a browser-only ReferenceError).

- [ ] **Step 7: Leave staged for Jan (do not commit)**

Report: 3b done. List green money suites + full-suite result + browser-smoke results. Note `sw.js` v39→v40. Changes + new spec/plan left uncommitted for Jan.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- 4 money slices migrated → Task 2 Steps 1-2. ✅
- Mechanism reused unchanged (no pb-store.js edit) → Global Constraints; no task touches pb-store.js. ✅
- Mutator bodies + dedup effect unchanged; C4 preserved → Task 2 Step 1 (only decls change) + Global Constraints. ✅
- Schema seeds all via existing configure call → Task 2 Step 2 (no new configure call). ✅
- Anti-drift guards (money keys off usePersistedState; money keys in PORTFOLIO_SCHEMA) → Task 1. ✅
- Money correctness gate (money-math/cost-basis/import-matching/ee-ocr) → Task 2 Step 4. ✅
- Persistence byte-identical via LS → Global Constraints + schema uses existing `storage: LS`. ✅
- SW v39→v40 → Task 2 Step 5. ✅
- Browser smoke required gate → Task 2 Step 6. ✅
- No commit (Jan's) → Global Constraints + Task 2 Step 7. ✅

**Placeholder scan:** none — every step has concrete code/commands. ✅

**Type/name consistency:** slice names (`positions`/`transactions`/`contributions`/`tfsaDeposits`) + keys identical across Task 1 guards, Task 2 wiring, and the schema. `useCollection`/`setCollection`/`PORTFOLIO_SCHEMA` match the 3a-defined API. ✅
