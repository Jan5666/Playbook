# Phase 4 increment 2 — RulesView prose → `PBContent.RULES` — Design

**Date:** 2026-07-06
**Branch (to be created off `origin/main` f5cec94):** `refactor/phase-4-increment-2-rules`
**Predecessor:** Phase 4 increment 1 (content → `pb-content.js`), merged to `main` as `f5cec94`.

## Goal

Move the three hardcoded prose sections in `RulesView` out of `app.js` into structured
data on `PBContent.RULES`, and re-render them from that data. **Zero behavior change** —
the produced DOM is byte-identical to today's.

## Motivation

`RulesView` (`app.js:9477`) currently builds three static prose sections as literal
`React.createElement(...)` trees — the exact kind of static playbook content Phase 4
pulls out of `app.js`. Increment 1 established the pattern and the home: the dual-mode,
node-testable `pb-content.js` (`window.PBContent` + CommonJS). This increment continues
it for the Rules prose.

## Current state (what `RulesView` renders, in order)

1. **Trim rules** — `card mb-4`; 5 bullets, each a bold lead-in + em-dash text
   (`<strong>+100% gain</strong> — trim 25%…`).
2. **Thesis-break triggers** — `card mb-4`; 5 plain-text bullets.
3. **Key risks** — `grid grid-2 mb-4`; maps `DATA.RISKS` (from `data.js`). **Not in scope.**
4. **SA tax-year discipline** — `card` (no `mb-4`, it is the last card); 4 plain-text bullets.

The three prose sections (1, 2, 4) are **not contiguous** — the data-driven "Key risks"
grid sits between them, and the final card deliberately drops the `mb-4` bottom margin.
Both facts must be preserved.

## Decision: content home

`PBContent.RULES` (in `pb-content.js`), **not** `data.js`. Chosen for consistency with
increment 1 and because `pb-content.js` is dual-mode and node-testable (anti-drift guards),
whereas `data.js` is browser-only (`window.PB_DATA`). Accepted trade-off: `RulesView` will
read its RISKS from `data.js` and its RULES from `pb-content.js` — content split across two
files. `DATA.RISKS`/`PILLARS` are **not** moved (that would expand scope to `OverviewView`
and other `data.js` consumers).

## Design

### 1. Data shape — `PBContent.RULES`

An array of sections, each `{ id, heading, bullets }`; a bullet is `{ text }` or
`{ strong, text }`. The code block below shows literal em-dashes for readability, but the
implementation authors every em-dash as its JavaScript unicode escape (backslash-u-2014) so `pb-content.js` stays pure ASCII — zero
unicode-corruption risk when writing the strings.

```js
const RULES = [
  { id: 'trim', heading: 'Trim rules', bullets: [
    { strong: '+100% gain',            text: ' — trim 25% of position, bank profits' },
    { strong: '+150% gain',            text: ' — trim another 20% of remainder' },
    { strong: '+200% gain',            text: ' — trim another 20%, let the rest ride' },
    { strong: '-20% from cost',        text: ' — re-examine thesis, never average down without fresh conviction' },
    { strong: 'Position >12% of book', text: ' — trim to 10% regardless of gain' },
  ]},
  { id: 'thesisBreak', heading: 'Thesis-break triggers', bullets: [
    { text: 'Hyperscaler capex cut by top-3 player (MSFT, GOOGL, META, AMZN, ORCL)' },
    { text: 'Core CPI above 3.2% for two consecutive prints' },
    { text: 'Brent above $120 — consumer weakness trigger' },
    { text: 'VOO drawdown >15% from buy-zone — deploy all cash' },
    { text: 'Any position where CEO reneges on publicly-stated commitment (the MSTR lesson)' },
  ]},
  { id: 'saTax', heading: 'SA tax-year discipline', bullets: [
    { text: 'Tax year ends 28 February. Split disposals across 28 Feb + 1 March for two annual R40k CGT exclusions.' },
    { text: 'Combined shelter: up to R80k of gains untaxed per year.' },
    { text: 'At 40% marginal rate with 40% inclusion, each exclusion = ~R12,800 saved.' },
    { text: 'Keep broker IT3(c) certificates for each tax year.' },
  ]},
];
```

`RULES` is added to `pb-content.js`'s returned API object (5th key alongside
`RIBBON_CATALOG`, `RIBBON_CATALOG_MAP`, `INDICATOR_INFO`, `BUILTIN_MACRO_2026`).

### 2. `RulesView` render

`app.js` binds `const RULES = PBContent.RULES;` at the same site idiom as the other content
binds. A small helper turns a section into its eyebrow + card; `RulesView` composes the view
in the exact current order, looking sections up **by `id`** (not array index) and interleaving
the untouched RISKS grid:

