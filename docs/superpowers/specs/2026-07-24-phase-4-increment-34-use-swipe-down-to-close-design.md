# Phase 4 · Increment 34 — `useSwipeDownToClose` → `pb-modals.js` (design)

## Why

Phase 4 peels large view/modal components out of the no-build `app.js` UMD monolith into the
browser-only classic-script buckets (`pb-views.js`, `pb-modals.js`), shrinking the render-time
`window.PBApp` bridge toward **only genuinely-shared members** — anything consumed by just one bucket
(and not by root `App`) belongs *in* that bucket, not on the bridge.

inc-33 called the bridge "now holds only genuinely-shared members." A fresh caller inventory shows one
more mis-classification, the mirror of inc-33: `useSwipeDownToClose` (`app.js:302–439`, the iOS-sheet
swipe-to-dismiss hook) is **pb-modals-only**. It sits on the bridge only because it was authored in
`app.js` before the modal bucket existed and was bridged wholesale with the other modal primitives at
inc-15/16 — it was never re-examined when the modals it serves all moved into `pb-modals.js`.

A fresh caller inventory confirms it is **pb-modals-only**:

- `pb-modals.js` consumes it in **9 modals** (`ContributionModal`, `ContributionImportModal`,
  `SettingsModal`, `DetailModal`, `AlertsModal`, `ImportModal`, `BuyModal`, `SellModal`,
  `PositionModal`) — each via a `window.PBApp` lead read + a bare call.
- **Zero** root-`App` callers, **zero** `pb-views.js` callers (the only `app.js` occurrences are the
  definition, the bridge publish line, and three comments).
- It works today because `app.js` runs at **global scope** (no IIFE wrapper), so the top-level
  `function useSwipeDownToClose()` is a *global* that the bucket also redundantly re-reads from
  `window.PBApp`.

So this is a clean bridge-shrink, the same self-correcting cadence by which inc-33 corrected inc-32.
It shrinks the bridge by 1 (**40 → 39**).

## Scope

Move into `pb-modals.js` (verbatim): `function useSwipeDownToClose(panelRef, onClose, enabled = true)`
(`app.js:302–439`, ~138 lines) — the touch-drag / velocity / MutationObserver-guarded close hook,
bucket-private after the move (hoisted function declaration, no lead read needed). Pure display /
gesture behaviour — no money/alert code (rules #3/#4 unaffected).

Stays put in `app.js`: nothing adjacent moves; the hook sat between `useAsyncCache` (above) and the
`MARKET_CURRENCY`/money-helper binds (below), both of which are unrelated and remain.

## Dependency inventory

Move block = `function useSwipeDownToClose(panelRef, onClose, enabled = true)` (302–439).

| identifier | classification |
|---|---|
| `useRef`, `useEffect` | native React hooks — already IIFE-read at `pb-modals.js` top (line 5) |
| `window`, `document`, `Date`, `Math`, `String`, `MutationObserver`, `setTimeout`, `clearTimeout` | native browser globals (free) |
| `panelRef`, `onClose`, `enabled` | parameters — self-contained |

⇒ **Clean verbatim move. 0 new bridge members, 0 new IIFE reads, 0 injected lead reads** (it uses only
hooks already IIFE-read in `pb-modals.js`; as a hoisted bucket-private function its callers call it
directly). Nine lead reads *shrink*: each `const { …, useSwipeDownToClose, … } = window.PBApp;` drops
`useSwipeDownToClose`.

## Bridge / registration

- `window.PBApp` publish line: **remove** `useSwipeDownToClose` (bridge **40 → 39**).
- **Not** registered on `window.PBModals` — nothing outside `pb-modals.js` consumes it (the inc-31
  `SectorWeightRows` / inc-33 `useContainerWidth` precedent).
- The nine `pb-modals.js` lead reads drop `useSwipeDownToClose`; the bare calls
  (`useSwipeDownToClose(panelRef, …)`) are unchanged — they resolved to the app.js global before and
  resolve to the bucket-local function now. `app.js` retains a pointer comment where the code was.

## Encoding note

`app.js` and `pb-modals.js` are **BOM + LF** (verified 0 CRLF). The moved block is authored in ASCII
(no `£ € · —` glyphs). Move via a Node slice script (read/write `utf8`, split/join `\n`, keep the BOM,
content-anchored boundaries) — never the Edit tool; the captured source block is reused byte-for-byte
as the insertion so the move is provably verbatim.

## Read-out (measured)

- `node --check` app.js / pb-modals.js / sw.js: **OK**.
- Encoding after move: both **BOM + LF**, U+FFFD scan **clean** (0 replacement chars in either file).
- Anti-drift: `function useSwipeDownToClose` = **0** app.js / **1** pb-modals.js / **0** pb-views.js;
  `useSwipeDownToClose` **absent** from the `window.PBApp` publish line (bridge count **39**); **0**
  remaining lead reads pull it from `window.PBApp`; 9 bare call sites + 1 definition intact.
- Full node suite (money gate + content guard + deploy-assets): **28/28 pass**.
- Render gate: the committed `verify-refresh-behavior.mjs` mount gate does **not** mount in this remote
  Linux container (it fails identically on pristine `HEAD` — a container/harness setup artifact, not a
  regression). Validated instead with a standalone throwaway render probe (puppeteer-core + repo files
  + local React via `/__react.js`+`/__react-dom.js`, `--no-sandbox`,
  `CHROME_PATH=/opt/pw-browsers/chromium`, `pageerror` + `window.error` capture): app mounts, then
  `ContributionModal` and `SellModal` (two `useSwipeDownToClose` consumers) render into detached roots
  → **both produce their `.modal-panel`** (proving the hook's `useEffect` ran without "not a function")
  with **zero page exceptions**, and `('useSwipeDownToClose' in window.PBApp)` is **false** (bridge
  drop confirmed live).
- app.js: 5215 → 5078 lines (~137 net out); bridge 40 → 39; `sw` `CACHE_NAME` v84 → v85;
  `architecture-map.html` bridge list + count brought current (39).
