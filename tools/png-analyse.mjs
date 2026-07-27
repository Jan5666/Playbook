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