```js
function ruleSection(section, cardClass) {
  return [
    React.createElement("div", { key: section.id + '-eyebrow', className: "eyebrow" }, section.heading),
    React.createElement("div", { key: section.id + '-card', className: cardClass },
      React.createElement("ul", { className: "bullet-list" },
        section.bullets.map((b, i) => React.createElement("li", { key: i },
          React.createElement("span", null,
            b.strong ? React.createElement("strong", null, b.strong) : null,
            b.text)))))
  ];
}

function RulesView() {
  const byId = id => RULES.find(s => s.id === id);
  return React.createElement("div", null,
    ...ruleSection(byId('trim'), "card mb-4"),
    ...ruleSection(byId('thesisBreak'), "card mb-4"),
    React.createElement("div", { className: "eyebrow" }, "Key risks"),
    React.createElement("div", { className: "grid grid-2 mb-4" },
      DATA.RISKS.map(/* …unchanged… */)),
    ...ruleSection(byId('saTax'), "card")
  );
}
```

- `cardClass` (`"card mb-4"` vs `"card"`) stays a **view concern** — the data carries no styling.
- A `{ strong }` bullet renders `<strong>{strong}</strong>{text}`; a plain bullet renders just
  `{text}` (`b.strong ? … : null` → React drops the `null`). Byte-identical DOM to today.
- The "Key risks" eyebrow + `DATA.RISKS.map(...)` block is copied through unchanged.

### 3. Tests — extend `backend/test/content.test.mjs` (no new file)

- **Shape:** `PBContent.RULES` is a non-empty array; every section has a unique string `id`,
  a non-empty string `heading`, and a non-empty `bullets` array; every bullet has a string
  `text`; `strong`, when present, is a string.
- **Fidelity:** the three ids `{ trim, thesisBreak, saTax }` are present, with bullet counts
  `5 / 5 / 4` respectively.
- **Anti-drift source guards:** `app.js` no longer contains the moved prose — e.g.
  `!appSrc.includes('bank profits')`, `!appSrc.includes('R80k of gains untaxed')`,
  `!appSrc.includes('Thesis-break triggers')` — and it delegates:
  `appSrc.includes('const RULES = PBContent.RULES')`.

### 4. Wiring

`pb-content.js` already exists and is fully wired from increment 1 (index.html script tag,
`static.yml` allowlist + Guard-1 loop, and every app-mounting `verify-*.mjs` harness shell).
The **only** wiring change:

- **`sw.js` cache bump v45 → v46** — the *contents* of two precached assets (`pb-content.js`
  and `app.js`) change, so clients must fetch the new versions.

No change to `index.html`, `static.yml`, harness shells, `pb-core.js`, `pb-data.js`,
`pb-store.js`, or `backend/worker.js`.

## Verification

- `node --check` clean on `pb-content.js` and `app.js`.
- Full node sweep — 19 suites green, including the expanded `content.test.mjs`.
- Money gate unchanged (no formula touched) — spot-check `money-math` / `cost-basis` /
  `import-matching` / `ee-ocr-parse`.
- `node backend/test/verify-refresh-behavior.mjs` → app mounts (no `PBContent`/`RULES`
  `ReferenceError`).
- **Manual spot check** of the Rules tab: four sections render in order (Trim rules,
  Thesis-break triggers, Key risks, SA tax-year discipline) with bullet counts 5 / 5 / (risks) / 4,
  bold lead-ins on the Trim rules bullets, and the last card without a bottom margin.
  *(No existing browser harness drives the Rules tab; adding one is out of scope — the node
  shape/fidelity + anti-drift tests plus the app-mount smoke are the automated gate.)*

## Scope

**In scope:** the three prose sections of `RulesView` → `PBContent.RULES`; the `RulesView`
render refactor; `content.test.mjs` additions; `sw.js` cache bump.

**Out of scope:** the "Key risks" grid and `DATA.RISKS`/`PILLARS`/everything else in `data.js`;
any other view; `pb-core`/`pb-data`/`pb-store`/worker; import-matching tables, sector maps,
`MARKETS`/`DISPLAY_CURRENCIES` (later Phase-4 increments).

## Definition of done

- `PBContent.RULES` exists; the three prose blocks are gone from `app.js` (delegating bind +
  `ruleSection` helper remain); the RISKS section is unchanged.
- 19 node suites green; `node --check` clean on `pb-content.js` and `app.js`.
- `sw.js` at v46; no other wiring changed.
- App mounts under the smoke harness; Rules tab renders identically (manual spot check).
- **Left for Jan:** review + commit + PR/merge (per the standing workflow — the implementer
  builds in the working tree only).

## Constraints (carried from increment 1)

- **No build step.** Classic dual-mode `<script>`; `React.createElement` (no JSX).
- **CRLF:** `app.js` uses CRLF; the Edit tool normalizes CRLF when matching.
- **Commits/PR/merge are Jan's**, not the implementer's. Each task ends at a green
  verification, not a commit.
- **Test runner:** no npm script; `node backend/test/<name>.test.mjs` per suite.
