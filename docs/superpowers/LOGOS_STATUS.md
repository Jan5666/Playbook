# Instrument logos — status and where to improve next

> **Rev 4, 2026-07-28 — the universe, not the pipeline.** Rev 3 fixed how marks are
> found. It did not fix *what gets looked up*, and two follow-up reports (Bittensor, then
> Scottish Mortgage) had the same root cause: **`data.js` is a suggestions catalogue, not
> an inventory of what can be held.** Anything the owner types in that no suggestion row
> happens to mention was never in the universe, so it could not have a logo no matter how
> good the pipeline was. Chasing them one ticker at a time would have gone on forever.
>
> The universe is now driven by the **exchange listings themselves** (`cover` in
> `tv-harvest.mjs`): the entire JSE board, every SA ETF mirrored into TFSA, and every UK
> share, depositary receipt and investment trust. See *Coverage policy* below.
>
> The universe went **2173 -> 5510** instruments and coverage **1597 -> 5364 (97.4%)**,
> still with only the two deliberate `PCWGE` denials as regressions. On disk that is
> 4309 tiles / **12 MB** (de-duplicated from 5426 manifest rows).
>
> | Market | rev 2 | rev 3 | **rev 4** | of |
> |---|---|---|---|---|
> | JSE | 131 | 269 | **501** | 521 |
> | TFSA (SA ETFs) | 29 | 81 | **231** | 232 |
> | LSE (UK) | 73 | 118 | **3006** | 3079 |
> | CRYPTO | 26 | 81 | **81** | 81 |
> | US | 1215 | 1366 | **1366** | 1416 |


**Rev 3, 2026-07-28.** Rev 2 shipped ~300 brand-colour chips and 543 instruments with no
mark at all, on the conclusion that the missing marks needed "better source art" from a
keyed provider. That conclusion was half right and the diagnosis was wrong; see below.
Coverage went **73.5% -> 96.4%** (1597 -> 2094 of 2173 instruments), with **zero
regressions** — the only two keys that lost art are two that were deliberately denied.

- Spec: [`specs/2026-07-27-instrument-logos-design.md`](specs/2026-07-27-instrument-logos-design.md)
- Plan: [`plans/2026-07-27-instrument-logos.md`](plans/2026-07-27-instrument-logos.md) (rev 1; the tile rules here supersede its §normalise)

## What rev 2 got wrong

Rev 2 said the gap was wordmark-only brands that no gate could ever pass. Measuring the
actual reject reasons said otherwise: the dominant failure was **`too small (16x16)`**,
not `wordmark`. Anglo American, Sanlam, Implats, Satrix, Nedbank, Vodacom, Woolworths and
Glencore all have perfectly good square marks — **their own websites just never publish
one bigger than 32x32**, so every icon service (which can only relay what the site has)
returned art below the 48px floor. It was a source problem, and the floor was right.

| Market | rev 2 | rev 3 | of |
|---|---|---|---|
| JSE | 131 | **269** | 289 |
| TFSA (SA ETFs) | 29 | **81** | 82 |
| LSE | 73 | **118** | 124 |
| CRYPTO | 26 | **81** | 81 |
| US | 1215 | **1366** | 1416 |
| ASX / AMS / PAR / FRA | 123 | **179** | 181 |

## The source that closed it

`s3-symbol-logo.tradingview.com/<slug>--big.svg` — **vectors**, so the 48px floor stops
binding; curated square symbol marks; and an unknown slug returns HTTP 403 rather than a
generated placeholder, which is the same property that made Google's favicon service
acceptable and `icon.horse` not (rev 2, rule 2).

The slug is not a ticker, so this does not reopen the bare-ticker hazard. Slugs are
harvested **one exchange at a time** from TradingView's public screener into
`tools/logo-tv-ids.mjs`, so `JSE:SOL` can only ever carry Sasol's slug, never ReneSola's.
Each row carries the venue's own description as a comment, which is what makes 1957 rows
reviewable by a human.

```bash
node tools/tv-harvest.mjs      # refresh the slug map (committed; the builder never scans)
node tools/build-logos.mjs     # rebuild the pack; bumps LOGO_CACHE itself
node tools/logo-review.mjs out.png JSE:* CRYPTO:TAO   # screenshot a slice to actually look at
```

## Wrong-company marks the harvest introduced, and the detector that found them

Upstream is authoritative about tickers and **sometimes wrong about logos**. None of these
would have been caught by eye on a 2000-tile sheet:

| Key(s) | Upstream slug | Actually |
|---|---|---|
| `JSE:INCOME` `JSE:WNXT40` `*:PCWGE` | `10x-genomics` | **10x Genomics, a US biotech** — not 10X Investments |
| `JSE:VAL` | `anglo-american` | Valterra demerged from Anglo in 2025 |
| Coronation, Reitway, Vunani funds | `vge-actively-managed-etf` | one slug, three unrelated houses |
| `JSE:NEWUSD` | `absa-bank-ltd-pref` | NewFunds, not Absa |
| `*:EASYGE` | `paribas` | sold as an EasyETFs fund |
| `*:FNBEMG` | `firstrand-ltd` | FNB has its own mark |
| `US:XLE` `US:XLF` `US:XBI` | `sector/energy` … | **generic category pictograms** |

