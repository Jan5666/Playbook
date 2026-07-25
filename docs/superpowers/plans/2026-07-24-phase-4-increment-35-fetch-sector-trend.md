# Phase 4 · Increment 35 — plan (turnkey recipe)

Target: move `async function fetchSectorTrend(sectorName)` (`app.js:4857–4890`) + its module-private
`const SECTOR_TREND_CACHE = {}` (`app.js:4856`) + the SPDR-sector-ETF explanatory comment
(`app.js:4850–4853`) from `app.js` into `pb-modals.js` beside its only consumer (`SectorDetailModal`),
re-deriving the two `PBContent` binds (`SECTOR_ETF`, `SECTOR_TREND_WINDOWS`) and the `PBData` bind
(`fetchViaProxies`) as bucket IIFE reads, and drop `fetchSectorTrend` from the `window.PBApp` bridge. It
has no root-`App` and no `pb-views.js` caller, so this is a clean bridge shrink (**39 → 38**) correcting
inc-34's "bridge now holds only genuinely-shared members" note — and it reaches the **bridge floor**. See
the design doc for the dependency inventory.

Branch: `claude/refactor-plan-continuation-7tf0bb` (off latest `origin/main` @ inc-34 / PR #43).

1. **Inventory** — done (design doc). Bridge change: **remove** `fetchSectorTrend` (39 → 38). 0 new
   bridge members; **+3 new IIFE reads** (`SECTOR_ETF`, `SECTOR_TREND_WINDOWS` from `PBContent`;
   `fetchViaProxies` from `PBData`); 0 injected lead reads (a hoisted bucket-private function).

2. **Verbatim move** — Node slice script (BOM + LF safe; read `utf8`, keep BOM, content-anchored
   boundaries: start `// Each GICS-style sector maps to the SPDR sector ETF …`, end the lone `}` closing
   `fetchSectorTrend`). Capture the block byte-for-byte; filter out the two `PBContent` alias lines
   (they become IIFE reads, not moved code); reuse the SPDR comment + `SECTOR_TREND_CACHE` + function
   verbatim as the insertion. Cut the whole block (comment + aliases + cache + function) from `app.js`;
   insert the comment + cache + function into `pb-modals.js` immediately **above** the inc-34
   `useSwipeDownToClose` block (just after the IIFE reads header), with a bucket-private doc-comment. As
   a hoisted `async function` it needs no lead read; `SectorDetailModal`'s bare call resolves to it.

3. **IIFE reads + lead-read shrink** — add to the `pb-modals.js` module-read header:
   `const fetchViaProxies = PBData.fetchViaProxies;` (PBData group), `const SECTOR_ETF =
   PBContent.SECTOR_ETF;` + `const SECTOR_TREND_WINDOWS = PBContent.SECTOR_TREND_WINDOWS;` (PBContent
   group). `SectorDetailModal`'s lead read drops `fetchSectorTrend`:
   `const { Icon, useBodyScrollLock, fetchSectorTrend } = window.PBApp;` →
   `const { Icon, useBodyScrollLock } = window.PBApp;`.

4. **Bridge + comment** — remove `fetchSectorTrend` from the `window.PBApp = { … }` publish line
   (`app.js`). **Not** registered on `window.PBModals` (no cross-bucket consumer — inc-31/33/34
   precedent). Rewrite the `app.js` comment that said "fetchSectorTrend stays above (impure Yahoo
   reader…)" to a pointer: `// fetchSectorTrend + SECTOR_TREND_CACHE moved to pb-modals.js (Phase 4 inc
   35) — pb-modals-only (SectorDetailModal)`.

5. **Wiring** — `sw.js` `CACHE_NAME` v85 → v86 (only shipped-file change; `pb-modals.js` already wired,
   no new runtime file → no `index.html`/`SHELL_ASSETS`/`static.yml`/harness change; `deploy-assets`
   stays green). **Content guard:** two `PBContent` binds leave `app.js`, so update
   `backend/test/content.test.mjs` to check `(appSrc + modSrc)` for the `SECTOR_ETF` /
   `SECTOR_TREND_WINDOWS` binds (inc-16 `SECTOR_FWD_PE` precedent); anti-inline asserts unchanged.

6. **Docs** — `architecture-map.html` bridge member list (remove `fetchSectorTrend`) + count → 38, and
   append the inc-35 clause to the bridge-evolution narrative. `REFACTOR_STATUS.md` Done +
   Current-state (bridge 39 → 38, `CACHE_NAME` v86, structural extraction **complete at the bridge
   floor**, next phase = `SECURITY_ROADMAP.md`). `CLAUDE.md` stale Current-state block refreshed. This
   spec + plan pair.

## Verification (all green before commit)

- `node --check app.js && node --check pb-modals.js && node --check sw.js`.
- Full node suite incl. **money gate** (`money-math`, `cost-basis`, `import-matching`, `ee-ocr-parse`)
  + **content guard**: `for f in backend/test/*.test.mjs; do node "$f" || break; done` → **28/28**.
- Anti-drift greps: `function fetchSectorTrend` = 0 app.js / 1 pb-modals.js / 0 pb-views.js;
  `SECTOR_TREND_CACHE` 0 app.js code / 1 def pb-modals.js; `const SECTOR_(ETF|TREND_WINDOWS) =
  PBContent` 0 app.js / 2 pb-modals.js; absent from the `window.PBApp` publish line (bridge count 38);
  0 lead reads still pull it from `window.PBApp`; 1 bare call site + 1 definition intact.
- **Render gate** — the committed `verify-refresh-behavior.mjs` mount gate does not mount in this remote
  Linux container (fails identically on pristine `HEAD` — a harness/container artifact). Validated with
  two standalone throwaway probes (scratchpad): a **load-time smoke** (execute the `pb-modals.js` IIFE
  under `React`/`PB*`/`window` stubs → all 11 modals register, proving the new IIFE-top reads don't
  throw) and a **function probe** (expose + invoke `fetchSectorTrend` with a stubbed `fetchViaProxies`
  → unsupported branch, +10% 1m trend, cache-hit reference identity — proving all four in-scope deps
  resolve bucket-local). No money/network side-effects.
- U+FFFD scan over `app.js` + `pb-modals.js`; `git checkout -- test-screenshots/` if touched.

## Landing

Commit `refactor(modal): relocate fetchSectorTrend into pb-modals.js (inc 35)`; push
`git push -u origin claude/refactor-plan-continuation-7tf0bb`. **No PR, never `main`** — Jan reviews and
lands.
