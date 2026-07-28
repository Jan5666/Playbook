// Screenshot a slice of the logo pack so it can be reviewed as an image.
//
//   node tools/logo-review.mjs <out.png> <KEY|MARKET:*> [...]
//
// The contact sheet build-logos.mjs writes is an HTML file; this renders a
// chosen slice of it to a PNG. The pack's acceptance gate is a person looking
// at the marks (a wrong-company logo returns HTTP 200 and passes every
// automated check), and a slice small enough to actually read is what makes
// that review possible.
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const [out, ...patterns] = process.argv.slice(2);
if (!out || !patterns.length) {
  console.error('usage: node tools/logo-review.mjs <out.png> <KEY|MARKET:*> ...');
  process.exit(1);
}

// Read the pack through pb-content.js's own logoFor rather than re-parsing the
// manifest text. A private parser here silently disagreed with the app the
// moment the manifest gained its compact `1` form: every compact row failed the
// `{...}` regex, so this page reported "NONE" for thousands of marks that were
// on disk and rendering fine. The reviewer's whole job is to show what ships.
const require = createRequire(import.meta.url);
const { LOGO_MANIFEST, logoFor } = require(join(ROOT, 'pb-content.js'));
const manifest = {};
for (const key of Object.keys(LOGO_MANIFEST)) {
  const [market, ticker] = key.split(':');
  manifest[key] = logoFor(ticker, market) || {};
}

const wanted = [];
for (const p of patterns) {
  if (p.endsWith(':*')) {
    const mk = p.slice(0, -2);
    wanted.push(...Object.keys(manifest).filter(k => k.startsWith(mk + ':')).sort());
  } else if (manifest[p]) wanted.push(p);
  else wanted.push(p); // keep it, so a genuinely missing key shows as a gap
}

const cells = wanted.map((k) => {
  const v = manifest[k] || {};
  const [market, ticker] = k.split(':');
  const art = v.f && existsSync(join(ROOT, 'logos', v.f))
    ? `<img src="./logos/${v.f}" alt="">`
    : `<div class="mono" style="background:${v.c || '#3f3f46'}">${ticker.slice(0, 2)}</div>`;
  const tag = v.f ? '' : (v.c ? ' chip' : ' NONE');
  return `<figure>${art}<figcaption>${ticker}<span>${market}${tag}</span></figcaption></figure>`;
}).join('');

const COLS = 10;
const html = `<!doctype html><meta charset="utf-8"><style>
body{background:#09090b;color:#fafafa;font:13px system-ui;margin:0;padding:16px}
.grid{display:grid;grid-template-columns:repeat(${COLS},1fr);gap:10px}
figure{margin:0;text-align:center}
img,.mono{width:64px;height:64px;border-radius:14px;display:block;margin:0 auto;object-fit:contain}
.mono{display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px;color:#fff}
figcaption{margin-top:5px;font-size:11px;font-weight:600;line-height:1.25}
figcaption span{display:block;color:#a1a1aa;font-weight:400;font-size:9px}
</style><div class="grid">${cells}</div>`;

const dir = mkdtempSync(join(tmpdir(), 'pb-review-'));
const page = join(ROOT, '.logo-review.html');
writeFileSync(page, html);
const rows = Math.ceil(wanted.length / COLS);
const height = 40 + rows * 106;
const res = spawnSync(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
  `--screenshot=${out}`, `--window-size=1000,${height}`, '--default-background-color=09090b',
  `file:///${page.replace(/\\/g, '/')}`,
], { encoding: 'utf8', timeout: 90000 });
rmSync(dir, { recursive: true, force: true });
rmSync(page, { force: true });
if (!existsSync(out)) {
  console.error('screenshot failed:', (res.stderr || '').slice(0, 400));
  process.exit(1);
}
console.log(`wrote ${out} — ${wanted.length} marks`);
