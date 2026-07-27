# Instrument logos in Holdings + Watchlist (design)

**Status: designed 2026-07-27, approved by Jan. Not yet implemented.**

Show the company/fund mark beside the name in the Holdings rows and the Watchlist cards.
Jan's decisions, taken against a rendered mockup of the real rows:

| Decision | Choice |
|---|---|
| Delivery | **Self-hosted pack** — logos committed to the repo, no runtime third-party call |
| Treatment | **C — Adaptive tile** (white backing only where the art needs it) |
| Size / scope | **34 px**, Holdings + Watchlist (detail modal explicitly out of scope) |
| Correctness | **Every mark must be the company's official logo.** A wrong logo is a defect, not a cosmetic miss — see §1 Claim A and §5 |
| ETFs | Official fund mark first; **fall back to the managing house's logo** (Satrix ETFs → the Satrix mark) only when the fund has none; monogram last |

This spec follows the house rule the last seven increments established: **measure the claim
before building on it.** Every number below was produced by a script against the live sources
on 2026-07-27, not quoted from documentation. Four premises were checked and **none survived
intact** (§1). Two of them — that ticker-keyed logo APIs are trustworthy, and that the returned
art is consistent enough to drop straight into an `<img>` — were wrong in the direction that
ships visibly broken or **wrong** data. The other two were wrong in the safe direction: a
reliable key for JSE instruments does exist, and self-hosting costs no storage budget at all.
The pattern from the refactor held again.

---

## 1. The premise, and what measurement says about it

### Claim A — "free logo APIs cover the tickers I hold." Partly false, and dangerously so.

First measurement, by bare ticker, looked encouraging:

| Segment | FMP | Parqet |
|---|---|---|
| US stocks | 9/9 | 9/9 |
| US ETFs | 6/6 | 6/6 |
| JSE | 7/10 | 5/10 |
| **SA ETFs** (STX40, STXNDQ, SYGWD, ETF500, SYG500) | **0/5** | **0/5** |
| LSE | 2/4 | 2/4 |
| Crypto | 4/4 | 2/4 |

The JSE row is a lie. Rendering those logos revealed that **`MTN` returns the Vail Resorts
wordmark and `SOL` returns ReneSola** — the *US* companies holding those ticker symbols. The
bare-ticker endpoints are US-centric and resolve against a US listing first. A 404 is a
missing logo; this is a **confidently wrong logo**, which is strictly worse: nothing in the
HTTP response distinguishes it, and the app would have silently told Jan his Sasol position
was a Chinese solar company.

The same collision class hit crypto independently: FMP's `SOL.png` is byte-identical to its
JSE `SOL.png`. Solana would have rendered as ReneSola too.

**Consequence for the design: bare tickers are banned as a lookup key outside US/ETF.**

### Claim B — "there is no reliable key for JSE instruments." False. ISIN works.

Re-keyed on ISIN against Parqet:

| Ticker | ISIN | Result | Ticker | ISIN | Result |
|---|---|---|---|---|---|
| NPN | ZAE000015889 | 128×128, 11.8k | DSY | ZAE000022331 | 128×128, 30.5k |
| SOL | ZAE000006896 | 128×128, 10.5k | AGL | GB00B1XZS820 | 128×128, 16.4k |
| MTN | ZAE000042164 | 128×128, 6.9k | BTI | GB0002875804 | 128×128, 0.6k |
| SHP | ZAE000012084 | 128×128, 0.8k | CFR | CH0210483332 | 128×128, 0.8k |
| PRX | NL0013654783 | 128×128, 12.9k | ABG | ZAE000255915 | 128×128, 8.8k |
| FSR | ZAE000066304 | 128×128, 14.2k | SBK | ZAE000109815 | 128×128, 18.7k |
| CPI | ZAE000035861 | 128×128, 14.9k | KIO | ZAE000085346 | 128×128, 8.1k |
| BVT | ZAE000117321 | 128×128, 11.6k | | | **15/15** |

Having just been burned by counting bad hits as good, the three suspiciously small responses
(SHP 836 B, BTI 631 B, CFR 793 B) were checked for being a shared placeholder: all five sampled
SHA-1s are distinct, and two bogus ISINs (`ZAE999999999`, `GB0000000000`) return a clean 404.
Parqet does not serve placeholders. **15/15 is real.**

