// Imaging primitives for the logo pack (tools/png-analyse.mjs, tools/png-crop.mjs).
// These decide whether a fetched logo is usable and how it is tiled, so they are
// pinned against synthetic PNGs built in-test — no network, no fixtures on disk.
import assert from 'node:assert';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { analysePng } from '../../tools/png-analyse.mjs';

// Build a real 8-bit PNG so the decoder is exercised end to end.
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

// paint(x, y) must return [r, g, b, a]. colorType: 0=gray, 2=rgb, 3=indexed, 4=grayAlpha, 6=rgba.
function makePng(w, h, paint, { colorType = 6, filter = 0, plte = null, trns = null } = {}) {
  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = CHANNELS[colorType];
  const stride = w * bpp;

  // Build unfiltered data first
  const unfiltered = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      const o = y * stride + x * bpp;

      if (colorType === 6) { // RGBA
        unfiltered[o] = r; unfiltered[o + 1] = g; unfiltered[o + 2] = b; unfiltered[o + 3] = a;
      } else if (colorType === 2) { // RGB
        unfiltered[o] = r; unfiltered[o + 1] = g; unfiltered[o + 2] = b;
      } else if (colorType === 0) { // Grayscale
        unfiltered[o] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      } else if (colorType === 4) { // Grayscale + Alpha
        unfiltered[o] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        unfiltered[o + 1] = a;
      } else if (colorType === 3) { // Indexed
        unfiltered[o] = 0; // simplified: always use first palette entry
      }
    }
  }

  // Apply filter transformation to the data
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = filter; // filter byte for this scanline
    const srcRow = unfiltered.slice(y * stride, (y + 1) * stride);
    const dstRow = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? srcRow[x - bpp] : 0;
      const b = y > 0 ? unfiltered[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? unfiltered[(y - 1) * stride + x - bpp] : 0;
      let v = srcRow[x];

      if (filter === 1) { // Sub: Paeth predictor = a
        v = (v - a) & 0xff;
      } else if (filter === 2) { // Up: Paeth predictor = b
        v = (v - b) & 0xff;
      } else if (filter === 3) { // Average: Paeth predictor = (a + b) >> 1
        v = (v - ((a + b) >> 1)) & 0xff;
      } else if (filter === 4) { // Paeth: full predictor
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        v = (v - pr) & 0xff;
      }
      // filter === 0 (None): v stays as-is
      dstRow[x] = v;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // depth
  ihdr[9] = colorType;
  ihdr[12] = 0; // interlace

  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];

  if (plte) chunks.push(chunk('PLTE', plte));
  if (trns) chunks.push(chunk('tRNS', trns));

  chunks.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })));
  chunks.push(chunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

// Helper to make palette-based PNGs (color type 3)
function makePngIndexed(w, h, paint, paletteColors = [[255, 255, 255], [0, 0, 0]]) {
  const stride = w;
  const raw = Buffer.alloc(h * (stride + 1));

  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter byte
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      // Simplified: use index 0 for opaque white, index 1 for anything else
      raw[y * (stride + 1) + 1 + x] = (r + g + b > 384) ? 0 : 1;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // depth
  ihdr[9] = 3; // indexed
  ihdr[12] = 0; // interlace

  const plte = Buffer.alloc(paletteColors.length * 3);
  for (let i = 0; i < paletteColors.length; i++) {
    plte[i * 3] = paletteColors[i][0];
    plte[i * 3 + 1] = paletteColors[i][1];
    plte[i * 3 + 2] = paletteColors[i][2];
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WHITE = () => [255, 255, 255, 255];
const BLACK_ON_CLEAR = (x, y) => (x > 20 && x < 100 && y > 20 && y < 100) ? [0, 0, 0, 255] : [0, 0, 0, 0];
const BRIGHT_ON_CLEAR = (x, y) => (x > 20 && x < 100 && y > 20 && y < 100) ? [0, 220, 120, 255] : [0, 0, 0, 0];
// Bright sparse color: high coverage isolation requires meanLum > 0.34 but alphaCoverage < 0.15
const BRIGHT_SPARSE = (x, y) => (x > 60 && x < 68 && y > 60 && y < 68) ? [255, 200, 100, 255] : [0, 0, 0, 0];
// Fully opaque dark gray (meanLum ~0.32): isolates the meanLum > 0.6 clause of bleed condition
// 60/255 ≈ 0.235 for each channel, gives meanLum ~0.235 which is below 0.34
// Use 100 instead to get ~0.39 which is above 0.34
const DARK_FULL = () => [100, 100, 100, 255];

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

test('bright sparse art needs backing only due to low coverage, not luminance', () => {
  // This isolates the coverage clause: meanLum is well above 0.34, but alphaCoverage < 0.15
  const a = analysePng(makePng(128, 128, BRIGHT_SPARSE));
  assert.ok(a.meanLum > 0.34, `coverage test requires meanLum > 0.34, got ${a.meanLum}`);
  assert.ok(a.alphaCoverage < 0.15, `expected sparse, got ${a.alphaCoverage}`);
  assert.strictEqual(a.needsBacking, true, 'coverage alone must trip needsBacking');
});

test('opaque dark art has no backing but does not bleed (luminance > 0.6 required)', () => {
  // Isolates the luminance clause of bleed: coverage > 0.9 but meanLum < 0.6
  const a = analysePng(makePng(128, 128, DARK_FULL));
  assert.ok(a.alphaCoverage > 0.9, `bleed test requires alphaCoverage > 0.9, got ${a.alphaCoverage}`);
  assert.ok(a.meanLum < 0.6, `expected dark, got ${a.meanLum}`);
  assert.strictEqual(a.needsBacking, false, 'dark opaque art is not sparse');
  assert.strictEqual(a.bleed, false, 'luminance clause must prevent bleed');
});

test('non-PNG input returns null rather than throwing', () => {
  assert.strictEqual(analysePng(Buffer.from('not a png at all')), null);
});

test('bad PNG signature returns null', () => {
  const buf = Buffer.alloc(100);
  buf[0] = 0x88; // wrong first byte
  assert.strictEqual(analysePng(buf), null);
});

test('depth !== 8 returns unsupported', () => {
  const w = 32, h = 32;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255; raw[o + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 16; // depth = 16, not 8
  ihdr[9] = 6;
  ihdr[12] = 0;

  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  const result = analysePng(buf);
  assert.strictEqual(result.unsupported, true);
  assert.strictEqual(result.w, w);
  assert.strictEqual(result.h, h);
});

test('interlace !== 0 returns unsupported', () => {
  const w = 32, h = 32;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255; raw[o + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[12] = 1; // interlace = 1 (Adam7), not 0

  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  const result = analysePng(buf);
  assert.strictEqual(result.unsupported, true);
  assert.strictEqual(result.w, w);
  assert.strictEqual(result.h, h);
});

test('color type 0 (grayscale) decodes correctly', () => {
  const a = analysePng(makePng(32, 32, WHITE, { colorType: 0 }));
  assert.strictEqual(a.w, 32);
  assert.strictEqual(a.h, 32);
  assert.strictEqual(a.alphaCoverage, 1);
  assert.ok(a.meanLum > 0.9, `grayscale white should be bright, got ${a.meanLum}`);
});

test('color type 2 (RGB) decodes correctly', () => {
  const a = analysePng(makePng(32, 32, WHITE, { colorType: 2 }));
  assert.strictEqual(a.w, 32);
  assert.strictEqual(a.h, 32);
  assert.strictEqual(a.alphaCoverage, 1);
  assert.ok(a.meanLum > 0.9, `RGB white should be bright, got ${a.meanLum}`);
});

test('color type 3 (indexed) with palette decodes correctly', () => {
  const a = analysePng(makePngIndexed(32, 32, WHITE));
  assert.strictEqual(a.w, 32);
  assert.strictEqual(a.h, 32);
  assert.strictEqual(a.alphaCoverage, 1);
});

test('color type 4 (grayscale+alpha) decodes correctly', () => {
  const a = analysePng(makePng(32, 32, BRIGHT_ON_CLEAR, { colorType: 4 }));
  assert.strictEqual(a.w, 32);
  assert.strictEqual(a.h, 32);
  assert.ok(a.alphaCoverage < 1, 'should be partially transparent');
  assert.ok(a.alphaCoverage > 0, 'should have some opaque pixels');
});

test('color type 6 (RGBA) decodes correctly', () => {
  const a = analysePng(makePng(32, 32, WHITE, { colorType: 6 }));
  assert.strictEqual(a.w, 32);
  assert.strictEqual(a.h, 32);
  assert.strictEqual(a.alphaCoverage, 1);
  assert.ok(a.meanLum > 0.9, `RGBA white should be bright, got ${a.meanLum}`);
});

test('filter 0 (None) decodes correctly', () => {
  const a = analysePng(makePng(32, 32, WHITE, { filter: 0 }));
  assert.ok(a.meanLum > 0.9, `filter 0 white should be bright, got ${a.meanLum}`);
});

test('filter 1 (Sub) decodes correctly', () => {
  const a = analysePng(makePng(32, 32, WHITE, { filter: 1 }));
  assert.ok(a.meanLum > 0.9, `filter 1 white should be bright, got ${a.meanLum}`);
});

test('filter 2 (Up) decodes correctly', () => {
  const a = analysePng(makePng(32, 32, WHITE, { filter: 2 }));
  assert.ok(a.meanLum > 0.9, `filter 2 white should be bright, got ${a.meanLum}`);
});

test('filter 3 (Average) decodes correctly', () => {
  const a = analysePng(makePng(32, 32, WHITE, { filter: 3 }));
  assert.ok(a.meanLum > 0.9, `filter 3 white should be bright, got ${a.meanLum}`);
});

test('filter 4 (Paeth) decodes correctly', () => {
  const a = analysePng(makePng(32, 32, WHITE, { filter: 4 }));
  assert.ok(a.meanLum > 0.9, `filter 4 white should be bright, got ${a.meanLum}`);
});

test('indexed PNG without PLTE returns unsupported', () => {
  const w = 32, h = 32;
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) {
      raw[y * (w + 1) + 1 + x] = 0;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 3; // indexed without PLTE
  ihdr[12] = 0;

  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  const result = analysePng(buf);
  assert.strictEqual(result.unsupported, true);
});

test('short IDAT buffer returns unsupported', () => {
  // Create a PNG IDAT that decompresses to fewer bytes than expected
  const w = 20, h = 20;
  // Only include data for 10 rows instead of 20
  const raw = Buffer.alloc(10 * (w * 4 + 1));
  for (let y = 0; y < 10; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255; raw[o + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); // claim 20x20
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[12] = 0;

  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), // but IDAT only has 10 rows
    chunk('IEND', Buffer.alloc(0)),
  ]);

  const result = analysePng(buf);
  assert.strictEqual(result.unsupported, true, 'short IDAT should return unsupported');
  assert.strictEqual(result.w, w);
  assert.strictEqual(result.h, h);
});

import { decodeRGBA, encodeRGBA, inkBox, crop, squarePad } from '../../tools/png-crop.mjs';

test('decode → encode round-trips pixel data exactly', () => {
  const src = makePng(16, 8, (x, y) => [x * 8, y * 8, 128, 255]);
  const img = decodeRGBA(src);
  assert.strictEqual(img.w, 16);
  assert.strictEqual(img.h, 8);
  const again = decodeRGBA(encodeRGBA(img.w, img.h, img.rgba));
  assert.deepStrictEqual(again.rgba, img.rgba);
});

// Test all five PNG scanline filters with a non-uniform gradient to ensure
// predictors are correct. Uniform fills (like WHITE) make a === b === c for every
// pixel, hiding predictor bugs. A gradient gives a !== b !== c on most pixels,
// so each predictor produces a distinct result and wrong formulas cannot round-trip.
for (const filter of [0, 1, 2, 3, 4]) {
  test(`filter ${filter} reconstructs a non-uniform gradient exactly`, () => {
    const paint = (x, y) => [(x * 11) % 256, (y * 7) % 256, (x * y) % 256, 255];
    const src = makePng(24, 24, paint, { filter });
    const img = decodeRGBA(src);
    assert.ok(img, `filter ${filter} failed to decode`);
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const o = (y * 24 + x) * 4;
        const expected = paint(x, y);
        assert.strictEqual(img.rgba[o], expected[0], `filter ${filter} R mismatch at ${x},${y}`);
        assert.strictEqual(img.rgba[o + 1], expected[1], `filter ${filter} G mismatch at ${x},${y}`);
        assert.strictEqual(img.rgba[o + 2], expected[2], `filter ${filter} B mismatch at ${x},${y}`);
        assert.strictEqual(img.rgba[o + 3], expected[3], `filter ${filter} A mismatch at ${x},${y}`);
      }
    }
  });
}

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
  const paint = (x, y) => [x * 25, y * 20, (x * y) % 256, 255];
  const img = decodeRGBA(makePng(10, 10, paint));
  const c = crop(img, { x: 4, y: 1, w: 3, h: 2 });
  assert.strictEqual(c.w, 3);
  assert.strictEqual(c.h, 2);
  // Verify full pixel content across both rows and all channels
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 3; x++) {
      const o = (y * 3 + x) * 4;
      const expected = paint(4 + x, 1 + y);
      assert.strictEqual(c.rgba[o], expected[0], `R at cropped ${x},${y}`);
      assert.strictEqual(c.rgba[o + 1], expected[1], `G at cropped ${x},${y}`);
      assert.strictEqual(c.rgba[o + 2], expected[2], `B at cropped ${x},${y}`);
      assert.strictEqual(c.rgba[o + 3], expected[3], `A at cropped ${x},${y}`);
    }
  }
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

