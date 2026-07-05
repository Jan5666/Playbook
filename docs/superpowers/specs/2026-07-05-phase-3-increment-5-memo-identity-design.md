# Phase 3 increment 5 — memo / identity stabilization — Design

**Date:** 2026-07-05
**Branch:** `refactor/phase-3-increment-5-memo-identity` (off `origin/main` `716d5f8`)
**Status:** the LAST Phase-3 item. After this, Phase 3 is complete → Phase 4 (split components by feature).

## Problem

Phase 3 increment 1 memo'd three leaf components (`SessionBadge`, `PriceBlock`, `HoldingRow`), but two
sources of per-render identity churn keep the memoization from paying off, and increment 4 explicitly
deferred the cleanup to "the next increment". `App` re-renders for ordinary reasons — notably the shared
`useNow` timer that ticks the "Updated Ns ago" refresh chip **once per second**, plus any
settings/collection change — and on each render it hands children freshly-minted callback identities.

**Churn source 1 — the edge action wrappers (increment-4 flagged).** `usePortfolio` mutators are plain
`const` closures over reactive hook vars (new identity per render); the `App` edge then wraps each in
`withToast(_p.x)` (added in increment 4), which **also** mints a new identity per render. Same for the
three push actions and the backup caller.

**Churn source 2 — the UI handlers that actually feed the memo'd leaves.** `HoldingRow` takes four
callback props — `onOpenDetail, onBuyPosition, onSellPosition, onEditPosition`. At the `App` edge these
resolve to **inline UI handlers**, *not* the wrapped mutators:

```js
onOpenDetail: openDetail,                                    // openDetail (app.js:3371) is a plain const, not useCallback'd
onEditPosition: pos => { setPosModalEditId(pos.id); setPosModalOpen(true); },  // inline arrow, ~L3420 & ~L3457
onBuyPosition:  pos => setBuyModalPos(pos),                  // inline arrow
onSellPosition: pos => setSellModalPos(pos),                // inline arrow
```

So **`HoldingRow`'s memo is defeated by these four handlers**, which change identity every render.
Stabilizing only the mutator/wrapper identities (source 1) would finish the *literal* deferred item but
would **not** make `HoldingRow` stop re-rendering, because its props are the UI handlers, not the
mutators. `HoldingRow`'s other props are already ref-stable when a row's data is unchanged: `position`
(element ref from `positions`), `quote` (`prices[priceKey(...)]` — per-symbol ref-stable from the
increment-1 store) and `rates` (`fxRates?.rates`). `PriceBlock` takes only data props, so its memo
already works; `SessionBadge` likewise.

There is **no felt performance pain** — this increment finishes Phase 3's "React.memo on leaves" goal
cleanly and correctly; it is not chasing a specific hotspot.

## Goal

Stabilize the callback identities `App` hands to children so the already-memo'd `HoldingRow` stops
re-rendering on unrelated `App` renders, and remove the increment-4-flagged wrapper churn. Behaviour
must be identical.

## Chosen approach — edge-only stabilization, two pieces (Approach A)

Absorb all churn **at the `App` edge**, leaving the data-layer hook bodies untouched. Lowest-risk: no
mutator body changes, so the money math and its test gate are trivially unaffected; every edit is in
`App`'s render.

- **Piece 1 — action wrappers (hygiene, the inc-4 deferred item):** replace the per-render `withToast`
  factory + wrappers with one ref-backed helper, `useToastEvents`, giving every mutator/push/backup
  action a stable identity.
- **Piece 2 — memo-leaf UI handlers (the runtime payoff):** `useCallback` the four handlers that reach
  `HoldingRow` (`openDetail` + the buy/sell/edit modal-openers), so its memo genuinely bites.

Rejected alternatives:

- **B — full "mutators→actions" (read via `PBStore.getCollection`, `useCallback([])` in the hook).**
  Cleanest long-term but rewrites **every** mutator body including the money ones, for no felt-pain
  payoff. Higher risk than a "finish cleanly" increment warrants. Not chosen.
- **C — broad memo + self-subscription sweep.** Biggest structural change and it **overlaps Phase 4's
  component split** — doing it now risks re-doing it there. Not chosen.

### Piece 1 mechanism — `useToastEvents`