ISIN is not foreign to this codebase: `app.js:4592` already pattern-matches ISINs when deciding
whether a string is a human-readable name, and `pb-import.js:168` maps an `isin` column onto
`ticker` during EasyEquities import.

Crypto was re-keyed the same way, onto a dedicated icon set rather than a stock API:
`spothq/cryptocurrency-icons` (MIT, 128 px colour) returns **12/12** for BTC, ETH, XRP, SOL,
ADA, DOGE, DOT, LINK, LTC, AVAX, MATIC, UNI — all 128×128, all distinct hashes, and its `sol`
is **Solana**, not the ReneSola art FMP serves under the same three letters. Being MIT-licensed,
it is also the one source in this design that is unambiguously fine to redistribute in-repo.

### Claim C — "the art is consistent enough to just drop into an `<img>`." False.

A dependency-free PNG analyser (`tools/png-analyse.mjs`, written and validated during this
design) reports that the sources return **three incompatible kinds of art**:

| Kind | Example | `alphaCoverage` | `meanLum` | Renders on #09090b as |
|---|---|---|---|---|
| Opaque on white | AAPL, NPN, SOL | 1.00 | 0.89–0.96 | a white square |
| Transparent + bright | NVDA, GOOGL | 0.38–0.50 | 0.51–0.62 | correct |
| Transparent + near-black | VOO, PRX, SYGWD | 0.06–0.89 | 0.06–0.21 | invisible |

A naive `<img>` therefore produces a list where some rows are white squares, some are floating
glyphs, and some are blank. **The tile is not decoration — it is what makes the set coherent.**

The analyser also caught two art-quality failures that no HTTP check would: `MTN` is 4.8 %
opaque (a smudge at 34 px even on white), and `PRX`/`STX40` resolve only to 36×36 and 16×16
favicons.

### Claim D — "self-hosting costs storage budget." False, and worth stating plainly.

The pack is **files and code**, not state. Nothing is written to `localStorage`, so nothing
enters the `pb.*` namespace that `gatherBackup` enumerates. Cloud-backup blobs stay
byte-identical and **rule #5 is not in play at all**. The 261 KB / 5.1 % localStorage figure
from the Phase 5 spec does not move.

---

## 2. Architecture

### 2.1 Build-time: `tools/build-logos.mjs`

A dev script. `tools/` is not in the `static.yml` allowlist, so it never deploys.

1. **Collect the universe** — the `PB_DATA` suggestion lists in `data.js` (377 distinct
   tickers), plus `--from-backup <file>` to fold in Jan's real holdings/watchlist from a
   cloud-backup JSON.
