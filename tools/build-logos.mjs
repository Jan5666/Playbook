// Build the instrument logo pack.
//
//   node tools/build-logos.mjs [--dry-run] [--from-backup <backup.json>]
//
// Resolves one logo per MARKET:TICKER through tools/logo-sources.mjs (which
// enforces the market-scoped key rule), gates it on measured quality, normalises
// it, writes logos/*.png, rewrites the LOGO_MANIFEST block in pb-content.js, and
// emits a contact sheet for human review.
//
// The contact sheet is the acceptance gate: a wrong-company logo returns HTTP
// 200 and looks perfect to every automated check. Only eyes catch it.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analysePng } from './png-analyse.mjs';
import { decodeRGBA, encodeRGBA, inkBox, crop, squarePad } from './png-crop.mjs';
import { chainFor, ISSUERS, issuerFor } from './logo-sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGOS = join(ROOT, 'logos');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DRY = process.argv.includes('--dry-run');
const backupIdx = process.argv.indexOf('--from-backup');
const BACKUP = backupIdx > -1 ? process.argv[backupIdx + 1] : null;

// ─── 1. Collect the universe ────────────────────────────────────────────────
const SECTION_MARKET = {
  JSE_SUGGESTIONS: 'JSE', TFSA_SUGGESTIONS: 'TFSA', LSE_SUGGESTIONS: 'LSE',
  ASX_SUGGESTIONS: 'ASX', EU_SUGGESTIONS: 'FRA', CRYPTO_SUGGESTIONS: 'CRYPTO',
};
function collectUniverse() {
  const src = readFileSync(join(ROOT, 'data.js'), 'utf8');
  const set = new Map(); // 'MARKET:TICKER' -> { ticker, market }
  const add = (ticker, market) => {
    if (!ticker || !market) return;
    set.set(`${market}:${ticker}`, { ticker, market });
  };
  // Walk section headers in order; every ticker belongs to the last header seen.
  const marks = [...src.matchAll(/^\s{2}([A-Z_]+):\s*\[/gm)].map(m => ({ name: m[1], at: m.index }));
  for (const m of src.matchAll(/ticker\s*:\s*'([^']+)'/g)) {
    let section = null;
    for (const s of marks) { if (s.at < m.index) section = s.name; else break; }
    add(m[1], SECTION_MARKET[section] || 'US');
  }
  if (BACKUP) {
    const raw = JSON.parse(readFileSync(BACKUP, 'utf8'));
    const keys = raw.keys || raw;
    const parse = (k) => { try { return JSON.parse(keys[k]); } catch { return []; } };
    for (const p of parse('pb.positions.v1') || []) add(p.ticker, p.market);
    for (const w of parse('pb.watchlist.v1') || []) add(w.ticker, w.market);
  }
  return [...set.values()];
}

// ─── 2. Fetch helpers ───────────────────────────────────────────────────────
async function getBuffer(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length < 300 ? null : b;
  } catch { return null; }
}