Introduce one small edge helper that takes an object of (possibly-churning) action implementations and
returns an object of **stable-identity** wrappers. Each wrapper always calls the latest impl and toasts
`describeOutcome(result)` at the edge; the impls and `toast` are read through refs so the returned
identities never change (the established "latest-ref / `useEffectEvent`" pattern). It replaces the
`withToast` factory *and* unifies the portfolio, push, and backup edges under one mechanism.

```js
// Top-level, immediately after describeOutcome (~L2708, before ToastContext).
// impls: { name -> fn } of action implementations (may be recreated each render).
// Returns { name -> stableFn }: each stableFn's identity is fixed for the component's
// lifetime but always invokes the latest impl and toasts describeOutcome(result) at
// the edge. Safe to hand to React.memo'd children. Async impls toast after they resolve
// and the wrapper returns the impl's own value unchanged (e.g. addWatchGroup's { id }).
function useToastEvents(impls, toast) {
  const implsRef = useRef(impls); useLayoutEffect(() => { implsRef.current = impls; });
  const toastRef = useRef(toast); useLayoutEffect(() => { toastRef.current = toast; });
  return useMemo(() => {
    const out = {};
    for (const name of Object.keys(implsRef.current)) {   // fixed action set → keys stable
      out[name] = (...args) => {
        const r = implsRef.current[name](...args);
        if (r && typeof r.then === 'function')
          return r.then(o => { const m = describeOutcome(o); if (m) toastRef.current(m); return o; });
        const m = describeOutcome(r); if (m) toastRef.current(m);
        return r;
      };
    }
    return out;
  }, []); // built once; wrappers resolve implsRef.current[name] lazily at call time
}
```

At the `App` edge, replace the `withToast` `useCallback` and the ~30 `const x = withToast(_p.x)` lines
(`app.js` ~2954–3006) with a `useToastEvents({...}, toast)` call over the portfolio actions; do the same
for the three push wrappers (~L3249–3251) and fold `saveBackupFile` in, then update the backup caller
(~L3348) to call the wrapped `saveBackup`. Two `useToastEvents` calls are used (one after
`usePortfolio`, one after `usePushBackend`) because the push actions are not in scope at the portfolio
edge. Reactive **reads** (`positions, watchlist, …, previewLoadError`) still destructure straight off
`_p`. `setAlerts`/`setSectorCache` (today raw) now go through the helper too — their `undefined`/array
return maps to `null` in `describeOutcome`, so no spurious toast, and their identity is stabilized. The
two ambient-toast `useEffect`s (`previewLoadError`, `failStreak === 2`) are unchanged.

### Piece 2 mechanism — stabilize the memo-leaf handlers

The four handlers reaching `HoldingRow` are defined in `App` and duplicated inline across two viewProps
blocks (the dashboard/holdings view ~L3412–3423 and `TFSAView` ~L3455–3459). Make them stable:

```js
// openDetail (app.js:3371): wrap in useCallback. Its deps loadHistory/loadNews/loadFundamentals are
// already useCallback'd (L3295/3299/3367) and setSelected/indicatorFor are stable, so it is stable.
const openDetail = useCallback((ticker, market, opts) => { /* body unchanged */ },
  [loadHistory, loadNews, loadFundamentals]);

// Hoist the three duplicated modal-openers to single stable consts (they close over stable setters
// only). Define them once (near openDetail) and reference in BOTH viewProps blocks.
const onEditPosition = useCallback(pos => { setPosModalEditId(pos.id); setPosModalOpen(true); }, []);
const onBuyPosition  = useCallback(pos => setBuyModalPos(pos), []);
const onSellPosition = useCallback(pos => setSellModalPos(pos), []);
```

Then both viewProps blocks pass `onOpenDetail: openDetail, onEditPosition, onBuyPosition, onSellPosition`
(referencing the hoisted stable consts instead of re-declaring inline arrows). `onAddPosition` /
`onImportPositions` are **left inline** — they differ per view (US vs TFSA default, close over
`marketFilter`) and are view-level buttons, not `HoldingRow` props, so they don't affect the memo.

With all four handlers stable and `position`/`quote`/`rates` already ref-stable when unchanged (see
Problem), `HoldingRow`'s memo skips re-render for rows whose data didn't change. Sound-by-construction.

## Memo breadth — deliberately minimal

