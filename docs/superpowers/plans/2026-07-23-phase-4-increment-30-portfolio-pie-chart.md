# Phase 4 · Increment 30 — plan (turnkey recipe)

Target: move `PortfolioPieChart` + `SectorHoldingsPopup` + the pure donut-palette cluster from
`app.js` into `pb-views.js`; keep `resolvePositionSector` in app.js and bridge it. See the design
doc for the dependency inventory and the `DATA`-scope rationale.

1. **Inventory** — done (design doc). Only new bridge member: `resolvePositionSector`; only bridge
   removal: `PortfolioPieChart`. Zero new IIFE reads.
2. **Verbatim move** — Node slice script (BOM+LF safe; read utf8, split `\n`, keep BOM, splice by
   index). Anchor on content, not line numbers:
   - donut block: `// … Donut palettes …` header → `const DONUT_OTHER_COLOR = '#2E2E3C';`
   - PPC: `function PortfolioPieChart(` → the `}` before `// Floating breakdown …`
   - SHP: `// Floating breakdown …` → the `}` before `// DashboardView moved to pb-views.js`
   Insert the three slices (in order: donut, PPC, SHP) before the `window.PBViews = …` registration;
   register `PortfolioPieChart` + `SectorHoldingsPopup`.
3. **Lead reads** — inject into PPC and SHP as first body statements (see design doc).
4. **Bridge + callers** — remove `PortfolioPieChart` from `window.PBApp`, add `resolvePositionSector`
   (after `positionDisplayName`). Drop `PortfolioPieChart` from the `DashboardView` (`{ …,
   PortfolioPieChart, fmtNum }`) and `TFSAView` (`{ Icon, PortfolioPieChart }`) `window.PBApp`
   destructures so they read it bucket-local. Fix the stale app.js comment ("PortfolioPieChart +
   fmtNum stay in app.js").
5. **Wiring** — `sw.js` `CACHE_NAME` v80 → v81 (only shipped-file change; bucket already wired). No
   `PBContent`/`PBData`/`PBCore` bind left app.js, so no delegation guard changes.
6. **Docs** — `architecture-map.html` (member list: −PortfolioPieChart, +resolvePositionSector;
   count stays 44; inc-30 narrative clause), `REFACTOR_STATUS.md` Done + Current-state, this
   spec+plan pair.

## Verification (all green before commit)

- `node --check app.js && node --check pb-views.js`.
- Full node suite: `for f in backend/test/*.test.mjs; do node "$f" || break; done` (money gate +
  content guard + deploy-assets). **28/28.**
- Anti-drift greps (function-def counts, bridge membership, U+FFFD, BOM).
- **Mount gate**: `verify-refresh-behavior.mjs` from a scratchpad copy patched per REFACTOR_STATUS
  "Environment notes" (ROOT=/home/user/Playbook, local React via `/__react.js`, `--no-sandbox`,
  `CHROME_PATH=/opt/pw-browsers/chromium`). Do not modify committed harnesses.
- **Render probe**: mount the Dashboard tab, assert the pie chart renders; switch to Sector mode and
  open a wedge → assert `SectorHoldingsPopup` subtree renders; no destructive/money side-effects.

## Landing

Branch `claude/refactor-plan-next-4s8env` (off latest `origin/main`). Commit + push. **No PR, never
`main`** — Jan reviews and lands (rule #1).
