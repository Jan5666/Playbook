// Build the iOS launch-image pack (brand/splash/*.png).
//
//   node tools/build-splash.mjs [--dry-run]
//
// WHY THIS EXISTS
// ---------------
// iOS gives an installed PWA no splash screen of its own: Safari ignores the web
// app manifest's `background_color`, so between tapping the home-screen icon and
// WebKit painting the document, iOS shows a plain WHITE screen for 300-800ms.
// On a dark app that reads as a white flash on every single launch - the
// "flicker before the loading screen" that survived every earlier fix, because
// every earlier fix was inside the page and this happens before the page exists.
//
// The only supported cure is <link rel="apple-touch-startup-image"> with a media
// query per device, and iOS only honours an image whose pixel dimensions match
// that device's screen EXACTLY - a near-miss is silently ignored and you are
// back to white. Hence a generated pack rather than a couple of hand-made files.
//
// WHY SOLID COLOUR
// ----------------
// Each image is a flat fill of the loader's own background (--pb-bg in
// styles.css). Not the logo: a static mark can only ever land a pixel or two off
// the live loader's tile, and that lands as a JUMP at handoff, which is worse
// than what we are fixing. A flat fill cannot mis-register - the launch image and
// the page's first painted frame are the same colour, so the seam is invisible
// and the loader simply fades up out of it.
//
// Two themes because the app's theme is its own setting (pb.theme.v2), not the
// OS's, so a media query cannot pick for us. index.html ships the dark hrefs and
// its pre-paint script rewrites them to -light for a light-theme user, exactly
// the way it already swaps the apple-touch-icon.
import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'brand', 'splash');
const DRY = process.argv.includes('--dry-run');

// Must track --pb-bg in styles.css (the .pb-loader block). splash-boot.test.mjs
// asserts these two literals still match that stylesheet.
export const THEMES = { dark: [0x07, 0x07, 0x09], light: [0xF4, 0xF4, 0xF2] };

// Portrait launch geometry, CSS px + device-pixel-ratio. The manifest locks the
// app to portrait, so portrait images are the only ones iOS will ask for.
// `w`/`h` are CSS px (what the media query matches); the file is w*dpr x h*dpr.
export const DEVICES = [
  // iPhone
  { w: 320,  h: 568,  dpr: 2, note: 'iPhone SE 1st gen, 5s' },
  { w: 375,  h: 667,  dpr: 2, note: 'iPhone SE 2nd/3rd gen, 8, 7, 6s' },
  { w: 414,  h: 736,  dpr: 3, note: 'iPhone 8 Plus' },
  { w: 375,  h: 812,  dpr: 3, note: 'iPhone X, XS, 11 Pro, 12/13 mini' },
  { w: 414,  h: 896,  dpr: 2, note: 'iPhone XR, 11' },
  { w: 414,  h: 896,  dpr: 3, note: 'iPhone XS Max, 11 Pro Max' },
  { w: 390,  h: 844,  dpr: 3, note: 'iPhone 12, 12 Pro, 13, 13 Pro, 14' },
  { w: 428,  h: 926,  dpr: 3, note: 'iPhone 12/13 Pro Max, 14 Plus' },
  { w: 393,  h: 852,  dpr: 3, note: 'iPhone 14 Pro, 15, 15 Pro, 16' },
  { w: 430,  h: 932,  dpr: 3, note: 'iPhone 14 Pro Max, 15 Plus/Pro Max, 16 Plus' },
  { w: 402,  h: 874,  dpr: 3, note: 'iPhone 16 Pro' },
  { w: 440,  h: 956,  dpr: 3, note: 'iPhone 16 Pro Max' },
  // iPad - the app is portrait-locked, but it installs on iPad too.
  { w: 768,  h: 1024, dpr: 2, note: 'iPad 9.7, mini, Air' },
  { w: 810,  h: 1080, dpr: 2, note: 'iPad 10.2' },
  { w: 820,  h: 1180, dpr: 2, note: 'iPad Air 10.9' },
  { w: 834,  h: 1112, dpr: 2, note: 'iPad Pro 10.5' },
  { w: 834,  h: 1194, dpr: 2, note: 'iPad Pro 11' },
  { w: 1024, h: 1366, dpr: 2, note: 'iPad Pro 12.9' },
];

export const fileFor = (theme, d) => `${theme}-${d.w}x${d.h}@${d.dpr}x.png`;
export const mediaFor = (d) =>
  `screen and (device-width: ${d.w}px) and (device-height: ${d.h}px) ` +
  `and (-webkit-device-pixel-ratio: ${d.dpr}) and (orientation: portrait)`;

const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
};

// A 1-BIT PALETTE png, not png-raster's encodeRGB. These images are a single
// flat colour over as much as 2048x2732, and colour type 2 spends three bytes a
// pixel describing it - the pack came out at 455 KB that way. Colour type 3 at
// bit depth 1 spends one BIT, so every scanline is a run of zero bytes and the
// whole pack collapses to a few KB. Both encodings decode to identical pixels;
// this one is just the right shape for the data.
function solidPng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 1;   // bit depth: 1
  ihdr[9] = 3;   // colour type: palette
  // Two identical entries rather than one: a 1-bit image with a 2-entry palette
  // is the well-trodden path through every decoder, and index 1 is never used.
  const plte = Buffer.from([...rgb, ...rgb]);
  const stride = Math.ceil(w / 8);
  // filter byte 0 (None) + all-zero indices => every pixel is palette entry 0.
  const raw = Buffer.alloc(h * (stride + 1));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function main() {
  if (!DRY) {
    mkdirSync(OUT, { recursive: true });
    // Regenerate from scratch so a device dropped from DEVICES cannot leave an
    // orphan file behind that index.html no longer references.
    if (existsSync(OUT)) {
      for (const f of readdirSync(OUT)) if (f.endsWith('.png')) unlinkSync(join(OUT, f));
    }
  }
  let total = 0;
  for (const [theme, rgb] of Object.entries(THEMES)) {
    for (const d of DEVICES) {
      const name = fileFor(theme, d);
      const png = solidPng(d.w * d.dpr, d.h * d.dpr, rgb);
      total += png.length;
      if (!DRY) writeFileSync(join(OUT, name), png);
      console.log(`${DRY ? 'would write' : 'wrote'} brand/splash/${name}  ${String(d.w * d.dpr).padStart(4)}x${String(d.h * d.dpr).padStart(4)}  ${(png.length / 1024).toFixed(1)} KB  ${d.note}`);
    }
  }
  console.log(`\n${DEVICES.length} sizes x ${Object.keys(THEMES).length} themes = ${DEVICES.length * Object.keys(THEMES).length} files, ${(total / 1024).toFixed(1)} KB total`);
  console.log('\nRemember: bump CACHE_NAME in sw.js if these changed.');
}

if (process.argv[1] && process.argv[1].endsWith('build-splash.mjs')) main();