// --- whiteOnly / lumRange: catches "white logo for dark backgrounds" art that
// bleed/needsBacking cannot see, since both only measure ink quantity/brightness,
// never whether every opaque pixel is the SAME (white) colour. ---

const WHITE_ON_CLEAR = (x, y) => (x > 20 && x < 100 && y > 20 && y < 100) ? [255, 255, 255, 255] : [0, 0, 0, 0];
// NVDA-like: a flat, legible, non-white mid-luminance colour on transparency.
// meanLum ~0.62 (measured NVDA meanLum=0.622), so it must NOT be flagged whiteOnly
// even though a single flat fill also has lumRange 0 -- proves range alone can't trigger it.
const FLAT_MID_LUM = (x, y) => (x > 20 && x < 100 && y > 20 && y < 100) ? [118, 185, 0, 255] : [0, 0, 0, 0];
// A real multi-tone mark: three distinct opaque colours plus transparent padding.
const MULTITONE = (x, y) => {
  if (x >= 20 && x < 40 && y >= 20 && y < 40) return [200, 50, 50, 255];
  if (x >= 40 && x < 60 && y >= 20 && y < 40) return [50, 50, 200, 255];
  if (x >= 60 && x < 80 && y >= 20 && y < 40) return [50, 200, 50, 255];
  return [0, 0, 0, 0];
};

