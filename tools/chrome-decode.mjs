// Decode ANY raster/vector image to a plain RGBA PNG, using the headless Chrome
// the smokes already depend on.
//
// Why this exists: the sources that carry the *good* art do not all ship PNG.
// Company sites ship .ico (often with a 256px entry inside), .svg (infinite
// resolution — the best possible source), and .webp; Google's favicon service
// answers with jpeg for some hosts. png-decode.mjs handles PNG only, so before
// this module every one of those was a "miss" and the ticker fell to a monogram.
//
// Chrome is used for DECODE ONLY. Measurement and composition stay in Node
// (png-analyse / png-raster) so they remain unit-testable — a browser in the
// middle of the compositor would make the tile rules untestable without a
// browser, and those rules are what the look of the pack depends on.
//
// Batched: one Chrome launch per N images, not per image. 1600 launches would
// take hours; 40 batches take about a minute.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// A vector with no intrinsic size renders at whatever box we give it; raster art
// is never upscaled here (that would only invent detail), so MAX is a ceiling.
const MAX = 512;

function mimeFor(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF') return 'image/webp';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01) return 'image/x-icon';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  const head = buf.slice(0, 400).toString('utf8');
  if (/<svg[\s>]/i.test(head) || /<\?xml/.test(head)) return 'image/svg+xml';
  return 'application/octet-stream';
}

// Runs inside the page. Kept as a string so this file stays a plain module.
const PAGE_JS = `
async function one(item) {
  const img = new Image();
  const done = new Promise((res) => { img.onload = () => res(true); img.onerror = () => res(false); });
  img.src = item.d;
  if (!(await done)) return { k: item.k, err: 'decode' };
  // SVGs without width/height report 0; give them a square box to render into.
  let nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
  if (!nw || !nh) { nw = ${MAX}; nh = ${MAX}; }
  const scale = Math.min(1, ${MAX} / Math.max(nw, nh));
  // An SVG is resolution-free, so render it AT the ceiling rather than at the
  // token intrinsic size its author happened to write into the file.
  const vector = item.d.indexOf('image/svg') > 0;
  const k = vector ? ${MAX} / Math.max(nw, nh) : scale;
  const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  let url;
  try { url = c.toDataURL('image/png'); } catch (e) { return { k: item.k, err: 'taint' }; }
  return { k: item.k, w: w, h: h, b: url.slice(url.indexOf(',') + 1) };
}
(async () => {
  const out = [];
  for (const item of ITEMS) {
    try { out.push(await one(item)); } catch (e) { out.push({ k: item.k, err: String(e).slice(0, 60) }); }
  }
  const pre = document.createElement('pre');
  pre.id = 'pbout';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
`;

// items: [{ key, buf }] -> Map(key -> { buf, w, h })
export function decodeBatch(items, { batchSize = 40, chrome = CHROME } = {}) {
  const out = new Map();
  if (!items.length) return out;
  const dir = mkdtempSync(join(tmpdir(), 'pb-logo-'));
  try {
    for (let i = 0; i < items.length; i += batchSize) {
      const slice = items.slice(i, i + batchSize);
      const payload = slice.map(({ key, buf }) => ({
        k: key, d: `data:${mimeFor(buf)};base64,${buf.toString('base64')}`,
      }));
      const html = join(dir, `b${i}.html`);
      writeFileSync(html, `<!doctype html><meta charset="utf-8"><body>
<script>const ITEMS = ${JSON.stringify(payload)};</script>
<script>${PAGE_JS}</script></body>`);
      const res = spawnSync(chrome, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
        '--allow-file-access-from-files', '--virtual-time-budget=30000',
        '--dump-dom', `file:///${html.replace(/\\/g, '/')}`,
      ], { encoding: 'utf8', timeout: 180000, maxBuffer: 256 * 1024 * 1024 });
      const dom = res.stdout || '';
      const m = dom.match(/<pre id="pbout">([\s\S]*?)<\/pre>/);
      if (!m) continue;
      // The DOM serialiser escapes these three; base64 contains none of them,
      // but the JSON envelope is text too, so undo them before parsing.
      const json = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      let rows;
      try { rows = JSON.parse(json); } catch { continue; }
      for (const r of rows) {
        if (r.err || !r.b) continue;
        out.set(r.k, { buf: Buffer.from(r.b, 'base64'), w: r.w, h: r.h });
      }
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
  return out;
}

export { mimeFor, MAX };
