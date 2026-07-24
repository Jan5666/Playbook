# Phase 4 · Increment 31 — `SectorWeightRows` → `pb-modals.js` (design)

## Why

Phase 4 peels large view/modal components out of the no-build `app.js` UMD monolith into the
browser-only classic-script buckets (`pb-views.js`, `pb-modals.js`). Modal and view extraction are
already complete (through inc-30). The tail increments (inc-28 `HoldingRow`/`HoldingsListHead`,
inc-30 `PortfolioPieChart`) have been **shared-infra relocations** — moving a component off the
`window.PBApp` bridge and into the bucket that actually consumes it, once its last `app.js` caller
was gone.

`SectorWeightRows` (`app.js:4008–4046`, ~41 lines) is the **one remaining clean bridge-shrink
candidate**. It is a small, pure form sub-component — the ETF/fund sector-split editor (a controlled
list of `{ sector, weight }` rows with an add button and a running total). Its **only two consumers
both live in `pb-modals.js`** — `SectorAllocationModal` (moved inc-11) and `PositionModal` (moved
inc-22) — and it has **no `app.js` caller and no `pb-views.js` caller**. It was on the bridge only
because it predated the move of its two modals. It therefore belongs beside them in the bucket.

## Scope

Move into `pb-modals.js` (verbatim): `SectorWeightRows` (`app.js:4008–4046`).

Stays put: everything else. No money/alert code is involved (the component is pure form UI —
rules #3/#4 unaffected).

## Dependency inventory

| identifier            | classification                                                        |
|-----------------------|-----------------------------------------------------------------------|
| `React`               | UMD global (free)                                                     |
| `rows`, `setRows`     | props                                                                  |
| `parseFloat`/`isFinite`/`Math` | native                                                       |
| `Icon`                | already bridged; read via the per-component `const { … } = window.PBApp;` lead read |
| `DATA` (`DATA.SECTOR_CANON`) | `window.PB_DATA`; in `pb-modals.js` read **at render time** inside each component (data.js loads after the bucket — existing pattern, e.g. pb-modals.js:2484, :3334) |

⇒ Clean verbatim move. Two injected reads in the moved body: `const { Icon } = window.PBApp;` (lead
read) and `const DATA = window.PB_DATA;` (render-time). Both consumers already lead-read
`SectorWeightRows` from `window.PBApp`; those destructures lose the member (it becomes bucket-local).

## Bridge / registration

- `window.PBApp` publish line: **remove** `SectorWeightRows` (bridge **44 → 43**).
- **No** `window.PBModals.SectorWeightRows` registration — nothing outside the bucket consumes it.
- `app.js` retains only a pointer comment where the function was.

## Encoding note

Both files are **BOM + LF**. The body carries a literal `…` ellipsis ("Select sector…") and a
`needn't` apostrophe. Move via a Node slice script (read/write `utf8`, split/join `\n`, keep the
BOM) — never the Edit tool.

## Read-out (measured)

- `node --check app.js` / `node --check pb-modals.js`: **OK**.
- Encoding after move: both files **BOM + LF**, U+FFFD scan **clean** (ellipsis + apostrophe intact).
- Anti-drift: `function SectorWeightRows` = **0** in app.js / **1** in pb-modals.js; **0** in the
  `window.PBApp` publish line; `React.createElement(SectorWeightRows` = **0** app.js / **2** pb-modals.js.
- Full node suite (money gate + content guard + deploy-assets): _to be recorded at verify step_.
- Mount gate `verify-refresh-behavior` + a `SectorAllocationModal` render probe: _to be recorded_.
