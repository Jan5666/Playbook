// Tile composition for the logo pack.
//
// The pack's look is one rule: EVERY mark is a full-bleed square tile. The app
// rounds it with a single CSS radius, so uniformity is structural rather than
// something each mark has to happen to get right. Art that already IS a tile is
// passed through untouched; art that is a bare symbol gets a ground built from
// its own brand colour.
//
// What went wrong before this module existed: normalise() square-padded an 8%
// TRANSPARENT margin around art that was already a finished opaque tile, and the
// stylesheet painted #fff behind it — so every dark brand tile (ASML, AMZN,
// AVGO) rendered as a white frame around a smaller square. That is the "white
// box border". Measured: US-ASML.png was 297x297 with 0.743 opaque coverage,
// which is exactly 256^2/297^2.
//
// Pure Node and pure functions: the tile rules decide what the pack looks like,
// so they must be testable without a browser. Chrome only decodes (chrome-decode).
import { deflateSync } from 'node:zlib';
import { decodeRGBA, encodeRGBA, inkBox, crop, pngChunk } from './png-crop.mjs';

export const TILE = 128;          // output tile edge, in px
export const INSET = 0.68;        // symbol occupies this much of a composed tile
const PLATE_SHARE = 0.40;         // modal-colour share that means "this is a tile"
const NEUTRAL_DEEP = [0x23, 0x2a, 0x38];

// ─── colour helpers ─────────────────────────────────────────────────────────
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}
export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  if (!s) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h / 360 + 1 / 3), f(h / 360), f(h / 360 - 1 / 3)].map(v => Math.round(v * 255));
}
export const lumOf = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
export const isNearWhite = ([r, g, b]) => {
  const [, s, l] = rgbToHsl(r, g, b);
  return l > 0.90 && s < 0.14;
};
// Ground for a symbol that must read against it: a rich, deep brand colour.
export function deepen(rgb) {
  const [h, s] = rgbToHsl(...rgb);
  if (s < 0.10) return NEUTRAL_DEEP.slice();
  return hslToRgb(h, Math.min(0.92, Math.max(0.42, s)), 0.27);
}
// Ground for a multi-colour dark mark, which cannot be recoloured without
// destroying it: a soft tint of its own hue rather than a stark white square.
export function soften(rgb) {
  const [h, s] = rgbToHsl(...rgb);
  if (s < 0.10) return [0xec, 0xee, 0xf3];
  return hslToRgb(h, Math.min(0.78, Math.max(0.30, s)), 0.92);
}