test('pure-white opaque art on transparency is flagged whiteOnly', () => {
  const a = analysePng(makePng(128, 128, WHITE_ON_CLEAR));
  assert.ok(a.meanLum > 0.9, `expected bright, got ${a.meanLum}`);
  assert.ok(a.lumRange < 0.05, `expected near-zero range, got ${a.lumRange}`);
  assert.strictEqual(a.whiteOnly, true);
});

test('flat mid-luminance colour (NVDA-like) is not flagged whiteOnly', () => {
  const a = analysePng(makePng(128, 128, FLAT_MID_LUM));
  assert.ok(a.meanLum > 0.5 && a.meanLum < 0.7, `expected mid luminance, got ${a.meanLum}`);
  // A single flat fill also has near-zero range -- this documents that low range
  // ALONE is not the trigger; whiteOnly requires meanLum > 0.9 too.
  assert.ok(a.lumRange < 0.05, `expected near-zero range (flat fill), got ${a.lumRange}`);
  assert.strictEqual(a.whiteOnly, false, 'flat non-white colour must not be flagged');
});

test('normal multi-tone logo is not flagged whiteOnly', () => {
  const a = analysePng(makePng(128, 128, MULTITONE));
  assert.ok(a.lumRange > 0.05, `expected real range across tones, got ${a.lumRange}`);
  assert.strictEqual(a.whiteOnly, false);
});

