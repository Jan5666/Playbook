// Shared PNG → RGBA decode. Owned here so the measuring path (png-analyse) and
// the transforming path (png-crop) cannot drift: the chunk walk, the five
// scanline filters, and the malformed-input guards exist exactly once.
//
// Three-way return, because callers need to tell "not a PNG" from "a PNG I
// can't handle":
//   null                        → not a PNG
//   { ...ihdr, unsupported }    → a PNG, but undecodable
//   { w, h, rgba }              → decoded, 4 bytes per pixel
//
// Bit depths 1/2/4 are supported for colour types 0 (greyscale) and 3 (indexed)
// only -- the only depths the PNG spec allows for those types besides 8. Colour
// types 2/4/6 remain depth-8-only. Depth 16 is never supported, for any type.
import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// Depths legal per colour type (16 excluded everywhere: never supported).
const ALLOWED_DEPTHS = { 0: [1, 2, 4, 8], 2: [8], 3: [1, 2, 4, 8], 4: [8], 6: [8] };

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
  if (ihdr.interlace !== 0) return bad;
  const channels = CHANNELS[ihdr.color];
  if (!channels) return bad;
  const allowedDepths = ALLOWED_DEPTHS[ihdr.color];
  if (!allowedDepths.includes(ihdr.depth)) return bad;
  // An indexed PNG with no palette would throw on the palette reads below.
  if (ihdr.color === 3 && !plte) return bad;

  const bitsPerPixel = ihdr.depth * channels;
  // Bytes per scanline: the packed, byte-padded stride filtering runs over. Equal
  // to w * channels when depth is 8 (unchanged from before); smaller than that for
  // sub-byte depths, where several pixels share a byte.
  const stride = Math.ceil(ihdr.w * bitsPerPixel / 8);
  // Filter byte-distance: always 1 for sub-byte depths (a "pixel" is smaller than a
  // byte, so the predictor still steps by whole bytes), same as the old depth-8
  // `bpp` for every colour type already supported.
  const filterBpp = Math.max(1, Math.floor(bitsPerPixel / 8));

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
      const a = x >= filterBpp ? out[o + x - filterBpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = (x >= filterBpp && y > 0) ? out[prev + x - filterBpp] : 0;
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
  if (ihdr.depth < 8) {
    // Sub-byte depths only reach here for colour types 0/3 (channels === 1):
    // unpack each unfiltered byte into 8/depth values, MSB-first, discarding any
    // padding values beyond w.
    const perByte = 8 / ihdr.depth;
    const mask = (1 << ihdr.depth) - 1;
    for (let y = 0; y < ihdr.h; y++) {
      const rowStart = y * stride;
      for (let x = 0; x < ihdr.w; x++) {
        const byteIdx = rowStart + Math.floor(x / perByte);
        const shift = 8 - ihdr.depth * ((x % perByte) + 1);
        const val = (out[byteIdx] >> shift) & mask;
        const i = y * ihdr.w + x;
        let r, g, b, a = 255;
        if (ihdr.color === 3) {
          r = plte[val * 3]; g = plte[val * 3 + 1]; b = plte[val * 3 + 2];
          a = trns && val < trns.length ? trns[val] : 255;
        } else {
          r = g = b = Math.round(val * 255 / mask);
        }
        rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
      }
    }
  } else {
    for (let i = 0, n = ihdr.w * ihdr.h; i < n; i++) {
      const s = i * channels; let r, g, b, a = 255;
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
  }
  return { w: ihdr.w, h: ihdr.h, rgba };
}