All have one mechanical signature — *one slug, two different companies* — which is now a
test (`logo-slug-conflicts.test.mjs`). It is the only automated check in the pack that can
catch a wrong-company mark. The `sector/*` case is handled as a rule (`isGenericSlug`)
rather than three pins, because nine sibling funds were only correct by the accident of
already being pinned in `CANONICAL_ART`.

## The tile-rule bug this exposed

`planTile` decided "the art is already a finished tile" from `modalShare` — the share of
the single most common colour. **A gradient has no modal colour**, so TradingView's
dark-gradient tiles fell through to the symbol branch, where an opaque full-canvas image
measured as one giant mark and was flattened into a **solid white square**. Anglo American
and Naspers shipped exactly that.

`borderRing()` is the honest test and now runs when `modalShare` fails: if the outermost
pixels are opaque and vary only gently, the ground covers the canvas whatever it does in
the middle. Flat plates still take the `modalShare` path first, and a symbol on
transparency still fails (its edge is not opaque) — that discriminator is pinned by test.

## Other rules added

- **Same company, same mark.** A key with no art of its own inherits the art of a key
  sharing its `domainFor()` domain. That is the definition of "same company" used
  everywhere else here, so it cannot merge two brands: `CPIP` takes Capitec's mark,
  `ABSP`/`BGA` take Absa's, and Satrix funds upstream had no slug for take the Satrix
  mark their siblings carry. It only ever fills a gap, and `domainFor` is null for US, so
  the US pack cannot be touched by it. Filled 26 keys.
- **`SUPPLEMENTAL`** (`tools/logo-universe.mjs`) — `data.js` is a suggestions catalogue,
  not an inventory. **Bittensor was held and rendered as a hashed-letter monogram purely
  because no suggestion row mentioned it.** Entries here get a mark without becoming an
  in-app suggestion.
- **`JSE:KIO` is no longer denied.** The owner's ruling was "Kumba's own mark or nothing",
  and it held only because every source returned the parent Anglo triangle. TradingView
  carries a Kumba-specific mark, so the ruling's *condition* is met. A test now pins the
  thing that actually matters — that KIO's art is not byte-identical to Anglo's.
- **`*:PCWGE` is now denied.** PortfolioMetrix's only art is a near-black tile whose few
  faint dots vanish at 34px; it clears the blank-tile floor on measurement but not by eye.

## Coverage policy (rev 4)

`VENUES[].cover` in `tools/tv-harvest.mjs` decides which listed instruments get a slug
even when no `data.js` section names them. `collectUniverse()` then treats every harvested
key as part of the universe, so the listing drives the build.

| Venue | Covered | Why |
|---|---|---|
| JSE | **the whole board** (shares, SA ETFs, prefs) | 463 rows — covering it completely is cheaper than fielding one gap at a time |
| TFSA | every JSE `fund/etf`, **plus every JSE key `issuerFor()` calls a fund** | a SA tax-free account holds collective schemes, not single shares |
| LSE | shares + depositary receipts + **investment trusts** (`fund/closedend`) | the trusts are the point — SMT, FCIT, RIT are what UK portfolios hold |
| US | unchanged (`data.js` `_US_SECTORS`, 1412 rows) | already broad |
| ASX/FRA/PAR/AMS | unchanged | no gap reported; one line each to widen if one is |

**The LSE's 4836 `fund/etf` rows are deliberately excluded.** They are mostly
foreign-domiciled UCITS lines carrying just **72 distinct issuer marks** between them, so
they would add thousands of rows to a manifest the app parses at every cold start in
exchange for ~72 tiles. Add `'fund/etf'` to that venue's `cover` if it ever matters.

The TFSA mirror needs **both** halves. Mirroring only what the exchange still types as
`fund/etf` missed 18 ranges it has since retyped or delisted (`NFSWIX`, `STX100`,
`SYGGLD`, the CoreShares `CS*` line), which showed up as TFSA ETFs with no logo.
`issuerFor()` is the app's own definition of "this is an SA managed fund", so
`collectUniverse()` uses it to keep the two markets from drifting apart again.

Two changes keep the bigger universe from being expensive:

- **Identical tiles are stored once.** Whole issuer families compose to the same bytes
  (101 iShares funds, 52 Satrix funds); the pack had 458 redundant copies. The first key
  in sorted order owns the filename and the rest point at it, so the owning key is a
  property of the pack rather than of collection order.
- **The manifest is compact.** A row whose art is at the default path `MARKET-TICKER.png`
  is written as a bare `1` and expanded by `logoFor()`. The manifest is ~80% of
  `pb-content.js`, and spelling `"US-AAPL.png"` next to the key `"US:AAPL"` was pure
  repetition.