test('fully transparent art has lumRange 0 and does not crash', () => {
  const a = analysePng(makePng(32, 32, () => [0, 0, 0, 0]));
  assert.strictEqual(a.alphaCoverage, 0);
  assert.strictEqual(a.lumRange, 0);
  assert.strictEqual(a.whiteOnly, false);
});

test('lumRange is reported correctly for a known two-tone image', () => {
  // 4x4: rows 0-1 opaque white (lum=1.0), row 2 opaque red (lum=0.2126), row 3 transparent.
  const TWO_TONE = (x, y) => {
    if (y < 2) return [255, 255, 255, 255];
    if (y === 2) return [255, 0, 0, 255];
    return [0, 0, 0, 0];
  };
  const a = analysePng(makePng(4, 4, TWO_TONE));
  assert.strictEqual(a.alphaCoverage, 0.75, 'rows 0-2 of 4 are opaque');
  // hand-computed: max lum (white) - min lum (red) = 1.0 - 0.2126 = 0.7874 -> 0.787
  assert.strictEqual(a.lumRange, 0.787);
});

// --- sub-byte bit depths (1/2/4) for colour types 0 (greyscale) and 3 (indexed) ---
// The logo source's best art is depth=4/colorType=3; these pin the packed-byte
// unpacking (MSB-first, byte-padded scanlines) directly against decodePng so the
// exact RGBA bytes are checked, not just pass/fail through analysePng.
import { decodePng } from '../../tools/png-decode.mjs';

