import opentype from 'opentype.js';
import { readFileSync } from 'node:fs';

// iOS-style squircle (superellipse-ish) mask path for an SxS canvas, used for PREVIEW only.
export function squirclePath(S){
  // Continuous-corner superellipse approximation (Figma/iOS-like), n≈5 corners.
  const n = 64, a = S/2, cx=S/2, cy=S/2, p=4.0; // p=4 ~ iOS squircle roundness
  let d='';
  for(let i=0;i<=n;i++){
    const t = (i/n)*2*Math.PI;
    const ct=Math.cos(t), st=Math.sin(t);
    const x = cx + a*Math.sign(ct)*Math.pow(Math.abs(ct),2/p);
    const y = cy + a*Math.sign(st)*Math.pow(Math.abs(st),2/p);
    d += (i===0?'M':'L') + x.toFixed(2)+' '+y.toFixed(2)+' ';
  }
  return d+'Z';
}

// Returns {d, scale, tx, ty, capFrac} for a glyph centered (by bbox) in SxS, with given cap-height fraction.
export function glyphPath(fontPath, ch, S, capFrac, nudgeX=0, nudgeY=0){
  const b = readFileSync(fontPath);
  const font = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const EM = font.unitsPerEm;
  const glyph = font.charToGlyph(ch);
  const p = glyph.getPath(0,0,EM);
  const bb = p.getBoundingBox(); // x1,y1,x2,y2 (y down, baseline at 0)
  const gw = bb.x2-bb.x1, gh = bb.y2-bb.y1;
  const scale = (S*capFrac)/gh;
  const tx = S/2 - ((bb.x1+bb.x2)/2)*scale + nudgeX;
  const ty = S/2 - ((bb.y1+bb.y2)/2)*scale + nudgeY;
  return { d: p.toPathData(3), scale, tx, ty };
}
