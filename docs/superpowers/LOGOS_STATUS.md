# Instrument logos — status and where to improve next

**Rev 2, 2026-07-27.** Rev 1 was rejected on four counts; every one is fixed, and each
fix is a *rule* rather than a per-mark patch, so a rebuild cannot quietly undo it.

- Spec: [`specs/2026-07-27-instrument-logos-design.md`](specs/2026-07-27-instrument-logos-design.md)
- Plan: [`plans/2026-07-27-instrument-logos.md`](plans/2026-07-27-instrument-logos.md) (describes rev 1; the tile rules below supersede its §normalise)

## The four rejections and what actually caused them

| Rejected | Root cause (measured, not guessed) | Fix |
|---|---|---|
| "white box borders … like ASML and Amazon" | `normalise()` square-padded an **8% transparent margin** around art that was already a finished opaque tile, and the stylesheet painted `#fff` behind it. `US-ASML.png` was 297×297 at 0.743 coverage — exactly 256²/297². | `composeTile()` always fills the canvas. No CSS background exists any more. |
| "still way too much companies … no logos" | `collectUniverse()` regex-matched only `ticker:'X'`, seeing **155** symbols. `data.js` actually carries **1412** US tickers in `_US_SECTORS` and **558** more in `_INTL_SECTORS`. Broadcom, CAT, Meta and Micron were never *looked up*; Parqet had all four. | `data.js` is evaluated, not scraped. Universe **2140** keys. |
| "capitec … squished low quality" | Its only art is a two-line type lockup. Aspect ratio does **not** separate it from good marks (UNH's ink is 2.2:1 too, just a tall glyph). | `strokeRuns()` — mean ink runs per scanline. Good marks measure 1.3–3.5; Capitec measures **7.2**. Gate at 4.5. |
| "some square and some rounded" | Round/inset art left the corners empty, so the CSS radius had nothing to clip. | Every tile is square and full-bleed; a coin disc's own colour is extended into the corners. One class, one radius. |

## What exists

| Piece | File |
|---|---|
| PNG decode (depths 1/2/4/8, colour types 0/2/3/4/6) | `tools/png-decode.mjs` |
| Measurement → tile decision | `tools/png-analyse.mjs` |
| Crop / square-pad / PNG chunking | `tools/png-crop.mjs` |
| **Tile rules + colour maths + RGB encoder** | `tools/png-raster.mjs` |
| **Any-format decode via headless Chrome** | `tools/chrome-decode.mjs` |
| Per-market resolution, `DOMAIN_BY_KEY`, `DENY`, `CANONICAL_ART` | `tools/logo-sources.mjs` |
| Orchestrator + contact sheet | `tools/build-logos.mjs` |
| Generated manifest + `logoFor()` | `pb-content.js` (between `// <<< LOGO_MANIFEST_START/END`) |
| `LogoMark` + both call sites | `pb-views.js` |
| Tile / brand-chip / monogram styles | `styles.css` (`.pb-logo*`) |
| Cache-first serving | `sw.js` (`LOGO_CACHE`) |
| Deploy | `.github/workflows/static.yml` (`cp -r logos`, Guard-1 sentinel `logos/CRYPTO-AAVE.png`) |

Rebuild with `node tools/build-logos.mjs`. It rewrites the manifest in place, **bumps
`LOGO_CACHE` in sw.js itself** (filenames are stable and serving is cache-first, so
skipping that leaves installed PWAs on the old art forever), and emits
`logos/contact-sheet.html` (git-ignored) for review. Source bytes are cached under
`.logo-cache/` (git-ignored) so the tile rules can be iterated without refetching.

Useful flags: `--dry-run`, `--only US:AAPL,JSE:CPI`, `--limit N`, `--no-cache`.

## The tile rules (tools/png-raster.mjs)

`planTile()` sorts every piece of art into one of three:

1. **plate** — a solid ground covers ≥40% of the canvas. The art *is* a tile; pass it
   through, extending the ground into the corners. A near-**white** ground counts:
   UnitedHealth (white) and NVIDIA (green) are the two marks the owner named as the
   target look, so repainting UNH would replace art he asked for.
2. **symbol, light** — keeps its own colours on a deep ground built from its dominant
   chroma (saturation-weighted, so a large grey field cannot elect the hue).
3. **symbol, dark** — redrawn in white on its own brand ground if it is effectively one
   colour; otherwise it gets a light tint instead, because flattening a multi-colour
   mark to a silhouette destroys it (Google's G becomes a plain ring).

Greys deliberately fall back to a neutral slate: a grey has an undefined hue, which
reads as 0 — i.e. shipping a *red* tile for a black wordmark.

## The rules that must not be broken

1. **Bare tickers are banned outside the US market.** Bare-ticker logo APIs are
   US-centric and return the *US* company with that symbol at HTTP 200: `MTN`→Vail
   Resorts, `SOL`→ReneSola. Outside the US the key is the company's **domain** —
   human-checkable in the source file, and a domain-keyed service can only answer with
   that company's own art. `chainFor` is a safelist; only `market === 'US'` emits
   `key: 'ticker'`.
2. **Not every icon service is safe.** `icon.horse` answers with a *generated letter
   tile* at HTTP 200 — Shoprite, Sasol and Standard Bank came back byte-identical.
   Google's `s2/favicons` 404s on an unknown host instead, which is why it is the one
   used. FMP is removed and its hostname is banned by `logo-collisions.test.mjs`.
3. **One issuer, one mark.** `CANONICAL_ART` pins families to one file; the SA fund
   prefixes in `ISSUER_BY_PREFIX` are scoped to JSE/TFSA (GLD is NewGold in
   Johannesburg and SPDR Gold in New York).
4. **Human review is the acceptance gate.** No automated check catches a wrong-company
   logo. Regenerate the contact sheet and look before committing.
5. **No durable state.** The pack is files + code; nothing enters `pb.*`, so rule #5
   and the cloud-backup blob are untouched.

## Where to improve next

### 1. The ~300 brand-colour chips
Instruments with no legible mark now ship `{ c: "#rrggbb" }` — the real brand colour,
measured off the wordmark the gate had to reject — and render as a coloured monogram
instead of a hashed-hue one. Better than a gap, still not a logo. The population is
almost entirely:
- **SA ETF issuers** (Satrix, Sygnia, 1nvest, FNB, 10X, Coronation, EasyETFs, Reitway).
  Every one publishes a 16×16 favicon and a wide wordmark, nothing else.
- **Wordmark-first SA brands**: Nedbank, Woolworths, Sanlam, Clicks, Vodacom, Gold
  Fields, Impala, Anglo American, Capitec.
The only real fix is better source art — a keyed provider (`logo.dev`, Brandfetch)
would likely resolve most of them. Both need a free publishable key, which is safe to
ship in client code but was never supplied.

### 2. `JSE:KIO` stays denied
Kumba is an Anglo American subsidiary and *every* source — including
`angloamericankumba.com`'s own icon — returns the parent's blue/red triangle. Verified
by eye again in rev 2. The owner ruled Kumba's own mark or nothing; **that ruling is
the only thing keeping it denied, and it predates the "logos for everything"
instruction.** If he'd rather have the Anglo mark, deleting the `DENY` entry is the
whole change.

### 3. Smaller residue
- 28 non-US tickers have no domain (delisted or ambiguous codes: `AVST`, `POLY`,
  `MGGT`, `TGM`, `RPL`…). Mechanical to extend `DOMAIN_BY_KEY`.
- The duplicate-art report labels US ETF families "MIXED" because `domainFor` returns
  null for US keys, so every key looks like its own issuer. Cosmetic; the groups
  themselves (iShares 101, Vanguard 49, SPDR 30) are correct.
- `png-decode`'s Paeth tie-break order is still untested (the main selection is pinned).

### 4. Scope not attempted
The stock detail modal, dashboard and suggestion chips remain out of scope — logos
appear only in Holdings rows and Watchlist cards.
