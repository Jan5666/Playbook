# Instrument Logos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each company's official logo beside the name in the Holdings rows and Watchlist cards, from a self-hosted logo pack with no runtime third-party call.

**Architecture:** A dev-only Node script (`tools/build-logos.mjs`) fetches and normalises logos into `logos/*.png` and regenerates a `LOGO_MANIFEST` table inside the existing `pb-content.js`. A pure `LogoMark` component in `pb-views.js` reads that manifest and renders one of four states. The service worker caches `/logos/` cache-first. No `localStorage`, no new runtime script file, no `window.PBApp` bridge change.

**Tech Stack:** Vanilla ES modules for the tooling (Node built-ins only — `zlib`, `fs`, `fetch`); React 18 UMD via hand-written `React.createElement` for the component; `node:test` + `node:assert` for tests.

**Spec:** [`docs/superpowers/specs/2026-07-27-instrument-logos-design.md`](../specs/2026-07-27-instrument-logos-design.md)

## Global Constraints

- **No JSX anywhere.** Hand-written `React.createElement` only.
- **No build step, no lint, no npm scripts at the root.** Tooling is plain `node file.mjs`.
- **Tooling uses Node built-ins only** — no new dependency may be added to the repo.
- **Commit to the feature branch `claude/instrument-logos` only. NEVER push, NEVER merge, NEVER switch to or commit on `main`.** Jan lands the work himself via PR, exactly as #48 landed. (Ruling given 2026-07-27: CLAUDE.md rule #1 means "not on main, never push" — per-task commits on a `claude/*` branch are established practice in this repo and the review loop depends on them.)
- **`app.js` has a BOM and LF line endings**; `£ € · —` are authored as `\uXXXX` ASCII escapes. The Edit tool decodes typed `\uXXXX` into literal glyphs. Files touched by this plan (`pb-content.js`, `pb-views.js`, `styles.css`, `sw.js`) must keep their existing encoding — verify with the Task 0 guard.
- **`pb-views.js` contains a literal NUL byte at offset 21595** (a deliberate map-key separator). Tools that treat it as binary must be passed a text flag; never "clean" it.
- **Bare tickers are banned as a lookup key for any market except `US`.** This is the rule that prevents `MTN`→Vail Resorts and `SOL`→ReneSola.
- **Crypto never uses a stock API.**
- **Every mark must be the company's official logo.** A wrong logo is a defect, not a cosmetic miss.
- **ETF resolution order:** the fund's own official mark → the managing house's official logo → monogram.
- **Bump `sw.js` `CACHE_NAME`** from `playbook-shell-v89` to `playbook-shell-v90` (any change to shipped files).
- **Logos must NOT be added to `SHELL_ASSETS`** — `cache.addAll` is atomic and one bad file would fail the whole SW install.
- **No new `pb.*` localStorage key.** Nothing in this feature is durable state; cloud backup must stay byte-identical (rule #5).
- **MONEY GATE unaffected** but must stay green: `money-math`, `cost-basis`, `import-matching`, `ee-ocr-parse`, `fx-providers`.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `tools/png-decode.mjs` | Create (Task 2) | Sole owner of PNG bytes → flat RGBA: chunk walk, scanline unfilter, malformed-input guards. Pure, no I/O. |
| `tools/png-analyse.mjs` | Create (Task 1), refactor onto the shared decoder (Task 2) | Measure only: `w/h`, `alphaCoverage`, `meanLum`, `bleed`, `needsBacking`. Pure, no I/O. |
| `tools/png-crop.mjs` | Create (Task 2) | Transform only: ink-box → crop → square-pad → re-encode. Pure, no I/O. |
| `tools/logo-sources.mjs` | Create | Per-market resolution chains + the curated ISIN / issuer / crop tables. Data + URL builders only, no fetching. |
| `tools/build-logos.mjs` | Create | Orchestrator: collect universe → resolve → analyse → normalise → write `logos/` → rewrite manifest → emit contact sheet. |
| `logos/` | Create | The committed PNG pack. |
| `pb-content.js` | Modify | Add `LOGO_MANIFEST` + `logoFor()`; add both to the returned API object. |
| `pb-views.js` | Modify | Add `LogoMark`; call it in `HoldingRow` and the watchlist card. |
| `styles.css` | Modify | `.pb-logo` tile states + monogram, both themes. |
| `sw.js` | Modify | `/logos/` cache-first branch; `LOGO_CACHE` in the activate keep-list; `CACHE_NAME` → v90. |
| `.github/workflows/static.yml` | Modify | `cp -r logos _site/` + Guard-1 sentinel. |
| `backend/test/logo-imaging.test.mjs` | Create | Unit tests for `png-analyse` + `png-crop`. |
| `backend/test/logo-manifest.test.mjs` | Create | Manifest ↔ filesystem integrity + quality gate. |
| `backend/test/logo-collisions.test.mjs` | Create | The wrong-company regression pin + anti-drift source guard. |

**Task order rationale:** imaging primitives (1–2) are pure and testable with zero network. The source tables (3) are data. The orchestrator (4) is the only networked piece. The UI (5–7) can be built against a hand-written 3-entry manifest before the real pack exists, so UI work never blocks on fetching.

---

### Task 1: PNG analyser

**Files:**
- Create: `tools/png-analyse.mjs`
- Test: `backend/test/logo-imaging.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `analysePng(buf: Buffer) => { w, h, alphaCoverage, meanLum, meanSat, needsBacking, bleed } | null`. Returns `null` for a non-PNG. Returns `{ ...dims, unsupported: true }` for 16-bit or interlaced PNGs. `bleed` is `true` when the art is opaque and bright (it *is* the tile). `needsBacking` is `true` when the art is dark or sparse (it needs white behind it). Used by Task 4.

- [ ] **Step 1: Write the failing test**

Create `backend/test/logo-imaging.test.mjs`:

```javascript
// Imaging primitives for the logo pack (tools/png-analyse.mjs, tools/png-crop.mjs).
// These decide whether a fetched logo is usable and how it is tiled, so they are
// pinned against synthetic PNGs built in-test — no network, no fixtures on disk.
import assert from 'node:assert';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { analysePng } from '../../tools/png-analyse.mjs';

// Build a real 8-bit RGBA PNG so the decoder is exercised end to end.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// paint(x, y) must return [r, g, b, a].
export function makePng(w, h, paint) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WHITE = () => [255, 255, 255, 255];
const BLACK_ON_CLEAR = (x, y) => (x > 20 && x < 100 && y > 20 && y < 100) ? [0, 0, 0, 255] : [0, 0, 0, 0];
const BRIGHT_ON_CLEAR = (x, y) => (x > 20 && x < 100 && y > 20 && y < 100) ? [0, 220, 120, 255] : [0, 0, 0, 0];
const SPARSE = (x, y) => (x > 60 && x < 68 && y > 60 && y < 68) ? [80, 80, 80, 255] : [0, 0, 0, 0];

test('analysePng reads dimensions', () => {
  const a = analysePng(makePng(128, 128, WHITE));
  assert.strictEqual(a.w, 128);
  assert.strictEqual(a.h, 128);
});

test('opaque bright art is flagged bleed (the art IS the tile)', () => {
  const a = analysePng(makePng(128, 128, WHITE));
  assert.strictEqual(a.alphaCoverage, 1);
  assert.ok(a.meanLum > 0.6, `expected bright, got ${a.meanLum}`);
  assert.strictEqual(a.bleed, true);
});

test('dark transparent art needs a white backing', () => {
  const a = analysePng(makePng(128, 128, BLACK_ON_CLEAR));
  assert.ok(a.meanLum < 0.34, `expected dark, got ${a.meanLum}`);
  assert.strictEqual(a.needsBacking, true);
  assert.strictEqual(a.bleed, false);
});

test('bright transparent art needs no backing and does not bleed', () => {
  const a = analysePng(makePng(128, 128, BRIGHT_ON_CLEAR));
  assert.strictEqual(a.needsBacking, false);
  assert.strictEqual(a.bleed, false);
});

test('sparse art is flagged needsBacking regardless of luminance', () => {
  // This is the MTN case: 4.8% ink, a smudge at 34px. Coverage alone must trip it.
  const a = analysePng(makePng(128, 128, SPARSE));
  assert.ok(a.alphaCoverage < 0.15, `expected sparse, got ${a.alphaCoverage}`);
  assert.strictEqual(a.needsBacking, true);
});

test('non-PNG input returns null rather than throwing', () => {
  assert.strictEqual(analysePng(Buffer.from('not a png at all')), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node backend/test/logo-imaging.test.mjs`
Expected: FAIL — `Cannot find module '../../tools/png-analyse.mjs'`

- [ ] **Step 3: Write the implementation**

Create `tools/png-analyse.mjs`:

```javascript
// Minimal dependency-free PNG reader → the facts the logo pipeline needs:
//   needsBacking : is the mark dark or sparse enough to vanish on #09090b?
//   bleed        : is the art opaque and bright, i.e. already its own tile?
// Node built-ins only — the repo has no build step and adds no dependencies.
import zlib from 'node:zlib';

export function analysePng(buf) {
  if (!buf || buf.length < 33 || buf[0] !== 0x89) return null;
  let pos = 8, ihdr = null, idat = [], plte = null, trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('latin1');
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) return null;
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) return { ...ihdr, unsupported: true };

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = CHANNELS[ihdr.color];
  if (!bpp) return { ...ihdr, unsupported: true };
  const stride = ihdr.w * bpp;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return { ...ihdr, unsupported: true }; }

  // Undo the five PNG scanline filters (None/Sub/Up/Average/Paeth) in place.
  const out = Buffer.alloc(ihdr.h * stride);
  let rp = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const o = y * stride, prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = (x >= bpp && y > 0) ? out[prev + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[o + x] = v & 0xff;
    }
  }

  const px = (i) => {
    if (ihdr.color === 6) return [out[i], out[i + 1], out[i + 2], out[i + 3]];
    if (ihdr.color === 2) return [out[i], out[i + 1], out[i + 2], 255];
    if (ihdr.color === 0) return [out[i], out[i], out[i], 255];
    if (ihdr.color === 4) return [out[i], out[i], out[i], out[i + 1]];
    const idx = out[i];
    const al = trns && idx < trns.length ? trns[idx] : 255;
    return [plte[idx * 3], plte[idx * 3 + 1], plte[idx * 3 + 2], al];
  };

  let lumSum = 0, satSum = 0, opaque = 0;
  for (let y = 0; y < ihdr.h; y++) {
    for (let x = 0; x < ihdr.w; x++) {
      const [r, g, b, a] = px(y * stride + x * bpp);
      if (a < 128) continue;
      opaque++;
      lumSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      satSum += mx === 0 ? 0 : (mx - mn) / mx;
    }
  }
  const total = ihdr.w * ihdr.h;
  const cover = opaque / total;
  const meanLum = opaque ? lumSum / opaque : 0;
  return {
    w: ihdr.w, h: ihdr.h,
    alphaCoverage: +cover.toFixed(3),
    meanLum: +meanLum.toFixed(3),
    meanSat: +(opaque ? satSum / opaque : 0).toFixed(3),
    // Near-black art vanishes on #09090b; sparse art is a smudge at 34px. Both need a tile.
    needsBacking: meanLum < 0.34 || cover < 0.15,
    // Opaque + bright art already carries its own white ground — it IS the tile.
    bleed: cover > 0.9 && meanLum > 0.6,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node backend/test/logo-imaging.test.mjs`
Expected: PASS — 6 tests.

- [ ] **Step 5: Verify against real art**

Run:

```bash
node -e "
const {analysePng}=require('./tools/png-analyse.mjs');
" 2>/dev/null || node --input-type=module -e "
import {analysePng} from './tools/png-analyse.mjs';
const r = await fetch('https://financialmodelingprep.com/image-stock/AAPL.png');
const a = analysePng(Buffer.from(await r.arrayBuffer()));
console.log(a);
"
```

Expected: `w: 100, h: 100, alphaCoverage: 1, meanLum: ~0.892, bleed: true, needsBacking: false`. These are the measured values from the spec — if they differ, the decoder is wrong, not the spec.

- [ ] **Step 6: Commit** 

```bash
git add tools/png-analyse.mjs backend/test/logo-imaging.test.mjs
git commit -m "feat(logos): PNG analyser for tile/backing decisions"
```

---

### Task 2: Shared PNG decoder + crop / square-pad

> **Plan revision (2026-07-27, Jan's ruling):** the original Task 2 had `png-crop.mjs`
> re-implement the chunk-parse and unfilter math that Task 1 already built and hardened in
> `png-analyse.mjs`. That duplication is now replaced by a shared `tools/png-decode.mjs` that
> both modules import. Task 1's short-IDAT and missing-PLTE guards therefore apply everywhere,
> and the filter math has one copy to pin rather than two.

**Files:**
- Create: `tools/png-decode.mjs`
- Create: `tools/png-crop.mjs`
- Modify: `tools/png-analyse.mjs` (import the shared decoder; keep measuring only)
- Modify: `backend/test/logo-imaging.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `decodePng(buf)` from `tools/png-decode.mjs`, a **three-way** return that preserves both existing tested contracts:
    - `null` — not a PNG at all (bad signature, too short, no IHDR)
    - `{ w, h, depth, color, interlace, unsupported: true }` — recognisably a PNG but undecodable (depth ≠ 8, interlaced, unknown colour type, truncated IDAT, colour type 3 with no PLTE)
    - `{ w, h, rgba }` — decoded; `rgba` is a flat 4-bytes-per-pixel Buffer
  - `decodeRGBA(buf) => { w, h, rgba } | null` from `tools/png-crop.mjs` — thin wrapper over `decodePng` that collapses `unsupported` to `null`.
  - `encodeRGBA(w, h, rgba) => Buffer`
  - `inkBox(img) => { x, y, w, h } | null`
  - `crop(img, box) => img`
  - `squarePad(img, margin = 0.08) => img`
  All consumed by Task 4. **No resampling function exists or is needed** — CSS scales the tile.

**The regression gate for this task:** Task 1's 22 existing tests must pass *unchanged* after the refactor, and the real-art Apple values must be identical (`100x100`, `alphaCoverage 1`, `meanLum 0.892`, `bleed true`, `needsBacking false`). If any moved, the refactor changed behaviour and is wrong.

- [ ] **Step 1: Create the shared decoder**

Create `tools/png-decode.mjs`. Move the chunk walk, the inflate + guards, and the scanline unfilter out of `tools/png-analyse.mjs` verbatim — including the three guards Task 1's review added — and expand to flat RGBA at the end:

```javascript
// Shared PNG → RGBA decode. Owned here so the measuring path (png-analyse) and
// the transforming path (png-crop) cannot drift: the chunk walk, the five
// scanline filters, and the malformed-input guards exist exactly once.
//
// Three-way return, because callers need to tell "not a PNG" from "a PNG I
// can't handle":
//   null                        → not a PNG
//   { ...ihdr, unsupported }    → a PNG, but undecodable
//   { w, h, rgba }              → decoded, 4 bytes per pixel
import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(buf) {
  if (!buf || buf.length < 33 || !buf.slice(0, 8).equals(PNG_SIG)) return null;
  let pos = 8, ihdr = null, idat = [], plte = null, trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('latin1');
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) return null;
  const bad = { ...ihdr, unsupported: true };
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) return bad;
  const bpp = CHANNELS[ihdr.color];
  if (!bpp) return bad;
  // An indexed PNG with no palette would throw on the palette reads below.
  if (ihdr.color === 3 && !plte) return bad;

  const stride = ihdr.w * bpp;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return bad; }
  // A short IDAT must not decode silently: reading past `raw` yields
  // `undefined & 0xff` === 0, which turns missing scanlines into transparent
  // black and corrupts every measurement downstream.
  if (raw.length < ihdr.h * (stride + 1)) return bad;

  const out = Buffer.alloc(ihdr.h * stride);
  let rp = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const o = y * stride, prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = (x >= bpp && y > 0) ? out[prev + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[o + x] = v & 0xff;
    }
  }

  const rgba = Buffer.alloc(ihdr.w * ihdr.h * 4);
  for (let i = 0, n = ihdr.w * ihdr.h; i < n; i++) {
    const s = i * bpp; let r, g, b, a = 255;
    if (ihdr.color === 6) { r = out[s]; g = out[s + 1]; b = out[s + 2]; a = out[s + 3]; }
    else if (ihdr.color === 2) { r = out[s]; g = out[s + 1]; b = out[s + 2]; }
    else if (ihdr.color === 0) { r = g = b = out[s]; }
    else if (ihdr.color === 4) { r = g = b = out[s]; a = out[s + 1]; }
    else {
      const ix = out[s];
      r = plte[ix * 3]; g = plte[ix * 3 + 1]; b = plte[ix * 3 + 2];
      a = trns && ix < trns.length ? trns[ix] : 255;
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { w: ihdr.w, h: ihdr.h, rgba };
}
```

- [ ] **Step 2: Refactor `png-analyse.mjs` onto the shared decoder**

`tools/png-analyse.mjs` keeps its exact public contract — same return shape, same thresholds — but stops owning the decode. Replace its body with:

```javascript
// Measures a PNG for the two facts the logo pipeline needs:
//   needsBacking : is the mark dark or sparse enough to vanish on #09090b?
//   bleed        : is the art opaque and bright, i.e. already its own tile?
// Decoding lives in png-decode.mjs so the measuring and transforming paths
// cannot drift apart.
import { decodePng } from './png-decode.mjs';

export function analysePng(buf) {
  const img = decodePng(buf);
  if (!img) return null;
  if (img.unsupported) return img;

  let lumSum = 0, satSum = 0, opaque = 0;
  for (let i = 0, n = img.w * img.h; i < n; i++) {
    const o = i * 4;
    const a = img.rgba[o + 3];
    if (a < 128) continue;
    opaque++;
    const r = img.rgba[o], g = img.rgba[o + 1], b = img.rgba[o + 2];
    lumSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += mx === 0 ? 0 : (mx - mn) / mx;
  }
  const total = img.w * img.h;
  const cover = opaque / total;
  const meanLum = opaque ? lumSum / opaque : 0;
  return {
    w: img.w, h: img.h,
    alphaCoverage: +cover.toFixed(3),
    meanLum: +meanLum.toFixed(3),
    meanSat: +(opaque ? satSum / opaque : 0).toFixed(3),
    // Near-black art vanishes on #09090b; sparse art is a smudge at 34px.
    needsBacking: meanLum < 0.34 || cover < 0.15,
    // Opaque + bright art already carries its own white ground — it IS the tile.
    bleed: cover > 0.9 && meanLum > 0.6,
  };
}
```

**Do not change the thresholds, the luminance coefficients, the rounding, or the returned field names.** The comparisons must keep using the full-precision `meanLum` / `cover`, never the rounded display fields.

- [ ] **Step 3: Prove the refactor changed no behaviour**

Run: `node backend/test/logo-imaging.test.mjs`
Expected: all of Task 1's existing tests still pass, **unmodified**. If a test needed editing to pass, the refactor changed behaviour — stop and report rather than editing the test.

Then re-verify against real art:

```bash
node --input-type=module -e "
import { analysePng } from './tools/png-analyse.mjs';
const r = await fetch('https://financialmodelingprep.com/image-stock/AAPL.png');
console.log(analysePng(Buffer.from(await r.arrayBuffer())));
"
```

Expected, unchanged from Task 1: `w: 100, h: 100, alphaCoverage: 1, meanLum: 0.892, bleed: true, needsBacking: false`. If the network is unavailable, say so in the report — do not fabricate the values.

- [ ] **Step 4: Write the failing tests for the crop functions**

Append to `backend/test/logo-imaging.test.mjs`:

```javascript
import { decodeRGBA, encodeRGBA, inkBox, crop, squarePad } from '../../tools/png-crop.mjs';

test('decode → encode round-trips pixel data exactly', () => {
  const src = makePng(16, 8, (x, y) => [x * 8, y * 8, 128, 255]);
  const img = decodeRGBA(src);
  assert.strictEqual(img.w, 16);
  assert.strictEqual(img.h, 8);
  const again = decodeRGBA(encodeRGBA(img.w, img.h, img.rgba));
  assert.deepStrictEqual(again.rgba, img.rgba);
});

test('encodeRGBA output survives a non-uniform gradient, exercising real filter math', () => {
  // Uniform fills make every Paeth neighbour equal, which hides predictor bugs.
  // A gradient gives a !== b !== c on most pixels.
  const src = makePng(24, 24, (x, y) => [(x * 11) % 256, (y * 7) % 256, (x * y) % 256, 255]);
  const a = decodeRGBA(src);
  const b = decodeRGBA(encodeRGBA(a.w, a.h, a.rgba));
  assert.deepStrictEqual(b.rgba, a.rgba);
});

test('inkBox finds the mark and ignores transparent padding', () => {
  const img = decodeRGBA(makePng(100, 100, (x, y) =>
    (x >= 30 && x < 70 && y >= 40 && y < 60) ? [10, 10, 200, 255] : [0, 0, 0, 0]));
  assert.deepStrictEqual(inkBox(img), { x: 30, y: 40, w: 40, h: 20 });
});

test('inkBox treats a near-white background as background, not ink', () => {
  // Several sources ship logos drawn on a solid white square; the white ground
  // must not widen the box to the full canvas.
  const img = decodeRGBA(makePng(100, 100, (x, y) =>
    (x >= 20 && x < 40 && y >= 20 && y < 40) ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  assert.deepStrictEqual(inkBox(img), { x: 20, y: 20, w: 20, h: 20 });
});

test('inkBox returns null for a fully transparent image', () => {
  assert.strictEqual(inkBox(decodeRGBA(makePng(8, 8, () => [0, 0, 0, 0]))), null);
});

test('crop extracts exactly the requested region', () => {
  const img = decodeRGBA(makePng(10, 10, (x) => [x * 25, 0, 0, 255]));
  const c = crop(img, { x: 4, y: 0, w: 3, h: 2 });
  assert.strictEqual(c.w, 3);
  assert.strictEqual(c.h, 2);
  assert.strictEqual(c.rgba[0], 100); // x=4 → 4*25
});

test('squarePad centres a wide wordmark without distorting it', () => {
  // The Satrix case: a 3.9:1 mark must become square by padding, never stretching.
  const img = decodeRGBA(makePng(40, 10, () => [0, 0, 255, 255]));
  const sq = squarePad(img, 0.1);
  assert.strictEqual(sq.w, sq.h, 'result must be square');
  assert.strictEqual(sq.w, 48); // round(40 * 1.2)
  assert.strictEqual(sq.rgba[3], 0, 'corners stay transparent');
  const cx = Math.floor(sq.w / 2), cy = Math.floor(sq.h / 2);
  assert.strictEqual(sq.rgba[(cy * sq.w + cx) * 4 + 3], 255, 'mark sits centred');
});

test('decodeRGBA collapses an undecodable PNG to null', () => {
  // png-decode reports {unsupported:true}; the crop path only cares yes/no.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 16; ihdr[9] = 6; // depth 16
  const deep = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(4 * (16 + 1)), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.strictEqual(decodeRGBA(deep), null);
});

test('decodeRGBA returns null for a non-PNG', () => {
  assert.strictEqual(decodeRGBA(Buffer.from('definitely not a png')), null);
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `node backend/test/logo-imaging.test.mjs`
Expected: FAIL — `Cannot find module '../../tools/png-crop.mjs'`

- [ ] **Step 6: Write `tools/png-crop.mjs`**

```javascript
// Crop / square-pad for the logo pack: lifts a square symbol mark out of a wide
// issuer wordmark (Satrix's X) and centres any mark on a square canvas.
// Decoding is delegated to png-decode.mjs — this module owns transformation only.
// No resampling exists here and none is needed: CSS scales the tile.
import zlib from 'node:zlib';
import { decodePng } from './png-decode.mjs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// The transform path only needs "did it decode?", so undecodable collapses to null.
export function decodeRGBA(buf) {
  const img = decodePng(buf);
  return (img && !img.unsupported) ? img : null;
}

export function encodeRGBA(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Tight bounds of real ink. Near-white opaque pixels count as background, because
// several sources ship logos drawn on a solid white square.
export function inkBox(img) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * 4;
    const a = img.rgba[i + 3];
    if (a < 24) continue;
    const lum = (0.2126 * img.rgba[i] + 0.7152 * img.rgba[i + 1] + 0.0722 * img.rgba[i + 2]) / 255;
    if (a > 200 && lum > 0.97) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function crop(img, box) {
  const out = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    const src = ((box.y + y) * img.w + box.x) * 4;
    img.rgba.copy(out, y * box.w * 4, src, src + box.w * 4);
  }
  return { w: box.w, h: box.h, rgba: out };
}

// Pad to a square canvas so a wide wordmark is centred, never stretched.
export function squarePad(img, margin = 0.08) {
  const side = Math.round(Math.max(img.w, img.h) * (1 + margin * 2));
  const out = Buffer.alloc(side * side * 4); // zero-filled = transparent
  const ox = Math.floor((side - img.w) / 2), oy = Math.floor((side - img.h) / 2);
  for (let y = 0; y < img.h; y++) {
    const src = y * img.w * 4;
    img.rgba.copy(out, ((oy + y) * side + ox) * 4, src, src + img.w * 4);
  }
  return { w: side, h: side, rgba: out };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node backend/test/logo-imaging.test.mjs`
Expected: PASS, `fail 0`, output pristine — Task 1's tests plus the 9 added here. Assert on "all passing", not a fixed total.

- [ ] **Step 8: Verify against the real Satrix wordmark**

```bash
node --input-type=module -e "
import { writeFileSync, unlinkSync } from 'node:fs';
import { decodeRGBA, encodeRGBA, inkBox, crop, squarePad } from './tools/png-crop.mjs';
const r = await fetch('https://satrix.co.za/assets/logo-nav.png');
const img = decodeRGBA(Buffer.from(await r.arrayBuffer()));
console.log('source', img.w + 'x' + img.h);
const box = inkBox(img);
const sym = { x: Math.round(box.x + box.w * 0.74), y: box.y, w: Math.round(box.w * 0.26), h: box.h };
let c = crop(img, sym); c = crop(c, inkBox(c));
const sq = squarePad(c, 0.10);
writeFileSync('satrix-mark.png', encodeRGBA(sq.w, sq.h, sq.rgba));
console.log('squared ->', sq.w + 'x' + sq.h);
"
```

Expected: `source 768x196` and `squared -> 240x240`. Open `satrix-mark.png` and confirm it is the cyan/blue Satrix **X** on transparency, not a slice of the "SATRIX" wordmark. **Then delete the file** — it is a check, not an artefact. If the network is unavailable, report the step skipped.

- [ ] **Step 9: Commit**

```bash
git add tools/png-decode.mjs tools/png-crop.mjs tools/png-analyse.mjs backend/test/logo-imaging.test.mjs
git commit -m "feat(logos): shared PNG decoder + dependency-free crop/square-pad"
```


---

### Task 3: Source tables and resolution chains

**Files:**
- Create: `tools/logo-sources.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ISIN_BY_TICKER: Record<'MARKET:TICKER', string>`
  - `ISSUER_BY_PREFIX: Array<{ test: RegExp, issuer: string }>`
  - `ISSUERS: Record<string, { name, page, cropBox?: {x,y,w,h} }>` where `cropBox` is in **relative** units (0–1) of the ink box.
  - `CRYPTO_ID: Record<string, string>` mapping app ticker → icon-set slug.
  - `chainFor(market, ticker) => Array<{ source, url, key }>` — the ordered candidate list. **Must never emit a bare-ticker URL for a market other than `US`.**

- [ ] **Step 1: Write the failing test**

Create `backend/test/logo-collisions.test.mjs`:

```javascript
// The wrong-company regression pin.
//
// Bare-ticker logo endpoints are US-centric: they resolve `MTN` to Vail Resorts
// and `SOL` to ReneSola, and return HTTP 200 while doing it. A 404 is a missing
// logo; this is a CONFIDENTLY WRONG logo, which is worse — nothing in the
// response distinguishes it. These tests pin the rule that prevents it: outside
// the US market, the lookup key is never a bare ticker.
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chainFor, ISIN_BY_TICKER, CRYPTO_ID } from '../../tools/logo-sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('JSE resolution never uses a bare ticker', () => {
  for (const t of ['SOL', 'MTN', 'NPN', 'SHP', 'PRX']) {
    const chain = chainFor('JSE', t);
    assert.ok(chain.length > 0, `${t}: expected at least one candidate`);
    for (const c of chain) {
      assert.notStrictEqual(c.key, 'ticker',
        `JSE:${t} used a bare-ticker lookup — this is the Vail Resorts bug`);
    }
  }
});