// Issuer sites are JS-rendered: a plain fetch returns markup with no icon <link>
// and no og:image. Drive the same headless Chrome the smokes already use.
const issuerArtCache = new Map();
async function fetchIssuerArt(issuerKey) {
  if (issuerArtCache.has(issuerKey)) return issuerArtCache.get(issuerKey);
  const cfg = ISSUERS[issuerKey];
  let best = null;
  const res = spawnSync(CHROME, [
    '--headless=new', '--disable-gpu', '--virtual-time-budget=8000', '--dump-dom', cfg.page,
  ], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const dom = res.stdout || '';
  const origin = new URL(cfg.page).origin;
  const candidates = [...dom.matchAll(/(?:src|href)="([^"]*logo[^"]*\.(?:png|svg))"/gi)]
    .map(m => m[1])
    .filter(u => !/instagram|facebook|twitter|linkedin|youtube/i.test(u))
    .map(u => (u.startsWith('http') ? u : origin + (u.startsWith('/') ? u : '/' + u)));
  for (const u of [...new Set(candidates)]) {
    if (u.endsWith('.svg')) continue; // the pipeline is raster-only
    const buf = await getBuffer(u);
    if (!buf) continue;
    const a = analysePng(buf);
    if (!a || a.unsupported) continue;
    if (!best || a.w * a.h > best.a.w * best.a.h) best = { buf, a, url: u };
  }
  issuerArtCache.set(issuerKey, best);
  return best;
}

// ─── 3-4. Gate + normalise ──────────────────────────────────────────────────
function gate(a) {
  if (!a || a.unsupported) return 'undecodable';
  if (a.w < 64 || a.h < 64) return `too small (${a.w}x${a.h})`;
  if (a.alphaCoverage < 0.12) return `too sparse (${a.alphaCoverage} ink)`;
  return null;
}
function normalise(buf, a, cropBox) {
  // Opaque bright art is already a finished tile — cropping it would eat its ground.
  if (a.bleed && !cropBox) return buf;
  const img = decodeRGBA(buf);
  if (!img) return buf;
  let box = inkBox(img);
  if (!box) return buf;
  if (cropBox) {
    box = {
      x: Math.round(box.x + box.w * cropBox.x), y: Math.round(box.y + box.h * cropBox.y),
      w: Math.max(1, Math.round(box.w * cropBox.w)), h: Math.max(1, Math.round(box.h * cropBox.h)),
    };
  }
  let c = crop(img, box);
  const tight = inkBox(c);
  if (tight) c = crop(c, tight);
  const sq = squarePad(c, 0.08);
  return encodeRGBA(sq.w, sq.h, sq.rgba);
}

// ─── Main ───────────────────────────────────────────────────────────────────
const universe = collectUniverse();
const manifest = {};
const report = [];
if (!DRY && !existsSync(LOGOS)) mkdirSync(LOGOS, { recursive: true });

for (const { ticker, market } of universe) {
  const key = `${market}:${ticker}`;
  let done = false;
  for (const cand of chainFor(market, ticker)) {
    let buf = null, via = cand.source, cropBox;
    if (cand.key === 'issuer') {
      const art = await fetchIssuerArt(cand.issuer);
      if (art) { buf = art.buf; via = `issuer:${cand.issuer}`; cropBox = ISSUERS[cand.issuer].cropBox; }
    } else {
      buf = await getBuffer(cand.url);
    }
    if (!buf) { report.push({ key, status: 'miss', via, why: 'no response' }); continue; }
    const a = analysePng(buf);
    const bad = gate(a);
    if (bad) { report.push({ key, status: 'reject', via, why: bad }); continue; }
    const outBuf = normalise(buf, a, cropBox);
    const finalA = analysePng(outBuf) || a;
    const file = `${market}-${ticker}.png`;
    if (!DRY) writeFileSync(join(LOGOS, file), outBuf);
    manifest[key] = { f: file, ...(finalA.bleed ? { b: 1 } : {}), ...(finalA.needsBacking ? { k: 1 } : {}) };
    report.push({ key, status: 'ok', via, why: `${finalA.w}x${finalA.h}`, lookup: cand.key });
    done = true;
    break;
  }
  if (!done) report.push({ key, status: 'monogram', via: '-', why: 'chain exhausted' });
}

// ─── 5-6. Rewrite the manifest block, bytes-exact outside the markers ───────
const START = '// <<< LOGO_MANIFEST_START';
const END = '// <<< LOGO_MANIFEST_END';
if (!DRY) {
  const pcPath = join(ROOT, 'pb-content.js');
  const buf = readFileSync(pcPath);
  const s = buf.indexOf(Buffer.from(START));
  const e = buf.indexOf(Buffer.from(END));
  if (s < 0 || e < 0) throw new Error('LOGO_MANIFEST markers not found in pb-content.js');
  const entries = Object.keys(manifest).sort()
    .map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(manifest[k])},`).join('\n');
  const block = Buffer.from(`${START}\nconst LOGO_MANIFEST = {\n${entries}\n};\n`);
  writeFileSync(pcPath, Buffer.concat([buf.slice(0, s), block, buf.slice(e)]));

  // Prune orphans so the pack never carries files the manifest dropped.
  const keep = new Set(Object.values(manifest).map(v => v.f));
  for (const f of readdirSync(LOGOS)) {
    if (f.endsWith('.png') && !keep.has(f)) unlinkSync(join(LOGOS, f));
  }
}

// ─── 7. Contact sheet — the acceptance gate ─────────────────────────────────
if (!DRY) {
  const rows = report.filter(r => r.status === 'ok').map(r => {
    const [market, ticker] = r.key.split(':');
    return `<figure><img class="big" src="./${manifest[r.key].f}" alt=""><img class="sm" src="./${manifest[r.key].f}" alt="">
      <figcaption><b>${ticker}</b> <span class="m">${market}</span><br><span class="v">${r.via} · ${r.lookup} · ${r.why}</span></figcaption></figure>`;
  }).join('\n');
  writeFileSync(join(LOGOS, 'contact-sheet.html'), `<!doctype html><meta charset="utf-8">
<title>Logo pack — review</title>
<style>body{background:#09090b;color:#fafafa;font:14px system-ui;padding:24px}
h1{font-size:18px;margin:0 0 4px}p{color:#a1a1aa;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}
figure{background:#18181b;border:1px solid #27272a;border-radius:12px;padding:12px;margin:0;text-align:center}
img{background:#fff;border-radius:8px;object-fit:contain}
.big{width:72px;height:72px}.sm{width:34px;height:34px;margin-left:8px;vertical-align:bottom}
figcaption{margin-top:8px;font-size:12px}.m{color:#71717a}.v{color:#71717a;font-size:10px}</style>
<h1>Logo pack — ${Object.keys(manifest).length} marks</h1>
<p>Check every mark against its ticker. A wrong-company logo returns HTTP 200 and passes every automated check — this page is the only thing that catches it.</p>
<div class="grid">${rows}</div>`);
}

// ─── 8. Summary ─────────────────────────────────────────────────────────────
const byStatus = {};
for (const r of report) (byStatus[r.status] ||= []).push(r);
for (const s of ['ok', 'reject', 'miss', 'monogram']) {
  console.log(`\n${s.toUpperCase()} (${(byStatus[s] || []).length})`);
  for (const r of (byStatus[s] || []).slice(0, 200)) {
    console.log('  ', r.key.padEnd(16), (r.via || '').padEnd(22), r.why || '');
  }
}
console.log(`\n${DRY ? 'DRY RUN — nothing written' : `wrote ${Object.keys(manifest).length} logos`}`);
// Fail loudly if a non-US market ever resolved through a bare ticker.
const illegal = report.filter(r => r.status === 'ok' && r.lookup === 'ticker' && !r.key.startsWith('US:'));
if (illegal.length) {
  console.error('\nFATAL: bare-ticker lookups outside US:', illegal.map(r => r.key).join(', '));
  process.exit(1);
}
