# Instrument logos — status and where to improve next

**Landed 2026-07-27 on branch `claude/instrument-logos` (17 commits off `main` @ a53bb62).**
Jan's verdict: *"the pack is better — but not as I want it; fine for now, use as a base to
improve further."* So this is a **working base, deliberately not final**.

- Spec: [`specs/2026-07-27-instrument-logos-design.md`](specs/2026-07-27-instrument-logos-design.md) (§2.1 carries an "Amended during implementation" note — read it, the original US chain was wrong)
- Plan: [`plans/2026-07-27-instrument-logos.md`](plans/2026-07-27-instrument-logos.md)

## What exists

| Piece | File |
|---|---|
| PNG decode (depths 1/2/4/8, colour types 0/2/3/4/6) | `tools/png-decode.mjs` |
| Measurement → tile decision | `tools/png-analyse.mjs` |
| Crop / square-pad | `tools/png-crop.mjs` |
| Per-market resolution + `DENY` + `CANONICAL_ART` | `tools/logo-sources.mjs` |
| Orchestrator + contact sheet | `tools/build-logos.mjs` |
| Generated manifest + `logoFor()` | `pb-content.js` (between `// <<< LOGO_MANIFEST_START/END`) |
| `LogoMark` + both call sites | `pb-views.js` |
| Tile + monogram styles | `styles.css` (`.pb-logo*`) |
| Cache-first serving | `sw.js` (`LOGO_CACHE`, `CACHE_NAME` v90) |
| Deploy | `.github/workflows/static.yml` (`cp -r logos`, Guard-1 sentinel `logos/CRYPTO-AAVE.png`) |

Rebuild with `node tools/build-logos.mjs`. It rewrites the manifest in place and emits
`logos/contact-sheet.html` (git-ignored) for review.

**155 marks / 144 files** — US 63, JSE 40, TFSA 26, CRYPTO 26.
Tests: `logo-imaging` 47, `logo-collisions` 10, `logo-manifest` 11.

## The rules that must not be broken

1. **Bare tickers are banned outside the US market.** Bare-ticker logo APIs are US-centric and
   return the *US* company with that symbol, at HTTP 200: `MTN`→Vail Resorts, `SOL`→ReneSola.
   A confidently wrong logo is worse than a missing one. `chainFor` is a safelist — only
   `market === 'US'` can emit `key: 'ticker'`; everything else falls through to ISIN/issuer.
2. **FMP is removed and its hostname is banned** by `logo-collisions.test.mjs`. It produced the
   pack Jan rejected (three iShares variants, a cropped "i", blank-white QQQ/ARKK). Parqet at
   `size=256` returns pre-composed brand tiles. Do not reintroduce FMP.
3. **One mark per issuer.** Providers split State Street across five variants including two
   pieces of clipart. `CANONICAL_ART` pins families to one file; `logo-manifest.test.mjs` has
   an issuer-consistency test. Add new families there.
4. **Human review is the acceptance gate.** No automated check can catch a wrong-company logo.
   Regenerate the contact sheet and look at every mark before committing a rebuilt pack.
5. **No durable state.** The pack is files + code; nothing enters `pb.*`, so rule #5 and the
   cloud-backup blob are untouched. Keep it that way.

## Where to improve (ranked, with what's already known)

### 1. Logo quality — the reason this is "not as I want it"
Jan wants each company's **own** mark at the quality other fintech apps ship. Measured on
2026-07-27, no-key sources cap out around here:

| Source | Result |
|---|---|
| Parqet @256 (current) | good pre-composed brand tiles; best free option found |
| FMP | rejected — stale/cropped/blank art |
| Company's own site | ~⅓ usable; most expose only 32×32 favicons |
| Wikipedia REST | useless — returns photos of buildings |
| Clearbit | dead |

**The untried option is `logo.dev`** — the API most fintech apps actually use, with ticker and
domain lookup. It needs a free publishable key (safe to ship in client code). Jan chose
"logo.dev first, site fallback" but the key was never supplied, so the build fell back to
Parqet-only. **Getting that key is the single highest-leverage improvement.**

### 2. Specific instruments still wrong or missing
- `JSE:KIO` is in `DENY` — every source returns the parent Anglo American mark for Kumba.
  Needs Kumba's own mark, or it stays a monogram.
- `JSE:SHP` (Shoprite) and `JSE:BTI` — art too sparse to read at 34 px, rejected by the gate.
  Do not lower the gate; find better art.
- ~50 ordinary JSE small caps have no ISIN in the 15-entry `ISIN_BY_TICKER` map, so their
  chain is empty → monogram. Extending that map is mechanical and safe (each ISIN is verified
  live by the build).
- SA ETF issuers other than Satrix (Sygnia, 1nvest, NewFunds, CoreShares, Ashburton, FNB)
  never produced art — their sites are JS-rendered and the Chrome extraction found nothing
  usable. Satrix works via a curated symbol crop; the others need the same treatment.

### 3. Known defects left in the tooling (none blocking)
- **The duplicate-art report groups by exact byte hash**, so six byte-variants of one wordmark
  read as six distinct marks — precisely the failure it was added to catch. Group by resolution
  source as well.
- **`collectUniverse()` does `SECTION_MARKET[section] || 'US'`** — a new `*_SUGGESTIONS` block
  in `data.js` would be silently routed down the US bare-ticker path. Make unmapped sections a
  hard error. (The `FATAL` guard at the end of `build-logos.mjs` is dead code: `key: 'ticker'`
  already implies `US:`, so it can never fire.)
- **`build-logos.mjs` does not bump `LOGO_CACHE`/`CACHE_NAME`.** Filenames are stable and
  serving is cache-first, so a rebuild leaves installed PWAs on the old art. Documented as a
  manual step in CLAUDE.md's wiring checklist; automating it is better.
- The generated manifest block writes LF into a CRLF file (harmless, reproduced each rebuild).
- `png-decode`'s Paeth **tie-break** order is untested (the main selection is pinned).

### 4. Scope not attempted
The stock detail modal, dashboard, and suggestion chips were explicitly out of scope — logos
appear only in Holdings rows and Watchlist cards.

## Unrelated finding worth acting on

Three test files fail on **`main` itself**: `backup-roundtrip`, `describe-outcome`,
`hot-topics-dates`. Verified in a clean worktree at `a53bb62`; this work never touches
`app.js`. CLAUDE.md claims a green 33-file suite — it is not green.