Piece 2 makes `HoldingRow`'s memo bite; `PriceBlock`/`SessionBadge` already work. Audit for any other
**existing standalone** leaf whose props are now fully stable and add `React.memo` there. Do **not**
extract inline-mapped rows (watchlist cards, alert rows) into new components to force memoization — that
is Phase 4's component-split work. If none qualifies cleanly, add no new memo.

## Out of scope (Phase 4 / later)

- Extracting inline-mapped rows into new memo'd components.
- Store self-subscription rework (moving prop-drilled data onto direct store reads).
- Any `usePortfolio` / `usePushBackend` / `usePriceFeed` body change; any money-math change.
- `pb-core.js` / `pb-data.js` / `pb-store.js` changes.
- View-level handlers that don't reach a memo'd leaf (`onAddPosition`, `onImportPositions`, etc.).

## Constraints

- Changes land in **`app.js`** (edge wiring + handler stabilization + any memo additions) and **`sw.js`**
  (cache bump `playbook-shell-v43` → `playbook-shell-v44`, exactly once).
- **No new runtime files** → no `index.html` / deploy-allowlist / precache change. **No** worker /
  `wrangler` impact.
- **Money gate trivially green**: no mutator body, formula, or data-flow touched. `money-math`,
  `cost-basis`, `import-matching`, `ee-ocr-parse` must pass unchanged.
- `app.js` ships **CRLF**; the Edit tool normalizes CRLF on match so `\n`-based edits work. Test
  source-slice markers must avoid multi-line `\n` spans.
- Test runner: no npm script — run each suite with `node backend/test/<name>.test.mjs`.
- **Commits and merges are Jan's.** Build + verify in the working tree only; never `git commit`/`merge`.

## Verification

Runtime-render proof is **sound-by-construction** (stable props + `React.memo` ⇒ React skips the
render), so no render-count instrumentation is added.

1. **Anti-drift source guards** (node, appended to `backend/test/toast-copy.test.mjs`):
   - *Piece 1:* `useToastEvents(impls, toast)` exists, builds its wrappers via `useMemo(…, [])`, and
     keeps `impls`/`toast` current via `implsRef`/`toastRef`; the standalone `const withToast =
     useCallback(` helper is gone and **no** `= withToast(` wrappers remain; `App` wires actions through
     `useToastEvents(` and still calls `usePortfolio(fxRates)` at the **call site** (`const _p =
     usePortfolio(fxRates)`), not merely the declaration.
   - *Piece 2:* `openDetail` is a `useCallback`; `onEditPosition`/`onBuyPosition`/`onSellPosition` are
     hoisted `useCallback` consts; the viewProps blocks no longer declare those three as inline
     `pos =>` arrows.
   - *Untouched hooks:* `usePortfolio`, `usePriceFeed`, `usePushBackend`, `saveBackupFile` signatures
     still take no `toast` param and call no `toast(` (as increment 4 established) — this increment did
     not reach into the hooks.
2. **Behaviour smokes** (existing, must stay green — re-run once on the known flaky CDP
   "Execution context destroyed" race): `verify-refresh-behavior` (app mounts, "Today" P/L pill,
   toasts still fire, no ReferenceError), `verify-holdings-redesign` (US/JSE/TFSA holdings render with
   correct avg-cost — exercises `HoldingRow` + the buy/sell/edit/detail handlers), `verify-settings`
   (only the pre-existing "Alerts: menu overflows" fail).
3. **The 2 test nits** in `backend/test/toast-copy.test.mjs`, tightened while here:
   - the over-broad `addPosition` C4 source slice (narrow it to the specific C4 read line);
   - the tautological `usePortfolio(fxRates)` positive assertion (line 105 currently matches the
     function *declaration*; make it assert the call site, e.g. `const _p = usePortfolio(fxRates)`).
4. `node --check app.js && node --check sw.js`; full node suite green.

## Success criteria

- Every action identity handed to children is stable across `App` re-renders (Piece 1, proven by guards).
- All four `HoldingRow` handlers are stable, so `HoldingRow` no longer re-renders on an unrelated `App`
  render (Piece 2, sound-by-construction from the guards + store ref-stability).
- All node suites green (incl. the money gate, unchanged); behaviour smokes baseline-equivalent.
- `app.js` + `sw.js` only; no new files; no worker impact.
- After merge, **Phase 3 is complete.**
