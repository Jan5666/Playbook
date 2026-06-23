import sharp from 'sharp';
import { glyphPath } from './lib.mjs';

const FONT = 'C:/Windows/Fonts/georgiab.ttf';
const MASTER = 1024;
const CAP = 0.55;          // cap-height as fraction of canvas
const NUDGE_Y = MASTER*0.005; // tiny optical nudge down

// ---- design knobs ----
const G0 = '#6175f7';      // top-left (cornflower blue) — keeps original family, hair brighter
const G1 = '#8a61f6';      // bottom-right (violet)
const G0deep = '#5566e8';  // slightly deeper start for richness at extreme corner

function masterSVG(S){
  const g = glyphPath(FONT,'P',S,CAP,0,S*0.005);
  const sh = Math.round(S*0.013);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0"    stop-color="${G0}"/>
      <stop offset="0.5"  stop-color="#7268f7"/>
      <stop offset="1"    stop-color="${G1}"/>
    </linearGradient>
    <!-- lit from above: soft cool-white glow near the top -->
    <radialGradient id="hl" cx="0.5" cy="-0.05" r="0.95">
      <stop offset="0"    stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="1"    stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <!-- grounding: gentle darkening toward the bottom corners -->
    <radialGradient id="vg" cx="0.5" cy="1.08" r="0.85">
      <stop offset="0"   stop-color="#1c1248" stop-opacity="0.22"/>
      <stop offset="0.6" stop-color="#1c1248" stop-opacity="0.05"/>
      <stop offset="1"   stop-color="#1c1248" stop-opacity="0"/>
    </radialGradient>
    <filter id="ds" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="${sh}" stdDev="${sh}" flood-color="#1a0f3d" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect width="${S}" height="${S}" fill="url(#bg)"/>
  <rect width="${S}" height="${S}" fill="url(#vg)"/>
  <rect width="${S}" height="${S}" fill="url(#hl)"/>
  <path filter="url(#ds)" transform="translate(${g.tx} ${g.ty}) scale(${g.scale})" d="${g.d}" fill="#ffffff"/>
</svg>`;
}

// Render master, then downscale with high-quality kernel.
const master = await sharp(Buffer.from(masterSVG(MASTER)), {density:300}).png().toBuffer();
const sizes = {'icon-180.png':180,'icon-192.png':192,'icon-512.png':512,'icon-1024.png':1024};
for(const [name,sz] of Object.entries(sizes)){
  await sharp(master).resize(sz,sz,{kernel:'lanczos3'}).png({compressionLevel:9}).toFile('../../'+name);
}
console.log('generated:', Object.keys(sizes).join(', '));

// ---- PREVIEW: rounded-rect (iOS r≈22.37%) at several homescreen sizes on a wallpaper-ish bg ----
function roundedMask(S){const r=(S*0.2237).toFixed(2);return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect width="${S}" height="${S}" rx="${r}" ry="${r}"/></svg>`;}
async function masked(sz){
  const ic = await sharp(master).resize(sz,sz,{kernel:'lanczos3'}).toBuffer();
  const m  = await sharp(Buffer.from(roundedMask(sz))).png().toBuffer();
  return sharp(ic).composite([{input:m,blend:'dest-in'}]).png().toBuffer();
}
const pv=[180,120,76];
const gap=40, H=180+gap*2;
let x=gap; const comps=[];
for(const sz of pv){ comps.push({input:await masked(sz), left:x, top:gap+(180-sz)}); x+=sz+gap; }
const W=x;
await sharp({create:{width:W,height:H,channels:4,background:'#2b2b30'}}).composite(comps).png().toFile('preview.png');
console.log('wrote preview.png', W+'x'+H);
