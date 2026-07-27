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
