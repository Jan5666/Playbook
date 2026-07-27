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