// ─── measurement ────────────────────────────────────────────────────────────
// Modal opaque colour, quantised to 5 bits per channel, plus the share of the
// WHOLE canvas it covers. A solid ground is the single most common colour by a
// wide margin, so its share is what separates "this art is a tile" from "this
// art is a symbol floating on nothing".
export function colourStats(img) {
  const bins = new Map();
  let opaque = 0, lumSum = 0, satSum = 0;
  let rS = 0, gS = 0, bS = 0;
  let lumMin = Infinity, lumMax = -Infinity;
  const hueW = new Float64Array(36), hueN = new Float64Array(36);
  const hueR = new Float64Array(36), hueG = new Float64Array(36), hueB = new Float64Array(36);
  for (let i = 0, n = img.w * img.h; i < n; i++) {
    const o = i * 4;
    if (img.rgba[o + 3] < 200) continue;
    const r = img.rgba[o], g = img.rgba[o + 1], b = img.rgba[o + 2];
    opaque++; rS += r; gS += g; bS += b;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const cur = bins.get(key);
    if (cur) { cur.n++; cur.r += r; cur.g += g; cur.b += b; }
    else bins.set(key, { n: 1, r, g, b });
    const [h, s, l] = rgbToHsl(r, g, b);
    const lum = lumOf([r, g, b]);
    lumSum += lum; satSum += s;
    if (lum < lumMin) lumMin = lum;
    if (lum > lumMax) lumMax = lum;
    // Weight the hue vote by saturation: near-greys carry no brand signal, and
    // an unweighted histogram lets a large grey field elect a meaningless hue.
    if (s > 0.22 && l > 0.10 && l < 0.94) {
      const bin = Math.min(35, Math.floor(h / 10));
      hueW[bin] += s; hueN[bin] += 1;
      hueR[bin] += r; hueG[bin] += g; hueB[bin] += b;
    }
  }
  const total = img.w * img.h;
  let best = null;
  for (const v of bins.values()) if (!best || v.n > best.n) best = v;
  const modal = best ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] : [0, 0, 0];

  // Dominant hue plus how concentrated the chroma is around it (a +/-1 bin
  // window = a 30-degree arc). One tight cluster means the mark is effectively
  // one colour and can safely be redrawn in white.
  let hb = -1, hbest = 0, hsum = 0;
  for (let i = 0; i < 36; i++) { hsum += hueW[i]; if (hueW[i] > hbest) { hbest = hueW[i]; hb = i; } }
  let chroma = null, hueFocus = 0;
  if (hb >= 0 && hbest > 0) {
    // The vote is saturation-weighted, but the COLOUR is a plain mean over the
    // winning bin's pixels — hence a separate count. Dividing the RGB sums by
    // the saturation weight instead would scale the colour by 1/meanSat and
    // blow every channel past 255.
    let win = 0;
    for (let d = -1; d <= 1; d++) win += hueW[(hb + d + 36) % 36];
    hueFocus = hsum ? win / hsum : 0;
    const n = hueN[hb] || 1;
    chroma = [Math.round(hueR[hb] / n), Math.round(hueG[hb] / n), Math.round(hueB[hb] / n)];
  }
  return {
    w: img.w, h: img.h,
    opaque, coverage: total ? opaque / total : 0,
    modal, modalShare: total ? best ? best.n / total : 0 : 0,
    meanColour: opaque ? [Math.round(rS / opaque), Math.round(gS / opaque), Math.round(bS / opaque)] : [0, 0, 0],
    meanLum: opaque ? lumSum / opaque : 0,
    meanSat: opaque ? satSum / opaque : 0,
    // Spread between the darkest and lightest opaque pixel. Zero means one flat
    // colour — art with no mark on it, which renders as a blank chip.
    lumRange: opaque ? lumMax - lumMin : 0,
    chroma, hueFocus,
  };
}

// Mean number of separate ink runs per scanline — how finely divided the art is
// horizontally. This is what separates a mark from a block of type, and it is the
// measurement the "squished low quality" rejection needed: on the sampled pack
// every acceptable mark scores 1.3-3.5 (AMZN 1.7, NVDA 2.4, UNH 3.5) while the
// Capitec wordmark lockup the owner singled out scores 7.2. Aspect ratio does NOT
// separate them — UNH's ink is a 2.2:1 box too, just a tall glyph rather than a
// line of text.
export function strokeRuns(img) {
  let runs = 0, rows = 0;
  for (let y = 0; y < img.h; y++) {
    let prev = false, n = 0;
    for (let x = 0; x < img.w; x++) {
      const on = img.rgba[(y * img.w + x) * 4 + 3] > 128;
      if (on && !prev) n++;
      prev = on;
    }
    if (n) { runs += n; rows++; }
  }
  return rows ? runs / rows : 0;
}

// ─── pixel ops ──────────────────────────────────────────────────────────────
// Several sources draw the mark on a solid white square. Once that ground is
// gone the mark can sit on a brand tile like every other one.
export function knockOutWhite(img) {
  const out = Buffer.from(img.rgba);
  for (let i = 0, n = img.w * img.h; i < n; i++) {
    const o = i * 4;
    if (out[o + 3] < 8) continue;
    if (isNearWhite([out[o], out[o + 1], out[o + 2]])) out[o + 3] = 0;
  }
  return { w: img.w, h: img.h, rgba: out };
}
export function tintOpaque(img, [r, g, b]) {
  const out = Buffer.from(img.rgba);
  for (let i = 0, n = img.w * img.h; i < n; i++) {
    const o = i * 4;
    if (!out[o + 3]) continue;
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
  }
  return { w: img.w, h: img.h, rgba: out };
}

