// The tile rules — what the logo pack LOOKS like.
//
// The pack was rejected for four things, and every one of them is a rule in
// tools/png-raster.mjs rather than a property of any individual mark:
//   1. white frames around dark brand tiles  -> composeTile always fills the canvas
//   2. square vs rounded marks side by side  -> every tile is square and full-bleed
//   3. an illegible "squished" wordmark      -> strokeRuns separates a mark from type
//   4. one style per mark instead of a pack  -> one plan function decides for all
// These are pinned here so a rebuild cannot regress them silently. The pack
// itself is asserted from the committed bytes in logo-manifest.test.mjs.
import assert from 'node:assert';
import { test } from 'node:test';
import {
  rgbToHsl, hslToRgb, lumOf, isNearWhite, deepen, soften,
  colourStats, knockOutWhite, tintOpaque, strokeRuns,
  resample, solid, over, planTile, composeTile, borderRing, TILE,
} from '../../tools/png-raster.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────
// A bare RGBA surface; the pipeline's own type, so no PNG round-trip is needed.
function surface(w, h, fn) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y) || [0, 0, 0, 0];
      const o = (y * w + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return { w, h, rgba };
}
const px = (img, x, y) => {
  const o = (y * img.w + x) * 4;
  return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3]];
};
// A filled disc on transparent — the shape every crypto coin icon arrives as.
const disc = (size, colour, glyph) => surface(size, size, (x, y) => {
  const r = size / 2, dx = x - r + 0.5, dy = y - r + 0.5;
  if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
  if (glyph && Math.abs(dx) < size * 0.12 && Math.abs(dy) < size * 0.3) return [255, 255, 255, 255];
  return [...colour, 255];
});

// ─── colour maths ───────────────────────────────────────────────────────────
test('rgb -> hsl -> rgb round-trips', () => {
  for (const c of [[220, 38, 38], [118, 185, 0], [12, 35, 80], [128, 128, 128], [0, 0, 0], [255, 255, 255]]) {
    assert.deepStrictEqual(hslToRgb(...rgbToHsl(...c)), c, `round trip failed for ${c}`);
  }
});

test('isNearWhite accepts off-whites and rejects pale brand colours', () => {
  assert.ok(isNearWhite([255, 255, 255]));
  assert.ok(isNearWhite([246, 246, 248]));
  assert.ok(!isNearWhite([12, 35, 80]));
  assert.ok(!isNearWhite([255, 214, 214]), 'a pale red is a colour, not a white ground');
});

test('deepen produces a dark, saturated ground and keeps the hue', () => {
  const g = deepen([118, 185, 0]);           // NVIDIA green
  const [h, s, l] = rgbToHsl(...g);
  assert.ok(Math.abs(h - rgbToHsl(118, 185, 0)[0]) < 2, 'hue drifted');
  assert.ok(l > 0.2 && l < 0.35, `lightness ${l} is not a deep ground`);
  assert.ok(s >= 0.42, `saturation ${s} is washed out`);
});

test('deepen falls back to a neutral for greys rather than inventing a hue', () => {
  // A grey has an undefined hue, which reads as 0 — i.e. red. Shipping a red
  // tile for a black wordmark would be a fabricated brand colour.
  const g = deepen([90, 90, 92]);
  assert.ok(rgbToHsl(...g)[1] < 0.35, 'a grey mark produced a saturated ground');
  assert.ok(lumOf(g) < 0.3, 'the neutral ground must still be dark');
});

test('soften produces a light ground for marks that cannot be recoloured', () => {
  assert.ok(lumOf(soften([255, 153, 0])) > 0.85);
  assert.ok(lumOf(soften([90, 90, 92])) > 0.85);
});

// ─── measurement ────────────────────────────────────────────────────────────
test('colourStats reports coverage, modal colour and its share', () => {
  const s = colourStats(solid(16, [10, 20, 30]));
  assert.strictEqual(s.coverage, 1);
  assert.deepStrictEqual(s.modal, [10, 20, 30]);
  assert.strictEqual(s.modalShare, 1);
});

test('colourStats ignores transparent pixels', () => {
  const half = surface(10, 10, (x) => (x < 5 ? [200, 0, 0, 255] : [0, 0, 0, 0]));
  const s = colourStats(half);
  assert.strictEqual(s.coverage, 0.5);
  assert.deepStrictEqual(s.modal, [200, 0, 0], 'transparent pixels voted');
});

