// Minimal dependency-free PNG reader → the facts the logo pipeline needs:
//   needsBacking : is the mark dark or sparse enough to vanish on #09090b?
//   bleed        : is the art opaque and bright, i.e. already its own tile?
// Node built-ins only — the repo has no build step and adds no dependencies.
import zlib from 'node:zlib';

export function analysePng(buf) {
  // Verify full 8-byte PNG signature
  if (!buf || buf.length < 33) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
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
  if (ihdr.color === 3 && !plte) return { ...ihdr, unsupported: true };
  const stride = ihdr.w * bpp;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return { ...ihdr, unsupported: true }; }
  // Verify inflated buffer contains the expected amount of data
  if (raw.length < ihdr.h * (stride + 1)) return { ...ihdr, unsupported: true };

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
