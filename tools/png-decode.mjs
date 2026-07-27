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
