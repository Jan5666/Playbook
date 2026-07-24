# Phase 4 · Increment 34 — plan (turnkey recipe)

Target: move `function useSwipeDownToClose(panelRef, onClose, enabled = true)` (`app.js:302–439`) from
`app.js` into `pb-modals.js` beside its only consumers (9 modals), and drop `useSwipeDownToClose` from
the `window.PBApp` bridge. It has no root-`App` and no `pb-views.js` caller, so this is a clean bridge
shrink (**40 → 39**) correcting inc-33's "bridge now holds only genuinely-shared members" note. See the
design doc for the dependency inventory.

1. **Inventory** — done (design doc). Bridge change: **remove** `useSwipeDownToClose` (40 → 39). 0 new
   bridge members, 0 new IIFE reads, 0 injected lead reads (uses only `useRef`/`useEffect`, already
   IIFE-read at `pb-modals.js:5`).

2. **Verbatim move** — Node slice script (BOM + LF safe; read `utf8`, keep BOM, content-anchored
   boundaries: start `function useSwipeDownToClose(panelRef, onClose, enabled = true) {`, end the lone
   `}` before the `// MARKET_CURRENCY …` comment). Capture the exact block from `app.js` and reuse it
   byte-for-byte as the insertion. Cut it from `app.js` and insert into `pb-modals.js` immediately
   **above** `function SectorWeightRows(` (just after the IIFE reads block), with a bucket-private
   doc-comment. As a hoisted function declaration it needs no lead read; the bare calls in the 9 modals
   resolve to it directly.

3. **Lead read shrink** — the 9 `pb-modals.js` lead reads each drop `useSwipeDownToClose` from their
   `const { … } = window.PBApp;` destructure (`ContributionModal`, `ContributionImportModal`,
   `SettingsModal`, `DetailModal`, `AlertsModal`, `ImportModal`, `BuyModal`, `SellModal`,
   `PositionModal`).

4. **Bridge + comment** — remove `useSwipeDownToClose` from the `window.PBApp = { … }` publish line
   (`app.js`). **Not** registered on `window.PBModals` (no cross-bucket consumer — the inc-31
   `SectorWeightRows` / inc-33 `useContainerWidth` precedent). Leave a pointer comment where the code
   was: `// useSwipeDownToClose moved to pb-modals.js (Phase 4 inc 34).`

5. **Wiring** — `sw.js` `CACHE_NAME` v84 → v85 (only shipped-file change; `pb-modals.js` already wired,
   no new runtime file → no `index.html`/`SHELL_ASSETS`/`static.yml`/harness change; `deploy-assets`
   stays green). No `PBContent`/`PBData`/`PBCore` bind left app.js → no delegation/anti-inline guard
   change; no test references `useSwipeDownToClose`.

6. **Docs** — `architecture-map.html` bridge member list (remove `useSwipeDownToClose`) + count → 39,
   and append the inc-34 note to the bridge-evolution narrative. `REFACTOR_STATUS.md` Done +
   Current-state (bridge 40 → 39, `CACHE_NAME` v85, correct the inc-33 "only genuinely-shared members"
   line). This spec + plan pair.

## Verification (all green before commit)

- `node --check app.js && node --check pb-modals.js && node --check sw.js`.
- Full node suite incl. **money gate** (`money-math`, `cost-basis`, `import-matching`, `ee-ocr-parse`):
  `for f in backend/test/*.test.mjs; do node "$f" || break; done` → **28/28**.
- Anti-drift greps: `function useSwipeDownToClose` = 0 app.js / 1 pb-modals.js / 0 pb-views.js; absent
  from the `window.PBApp` publish line (bridge count 39); 0 lead reads still pull it from
  `window.PBApp`; 9 bare call sites + 1 definition intact.
- **Render gate** — the committed `verify-refresh-behavior.mjs` mount gate does not mount in this
  remote Linux container (fails identically on pristine `HEAD` — a harness/container artifact, not a
  regression). Validated with a standalone throwaway render probe (scratchpad `probe.mjs`:
  puppeteer-core + repo files + local React via `/__react.js`+`/__react-dom.js`, `--no-sandbox`,
  `CHROME_PATH=/opt/pw-browsers/chromium`, `pageerror`/`window.error` capture): mount → render
  `ContributionModal` + `SellModal` (two `useSwipeDownToClose` consumers) into detached roots → assert
  both produce their `.modal-panel` with **zero page exceptions**, and `'useSwipeDownToClose' in
  window.PBApp` is **false**. No money side-effects.
- U+FFFD scan over `app.js` + `pb-modals.js`; `git checkout -- test-screenshots/` if touched.

## Landing

Branch `claude/refactor-plan-continuation-2x65br` (off latest `origin/main` @ inc-33/PR #42). Commit
`refactor(modal): relocate useSwipeDownToClose into pb-modals.js (inc 34)`; push
`git push -u origin claude/refactor-plan-continuation-2x65br`. **No PR, never `main`** — Jan reviews
and lands.