// Packs one scanline's worth of sub-byte values MSB-first into bytes, padding the
// final byte with `padValue` when w * depth isn't a multiple of 8 -- pass a nonzero
// padValue to prove a decoder discards it rather than reading a phantom pixel.
function packScanline(rowValues, w, depth, padValue = 0) {
  const perByte = 8 / depth;
  const bytesPerScanline = Math.ceil(w * depth / 8);
  const mask = (1 << depth) - 1;
  const row = Buffer.alloc(bytesPerScanline);
  for (let byteIdx = 0; byteIdx < bytesPerScanline; byteIdx++) {
    let byte = 0;
    for (let slot = 0; slot < perByte; slot++) {
      const x = byteIdx * perByte + slot;
      const shift = 8 - depth * (slot + 1);
      const val = x < w ? rowValues[x] : padValue;
      byte |= (val & mask) << shift;
    }
    row[byteIdx] = byte;
  }
  return row;
}

// Builds a depth 1/2/4/8 PNG for colour type 0 (greyscale) or 3 (indexed): `values`
// is a flat row-major array of grey levels or palette indices in [0, 2^depth - 1].
// Filtering (including Paeth) is applied to the packed bytes with byte-distance
// bpp = max(1, floor(depth/8)) -- i.e. 1 for every sub-byte depth -- mirroring the
// PNG spec: filtering always operates on raw bytes, never on unpacked pixels.
function makePngSubByte(w, h, depth, colorType, values, { palette = null, trns = null, filter = 0, padValue = 0 } = {}) {
  const bytesPerScanline = Math.ceil(w * depth / 8);
  const bpp = Math.max(1, Math.floor(depth / 8));
  const unfiltered = Buffer.alloc(h * bytesPerScanline);
  for (let y = 0; y < h; y++) {
    packScanline(values.slice(y * w, y * w + w), w, depth, padValue).copy(unfiltered, y * bytesPerScanline);
  }

  const raw = Buffer.alloc(h * (bytesPerScanline + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (bytesPerScanline + 1)] = filter;
    const dst = raw.slice(y * (bytesPerScanline + 1) + 1, (y + 1) * (bytesPerScanline + 1));
    for (let x = 0; x < bytesPerScanline; x++) {
      const a = x >= bpp ? unfiltered[y * bytesPerScanline + x - bpp] : 0;
      const b = y > 0 ? unfiltered[(y - 1) * bytesPerScanline + x] : 0;
      const c = (x >= bpp && y > 0) ? unfiltered[(y - 1) * bytesPerScanline + x - bpp] : 0;
      let v = unfiltered[y * bytesPerScanline + x];
      if (filter === 1) v = (v - a) & 0xff;
      else if (filter === 2) v = (v - b) & 0xff;
      else if (filter === 3) v = (v - ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        v = (v - pr) & 0xff;
      }
      dst[x] = v;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = 0;

  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (colorType === 3 && palette) chunks.push(chunk('PLTE', palette));
  if (trns) chunks.push(chunk('tRNS', trns));
  chunks.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function paletteBuffer(colors) {
  const buf = Buffer.alloc(colors.length * 3);
  colors.forEach(([r, g, b], i) => { buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b; });
  return buf;
}

test('depth-4 indexed PNG decodes to exact expected RGBA pixels', () => {
  const palette = [[10, 20, 30], [200, 150, 90], [0, 255, 0], [255, 0, 255]];
  const values = [0, 1, 2, 3, 3, 2, 1, 0]; // w=4, h=2
  const img = decodePng(makePngSubByte(4, 2, 4, 3, values, { palette: paletteBuffer(palette) }));
  assert.ok(img && !img.unsupported, 'expected a decoded image');
  assert.strictEqual(img.w, 4);
  assert.strictEqual(img.h, 2);
  for (let i = 0; i < values.length; i++) {
    const [r, g, b] = palette[values[i]];
    assert.strictEqual(img.rgba[i * 4], r, `pixel ${i} R`);
    assert.strictEqual(img.rgba[i * 4 + 1], g, `pixel ${i} G`);
    assert.strictEqual(img.rgba[i * 4 + 2], b, `pixel ${i} B`);
    assert.strictEqual(img.rgba[i * 4 + 3], 255, `pixel ${i} A`);
  }
});

test('depth-2 indexed PNG decodes correctly (4 values per byte)', () => {
  const palette = [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255]];
  const values = [0, 1, 2, 3, 3, 1, 0, 2]; // w=8, h=1 -> exactly 2 bytes, no padding
  const img = decodePng(makePngSubByte(8, 1, 2, 3, values, { palette: paletteBuffer(palette) }));
  assert.ok(img && !img.unsupported, 'expected a decoded image');
  assert.strictEqual(img.w, 8);
  for (let i = 0; i < values.length; i++) {
    const [r, g, b] = palette[values[i]];
    assert.strictEqual(img.rgba[i * 4], r, `pixel ${i} R`);
    assert.strictEqual(img.rgba[i * 4 + 1], g, `pixel ${i} G`);
    assert.strictEqual(img.rgba[i * 4 + 2], b, `pixel ${i} B`);
  }
});

test('depth-1 indexed PNG decodes correctly (8 values per byte)', () => {
  const palette = [[255, 255, 255], [0, 0, 0]];
  const values = [0, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0]; // w=16, h=1 -> exactly 2 bytes
  const img = decodePng(makePngSubByte(16, 1, 1, 3, values, { palette: paletteBuffer(palette) }));
  assert.ok(img && !img.unsupported, 'expected a decoded image');
  assert.strictEqual(img.w, 16);
  for (let i = 0; i < values.length; i++) {
    const [r, g, b] = palette[values[i]];
    assert.strictEqual(img.rgba[i * 4], r, `pixel ${i} R`);
    assert.strictEqual(img.rgba[i * 4 + 1], g, `pixel ${i} G`);
    assert.strictEqual(img.rgba[i * 4 + 2], b, `pixel ${i} B`);
  }
});

test('depth-4 greyscale PNG scales levels correctly to 0-255', () => {
  const values = [0, 1, 8, 15, 7, 15, 0, 8]; // w=8, h=1, colour type 0
  const img = decodePng(makePngSubByte(8, 1, 4, 0, values));
  assert.ok(img && !img.unsupported, 'expected a decoded image');
  const expected = values.map(v => Math.round(v * 255 / 15));
  for (let i = 0; i < values.length; i++) {
    assert.strictEqual(img.rgba[i * 4], expected[i], `pixel ${i} grey R`);
    assert.strictEqual(img.rgba[i * 4 + 1], expected[i], `pixel ${i} grey G`);
    assert.strictEqual(img.rgba[i * 4 + 2], expected[i], `pixel ${i} grey B`);
    assert.strictEqual(img.rgba[i * 4 + 3], 255, `pixel ${i} alpha`);
  }
  assert.strictEqual(img.rgba[3 * 4], 255, 'level 15 -> 255');
  assert.strictEqual(img.rgba[0 * 4], 0, 'level 0 -> 0');
});

test('depth-4 indexed PNG with width not a multiple of pixels-per-byte discards padding', () => {
  // w=3 at depth 4: 2 pixels/byte, so the last byte holds one real pixel (index 2)
  // plus 4 padding bits. Seed the padding with 0b1111 -- a decoder that reads it as
  // part of a value, or as a phantom 4th pixel, will diverge from the assertions.
  const palette = Array.from({ length: 16 }, (_, i) => [i * 15, 255 - i * 15, (i * 41) % 256]);
  const values = [2, 5, 9];
  const buf = makePngSubByte(3, 1, 4, 3, values, { palette: paletteBuffer(palette), padValue: 0b1111 });
  const img = decodePng(buf);
  assert.ok(img && !img.unsupported, 'expected a decoded image');
  assert.strictEqual(img.w, 3);
  assert.strictEqual(img.h, 1);
  assert.strictEqual(img.rgba.length, 3 * 1 * 4, 'exactly w*h pixels -- padding is not a 4th pixel');
  for (let i = 0; i < values.length; i++) {
    const [r, g, b] = palette[values[i]];
    assert.strictEqual(img.rgba[i * 4], r, `pixel ${i} R`);
    assert.strictEqual(img.rgba[i * 4 + 1], g, `pixel ${i} G`);
    assert.strictEqual(img.rgba[i * 4 + 2], b, `pixel ${i} B`);
  }
});

test('depth-4 indexed PNG with Paeth filter (type 4) round-trips', () => {
  // Non-uniform 5x4 grid (w=5 gives a 3-byte scanline with a partial last byte) so
  // a !== b !== c for most pixels, proving Paeth runs on the packed bytes before
  // unpacking rather than on already-unpacked pixel values.
  const palette = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, (i * 37) % 256]);
  const w = 5, h = 4;
  const values = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values.push((x * 3 + y * 5) % 16);
  const img = decodePng(makePngSubByte(w, h, 4, 3, values, { palette: paletteBuffer(palette), filter: 4 }));
  assert.ok(img && !img.unsupported, 'expected a decoded image');
  assert.strictEqual(img.w, w);
  assert.strictEqual(img.h, h);
  for (let i = 0; i < values.length; i++) {
    const [r, g, b] = palette[values[i]];
    assert.strictEqual(img.rgba[i * 4], r, `pixel ${i} R (filter 4)`);
    assert.strictEqual(img.rgba[i * 4 + 1], g, `pixel ${i} G (filter 4)`);
    assert.strictEqual(img.rgba[i * 4 + 2], b, `pixel ${i} B (filter 4)`);
  }
});