// Area-average resample. Alpha is premultiplied first: averaging straight RGBA
// pulls the (arbitrary) colour of fully transparent pixels into the edge of the
// mark, which shows up as a dark fringe around every glyph.
export function resample(img, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const sx = img.w / dw, sy = img.h / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.ceil((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.ceil((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < Math.min(y1, img.h); yy++) {
        for (let xx = x0; xx < Math.min(x1, img.w); xx++) {
          const o = (yy * img.w + xx) * 4;
          const al = img.rgba[o + 3] / 255;
          r += img.rgba[o] * al; g += img.rgba[o + 1] * al; b += img.rgba[o + 2] * al;
          a += img.rgba[o + 3]; n++;
        }
      }
      const o = (y * dw + x) * 4;
      if (!n) continue;
      const am = a / n;
      out[o + 3] = Math.round(am);
      if (am > 0) {
        const k = 255 / am;
        out[o] = Math.min(255, Math.round(r / n * k));
        out[o + 1] = Math.min(255, Math.round(g / n * k));
        out[o + 2] = Math.min(255, Math.round(b / n * k));
      }
    }
  }
  return { w: dw, h: dh, rgba: out };
}

export function solid(size, [r, g, b]) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
  }
  return { w: size, h: size, rgba };
}

// Source-over composite of `top` onto `base` at (ox, oy).
export function over(base, top, ox, oy) {
  const out = Buffer.from(base.rgba);
  for (let y = 0; y < top.h; y++) {
    const by = oy + y;
    if (by < 0 || by >= base.h) continue;
    for (let x = 0; x < top.w; x++) {
      const bx = ox + x;
      if (bx < 0 || bx >= base.w) continue;
      const s = (y * top.w + x) * 4, d = (by * base.w + bx) * 4;
      const sa = top.rgba[s + 3] / 255;
      if (!sa) continue;
      const da = out[d + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        out[d + c] = Math.round((top.rgba[s + c] * sa + out[d + c] * da * (1 - sa)) / oa);
      }
      out[d + 3] = Math.round(oa * 255);
    }
  }
  return { w: base.w, h: base.h, rgba: out };
}

// ─── the tile rule ──────────────────────────────────────────────────────────
// Returns { kind, ground, ink } describing how a piece of art becomes a tile.
// Split out from composeTile so the decision can be asserted directly in tests.
export function planTile(img) {
  const st = colourStats(img);
  // 1. The art is already a finished tile: a solid ground covering a large share
  //    of the canvas. Circles and rounded squares qualify too — the ground colour
  //    is extended into the corners, which is what makes a round coin icon and a
  //    square brand tile end up the same shape.
  //
  //    A near-WHITE ground counts. It is tempting to knock white out and invent a
  //    brand-coloured ground instead, but the two marks the owner named as the
  //    target look — UnitedHealth and NVIDIA — are a white tile and a green tile:
  //    what he rejected was a white FRAME around a smaller tile, not a white
  //    ground. Repainting UNH would replace art he asked for with art he did not.
  if (st.modalShare >= PLATE_SHARE) {
    return { kind: 'plate', ground: st.modal, ink: null, stats: st };
  }
  // 2. Everything else is a symbol. Strip any white ground, then build one.
  const bare = knockOutWhite(img);
  const box = inkBox(bare);
  const mark = box ? crop(bare, box) : bare;
  const ms = colourStats(mark);
  const base = ms.chroma || ms.meanColour;
  // A light mark already reads against a deep ground — keep its own colours.
  if (ms.meanLum >= 0.60) {
    return { kind: 'symbol', ground: deepen(base), ink: null, mark, stats: ms };
  }
  // A dark mark needs either recolouring or a light ground. Recolouring is only
  // safe when the mark is effectively one colour: flattening a multi-colour mark
  // to a silhouette destroys it (Google's G becomes a plain white ring).
  const monochrome = ms.meanSat < 0.16 || ms.hueFocus >= 0.72;
  if (monochrome) {
    return { kind: 'symbol', ground: deepen(base), ink: [255, 255, 255], mark, stats: ms };
  }
  return { kind: 'symbol', ground: soften(base), ink: null, mark, stats: ms };
}

