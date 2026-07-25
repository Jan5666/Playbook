# Increment 37 — bounded, flushable `pb.prices.v1` write scheduler (design)

## Why — and a correction to GAPS #9

`REFACTOR_STATUS.md` listed this as the next-smallest step:

> **The GAPS #9 interim task** — debounce/throttle the `pb.prices.v1` write (it is in `BACKUP_SKIP`, so
> nothing downstream cares about write timing). Small, pure perf.

**That task's premise is wrong, and this increment records the correction.** GAPS.md #9 claims
`pb.prices.v1` "is re-stringified on every sweep" and that the write happens "currently every sweep".
It does not. `usePriceFeed` has carried a trailing debounce since the repository's **first commit**
(`2de0e16`, the squashed import — it was never a later fix, and never GAPS #9 work):

```js
// Debounced persist so a burst of merges writes once.
const persistRef = useRef(null);
const persistPrices = useCallback((obj) => {
  if (persistRef.current) clearTimeout(persistRef.current);
  persistRef.current = setTimeout(() => LS.set(PRICES_LS_KEY, obj), 1200);
}, []);
```

Both merge paths already ride it (`mergePrices` at `app.js:1632` and the per-batch `onBatch` at
`app.js:1651`), and `fetchQuoteBatch` emits `onBatch` once per **8-symbol** batch, so a whole sweep
already collapses into **one** `JSON.stringify` 1.2 s after its last batch. The main-thread
stringify-per-merge cost GAPS #9 describes **does not exist**. Verified by reading both call sites and
`pb-data.js:620–655`; there is no third writer of `PRICES_LS_KEY`.

So this increment does **not** add a debounce. It fixes the three real defects that the existing
debounce has, which GAPS #9 never identified, and moves the logic to where it can be tested.

## The three real defects

| # | Defect | Consequence |
|---|---|---|
| 1 | **No flush on hide/unmount.** iOS freezes/discards a backgrounded PWA and kills pending timers. | A sweep that finishes within 1.2 s of the user swiping away is **silently lost**. The seed-on-open code at `app.js:1587–1600` exists precisely so the app paints real numbers immediately — this is the path that starves it. |
| 2 | **Unbounded deferral (trailing-only, no max-wait).** Every `schedule` resets the timer. | A merge stream arriving faster than 1200 ms apart defers the write **forever**. Bounded in practice today only because batch round-trips usually exceed 1.2 s — an accident of network latency, not a guarantee. |
| 3 | **Stale-snapshot capture.** `persistPrices(PBStore.getPrices())` captures the map and holds it in a closure for 1.2 s. | Correct today only because *every* merge path also calls `persistPrices`, so the last call wins. It is an invariant nothing enforces, and it pins a whole prices map alive per pending write. |

Severity is **latent durability**, not perf. Defect 1 is the one a user could actually notice (cold
start with no cached prices); 2 and 3 are future-proofing ahead of Phase 5.

## What changes

**`pb-store.js` gains `createWriteScheduler(opts)`** — a pure, clock-injectable, bounded, flushable
trailing debounce. It lives in `pb-store.js` because that module already owns the prices slice, is
dual-mode (Node-testable), and is already wired into `index.html` / `sw.js` / `static.yml` / the 16
harness shells. **No new runtime file**, so the wiring checklist reduces to a `CACHE_NAME` bump.

```
createWriteScheduler({ write, delay, maxDelay, now?, setTimeout?, clearTimeout? })
  -> { schedule(), flush(), cancel(), isPending() }
```

- `write` takes **no arguments** — the caller's closure reads the freshest value at fire time. Kills
  defect 3 by construction.
- `delay` — the trailing quiet period. Unchanged at **1200 ms**.
- `maxDelay` — a hard ceiling measured from the **first** `schedule()` of a burst. Kills defect 2.
  **10 000 ms**: long enough that a normal sweep (which finishes well inside it) still writes exactly
  once, short enough to bound worst-case loss to one checkpoint interval.
- `flush()` fires a pending write **synchronously** and returns whether it wrote. Kills defect 1.
- `now` / `setTimeout` / `clearTimeout` are injectable **for tests only** — the browser passes none and
  gets real timers.

**`app.js` `usePriceFeed`** swaps its inline `setTimeout` for the scheduler, and adds a lifecycle
effect that flushes on `pagehide`, on `visibilitychange`→hidden, and on unmount. Both call sites become
argument-less `persistPrices()`.

## Behavioural contract

The write **content** is byte-identical — same `LS.set(PRICES_LS_KEY, PBStore.getPrices())`, same key,
same JSON shape. Only *timing* changes, and only in the three directions above:

| Scenario | Before | After |
|---|---|---|
| Burst of merges, then quiet | one write at `last + 1200 ms` | **identical** |
| Merge stream faster than 1200 ms | never writes | writes every 10 000 ms |
| Page hidden with a write pending | write lost | write flushed |
| Value changed between schedule and fire | writes the captured snapshot | writes the current map |

Row 1 is the characterization case and is pinned by test as **exactly** the old semantics
(`maxDelay: 0`, no flush ⇒ the old inline debounce).

## Rules check

- **Rule #5 (backup byte-compatibility)** — the write still goes through the `LS` adapter, to the same
  `pb.prices.v1` key, with the same serialized shape. `pb.prices.v1` is in `BACKUP_SKIP`, so `LS.set`
  does not call `_backupNotify` and cloud-sync cadence is untouched. No `LEGACY_KEY_MAP` migration
  needed. ✔
- **Rule #3 (money/alert code)** — no money math is added, moved, or reordered. Quote *values* are
  produced by `guardBatch`/`PBCore.guardQuote` and merged by `PBStore.mergePrices`, all untouched; this
  increment only schedules when the already-merged map is serialized. ✔
- **Rule #4 (`SessionBadge`)** — untouched. ✔
- `quote-guard.test.mjs:79`'s "both merge call sites ride the gate" guard stays green: both keep
  `PBStore.mergePrices(guardBatch(…))`. ✔
- `store.test.mjs:73`'s exact-`return`-line guard for `usePriceFeed` is untouched. ✔

## Verification

- Characterization first: the old inline debounce's semantics are pinned as tests **before** the app.js
  rewire, then re-run against the scheduler.
- New `backend/test/write-scheduler.test.mjs` (suite **29 → 30**) with a fake clock — deterministic, no
  real timers, no sleeps.
- Anti-drift source guards asserting the inline `setTimeout(… LS.set(PRICES_LS_KEY …))` is gone, that
  `usePriceFeed` delegates to `PBStore.createWriteScheduler`, and that the flush is wired to `pagehide`.
- `node --check` on both changed runtime files; full node suite (money gate green).
- Mount gate `verify-refresh-behavior` — the harness that actually exercises the price feed.

## Measured read-out

| | |
|---|---|
| `app.js` | 4999 → **5025** lines |
| `pb-store.js` | 129 → **179** lines |
| `window.PBApp` bridge | **38 → 38** (untouched — not a Phase 4 move) |
| `sw.js` `CACHE_NAME` | `playbook-shell-v87` → **v88** |
| Node suite | 29 → **30** files; new suite = **36 tests** |

- **Characterization: all 7 scenarios produced identical write traces** to the old inline debounce
  (`deepStrictEqual` on the virtual fire times). The quiet-period contract did not move.
- One test bug was caught and fixed during the run — the original `cancel:` case advanced past the
  1200 ms delay, so the write had already fired before `cancel()`. Rewritten to keep the burst pending
  (sub-delay re-schedules) and to assert the stronger property: a cancelled burst leaves **no ceiling
  behind** (nothing fires at the dead burst's `maxDelay`).
- Money gate green (money-math, cost-basis, import-matching, ee-ocr-parse, fx-providers).
- **Mount gate `verify-refresh-behavior`: ALL PASSED** — 20 assertions, including the auto-poll/manual
  cache-bust split, positions-first ordering, the `▲+$170.00 · +5.70%` Today pill, and the rule-#4
  "holdings rows deliberately have NO session badge" check. Run from a patched scratchpad copy (Linux
  Chromium, locally-served React — unpkg is 403-blocked in this container); the committed harness was
  not modified. Unlike inc-33/34/35, this gate **does** mount here, so it is a real pin, not a
  fails-identically-on-HEAD note.
- Encoding: `app.js` BOM=true / CRLF=0 / U+FFFD=0; `pb-store.js` BOM=false / CRLF=0 / U+FFFD=0.

## Out of scope

Phase 5 (IndexedDB behind `LS`) is unaffected and still wants its own spec + Jan's sign-off. This
increment deliberately does **not** touch the `LS` adapter, the key set, or any stored format — it only
makes the one churny write bounded, durable and testable, which is a strictly smaller change and a
better starting point for Phase 5.