test('the dominant chroma is the brand colour, not the larger grey field', () => {
  // Two thirds grey, one third brand red. An unweighted histogram elects grey.
  const img = surface(30, 10, (x) => (x < 20 ? [130, 130, 130, 255] : [200, 30, 40, 255]));
  const s = colourStats(img);
  const [h] = rgbToHsl(...s.chroma);
  assert.ok(h < 15 || h > 345, `chroma hue ${h} is not the red the mark is branded in`);
});

test('strokeRuns separates a solid mark from a line of type', () => {
  const block = surface(40, 40, () => [0, 0, 0, 255]);
  assert.strictEqual(strokeRuns(block), 1, 'a solid block is one run per row');
  // Eight separate vertical strokes per row is what a word looks like.
  const type = surface(40, 40, (x) => (x % 5 < 2 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  assert.ok(strokeRuns(type) >= 5, `type scored ${strokeRuns(type)}, too low to be rejected`);
});

test('strokeRuns ignores empty rows rather than counting them as zero', () => {
  const img = surface(20, 20, (x, y) => (y < 5 && x < 10 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  assert.strictEqual(strokeRuns(img), 1);
});

// ─── pixel ops ──────────────────────────────────────────────────────────────
test('knockOutWhite removes a white ground and keeps the mark', () => {
  const onWhite = surface(10, 10, (x, y) => (x === y ? [200, 30, 40, 255] : [255, 255, 255, 255]));
  const bare = knockOutWhite(onWhite);
  assert.strictEqual(px(bare, 0, 5)[3], 0, 'white ground survived');
  assert.deepStrictEqual(px(bare, 5, 5), [200, 30, 40, 255], 'the mark was damaged');
});

test('tintOpaque recolours the mark and preserves its alpha', () => {
  const img = surface(4, 1, (x) => [10, 20, 30, x * 60]);
  const t = tintOpaque(img, [255, 255, 255]);
  assert.deepStrictEqual(px(t, 0, 0), [10, 20, 30, 0], 'a fully transparent pixel was tinted');
  assert.deepStrictEqual(px(t, 2, 0), [255, 255, 255, 120], 'alpha was not preserved');
});

test('resample premultiplies alpha, so edges get no dark fringe', () => {
  // Straight averaging pulls the (black) colour of the transparent pixel into
  // the result, greying the mark's edge. Premultiplied, the colour stays pure.
  const pair = surface(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  const out = resample(pair, 1, 1);
  assert.deepStrictEqual(px(out, 0, 0), [255, 0, 0, 128]);
});

test('resample leaves a flat colour exact at any size', () => {
  for (const n of [4, 16, 200]) {
    assert.deepStrictEqual(px(resample(solid(64, [10, 20, 30]), n, n), 1, 1), [10, 20, 30, 255]);
  }
});

test('over composites source-over and leaves the base where the top is clear', () => {
  const base = solid(4, [0, 0, 0]);
  const top = surface(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  const out = over(base, top, 1, 1);
  assert.deepStrictEqual(px(out, 1, 1), [255, 255, 255, 255]);
  assert.deepStrictEqual(px(out, 0, 0), [0, 0, 0, 255], 'the base was disturbed');
});

// ─── the tile rule ──────────────────────────────────────────────────────────
test('an opaque colour tile is recognised as already being a tile', () => {
  const plan = planTile(solid(64, [118, 185, 0]));
  assert.strictEqual(plan.kind, 'plate');
  assert.deepStrictEqual(plan.ground, [118, 185, 0]);
  assert.strictEqual(plan.ink, null, 'a finished tile must not be recoloured');
});

test('a WHITE tile is also a tile — UnitedHealth is the reference look', () => {
  // The owner named UnitedHealth and NVIDIA as the target: one is a white tile,
  // the other a green one. What he rejected was a white FRAME around a smaller
  // tile. Knocking the white out and inventing a brand ground would replace art
  // he asked for with art he did not.
  const unhLike = surface(64, 64, (x, y) => (x > 20 && x < 44 && y > 10 && y < 54
    ? [40, 60, 150, 255] : [255, 255, 255, 255]));
  assert.strictEqual(planTile(unhLike).kind, 'plate');
  assert.ok(isNearWhite(planTile(unhLike).ground));
});

test('a dark single-colour symbol is redrawn in white on its own brand ground', () => {
  const mark = surface(64, 64, (x, y) => (x > 24 && x < 40 && y > 8 && y < 56 ? [12, 35, 110, 255] : [0, 0, 0, 0]));
  const plan = planTile(mark);
  assert.strictEqual(plan.kind, 'symbol');
  assert.deepStrictEqual(plan.ink, [255, 255, 255], 'a dark mark on a dark ground would vanish');
  assert.ok(lumOf(plan.ground) < 0.4, 'the ground is not deep');
});

test('a light symbol keeps its own colours on a deep ground', () => {
  const mark = surface(64, 64, (x, y) => (x > 20 && x < 44 && y > 20 && y < 44 ? [250, 230, 90, 255] : [0, 0, 0, 0]));
  const plan = planTile(mark);
  assert.strictEqual(plan.ink, null, 'a light mark already reads — recolouring it destroys the brand');
  assert.ok(lumOf(plan.ground) < 0.45);
});

test('a multi-colour dark mark gets a light ground instead of being flattened', () => {
  // Flattening a multi-colour mark to a white silhouette destroys it (Google's
  // G becomes a plain ring), so this path trades the deep ground away instead.
  const mark = surface(64, 64, (x, y) => {
    if (x < 16 || x > 48 || y < 16 || y > 48) return [0, 0, 0, 0];
    if (x < 26) return [200, 30, 40, 255];
    if (x < 36) return [30, 120, 60, 255];
    return [40, 60, 190, 255];
  });
  const plan = planTile(mark);
  assert.strictEqual(plan.ink, null, 'a multi-colour mark was flattened to a silhouette');
  assert.ok(lumOf(plan.ground) > 0.8, 'a dark multi-colour mark needs a light ground to read');
});

// ─── composition: the invariants the look depends on ────────────────────────
test('every composed tile is square, exactly TILE across, and fully opaque', () => {
  const cases = {
    'colour plate': solid(64, [10, 90, 200]),
    'white plate': surface(64, 64, (x, y) => (x > 24 && x < 40 ? [0, 0, 0, 255] : [255, 255, 255, 255])),
    'transparent symbol': surface(64, 64, (x, y) => (x > 24 && x < 40 && y > 8 && y < 56 ? [12, 35, 110, 255] : [0, 0, 0, 0])),
    'coin disc': disc(64, [240, 150, 20], true),
    'wide mark': surface(120, 40, (x, y) => (y > 8 && y < 32 ? [200, 30, 40, 255] : [0, 0, 0, 0])),
    'tall mark': surface(40, 120, (x, y) => (x > 8 && x < 32 ? [200, 30, 40, 255] : [0, 0, 0, 0])),
  };
  for (const [name, art] of Object.entries(cases)) {
    const t = composeTile(art, TILE);
    assert.strictEqual(t.w, TILE, `${name}: width`);
    assert.strictEqual(t.h, TILE, `${name}: height`);
    const s = colourStats(t);
    assert.strictEqual(s.coverage, 1,
      `${name}: coverage ${s.coverage} — any transparent pixel lets the page behind show as a frame`);
  }
});

test('a coin disc becomes a full-bleed tile — the corners take its own colour', () => {
  // Round art in a square box is exactly the "some square, some rounded" defect:
  // the corners fell outside the art, so the CSS radius had nothing to clip and
  // the coin read as a circle beside a row of squares.
  const t = composeTile(disc(64, [240, 150, 20], true), 64);
  for (const [x, y] of [[0, 0], [63, 0], [0, 63], [63, 63]]) {
    assert.deepStrictEqual(px(t, x, y), [240, 150, 20, 255], `corner ${x},${y} is not the coin's own colour`);
  }
});

test('a finished tile is passed through without a margin being added', () => {
  // The exact regression: normalise() cropped and then square-padded an 8%
  // TRANSPARENT margin around art that was already an opaque tile, and the
  // stylesheet painted #fff into it. Measured on the shipped pack, US-ASML.png
  // was 297x297 at 0.743 coverage — precisely 256^2/297^2.
  const t = composeTile(solid(96, [18, 52, 140]), 64);
  for (const [x, y] of [[0, 0], [63, 0], [0, 63], [63, 63], [32, 0], [0, 32]]) {
    assert.deepStrictEqual(px(t, x, y), [18, 52, 140, 255], `edge ${x},${y} lost the tile's colour`);
  }
});

test('a wide mark is centred, never stretched', () => {
  // Kept sparse enough (20% of the canvas) to be read as a symbol rather than a
  // plate: a flat colour covering most of its canvas IS a tile, and tiles are
  // passed through rather than inset.
  const t = composeTile(surface(120, 40, (x, y) => (y > 15 && y < 24 ? [200, 30, 40, 255] : [0, 0, 0, 0])), 64);
  // The mark is dark and single-hued, so it is drawn in white on a deep ground:
  // count white pixels, not red ones (red is the GROUND's channel too).
  const inkInRow = (y) => { let n = 0; for (let x = 0; x < 64; x++) if (lumOf(px(t, x, y)) > 0.9) n++; return n; };
  // A stretch would fill the full height; centred, the top rows stay ground.
  assert.strictEqual(inkInRow(1), 0, 'the mark reached the top edge — it was stretched');
  assert.ok(inkInRow(32) > 20, `the mark is missing from the centre row (${inkInRow(32)} px)`);
});

// ─── a gradient ground is still a finished tile ─────────────────────────────
// Regression pin for the blank-white-square bug (2026-07-28). The TradingView
// source ships many marks on a dark GRADIENT ground. A gradient has no modal
// colour, so `modalShare` never reached PLATE_SHARE, the art fell through to
// the symbol branch, and an opaque full-canvas image was measured as one giant
// mark and flattened to a solid white silhouette. Anglo American and Naspers
// both shipped as plain white squares.
const gradientTile = (size, glyph) => surface(size, size, (x, y) => {
  // A diagonal charcoal ramp, the shape TradingView's dark tiles use.
  const t = (x + y) / (2 * size);
  const v = Math.round(42 - 30 * t);
  if (glyph && x > size * 0.3 && x < size * 0.7 && y > size * 0.3 && y < size * 0.7) {
    return [30, 120, 240, 255];
  }
  return [v, v + 4, v + 7, 255];
});

test('borderRing sees an opaque, gently-varying edge as a filled canvas', () => {
  const r = borderRing(gradientTile(64, true));
  assert.strictEqual(r.opaqueShare, 1, 'a full-bleed tile has a fully opaque edge');
  assert.ok(r.lumRange < 0.22, `a gradient edge drifts gently, got ${r.lumRange.toFixed(3)}`);
});

test('borderRing does NOT see a symbol on transparency as a filled canvas', () => {
  // The discriminator that keeps this rule from swallowing real symbols.
  const floating = surface(64, 64, (x, y) => (
    x > 20 && x < 44 && y > 20 && y < 44 ? [200, 30, 30, 255] : [0, 0, 0, 0]
  ));
  assert.ok(borderRing(floating).opaqueShare < 0.98, 'a floating mark must not read as a plate');
});

test('a mark on a GRADIENT ground is passed through, not flattened to a silhouette', () => {
  const plan = planTile(gradientTile(64, true));
  assert.strictEqual(plan.kind, 'plate', 'a gradient-ground tile must plan as a plate');
  assert.strictEqual(plan.ink, null, 'a plate is never re-inked — that is what erased the mark');
});

test('the gradient tile keeps its mark once composed', () => {
  // The bug was only visible in the OUTPUT: the plan looked plausible and the
  // tile came out uniformly white. Assert the composed tile still has contrast
  // and still carries the blue glyph.
  const tile = composeTile(gradientTile(64, true), TILE);
  const st = colourStats(tile);
  assert.ok(st.lumRange > 0.08, `composed tile is blank (lumRange ${st.lumRange.toFixed(3)})`);
  const mid = px(tile, TILE >> 1, TILE >> 1);
  assert.ok(mid[2] > mid[0], `centre should still be the blue glyph, got ${mid.join(',')}`);
});

test('a flat-ground plate is unaffected by the border rule', () => {
  // PLATE_SHARE still decides first; the border test only runs when it fails.
  const flat = surface(64, 64, (x, y) => (
    x > 24 && x < 40 && y > 24 && y < 40 ? [10, 10, 10, 255] : [240, 243, 250, 255]
  ));
  const plan = planTile(flat);
  assert.strictEqual(plan.kind, 'plate');
  assert.deepStrictEqual(plan.ground, [240, 243, 250], 'flat plates keep their modal ground');
});