test('every market except US forbids the ticker key', () => {
  for (const m of ['JSE', 'TFSA', 'LSE', 'ASX', 'FRA', 'PAR', 'AMS', 'CRYPTO']) {
    for (const c of chainFor(m, 'SOL')) {
      assert.notStrictEqual(c.key, 'ticker', `${m}:SOL used a bare-ticker lookup`);
    }
  }
});

test('crypto never routes through a stock API', () => {
  const hosts = chainFor('CRYPTO', 'SOL').map(c => new URL(c.url).hostname);
  for (const h of hosts) {
    assert.ok(!/financialmodelingprep|parqet/.test(h),
      `crypto resolved via a stock API (${h}) — FMP's SOL is ReneSola, not Solana`);
  }
});

test('the same ticker in different markets resolves differently', () => {
  const jse = chainFor('JSE', 'SOL')[0].url;
  const crypto = chainFor('CRYPTO', 'SOL')[0].url;
  assert.notStrictEqual(jse, crypto, 'SOL must not share a URL across markets');
});

test('US keeps the ticker key (its listings are the ones these APIs index)', () => {
  assert.ok(chainFor('US', 'AAPL').some(c => c.key === 'ticker'));
});

test('the ISIN table covers the JSE tickers measured in the spec', () => {
  for (const t of ['NPN', 'SOL', 'MTN', 'SHP', 'PRX', 'FSR', 'CPI', 'BVT', 'KIO', 'DSY']) {
    assert.ok(ISIN_BY_TICKER[`JSE:${t}`], `missing ISIN for JSE:${t}`);
    assert.match(ISIN_BY_TICKER[`JSE:${t}`], /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/, `JSE:${t} ISIN malformed`);
  }
});

