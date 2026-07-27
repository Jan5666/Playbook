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
