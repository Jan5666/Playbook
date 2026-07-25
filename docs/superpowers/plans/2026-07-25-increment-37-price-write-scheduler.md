# Increment 37 — plan (turnkey recipe)

Target: replace the inline `pb.prices.v1` debounce inside `usePriceFeed` (`app.js:1610–1615`) with a
bounded, flushable, **Node-testable** scheduler in `pb-store.js`, and flush it when the page goes away.
This is *not* a Phase 4 bucket move — the `window.PBApp` bridge is untouched at **38**. It closes the
GAPS #9 interim task by **correcting its premise**: the debounce already existed (since the repo's
first commit), so the perf problem GAPS described was not real; the three durability defects fixed
here are. See the design doc for the evidence.

Branch: `claude/refactor-plan-continuation-sq76f9` (off latest `origin/main` @ inc-36 / PR #45).

1. **Verify the premise before writing code.** `git log -S"persistRef" -- app.js` → the debounce lands
   in `2de0e16`, the squashed initial import. Grep every writer of `PRICES_LS_KEY` (2 call sites, both
   already debounced) and read `fetchQuoteBatch` (`pb-data.js:620–655`) to confirm `onBatch` fires once
   per 8-symbol batch. Conclusion: a sweep already collapses to one `JSON.stringify`. **Do not add a
   debounce.** Record the correction in the spec.

2. **Characterization FIRST** (the old timing is the contract). In
   `backend/test/write-scheduler.test.mjs`, replicate the old inline debounce as a reference
   implementation driven by a **fake clock**, and run a 7-scenario matrix (single schedule, 5-call
   burst, sub-delay starvation stream, the 1199/+1 boundary, two separated bursts, no schedules,
   exact-delay re-schedule) against `createWriteScheduler({ maxDelay: 0 })`. Write traces must be
   `deepStrictEqual`. Also pin the **defects themselves** as tests — the starvation stream writes 0
   times, the hide-at-100 ms write is lost, the captured snapshot persists `v1` — so a future silent
   regression is visible.

3. **`pb-store.js` — add `createWriteScheduler`** beside `createStore`, under the existing "Pure,
   React-free, fully unit-testable" heading. Plain `Edit` is fine here (no BOM, LF, no `\uXXXX`
   escapes). Key details:
   - `write()` takes **no arguments** — the caller reads at fire time.
   - `burstStart` is captured only when `timer === null`, so `maxDelay` measures from the **first**
     schedule of a burst; `fire()` resets it so ceilings repeat rather than accumulate.
   - `fire()` calls `stop()` **before** `write()`, so a throwing write (quota exceeded) leaves the
     scheduler idle rather than wedged with a dead timer id.
   - `remaining <= 0` fires synchronously inside `schedule()`.
   - `now`/`setTimeout`/`clearTimeout` injectable; default to real timers.
   Add to the `PBStore` export object: `createStore, createWriteScheduler,`.

4. **`app.js` — rewire via a Node slice script, NEVER the Edit tool** (BOM + LF; literal `—` in the
   comments). Assert every anchor line by exact content before splicing; splice by line index and
   recompute the shift after the first insert. Three edits:
   - `PRICES_PERSIST_MS = 1200` / `PRICES_PERSIST_MAX_MS = 10000` inserted after `PRICES_MAX_AGE_MS`.
   - The 6-line persist block → a lazily-initialised `persistRef` holding the scheduler, an
     argument-less `persistPrices`, and a `useEffect` flushing on `pagehide`,
     `visibilitychange`→hidden, and unmount.
   - Both call sites drop the now-unused snapshot arg: `persistPrices()`.
   Keep `PBStore.mergePrices(guardBatch(…))` untouched at both sites — `quote-guard.test.mjs:79`
   asserts it.

5. **Wiring** — `pb-store.js` is an existing runtime file already in `index.html` / `sw.js`
   `SHELL_ASSETS` / `static.yml` / the harness shells, so the checklist reduces to **bump `CACHE_NAME`**
   `playbook-shell-v87` → **v88**. No new script tag, no `static.yml` change, no harness edits.

6. **Anti-drift source guards** (in the new suite): the inline
   `setTimeout(() => LS.set(PRICES_LS_KEY …))` is gone; `app.js` never redefines
   `createWriteScheduler`; `usePriceFeed` calls `PBStore.createWriteScheduler(`; the write still reads
   `LS.set(PRICES_LS_KEY, PBStore.getPrices())` (rule #5); `pagehide` is wired;
   `PRICES_PERSIST_MAX_MS` is configured; `pb.prices.v1` is still inside `BACKUP_SKIP`.

7. **Verify (all green before commit):** `node --check app.js` + `node --check pb-store.js`; full node
   suite (**30/30** — the new file lifts it from 29 — money gate + content guard + deploy-assets);
   **mount gate** `verify-refresh-behavior`, which is the harness that actually drives the price feed —
   run it from a **patched scratchpad copy** (Linux Chromium at `/opt/pw-browsers/chromium`,
   `--no-sandbox`, React served locally at `/__react.js` because unpkg is 403-blocked); U+FFFD / BOM /
   CRLF scan; `git checkout -- test-screenshots/`.

8. **Docs** — `GAPS.md` #9 (correct the false claim, mark the interim task done), `architecture-map.html`
   (`:239` price-feed note + `:394` `pb-store` node notes; **no** bridge-count change), the spec's
   measured read-out, `REFACTOR_STATUS.md` Done + Current state, and `CLAUDE.md`'s Current-state block
   (plus the stale "BOM + CRLF" → "BOM + LF"). Commit + push to the feature branch. **No PR, never
   `main`.**

## Read-out (measured)

- `app.js` **4999 → 5025** lines; `pb-store.js` **129 → 179**. Bridge **38 → 38** (untouched).
- Node suite **30/30**; new file **36 tests**, all on a fake clock (no sleeps, deterministic).
- Characterization: all 7 scenarios produced **identical write traces** to the old inline debounce.
- Mount gate `verify-refresh-behavior`: **ALL PASSED** (20 assertions, incl. the rule-#4
  no-session-badge-on-holding-rows check and the `▲+$170.00 · +5.70%` Today pill).
- Money gate green: money-math, cost-basis, import-matching, ee-ocr-parse, fx-providers.
- Encoding: `app.js` BOM=true, CRLF=0, U+FFFD=0; `pb-store.js` BOM=false, CRLF=0, U+FFFD=0.