test('crypto ids are lower-case slugs', () => {
  for (const [t, id] of Object.entries(CRYPTO_ID)) {
    assert.strictEqual(id, id.toLowerCase(), `${t} → ${id} must be lower-case`);
  }
});

test('anti-drift: build-logos.mjs contains no bare-ticker URL builder', () => {
  // If someone reintroduces a ticker-keyed fetch in the orchestrator, the guard
  // in logo-sources.mjs can be bypassed entirely. Grep for it.
  const src = readFileSync(join(ROOT, 'tools', 'build-logos.mjs'), 'utf8');
  assert.ok(!/image-stock\/\$\{/.test(src),
    'build-logos.mjs builds an FMP ticker URL directly — it must go through chainFor()');
  assert.ok(!/logos\/symbol\/\$\{/.test(src),
    'build-logos.mjs builds a Parqet symbol URL directly — it must go through chainFor()');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node backend/test/logo-collisions.test.mjs`
Expected: FAIL — `Cannot find module '../../tools/logo-sources.mjs'`

- [ ] **Step 3: Write the implementation**

Create `tools/logo-sources.mjs`.

```javascript
// Per-market logo resolution. The ONE rule this file exists to enforce:
// outside the US market, a bare ticker is never a lookup key. Bare-ticker
// endpoints are US-centric and return the US listing with a 200 — MTN resolves
// to Vail Resorts, SOL to ReneSola. See the spec, §1 Claim A.

export const ISIN_BY_TICKER = {
  'JSE:NPN': 'ZAE000015889', 'JSE:SOL': 'ZAE000006896', 'JSE:MTN': 'ZAE000042164',
  'JSE:SHP': 'ZAE000012084', 'JSE:PRX': 'NL0013654783', 'JSE:FSR': 'ZAE000066304',
  'JSE:CPI': 'ZAE000035861', 'JSE:BVT': 'ZAE000117321', 'JSE:KIO': 'ZAE000085346',
  'JSE:DSY': 'ZAE000022331', 'JSE:AGL': 'GB00B1XZS820', 'JSE:BTI': 'GB0002875804',
  'JSE:CFR': 'CH0210483332', 'JSE:ABG': 'ZAE000255915', 'JSE:SBK': 'ZAE000109815',
};

export const ISSUER_BY_PREFIX = [
  { test: /^STX/,  issuer: 'satrix' },
  { test: /^SYG/,  issuer: 'sygnia' },
  { test: /^ETF/,  issuer: '1nvest' },
  { test: /^NFE/,  issuer: 'newfunds' },
  { test: /^CSP|^CTOP|^COG/, issuer: 'coreshares' },
  { test: /^ASH|^AS[A-Z]{2}ET/, issuer: 'ashburton' },
  { test: /^FNB/,  issuer: 'fnb' },
];

// `page` is fetched through headless Chrome (these sites are JS-rendered — a
// plain fetch returns markup with no icon <link> and no og:image).
// `cropBox` is RELATIVE to the ink box, used to lift a square symbol out of a
// wide wordmark. Satrix's is measured: the X occupies the right ~26%.
export const ISSUERS = {
  satrix: { name: 'Satrix', page: 'https://satrix.co.za/', cropBox: { x: 0.74, y: 0, w: 0.26, h: 1 } },
  sygnia: { name: 'Sygnia', page: 'https://www.sygnia.co.za/' },
  '1nvest': { name: '1nvest', page: 'https://www.1nvest.co.za/' },
  newfunds: { name: 'NewFunds', page: 'https://www.newfunds.co.za/' },
  coreshares: { name: 'CoreShares', page: 'https://coreshares.co.za/' },
  ashburton: { name: 'Ashburton', page: 'https://www.ashburtoninvestments.com/' },
  fnb: { name: 'FNB', page: 'https://www.fnb.co.za/' },
};

export const CRYPTO_ID = {
  BTC: 'btc', ETH: 'eth', XRP: 'xrp', SOL: 'sol', ADA: 'ada', DOGE: 'doge',
  DOT: 'dot', LINK: 'link', LTC: 'ltc', AVAX: 'avax', MATIC: 'matic', UNI: 'uni',
  BCH: 'bch', XLM: 'xlm', ATOM: 'atom', XMR: 'xmr', ETC: 'etc', FIL: 'fil',
  NEAR: 'near', ALGO: 'algo', HBAR: 'hbar', AAVE: 'aave', MKR: 'mkr', TRX: 'trx',
  USDT: 'usdt', USDC: 'usdc', BNB: 'bnb', SHIB: 'shib', TON: 'ton', XTZ: 'xtz',
};

const CRYPTO_CDN = 'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color';

export function issuerFor(ticker) {
  const hit = ISSUER_BY_PREFIX.find(p => p.test.test(ticker));
  return hit ? hit.issuer : null;
}

export function chainFor(market, ticker) {
  const out = [];
  if (market === 'CRYPTO') {
    const id = CRYPTO_ID[String(ticker).replace(/-USD$/i, '').toUpperCase()];
    // Stock APIs are deliberately absent here: FMP's SOL.png is ReneSola.
    if (id) out.push({ source: 'cryptocurrency-icons', key: 'coin', url: `${CRYPTO_CDN}/${id}.png` });
    return out;
  }
  if (market === 'US') {
    out.push({ source: 'fmp', key: 'ticker', url: `https://financialmodelingprep.com/image-stock/${encodeURIComponent(ticker)}.png` });
    out.push({ source: 'parqet', key: 'ticker', url: `https://assets.parqet.com/logos/symbol/${encodeURIComponent(ticker)}?format=png&size=128` });
    return out;
  }
  // Every other market: ISIN only, then the managing house.
  const isin = ISIN_BY_TICKER[`${market}:${ticker}`];
  if (isin) out.push({ source: 'parqet-isin', key: 'isin', url: `https://assets.parqet.com/logos/isin/${isin}?format=png&size=128` });
  const issuer = issuerFor(ticker);
  if (issuer) out.push({ source: 'issuer', key: 'issuer', url: ISSUERS[issuer].page, issuer });
  return out;
}
```

- [ ] **Step 4: Create the orchestrator stub so the anti-drift guard has a file to read**

The last test reads `tools/build-logos.mjs`. Create it now as a one-line placeholder that Task 4 fills in:

```javascript
// Logo pack builder — see docs/superpowers/plans/2026-07-27-instrument-logos.md Task 4.
export {};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node backend/test/logo-collisions.test.mjs`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit** 

```bash
git add tools/logo-sources.mjs tools/build-logos.mjs backend/test/logo-collisions.test.mjs
git commit -m "feat(logos): market-scoped resolution chains + collision pin"
```

---

### Task 4: The build orchestrator + the pack

**Files:**
- Modify: `tools/build-logos.mjs` (replace the Task 3 stub)
- Create: `logos/*.png`
- Modify: `pb-content.js`

**Interfaces:**
- Consumes: `analysePng` (Task 1); `decodeRGBA`/`encodeRGBA`/`inkBox`/`crop`/`squarePad` (Task 2); `chainFor`/`ISSUERS`/`issuerFor` (Task 3).
- Produces: `logos/<MARKET>-<TICKER>.png`; a regenerated `LOGO_MANIFEST` in `pb-content.js` of shape `Record<'MARKET:TICKER', { f: string, b?: 1, k?: 1 }>` where `f` is the filename, `b` marks `bleed`, `k` marks `needsBacking`. Absent flags mean plain. Consumed by Tasks 5–7.

- [ ] **Step 1: Write the orchestrator**

Replace `tools/build-logos.mjs`:

```javascript
// Build the instrument logo pack.
//
//   node tools/build-logos.mjs [--dry-run] [--from-backup <backup.json>]
//
// Resolves one logo per MARKET:TICKER through tools/logo-sources.mjs (which
// enforces the market-scoped key rule), gates it on measured quality, normalises
// it, writes logos/*.png, rewrites the LOGO_MANIFEST block in pb-content.js, and
// emits a contact sheet for human review.
//
// The contact sheet is the acceptance gate: a wrong-company logo returns HTTP
// 200 and looks perfect to every automated check. Only eyes catch it.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analysePng } from './png-analyse.mjs';
import { decodeRGBA, encodeRGBA, inkBox, crop, squarePad } from './png-crop.mjs';
import { chainFor, ISSUERS, issuerFor } from './logo-sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGOS = join(ROOT, 'logos');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DRY = process.argv.includes('--dry-run');
const backupIdx = process.argv.indexOf('--from-backup');
const BACKUP = backupIdx > -1 ? process.argv[backupIdx + 1] : null;

// ─── 1. Collect the universe ────────────────────────────────────────────────
const SECTION_MARKET = {
  JSE_SUGGESTIONS: 'JSE', TFSA_SUGGESTIONS: 'TFSA', LSE_SUGGESTIONS: 'LSE',
  ASX_SUGGESTIONS: 'ASX', EU_SUGGESTIONS: 'FRA', CRYPTO_SUGGESTIONS: 'CRYPTO',
};
function collectUniverse() {
  const src = readFileSync(join(ROOT, 'data.js'), 'utf8');
  const set = new Map(); // 'MARKET:TICKER' -> { ticker, market }
  const add = (ticker, market) => {
    if (!ticker || !market) return;
    set.set(`${market}:${ticker}`, { ticker, market });
  };
  // Walk section headers in order; every ticker belongs to the last header seen.
  const marks = [...src.matchAll(/^\s{2}([A-Z_]+):\s*\[/gm)].map(m => ({ name: m[1], at: m.index }));
  for (const m of src.matchAll(/ticker\s*:\s*'([^']+)'/g)) {
    let section = null;
    for (const s of marks) { if (s.at < m.index) section = s.name; else break; }
    add(m[1], SECTION_MARKET[section] || 'US');
  }
  if (BACKUP) {
    const raw = JSON.parse(readFileSync(BACKUP, 'utf8'));
    const keys = raw.keys || raw;
    const parse = (k) => { try { return JSON.parse(keys[k]); } catch { return []; } };
    for (const p of parse('pb.positions.v1') || []) add(p.ticker, p.market);
    for (const w of parse('pb.watchlist.v1') || []) add(w.ticker, w.market);
  }
  return [...set.values()];
}

// ─── 2. Fetch helpers ───────────────────────────────────────────────────────
async function getBuffer(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length < 300 ? null : b;
  } catch { return null; }
}

// Issuer sites are JS-rendered: a plain fetch returns markup with no icon <link>
// and no og:image. Drive the same headless Chrome the smokes already use.
const issuerArtCache = new Map();
async function fetchIssuerArt(issuerKey) {
  if (issuerArtCache.has(issuerKey)) return issuerArtCache.get(issuerKey);
  const cfg = ISSUERS[issuerKey];
  let best = null;
  const res = spawnSync(CHROME, [
    '--headless=new', '--disable-gpu', '--virtual-time-budget=8000', '--dump-dom', cfg.page,
  ], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const dom = res.stdout || '';
  const origin = new URL(cfg.page).origin;
  const candidates = [...dom.matchAll(/(?:src|href)="([^"]*logo[^"]*\.(?:png|svg))"/gi)]
    .map(m => m[1])
    .filter(u => !/instagram|facebook|twitter|linkedin|youtube/i.test(u))
    .map(u => (u.startsWith('http') ? u : origin + (u.startsWith('/') ? u : '/' + u)));
  for (const u of [...new Set(candidates)]) {
    if (u.endsWith('.svg')) continue; // the pipeline is raster-only
    const buf = await getBuffer(u);
    if (!buf) continue;
    const a = analysePng(buf);
    if (!a || a.unsupported) continue;
    if (!best || a.w * a.h > best.a.w * best.a.h) best = { buf, a, url: u };
  }
  issuerArtCache.set(issuerKey, best);
  return best;
}

// ─── 3-4. Gate + normalise ──────────────────────────────────────────────────
function gate(a) {
  if (!a || a.unsupported) return 'undecodable';
  if (a.w < 64 || a.h < 64) return `too small (${a.w}x${a.h})`;
  if (a.alphaCoverage < 0.12) return `too sparse (${a.alphaCoverage} ink)`;
  return null;
}
function normalise(buf, a, cropBox) {
  // Opaque bright art is already a finished tile — cropping it would eat its ground.
  if (a.bleed && !cropBox) return buf;
  const img = decodeRGBA(buf);
  if (!img) return buf;
  let box = inkBox(img);
  if (!box) return buf;
  if (cropBox) {
    box = {
      x: Math.round(box.x + box.w * cropBox.x), y: Math.round(box.y + box.h * cropBox.y),
      w: Math.max(1, Math.round(box.w * cropBox.w)), h: Math.max(1, Math.round(box.h * cropBox.h)),
    };
  }
  let c = crop(img, box);
  const tight = inkBox(c);
  if (tight) c = crop(c, tight);
  const sq = squarePad(c, 0.08);
  return encodeRGBA(sq.w, sq.h, sq.rgba);
}

// ─── Main ───────────────────────────────────────────────────────────────────
const universe = collectUniverse();
const manifest = {};
const report = [];
if (!DRY && !existsSync(LOGOS)) mkdirSync(LOGOS, { recursive: true });

for (const { ticker, market } of universe) {
  const key = `${market}:${ticker}`;
  let done = false;
  for (const cand of chainFor(market, ticker)) {
    let buf = null, via = cand.source, cropBox;
    if (cand.key === 'issuer') {
      const art = await fetchIssuerArt(cand.issuer);
      if (art) { buf = art.buf; via = `issuer:${cand.issuer}`; cropBox = ISSUERS[cand.issuer].cropBox; }
    } else {
      buf = await getBuffer(cand.url);
    }
    if (!buf) { report.push({ key, status: 'miss', via, why: 'no response' }); continue; }
    const a = analysePng(buf);
    const bad = gate(a);
    if (bad) { report.push({ key, status: 'reject', via, why: bad }); continue; }
    const outBuf = normalise(buf, a, cropBox);
    const finalA = analysePng(outBuf) || a;
    const file = `${market}-${ticker}.png`;
    if (!DRY) writeFileSync(join(LOGOS, file), outBuf);
    manifest[key] = { f: file, ...(finalA.bleed ? { b: 1 } : {}), ...(finalA.needsBacking ? { k: 1 } : {}) };
    report.push({ key, status: 'ok', via, why: `${finalA.w}x${finalA.h}`, lookup: cand.key });
    done = true;
    break;
  }
  if (!done) report.push({ key, status: 'monogram', via: '-', why: 'chain exhausted' });
}

// ─── 5-6. Rewrite the manifest block, bytes-exact outside the markers ───────
const START = '// <<< LOGO_MANIFEST_START';
const END = '// <<< LOGO_MANIFEST_END';
if (!DRY) {
  const pcPath = join(ROOT, 'pb-content.js');
  const buf = readFileSync(pcPath);
  const s = buf.indexOf(Buffer.from(START));
  const e = buf.indexOf(Buffer.from(END));
  if (s < 0 || e < 0) throw new Error('LOGO_MANIFEST markers not found in pb-content.js');
  const entries = Object.keys(manifest).sort()
    .map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(manifest[k])},`).join('\n');
  const block = Buffer.from(`${START}\nconst LOGO_MANIFEST = {\n${entries}\n};\n`);
  writeFileSync(pcPath, Buffer.concat([buf.slice(0, s), block, buf.slice(e)]));

  // Prune orphans so the pack never carries files the manifest dropped.
  const keep = new Set(Object.values(manifest).map(v => v.f));
  for (const f of readdirSync(LOGOS)) {
    if (f.endsWith('.png') && !keep.has(f)) unlinkSync(join(LOGOS, f));
  }
}

// ─── 7. Contact sheet — the acceptance gate ─────────────────────────────────
if (!DRY) {
  const rows = report.filter(r => r.status === 'ok').map(r => {
    const [market, ticker] = r.key.split(':');
    return `<figure><img class="big" src="./${manifest[r.key].f}" alt=""><img class="sm" src="./${manifest[r.key].f}" alt="">
      <figcaption><b>${ticker}</b> <span class="m">${market}</span><br><span class="v">${r.via} · ${r.lookup} · ${r.why}</span></figcaption></figure>`;
  }).join('\n');
  writeFileSync(join(LOGOS, 'contact-sheet.html'), `<!doctype html><meta charset="utf-8">
<title>Logo pack — review</title>
<style>body{background:#09090b;color:#fafafa;font:14px system-ui;padding:24px}
h1{font-size:18px;margin:0 0 4px}p{color:#a1a1aa;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}
figure{background:#18181b;border:1px solid #27272a;border-radius:12px;padding:12px;margin:0;text-align:center}
img{background:#fff;border-radius:8px;object-fit:contain}
.big{width:72px;height:72px}.sm{width:34px;height:34px;margin-left:8px;vertical-align:bottom}
figcaption{margin-top:8px;font-size:12px}.m{color:#71717a}.v{color:#71717a;font-size:10px}</style>
<h1>Logo pack — ${Object.keys(manifest).length} marks</h1>
<p>Check every mark against its ticker. A wrong-company logo returns HTTP 200 and passes every automated check — this page is the only thing that catches it.</p>
<div class="grid">${rows}</div>`);
}

// ─── 8. Summary ─────────────────────────────────────────────────────────────
const byStatus = {};
for (const r of report) (byStatus[r.status] ||= []).push(r);
for (const s of ['ok', 'reject', 'miss', 'monogram']) {
  console.log(`\n${s.toUpperCase()} (${(byStatus[s] || []).length})`);
  for (const r of (byStatus[s] || []).slice(0, 200)) {
    console.log('  ', r.key.padEnd(16), (r.via || '').padEnd(22), r.why || '');
  }
}
console.log(`\n${DRY ? 'DRY RUN — nothing written' : `wrote ${Object.keys(manifest).length} logos`}`);
// Fail loudly if a non-US market ever resolved through a bare ticker.
const illegal = report.filter(r => r.status === 'ok' && r.lookup === 'ticker' && !r.key.startsWith('US:'));
if (illegal.length) {
  console.error('\nFATAL: bare-ticker lookups outside US:', illegal.map(r => r.key).join(', '));
  process.exit(1);
}
```

- [ ] **Step 2: Add the manifest markers to `pb-content.js`**

Insert immediately before the final `return { … };` line:

```javascript
// Instrument logo pack. GENERATED — do not hand-edit; run `node tools/build-logos.mjs`.
// Keys are `MARKET:TICKER`. `f` = filename under ./logos/, `b` = bleed (art is
// its own tile), `k` = needs a white backing. No flag = plain, no tile.
// <<< LOGO_MANIFEST_START
const LOGO_MANIFEST = {};
// <<< LOGO_MANIFEST_END

// Market-scoped so `SOL` cannot resolve Sasol art for Solana (see the logo spec).
function logoFor(ticker, market) {
  if (!ticker || !market) return null;
  return LOGO_MANIFEST[market + ':' + ticker] || null;
}
```

Then add `LOGO_MANIFEST, logoFor` to the returned object on the final `return { … };` line.

- [ ] **Step 3: Add `logos/` handling to `.gitignore`**

Append to `.gitignore`:

```
logos/contact-sheet.html
```

The PNGs themselves **are** committed — they are the pack.

- [ ] **Step 4: Dry-run and read the report**

Run: `node tools/build-logos.mjs --dry-run`
Expected: a summary showing US and US-ETF near-100%, JSE resolving via `parqet-isin`, `CRYPTO` via `cryptocurrency-icons`, and SA ETFs via `issuer` or falling through to no-art. **No row may show source `fmp` or `parqet` with key `ticker` for a non-US market.**

- [ ] **Step 5: Build for real**

Run: `node tools/build-logos.mjs`
Expected: `logos/` populated, `pb-content.js` manifest rewritten, contact sheet emitted.

- [ ] **Step 6: Verify the manifest splice did not corrupt the file**

Run:

```bash
node --check pb-content.js
node -e "const c=require('./pb-content.js');console.log('entries:',Object.keys(c.LOGO_MANIFEST).length);console.log('SOL/JSE:',c.logoFor('SOL','JSE'));console.log('SOL/CRYPTO:',c.logoFor('SOL','CRYPTO'));"
```

Expected: parses; a non-zero entry count; and the two `SOL` lookups return **different** filenames (or one returns `null`) — never the same file.

- [ ] **Step 7: REVIEW THE CONTACT SHEET — the acceptance gate**

Open `logos/contact-sheet.html` in a browser and check **every** entry: does the mark match the company name beside it?

This is the only mechanism that catches a wrong-company logo. No status code, byte size, or hash check finds them. Known traps already caught by eye: `MTN`→Vail Resorts, `SOL`→ReneSola, `NPN`→wrong mark via the ticker path.

Any mismatch: add or correct the ISIN in `tools/logo-sources.mjs` and re-run. **Do not proceed to Task 5 with an unreviewed sheet.**

- [ ] **Step 8: Re-assert the anti-drift guard against the REAL orchestrator**

Task 3's anti-drift test ran against a near-empty stub, so it passed vacuously. Now that `tools/build-logos.mjs` is real, the guard is meaningful for the first time.

Run: `node backend/test/logo-collisions.test.mjs`
Expected: PASS — and specifically the `anti-drift` test now proves the real orchestrator builds no ticker-keyed URL of its own. Paste the output into the task report; a reviewer must be able to see this ran against the filled-in file, not the stub.

- [ ] **Step 9: Commit**

```bash
git add tools/build-logos.mjs pb-content.js logos .gitignore
git commit -m "feat(logos): build the instrument logo pack"
```

---

### Task 5: Manifest integrity test

**Files:**
- Create: `backend/test/logo-manifest.test.mjs`

**Interfaces:**
- Consumes: `LOGO_MANIFEST`, `logoFor` from `pb-content.js` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Write the test**

```javascript
// Manifest ↔ filesystem integrity for the logo pack.
//
// The manifest is generated, so the failure mode is drift: a PNG deleted but
// still listed (broken image in a row), or written but unlisted (dead weight in
// the deploy). Both are caught here. The quality gate is re-asserted from the
// committed bytes so a hand-edit cannot smuggle a 16x16 favicon into the pack.
import assert from 'node:assert';
import { test } from 'node:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { analysePng } from '../../tools/png-analyse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOGOS = join(ROOT, 'logos');
// pb-content.js is a dual-mode classic script (CommonJS branch for Node tests),
// so it is loaded through createRequire rather than `import`.
const { LOGO_MANIFEST, logoFor } = createRequire(import.meta.url)(join(ROOT, 'pb-content.js'));

const onDisk = existsSync(LOGOS)
  ? readdirSync(LOGOS).filter(f => f.endsWith('.png'))
  : [];

test('every manifest entry has a file on disk', () => {
  for (const [key, v] of Object.entries(LOGO_MANIFEST)) {
    assert.ok(existsSync(join(LOGOS, v.f)), `${key} → missing file ${v.f}`);
  }
});

test('every PNG on disk is listed in the manifest', () => {
  const listed = new Set(Object.values(LOGO_MANIFEST).map(v => v.f));
  for (const f of onDisk) {
    assert.ok(listed.has(f), `${f} is deployed but unlisted — dead weight`);
  }
});

test('manifest keys are MARKET:TICKER', () => {
  for (const key of Object.keys(LOGO_MANIFEST)) {
    assert.match(key, /^[A-Z]+:[A-Za-z0-9^.\-]+$/, `malformed manifest key: ${key}`);
  }
});

test('every committed logo clears the quality gate', () => {
  for (const [key, v] of Object.entries(LOGO_MANIFEST)) {
    const a = analysePng(readFileSync(join(LOGOS, v.f)));
    assert.ok(a, `${key}: ${v.f} is not a readable PNG`);
    assert.ok(a.w >= 64 && a.h >= 64, `${key}: ${a.w}x${a.h} is below the 64px floor`);
    assert.ok(a.alphaCoverage >= 0.12, `${key}: ${a.alphaCoverage} ink is too sparse to read at 34px`);
  }
});

test('manifest flags agree with the committed bytes', () => {
  for (const [key, v] of Object.entries(LOGO_MANIFEST)) {
    const a = analysePng(readFileSync(join(LOGOS, v.f)));
    assert.strictEqual(!!v.b, a.bleed, `${key}: bleed flag disagrees with the art`);
    assert.strictEqual(!!v.k, a.needsBacking, `${key}: needsBacking flag disagrees with the art`);
  }
});

test('logoFor is market-scoped and returns null for unknowns', () => {
  assert.strictEqual(logoFor('DEFINITELYNOTATICKER', 'US'), null);
  assert.strictEqual(logoFor('AAPL', null), null);
  assert.strictEqual(logoFor(null, 'US'), null);
});
```

- [ ] **Step 2: Run the test**

Run: `node backend/test/logo-manifest.test.mjs`
Expected: PASS — 6 tests. A failure here means the pack and the manifest have drifted; re-run `node tools/build-logos.mjs`.

- [ ] **Step 3: Run the whole suite**

Run: `for f in backend/test/*.test.mjs; do node "$f" || break; done`
Expected: all green. Suite count rises 33 → 36.

- [ ] **Step 4: Commit** 

```bash
git add backend/test/logo-manifest.test.mjs
git commit -m "test(logos): manifest ↔ filesystem integrity + quality gate"
```

---

### Task 6: The `LogoMark` component and its styles

**Files:**
- Modify: `pb-views.js` (add `LogoMark` near `HoldingRow`, ~line 2242)
- Modify: `styles.css`

**Interfaces:**
- Consumes: `PBContent.logoFor` (Task 4).
- Produces: `LogoMark({ ticker, market })` — a React element. Pure: no state, no effects, no refs. Not added to `window.PBViews` or `window.PBApp` (both consumers are in this file).

- [ ] **Step 1: Add the module-global binding**

At the top of `pb-views.js`, beside the other `PBContent` binds (~line 22), add:

```javascript
// PBContent module global for the instrument logo pack.
const logoFor = PBContent.logoFor;
```

- [ ] **Step 2: Write `LogoMark`**

Insert immediately above `const HoldingRow = React.memo(...)`:

```javascript
// ─── Instrument logo ─────────────────────────────────────────────────────────
// The mark shown beside a holding/watchlist name. Pure in (ticker, market) —
// no state, no effects — so HoldingRow's React.memo still skips unchanged rows.
//
// Four states, decided at build time by tools/build-logos.mjs and baked into
// PBContent.LOGO_MANIFEST:
//   b (bleed)       — opaque, bright art that IS the tile; fills it edge to edge
//   k (needsBacking)— dark or sparse art; gets the white tile behind it
//   neither         — bright transparent art; floats on the surface, no tile
//   no entry        — monogram, deterministic hue per ticker
// The white tile is what makes the set coherent: the sources return three
// incompatible kinds of art (see the logo spec, §1 Claim C).
function logoHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
function LogoMark(_refLM) {
  const { ticker, market } = _refLM;
  const hit = logoFor(ticker, market);
  if (!hit) {
    // Fund codes (STX40, SYGWD) read better on three characters than two.
    const label = /^[A-Z]{3,}\d/.test(ticker) ? ticker.slice(0, 3) : String(ticker).slice(0, 2);
    return React.createElement("span", {
      className: "pb-logo pb-logo-mono", style: { '--logo-h': logoHue(String(ticker)) },
      "aria-hidden": "true"
    }, React.createElement("span", null, label));
  }
  const cls = "pb-logo" + (hit.b ? " pb-logo-bleed" : hit.k ? " pb-logo-backed" : " pb-logo-plain");
  return React.createElement("span", { className: cls, "aria-hidden": "true" },
    React.createElement("img", {
      src: "./logos/" + hit.f, alt: "", width: 34, height: 34,
      loading: "lazy", decoding: "async",
      // A file that 404s must not leave a broken-image glyph in the row.
      onError: e => { e.target.style.display = 'none'; }
    }));
}
```

- [ ] **Step 3: Add the styles**

Append to `styles.css`:

```css
/* ─── Instrument logos ──────────────────────────────────────────────────────
   One 34px box in four states. The white tile is not decoration: the logo
   sources return opaque-on-white, bright-transparent, and near-black-transparent
   art, and only a light ground renders all three legibly. */
.pb-logo {
  flex: 0 0 auto; width: 34px; height: 34px;
  border-radius: 9.5px; overflow: hidden;
  display: grid; place-items: center; position: relative;
}
.pb-logo img { width: 100%; height: 100%; object-fit: contain; display: block; }
.pb-logo-bleed { background: #fff; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.08); }
.pb-logo-backed { background: #fff; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.08); }
.pb-logo-backed img { padding: 2px; }
.pb-logo-plain { background: transparent; }
.pb-logo-plain img { padding: 1px; }

/* Monogram fallback — deterministic hue per ticker, so a symbol keeps its
   colour for good. Tokenised because the light theme needs a genuinely
   different tint: a 94%-light chip is invisible on a white card. */
:root, :root[data-theme="dark"] {
  --logo-mono-bg: hsl(var(--logo-h) 42% 17%);
  --logo-mono-ring: hsl(var(--logo-h) 40% 30%);
  --logo-mono-ink: hsl(var(--logo-h) 78% 72%);
}
:root[data-theme="light"] {
  --logo-mono-bg: hsl(var(--logo-h) 58% 88%);
  --logo-mono-ring: hsl(var(--logo-h) 42% 70%);
  --logo-mono-ink: hsl(var(--logo-h) 60% 28%);
}
.pb-logo-mono { background: var(--logo-mono-bg); box-shadow: inset 0 0 0 1px var(--logo-mono-ring); }
.pb-logo-mono > span {
  font-family: var(--mono); font-weight: 700; font-size: 12px;
  letter-spacing: -0.02em; color: var(--logo-mono-ink); line-height: 1;
}
```

- [ ] **Step 4: Verify the light-theme monogram is actually visible**

This is the defect the design mockup exposed — a 94%-light chip disappears on the light theme's white card, leaving what looks like stray floating text.

Run `npx serve .`, open the app, switch to the light theme in Settings, and find a monogram row (any SA ETF, e.g. `STX40`). Confirm the chip has a **visible tint and a visible ring** against the card. If it does not, deepen `--logo-mono-bg` and `--logo-mono-ring` until it does.

- [ ] **Step 5: Commit** 

```bash
git add pb-views.js styles.css
git commit -m "feat(logos): LogoMark component + adaptive tile styles"
```

---

### Task 7: Wire the mark into both views

**Files:**
- Modify: `pb-views.js` — `HoldingRow` (~line 2274) and the watchlist card (~line 3244)
- Modify: `styles.css`

**Interfaces:**
- Consumes: `LogoMark` (Task 6).
- Produces: the rendered feature.

- [ ] **Step 1: Restructure the holding row's left zone**

`HoldingRow` currently renders `row-main` as a plain container of two divs. Wrap the text in its own element so the mark can sit beside it. Replace:

```javascript
    React.createElement("div", { className: "row-main" },
      React.createElement("div", { className: "hold-id" },
        React.createElement("span", { className: "hold-tkr-main" }, mainLabel),
        React.createElement("span", { className: "mkt-badge" }, isUT ? "fund" : market)),
      React.createElement("div", { className: "row-meta" },
        (hasName && !isUT) ? React.createElement("span", { className: "hold-co-name" }, name) : null)),
```

with:

```javascript
    React.createElement("div", { className: "row-main" },
      React.createElement(LogoMark, { ticker: p.ticker, market: market }),
      React.createElement("div", { className: "hold-txt" },
        React.createElement("div", { className: "hold-id" },
          React.createElement("span", { className: "hold-tkr-main" }, mainLabel),
          React.createElement("span", { className: "mkt-badge" }, isUT ? "fund" : market)),
        React.createElement("div", { className: "row-meta" },
          (hasName && !isUT) ? React.createElement("span", { className: "hold-co-name" }, name) : null))),
```

- [ ] **Step 2: Restructure the watchlist card's head**

In `WatchlistView`, replace:

```javascript
              React.createElement("div", { className: "flex-1" },
                React.createElement("div", { className: "flex items-center gap-2" },
                  React.createElement("span", { className: "tkr" }, w.ticker),
```

with:

```javascript
              React.createElement("div", { className: "flex-1 wl-id" },
                React.createElement(LogoMark, { ticker: w.ticker, market: w.market }),
                React.createElement("div", { className: "wl-idtxt" },
                React.createElement("div", { className: "flex items-center gap-2" },
                  React.createElement("span", { className: "tkr" }, w.ticker),
```

and close the extra `div` by changing the line that currently reads:

```javascript
                displayName ? React.createElement("div", { className: "tkr-name" }, displayName) : null),
```

to:

```javascript
                displayName ? React.createElement("div", { className: "tkr-name" }, displayName) : null)),
```

- [ ] **Step 3: Add the layout styles**

Append to `styles.css`:

```css
/* The mark sits beside the two-line ticker/name block in both lists. */
.holding-row .row-main { display: flex; align-items: center; gap: 11px; }
.hold-txt { min-width: 0; flex: 1 1 auto; }
.wl-id { display: flex; align-items: center; gap: 11px; min-width: 0; }
.wl-idtxt { min-width: 0; }
```

- [ ] **Step 4: Syntax check**

Run: `node --check pb-views.js`
Expected: no output. A mismatched paren from Step 2 shows up here.

Note: `node --check` passing does **not** mean the app works — see Step 5.

- [ ] **Step 5: Run the mount gate**

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: PASS. This is the gate that catches an extraction/binding error; Node suites never load the view bucket.

- [ ] **Step 6: Run the watchlist smoke**

Run: `node backend/test/verify-watchlist.mjs`
Expected: PASS.

- [ ] **Step 7: Look at it**

Run `npx serve .`, open Holdings and Watchlist. Confirm: marks align with the text block, rows have not changed height, long names still ellipsise, and no row shows a broken-image glyph. Check both themes.

- [ ] **Step 8: Commit** 

```bash
git add pb-views.js styles.css
git commit -m "feat(logos): show instrument marks in Holdings + Watchlist"
```

---

### Task 8: Service worker, deploy wiring, and the full gate

**Files:**
- Modify: `sw.js`
- Modify: `.github/workflows/static.yml`

**Interfaces:**
- Consumes: `logos/` (Task 4).
- Produces: the deployable app.

- [ ] **Step 1: Add the logo cache to `sw.js`**

Change line 2–3 from:

```javascript
const CACHE_NAME   = 'playbook-shell-v89';
const CDN_CACHE    = 'playbook-cdn-v1';
```

to:

```javascript
const CACHE_NAME   = 'playbook-shell-v90';
const CDN_CACHE    = 'playbook-cdn-v1';
// Instrument logos: immutable per filename, so cache-first. Bumped only when
// the pack is rebuilt. Deliberately NOT in SHELL_ASSETS — cache.addAll is
// atomic, so one bad file there would fail the entire SW install.
const LOGO_CACHE   = 'playbook-logos-v1';
```

- [ ] **Step 2: Keep the logo cache across activation**

In the `activate` handler, change:

```javascript
          .filter(k => k !== CACHE_NAME && k !== CDN_CACHE)
```

to:

```javascript
          .filter(k => k !== CACHE_NAME && k !== CDN_CACHE && k !== LOGO_CACHE)
```

Without this the logo cache is deleted on every activation and every logo is refetched.

- [ ] **Step 3: Add the cache-first branch**

In the `fetch` handler, insert this **before** the existing same-origin block (the one that calls `networkFirst`). Order matters: after it, logos would hit the network on every load.

```javascript
  // Logos are content-stable per filename → cache-first, so a scrolled list
  // never refetches. Must precede the same-origin network-first rule below.
  if (url.origin === self.location.origin && url.pathname.includes('/logos/')) {
    e.respondWith(cacheFirst(request, LOGO_CACHE));
    return;
  }
```

Then add the strategy beside `networkFirst`:

```javascript
function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    }).catch(() => cached))
  );
}
```

- [ ] **Step 4: Add `logos/` to the deploy**

In `.github/workflows/static.yml`, after the line `cp -r brand _site/`, add:

```bash
          cp -r logos _site/
```

And in the Guard-1 loop, add a sentinel to the file list so a missing pack fails the deploy. Change:

```bash
                   brand/favicon.svg brand/apple-touch-icon.png; do
```

to:

```bash
                   brand/favicon.svg brand/apple-touch-icon.png \
                   logos/US-AAPL.png; do
```

If `US-AAPL.png` is not in the built pack, substitute any filename the manifest actually contains — confirm with `ls logos | head`.

- [ ] **Step 5: Verify the contact sheet is not deployed**

Run: `rg -n "contact-sheet" .github/workflows/static.yml || echo "not referenced — good"`

The workflow copies `logos/` wholesale, so confirm the sheet is absent from the working tree at deploy time, or have the build write it to the scratchpad instead. It is git-ignored (Task 4 Step 3), so a clean checkout in CI will not contain it — verify with `git status --porcelain logos/`.

- [ ] **Step 6: Run the full unit suite**

Run: `for f in backend/test/*.test.mjs; do node "$f" || break; done`
Expected: all green, 36 files.

- [ ] **Step 7: Run the MONEY GATE**

Run:

```bash
node backend/test/money-math.test.mjs
node backend/test/cost-basis.test.mjs
node backend/test/import-matching.test.mjs
node backend/test/ee-ocr-parse.test.mjs
node backend/test/fx-providers.test.mjs
```

Expected: all green. This feature does not touch money code, so any failure here means something unrelated broke and must be understood before proceeding.

- [ ] **Step 8: Run the reliable browser smokes**

Run:

```bash
node backend/test/verify-refresh-behavior.mjs
node backend/test/verify-watchlist.mjs
node backend/test/verify-settings.mjs
```

Expected: all PASS.

- [ ] **Step 9: Prove rule #5 — the backup blob is unchanged**

The feature must add no durable state. Run:

```bash
node -e "
const fs=require('fs');
const src=fs.readFileSync('pb-views.js','utf8');
const bad=[...src.matchAll(/localStorage|usePersistedState|useSetting\(|setCollection\(/g)]
  .filter(m=>{const i=m.index;const w=src.slice(Math.max(0,i-400),i);return /LogoMark|logoFor|logoHue/.test(w);});
console.log('logo code touching persistence:', bad.length);
"
```

Expected: `0`. Then confirm no new key: `rg -n "pb\.logo" . --glob '!node_modules'` should return nothing.

- [ ] **Step 10: Commit** 

```bash
git add sw.js .github/workflows/static.yml
git commit -m "feat(logos): cache-first logo serving + deploy wiring (v90)"
```

---

## Definition of done

- [ ] Contact sheet reviewed end to end; every mark matches its company name.
- [ ] `logos/` committed; manifest regenerated; `node --check pb-content.js` clean.
- [ ] 36 unit test files green, including the three new ones.
- [ ] MONEY GATE green.
- [ ] `verify-refresh-behavior`, `verify-watchlist`, `verify-settings` PASS.
- [ ] Both themes checked by eye, including a monogram row in the light theme.
- [ ] `CACHE_NAME` = `playbook-shell-v90`; `LOGO_CACHE` in the activate keep-list; logos absent from `SHELL_ASSETS`.
- [ ] `static.yml` copies `logos/` and guards a sentinel file.
- [ ] No new `pb.*` key; no `PBApp` bridge change (still 38 members).
- [ ] Nothing committed or pushed without Jan asking.