Two consequences of sharing tiles, both handled:

- **The deploy sentinel is fragile.** `static.yml`'s Guard 1 names one real file inside
  `logos/`, and a rebuild can legitimately de-duplicate that exact filename away, failing
  the deploy on a build where nothing is wrong. `deploy-assets.test.mjs` now asserts every
  `logos/*.png` filename mentioned in the workflow still exists.
- **A shared tile's filename can look wrong in a diff.** `JSE:FSR` resolves to
  `JSE-ADETNC.png` because the alphabetically-first key owns the file and the `*ETN*`
  tickers are FNB ETNs — FirstRand-issued notes that legitimately carry FirstRand's mark.
  The art is right; only the name is arbitrary. Read shared filenames as "whichever key
  sorted first", never as a claim about which company the mark belongs to.

Anything reading the pack must go through `logoFor()`, not a private parser. The review
tool had its own manifest regex and reported "NONE" for thousands of marks the instant
the compact form landed — it now requires `pb-content.js` like the tests do.

## The rules that must not be broken

1. **Bare tickers are banned outside the US market.** Only `market === 'US'` emits
   `key: 'ticker'`. Slugs are exchange-scoped, which is why they are allowed elsewhere.
2. **Not every icon service is safe.** A source must 404/403 on an unknown key rather than
   invent a placeholder.
3. **One issuer, one mark** — `CANONICAL_ART`, `ISSUER_BY_PREFIX` (scoped to JSE/TFSA:
   GLD is NewGold in Johannesburg and SPDR Gold in New York), and the domain-sibling pass.
4. **Human review is the acceptance gate.** No automated check catches a wrong-company
   logo in general; the conflict test catches only the one signature above.
5. **No durable state.** The pack is files + code; nothing enters `pb.*`.
6. **`logo-tv-ids.mjs` is generated — never hand-edit it.** Hand pins go in
   `TV_SLUG_EXTRA` / `TV_SLUG_DENY`, which survive a re-harvest.
7. **`effectiveSlugFor()` is the single answer to "which slug does this key use".**
   `chainFor` and `logo-slug-conflicts.test.mjs` both read it, so the test cannot
   disagree with what shipped. Anything that suppresses a slug belongs inside it.

### Wrong-company suppression is a rule, not a list

`SLUG_NEVER_FOR_SA_FUND` names the *slugs* that must never reach a South African fund —
the parent bank's mark (`firstrand-ltd` for FNB's and NewFunds' ranges,
`absa-bank-ltd-pref`), an unrelated firm's (`10x-genomics`), or a shared placeholder
(`vge-actively-managed-etf`, `paribas`). It is scoped to JSE/TFSA keys that `issuerFor()`
recognises as funds, so **the parent itself is untouched**: `JSE:FSR` *is* FirstRand and
keeps `firstrand-ltd`, while `JSE:FNB500` and `JSE:NFETNQ` do not.

This replaced a hand-maintained key list, which had to be re-extended every time the
harvest reached another fund in the same range — FNB's ETFs arrived in three separate
waves — and the failure mode of forgetting is a wrong company's logo on screen.

## Where to improve next

### 0. Where rev 4 left off (146 instruments without a mark, of 5510)
- **47 LSE / 26 LSE chips** — the long tail of AIM shells and suspended lines the
  listing sweep now includes. Nothing is wrong with them; no source carries art.
- **18 JSE** — delisted or acquired codes (MultiChoice, PSG, Royal Bafokeng, Adcock).
- **18 US**, unchanged from rev 3 (see below).
- **`JSE:TWR` / `JSE:KGD`** stay monograms: slugs exist, but neither the screener nor the
  art identifies the company, and a monogram beats a mark nobody can vouch for.

### 1. The 18 US instruments still without a mark
- **18 US**, dominated by companies whose logo genuinely *is* a wordmark (Philip Morris,
  United, Church & Dwight, Morningstar, Phillips 66, the abrdn physical-metal ETFs). The
  gate is doing its job; a monogram is more legible at 34px than "abrdn" is.
  - **`US:SBUX` is a false reject worth revisiting**: the Starbucks siren scores **4.6**
    stroke-runs against a `MAX_RUNS` of 4.5 — the detail in her hair and crown reads as
    type. Raising the threshold to 5.0 would also admit Morningstar (4.6) and Phillips 66
    (4.8), which are real wordmarks, so this needs a better discriminator (ink squareness?)
    rather than a looser number. Not attempted; the threshold is calibrated and rule-3 code.

### 2. Weak-but-passing marks
`JSE:CLS` (Clicks) and `JSE:TRU` (Truworths) pass the lockup gate at ~4.7 runs but are
still a line of type at 34px; `JSE:VAL` is legible but washed out. These are the band the
`MAX_RUNS` discriminator does not separate well — same open problem as SBUX, from the
other side.

### 3. Scope not attempted
The stock detail modal, dashboard and suggestion chips remain out of scope — logos appear
only in Holdings rows and Watchlist cards.