test('depth 16 stays unsupported for greyscale and indexed colour types too', () => {
  // Greyscale depth 16: 2 bytes/pixel.
  const wG = 4, hG = 2;
  const rawG = Buffer.alloc(hG * (wG * 2 + 1));
  const ihdrG = Buffer.alloc(13);
  ihdrG.writeUInt32BE(wG, 0); ihdrG.writeUInt32BE(hG, 4);
  ihdrG[8] = 16; ihdrG[9] = 0; ihdrG[12] = 0;
  const bufG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdrG),
    chunk('IDAT', zlib.deflateSync(rawG, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const imgG = decodePng(bufG);
  assert.strictEqual(imgG.unsupported, true);
  assert.strictEqual(imgG.w, wG);
  assert.strictEqual(imgG.h, hG);

  // Indexed depth 16 (not spec-legal, but must degrade to unsupported, not throw).
  const wI = 4, hI = 2;
  const rawI = Buffer.alloc(hI * (wI * 2 + 1));
  const ihdrI = Buffer.alloc(13);
  ihdrI.writeUInt32BE(wI, 0); ihdrI.writeUInt32BE(hI, 4);
  ihdrI[8] = 16; ihdrI[9] = 3; ihdrI[12] = 0;
  const bufI = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdrI),
    chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])),
    chunk('IDAT', zlib.deflateSync(rawI, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const imgI = decodePng(bufI);
  assert.strictEqual(imgI.unsupported, true);
});