2. **Resolve, keyed by market** — the rule that §1 Claim A forces:

   | Market | Key | Chain |
   |---|---|---|
   | `US` | ticker | Parqet by symbol @256 (**FMP removed** — see the note below) |
   | `JSE`, `TFSA`, `LSE`, `FRA`, `PAR`, `AMS`, `ASX` | **ISIN** | Parqet by ISIN |
   | `CRYPTO` | coin symbol | `spothq/cryptocurrency-icons` (128px colour set, MIT) — **never a stock API** |
   | SA ETFs (`STX*`, `SYG*`, `ETF*`, `NFE*`, `CSP*`…) | fund ISIN, then issuer | fund mark → **manager mark** (Chrome-extracted + symbol-cropped) → monogram |

   A market outside the US column **never** falls back to a bare-ticker lookup. That fallback
   is precisely the Vail Resorts bug.

   > **Amended during implementation (2026-07-27).** The US chain originally read
   > "FMP → Parqet". Built that way, FMP won every US lookup and produced the pack Jan
   > **rejected**: three different iShares variants, a bare cropped "i", and pure-white
   > blank tiles for QQQ and ARKK. Parqet at `size=256` returns pre-composed brand tiles
   > (verified 16/16), so **FMP was removed entirely** and `logo-collisions.test.mjs` now
   > bans its hostname from the orchestrator. Any FMP reference below is a record of the
   > original measurement, not a recommendation — do not reintroduce it.
   >
   > Two further amendments from the same rebuild: Parqet's best art is **4-bit indexed
   > PNG**, so `png-decode.mjs` gained sub-byte bit depths (1/2/4); and `logo-sources.mjs`
   > gained a `DENY` set (`JSE:KIO`, where every source returns the parent Anglo American
   > mark) plus a `CANONICAL_ART` table forcing one mark per issuer (State Street shipped
   > five variants across nine funds, two of them generic clipart).

   **ETFs resolve in a fixed order** (Jan's rule): the fund's own official mark → **the
   managing house's official logo** → monogram. In practice the second step is the common one,
   because funds rarely carry a mark distinct from their manager's — this is already what the
   working sources do unprompted, e.g. FMP returns the Vanguard wordmark for `VOO` and the
   Invesco mark for `QQQ`. So the rule mostly needs enforcing for the SA funds, where no API
   has coverage at all (0/5 measured).

   **Manager marks are obtainable, and the mechanism is proven.** Issuer sites are JS-rendered
   (a plain fetch of `satrix.co.za` returns markup with no icon `<link>` and no `og:image`), so
   the script drives the headless Chrome the repo already spawns for smokes and reads the
   rendered DOM. `satrix.co.za` yields `/assets/logo-nav.png` at **768×196** — official, but a
   3.9:1 wordmark that would render ~34×9 px inside a square tile. `tools/png-crop.mjs`
   (written and validated during this design) lifts the symbol out: ink-box → curated symbol
   box → square pad, producing a **240×240 transparent Satrix "X"** in brand cyan/blue. The
   curated crop box is one line per issuer, and there are ~6 (Satrix, Sygnia, 1nvest,
   CoreShares, Ashburton, FNB).

   The monogram remains the floor if a manager mark cannot be obtained — a designed state, not
   a failure state.
3. **Analyse + gate** (`tools/png-analyse.mjs`): reject art under 64 px or under 12 % ink;
   compute `bleed` (opaque and bright — the art *is* the tile) and `needsBacking` (dark or
   sparse — needs white behind it).
4. **Normalise + emit** `logos/<MARKET>-<TICKER>.png` and regenerate the `LOGO_MANIFEST` block
   in `pb-content.js`. Normalisation is crop-and-pad only, via `tools/png-crop.mjs`: ink-box
   trim, optional curated symbol crop for wordmarks, then square-pad so no mark is distorted by
   the tile. **No resampling anywhere** — CSS scales the tile, so a decoder plus a plain
   encoder is the entire imaging requirement and the pipeline stays dependency-free.
5. **Emit a contact sheet** of every accepted mark as an HTML page.

**Step 5 is not optional, and it is the acceptance gate for the whole feature.** Reviewing
rendered art is the only mechanism that catches a wrong-company logo — it is how ReneSola and
Vail Resorts were caught, and no status code, byte size, or hash check would have found either.
Jan independently caught the Naspers mark being wrong in the design mockup, which is the same
failure and confirms that only human review of rendered art closes it.

The sheet therefore renders, per entry: the mark at 34 px **and** at full size, the ticker, the
market, the resolved company name, the source, and the lookup key used. Anything whose name and
mark disagree is rejected and re-keyed. **No pack is committed until the sheet has been reviewed
end to end.**

### 2.2 Runtime: `LogoMark`

Lives in **`pb-views.js`**. Both consumers are already there — `HoldingRow` (`pb-views.js:2242`)
and `WatchlistView` (`pb-views.js:2523`) — so **the `window.PBApp` bridge stays at 38 members.**

```
LogoMark({ ticker, market })
  → manifest hit + bleed        → <img> filling a white tile
  → manifest hit + needsBacking → <img> at 87% on a white tile
  → manifest hit, otherwise     → <img> at 96%, no tile   (treatment C)
  → manifest miss / rejected    → monogram chip
```

It is a **pure function of `(ticker, market)`** — no state, no effects, no new props threaded
through rows. `HoldingRow`'s `React.memo` and the `mergePrices` reference-identity contract are
untouched. `<img>` carries `loading="lazy"`, `decoding="async"`, and explicit `width`/`height`
so rows never reflow.

### 2.3 Wiring

Deliberately chosen to stay clear of the four-step new-runtime-file checklist:

| File | Change | Why this shape |
|---|---|---|
| `pb-content.js` | add `LOGO_MANIFEST` + `logoFor()` | Extending an existing `pb-*` file means **no new `<script>` tag, no `static.yml` script edits, and no touching the 16 harness shells** |
| `pb-views.js` | add `LogoMark`, call it in `HoldingRow` + the watchlist card | both consumers already live here |
| `styles.css` | `.pb-logo` tile + monogram | |
| `sw.js` | `/logos/` **cache-first** branch, `LOGO_CACHE` in the `activate()` keep-list, bump `CACHE_NAME` → `v90` | |
| `static.yml` | `cp -r logos _site/` + a Guard-1 sentinel | same pattern as `brand/` |
| `logos/` | new asset directory | |

Two sharp edges in the service worker, both load-bearing:

- The `/logos/` branch must sit **before** the same-origin network-first rule, or every logo
  hits the network on every load.
- `LOGO_CACHE` **must** be added to the `activate()` keep-list — the current handler deletes
  every cache that isn't `CACHE_NAME` or `CDN_CACHE`, so the logo cache would be purged on
  every activation.
- Logos are **not** added to `SHELL_ASSETS`. `cache.addAll` is atomic: one bad file would fail
  the entire service-worker install.

---

## 3. Visual specification (treatment C, 34 px)

| Property | Value |
|---|---|
| Box | 34 × 34 px, `border-radius: 9.5px` (0.28 ×), `overflow: hidden` |
| Gap to text | 11 px |
| `bleed` art | white tile, image at 100 % |
| `needsBacking` art | white tile (`inset 0 0 0 1px rgba(0,0,0,.08)`), image at 87 % |
| plain art | no tile, image at 96 % |
| Monogram | hue from a ticker hash (stable per ticker), initials — 3 chars for fund codes like `STX40`, 2 otherwise |

**A defect the mockup exposed, which the implementation must fix:** in the app's **light**
theme the monogram chip loses its container against the white card — the tint is nearly white
on white, so `STX40` and `PRX` read as stray floating text rather than a mark. The light-theme
monogram needs a deeper tint and a real ring, and the light theme must be verified explicitly,
not assumed to follow from the dark one.

The tile is styled through CSS custom properties redefined per theme, never by restyling the
component inside a theme selector.

---

## 4. Impact assessment

| Axis | Impact |
|---|---|
| **localStorage / cloud backup** | **Zero.** No new `pb.*` key; backup blob byte-identical; rule #5 untouched |
| **Privacy** | **Zero third-party requests at runtime.** Holdings never leave the device — the property the CDN option could not offer |
| **Network** | 2–15 KB per logo, lazy, cache-first forever after first paint. A 20-row Holdings view ≈ 150 KB, once |
| **Render** | `React.memo` unaffected (pure props); fixed box + explicit dimensions ⇒ no reflow |
| **Repo / deploy** | **+~1.5 MB.** The real cost, and the honest price of the three rows above |
| **Offline** | Works after first view |
| **Bridge** | Unchanged at 38 members |
| **New runtime file** | None — the four-step checklist is not triggered |

**Trademark:** company logos used to identify instruments the user holds, in a private personal
app. Nominative use. Worth knowing; not a blocker.

**Known limitation, by design:** a ticker added after the last pack build renders a monogram
until `build-logos.mjs` is re-run. The monogram is designed to look deliberate rather than
broken, so this degrades quietly.

---

## 5. Testing

| Test | Kind | Asserts |
|---|---|---|
| `backend/test/logo-imaging.test.mjs` | Node | `analysePng` / `png-crop` primitives, against synthetic PNGs built in-test — no network, no fixtures |
| `backend/test/logo-manifest.test.mjs` | Node | every manifest entry has a file on disk; every file has an entry; no entry below the 64 px / 12 % gate; manifest flags agree with the committed bytes; `logoFor()` is market-scoped |
| `backend/test/logo-collisions.test.mjs` | Node | a **known-collision fixture** (`SOL`→Sasol/ReneSola/Solana, `MTN`→MTN Group/Vail Resorts, `NPN`→Naspers) asserts each resolves via its market's correct key and that no two markets share a logo file hash |
| anti-drift source guard | Node | no bare-ticker lookup for a non-US market reappears in `build-logos.mjs` |
| `verify-refresh-behavior.mjs` | Browser | the mount gate — required, module boundaries move |
| `verify-watchlist.mjs` | Browser | watchlist cards still render, logo present |
| contact sheet | Manual | wrong-company art (the only thing that catches it) |

Node suites never load `app.js`, so the browser smoke is the only place an extraction bug
surfaces — per the existing convention.

---

## 6. Out of scope

- The stock detail modal, dashboard, and suggestion chips — Holdings and Watchlist only.
- Any runtime fetch of logos, including a fallback for unknown tickers. Rejected with the
  delivery decision: it reintroduces the third-party leak for exactly the tickers just added.
- Any change to `LS`, `gatherBackup`, `applyBackup`, or stored formats.
