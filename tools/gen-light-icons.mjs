// One-off: rasterize brand/icon-light.svg into PNG home-screen icons at the
// sizes the manifest / apple-touch-icon need. Dark PNGs already ship in brand/;
// only the light tile needs rasterizing. Uses headless Chrome (no native deps).
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const brand = join(here, '..', 'brand');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(1); }

// The light tile, inlined so we can scale it per target size.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="SZ" height="SZ"><rect width="512" height="512" rx="114" fill="#FFFFFF"></rect><rect x="142" y="260" width="56" height="120" rx="18" fill="#C9CBDB"></rect><rect x="228" y="180" width="56" height="200" rx="18" fill="#5A5AD0"></rect><rect x="314" y="90" width="56" height="290" rx="18" fill="#6E6EF0"></rect></svg>';

const targets = [
  { size: 180, out: 'apple-touch-icon-light.png' },
  { size: 180, out: 'icon-light-180.png' },
  { size: 192, out: 'icon-light-192.png' },
  { size: 512, out: 'icon-light-512.png' },
];

for (const { size, out } of targets) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px;background:transparent}</style></head><body>${SVG.replace(/SZ/g, size)}</body></html>`;
  const htmlPath = join(brand, `_tmp_${size}_${out}.html`);
  writeFileSync(htmlPath, html);
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--window-size=${size},${size}`,
    `--screenshot=${join(brand, out)}`,
    'file://' + htmlPath.replace(/\\/g, '/'),
  ], { stdio: 'ignore' });
  rmSync(htmlPath, { force: true });
  console.log('wrote brand/' + out);
}