export function composeTile(img, size = TILE) {
  const plan = planTile(img);
  const canvas = solid(size, plan.ground);
  const art = plan.kind === 'plate' ? img : plan.mark;
  if (!art || !art.w || !art.h) return { ...canvas, kind: plan.kind, ground: plan.ground };
  const budget = plan.kind === 'plate' ? size : Math.round(size * INSET);
  const k = Math.min(budget / art.w, budget / art.h);
  const dw = Math.max(1, Math.round(art.w * k)), dh = Math.max(1, Math.round(art.h * k));
  let scaled = resample(art, dw, dh);
  if (plan.ink) scaled = tintOpaque(scaled, plan.ink);
  const out = over(canvas, scaled, Math.round((size - dw) / 2), Math.round((size - dh) / 2));
  return { ...out, kind: plan.kind, ground: plan.ground, inked: !!plan.ink };
}

// ─── encoding ───────────────────────────────────────────────────────────────
// Every composed tile is fully opaque, so its alpha channel is 25% of the file
// carrying no information, and every row was being written with filter None —
// the worst choice for flat colour, where the neighbouring-pixel delta is zero
// and compresses to nothing. Encoding as colour type 2 with per-row adaptive
// filtering is lossless and cut the 1648-mark pack from 12 MB to a third of it.
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}
// `adaptive` picks a filter per row by the standard minimum-sum-of-magnitudes
// heuristic. It is a big win on gradients and a LOSS on flat brand tiles, where
// filter None leaves identical rows byte-identical and LZ77 matches them whole
// (measured: NVDA 1541 -> 2506 bytes with adaptive on). Neither mode wins
// everywhere, so tileToPng runs both and keeps the smaller file.
export function encodeRGB(w, h, rgba, adaptive = true) {
  const bpp = 3, stride = w * bpp;
  const cur = Buffer.alloc(stride);
  let prior = Buffer.alloc(stride);
  const out = Buffer.alloc(h * (stride + 1));
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = x * bpp;
      cur[d] = rgba[s]; cur[d + 1] = rgba[s + 1]; cur[d + 2] = rgba[s + 2];
    }
    let bestType = 0, bestScore = Infinity;
    for (let t = 0; t < (adaptive ? 5 : 1); t++) {
      const buf = cand[t];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prior[i];
        const c = i >= bpp ? prior[i - bpp] : 0;
        let v;
        if (t === 0) v = cur[i];
        else if (t === 1) v = cur[i] - a;
        else if (t === 2) v = cur[i] - b;
        else if (t === 3) v = cur[i] - ((a + b) >> 1);
        else v = cur[i] - paeth(a, b, c);
        v &= 0xff;
        buf[i] = v;
        score += v < 128 ? v : 256 - v;   // signed magnitude
      }
      if (score < bestScore) { bestScore = score; bestType = t; }
    }
    out[y * (stride + 1)] = bestType;
    cand[bestType].copy(out, y * (stride + 1) + 1);
    prior = Buffer.from(cur);   // filters reference the UNfiltered previous row
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(out, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function tileToPng(tile) {
  // Guarded rather than assumed: a tile that somehow carried transparency would
  // silently lose it to colour type 2, which is exactly the class of bug this
  // pack already shipped once.
  if (colourStats(tile).coverage !== 1) return encodeRGBA(tile.w, tile.h, tile.rgba);
  const a = encodeRGB(tile.w, tile.h, tile.rgba, true);
  const b = encodeRGB(tile.w, tile.h, tile.rgba, false);
  return a.length <= b.length ? a : b;
}
export { decodeRGBA };
