// Build the instrument logo pack.
//
//   node tools/build-logos.mjs [--dry-run] [--only US:AAPL,JSE:CPI] [--no-cache]
//                              [--from-backup <backup.json>] [--limit N]
//
// Resolves one logo per MARKET:TICKER through tools/logo-sources.mjs (which
// enforces the market-scoped key rule), gates it on measured quality, composes a
// uniform full-bleed tile, writes logos/*.png, rewrites the LOGO_MANIFEST block
// in pb-content.js, and emits a contact sheet for human review.
//
// The contact sheet is the acceptance gate: a wrong-company logo returns HTTP
// 200 and looks perfect to every automated check. Only eyes catch it.
//
// Source bytes are cached under .logo-cache/ (git-ignored) so the tile rules can
// be iterated on without refetching ~1800 URLs. --no-cache forces a refetch.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analysePng } from './png-analyse.mjs';
import { decodeRGBA, inkBox, crop } from './png-crop.mjs';
import {
  composeTile, tileToPng, colourStats, knockOutWhite, strokeRuns, deepen, rgbToHsl, TILE,
} from './png-raster.mjs';
import { decodeBatch } from './chrome-decode.mjs';
import {
  chainFor, CANONICAL_ART, issuerFor, domainFor, siteUrl, WELL_KNOWN_ICON_PATHS,
} from './logo-sources.mjs';
import { collectUniverse } from './logo-universe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGOS = join(ROOT, 'logos');
const CACHE = join(ROOT, '.logo-cache');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const DRY = flag('--dry-run');
const NO_CACHE = flag('--no-cache');
const BACKUP = opt('--from-backup');
const ONLY = opt('--only') ? new Set(opt('--only').split(',')) : null;
const LIMIT = opt('--limit') ? +opt('--limit') : 0;

// ─── 1. Collect the universe ────────────────────────────────────────────────
// The universe itself lives in logo-universe.mjs so that tv-harvest.mjs resolves
// exactly the same keys this builder asks for; only the CLI filtering is here.
function selectUniverse() {
  let out = collectUniverse({ backupPath: BACKUP });
  if (ONLY) out = out.filter(v => ONLY.has(v.key));
  if (LIMIT) out = out.slice(0, LIMIT);
  return out;
}

// ─── 2. Fetch helpers ───────────────────────────────────────────────────────
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
const cachePath = (url) => join(CACHE, createHash('sha1').update(url).digest('hex') + '.bin');

async function getBuffer(url, { cache = true } = {}) {
  const cp = cachePath(url);
  if (cache && !NO_CACHE && existsSync(cp)) {
    const b = readFileSync(cp);
    return b.length ? b : null;
  }
  let out = null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: UA });
    clearTimeout(t);
    if (r.ok) {
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length >= 200) out = b;
    }
  } catch { /* a miss is a miss; the chain moves on */ }
  if (cache) { mkdirSync(CACHE, { recursive: true }); writeFileSync(cp, out || Buffer.alloc(0)); }
  return out;
}

async function getText(url) {
  const b = await getBuffer(url);
  return b ? b.toString('utf8') : null;
}

// Some sites (Capitec among them) refuse a plain fetch but render fine in the
// headless Chrome the smokes already depend on. spawnSync BLOCKS the event loop,
// so every concurrent worker stalls for its whole duration — keep the timeout
// tight, and only reach for this when a plain fetch produced nothing at all.
function chromeDom(url) {
  const cp = cachePath('DOM:' + url);
  if (!NO_CACHE && existsSync(cp)) { const b = readFileSync(cp); return b.length ? b.toString('utf8') : null; }
  const res = spawnSync(CHROME, [
    '--headless=new', '--disable-gpu', '--virtual-time-budget=5000', '--dump-dom', url,
  ], { encoding: 'utf8', timeout: 25000, maxBuffer: 64 * 1024 * 1024 });
  const dom = res.stdout && res.stdout.length > 500 ? res.stdout : null;
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cp, dom || '');
  return dom;
}

// Square icons only. og:image is deliberately NOT read: it is a wide banner or a
// wordmark, and a 5:1 wordmark shrunk into a 34px square is the unreadable
// smudge the pack was rejected for. Icons are square by construction.
function iconLinksFrom(html, base) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["'][^"']*\b(?:apple-touch-icon(?:-precomposed)?|icon|shortcut icon|mask-icon)\b[^"']*["']/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!href) continue;
    const sz = +((tag.match(/sizes\s*=\s*["'](\d+)/i) || [])[1] || 0);
    try { out.push({ url: new URL(href[1], base).href, sz }); } catch { /* junk href */ }
  }
  for (const m of html.matchAll(/<meta\b[^>]*name=["']msapplication-TileImage["'][^>]*>/gi)) {
    const c = m[0].match(/content\s*=\s*["']([^"']+)["']/i);
    if (c) { try { out.push({ url: new URL(c[1], base).href, sz: 0 }); } catch { /* junk */ } }
  }
  // NOT scraped: any `*logo*.svg|png` in the page body. That was tried, and it is
  // the one source in this pipeline that can return ANOTHER COMPANY'S mark —
  // corporate sites carry portfolio, partner and sponsor logos. It shipped
  // Stellenbosch FC's crest as Remgro and a stock play-button as Bidvest, and it
  // did not rescue a single one of the tickers it was added for (Anglo American,
  // Nedbank, Impala still have no square mark). A declared icon or a well-known
  // icon path can only ever be the site's own; a body image cannot be trusted,
  // and no automated check can tell the difference.
  return out;
}

// Cached by PROMISE, not by result: several tickers share a domain (dual
// listings, and every ETF of one issuer), and workers run concurrently, so
// caching the resolved value still lets N workers do the same work N times.
const siteIconCache = new Map();
function siteIcons(domain) {
  if (!siteIconCache.has(domain)) siteIconCache.set(domain, siteIconsUncached(domain));
  return siteIconCache.get(domain);
}
async function siteIconsUncached(domain) {
  const base = siteUrl(domain);
  let html = await getText(base);
  if (!html || !/<link/i.test(html)) html = await getText(`https://${domain}/`);
  if (!html || !/<link/i.test(html)) html = chromeDom(base);
  let out = [];
  if (html) {
    out = iconLinksFrom(html, base);
    const man = html.match(/<link[^>]+rel=["'][^"']*manifest[^"']*["'][^>]*href=["']([^"']+)["']/i);
    if (man) {
      try {
        const mj = await getText(new URL(man[1], base).href);
        const parsed = mj ? JSON.parse(mj) : null;
        for (const ic of (parsed && parsed.icons) || []) {
          if (ic.src) out.push({ url: new URL(ic.src, base).href, sz: +(String(ic.sizes || '').split('x')[0] || 0) });
        }
      } catch { /* manifests are frequently malformed; the <link> icons stand */ }
    }
  }
  // Well-known default paths, which a great many sites ship without declaring.
  for (const p of WELL_KNOWN_ICON_PATHS) out.push({ url: siteUrl(domain, p), sz: 0, guess: true });
  const seen = new Set();
  return out.filter(i => !seen.has(i.url) && seen.add(i.url)).slice(0, 14);
}

// ─── 3. Quality gate ────────────────────────────────────────────────────────
const MIN_EDGE = 48;      // below this the art is a blurry smudge at 34px
const MAX_ASPECT = 2.6;   // a true banner wordmark; a tall glyph is fine
// The mark is shown in a 34px square, where a line of type turns to mush. This
// is the gate the owner's "squished low quality" rejection needed — see
// strokeRuns() for the measured separation. Ship a clean monogram instead of an
// illegible lockup.
const MAX_RUNS = 4.5;
function inkAspect(img) {
  const box = inkBox(img);
  if (!box) return null;
  return { box, aspect: Math.max(box.w / box.h, box.h / box.w) };
}
function gateArt(img) {
  if (!img) return 'undecodable';
  if (img.w < MIN_EDGE || img.h < MIN_EDGE) return `too small (${img.w}x${img.h})`;
  const st = colourStats(img);
  if (st.coverage < 0.02) return `empty (${st.coverage.toFixed(3)} ink)`;
  // A tile whose every opaque pixel is white renders as a blank square.
  if (st.coverage > 0.85 && st.meanLum > 0.95 && st.meanSat < 0.06) return 'all-white art';
  // ...and so does a tile that is one flat colour with no mark on it at all,
  // which is what Discovery's site icon turned out to be: JSE-DSY.png shipped
  // with lumRange 0.000 — a plain tan square. A blank tile is strictly worse
  // than a monogram, which at least says which instrument the row is.
  if (st.coverage > 0.85 && st.lumRange < 0.06) return `flat tile (lumRange ${st.lumRange.toFixed(3)})`;
  const ia = inkAspect(img);
  if (!ia) return 'no ink';
  if (ia.box.w < 12 || ia.box.h < 12) return `ink too small (${ia.box.w}x${ia.box.h})`;
  if (ia.aspect > MAX_ASPECT) return `wordmark (${ia.aspect.toFixed(1)}:1)`;
  // Measured on the mark itself, i.e. after any white ground is knocked out —
  // on the raw canvas a solid tile always scores 1 and the gate never fires.
  const bare = knockOutWhite(img);
  const box2 = inkBox(bare);
  const runs = strokeRuns(box2 ? crop(bare, box2) : bare);
  if (runs > MAX_RUNS) return `type lockup (${runs.toFixed(1)} runs/row)`;
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────
const universe = selectUniverse();
console.log(`universe: ${universe.length} keys`);

const jobs = universe.map(u => ({ ...u, chain: chainFor(u.market, u.ticker) }));

async function pool(items, n, fn, label) {
  const it = items[Symbol.iterator]();
  let done = 0;
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      const { value, done: end } = it.next();
      if (end) return;
      await fn(value);
      if (++done % 200 === 0) process.stderr.write(`  ${label} ...${done}/${items.length}\n`);
    }
  });
  await Promise.all(workers);
}

const report = [];

// ─── Brand colour for the monogram fallback ─────────────────────────────────
// Keyed MARKET:TICKER -> { rgb, score }. Highest-scoring sample wins: a
// saturated colour drawn from a decent number of pixels beats a near-grey or a
// couple of anti-aliased edge pixels.
const brandColour = new Map();
const hex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
function rememberBrandColour(key, img) {
  const bare = knockOutWhite(img);
  const box = inkBox(bare);
  const mark = box ? crop(bare, box) : bare;
  const st = colourStats(mark);
  if (!st.opaque) return;
  const rgb = st.chroma || st.meanColour;
  const [, s] = rgbToHsl(...rgb);
  const score = s * Math.min(1, st.opaque / 400);
  const cur = brandColour.get(key);
  if (!cur || score > cur.score) brandColour.set(key, { rgb, score });
}

// Decode a batch of fetched candidates. PNG goes through the in-repo decoder;
// everything else (ico, svg, webp, jpeg, interlaced png) goes to Chrome.
function decodeAll(cands) {
  const out = new Map();
  const needChrome = [];
  cands.forEach((c, i) => {
    const a = analysePng(c.buf);
    if (a && !a.unsupported) {
      const img = decodeRGBA(c.buf);
      if (img) { out.set(i, img); return; }
    }
    needChrome.push({ key: String(i), buf: c.buf });
  });
  if (needChrome.length) {
    for (const [id, r] of decodeBatch(needChrome)) {
      const img = decodeRGBA(r.buf);
      if (img) out.set(+id, img);
    }
  }
  return out;
}

// Squareness beats resolution. A site that ships both a 512px wordmark and a
// 128px square app icon should give up the app icon: at 34px the extra pixels of
// the wordmark buy nothing and its shape costs legibility.
const squarish = (c) => (c.aspect <= 1.35 ? 0 : 1);
function bestOf(list) {
  return list.slice().sort((a, b) => squarish(a) - squarish(b) || b.area - a.area || a.rank - b.rank)[0];
}

// One resolution round: fetch the given candidates, decode them together, gate
// each, and hand back the survivors per key.
async function round(work, label) {
  const flat = [];
  await pool(work, 12, async (w) => {
    for (const c of w.cands) {
      if (c.expand) {
        for (const ic of await siteIcons(c.domain)) {
          const buf = await getBuffer(ic.url);
          if (buf) flat.push({ key: w.key, via: `site:${c.domain}`, url: ic.url, buf });
        }
      } else {
        const buf = await getBuffer(c.url);
        if (buf) flat.push({ key: w.key, via: c.source, url: c.url, buf });
      }
    }
  }, label);
  const imgs = decodeAll(flat);
  const perKey = new Map();
  flat.forEach((c, i) => {
    const img = imgs.get(i);
    if (!img) return;
    const bad = gateArt(img);
    if (bad) {
      report.push({ key: c.key, status: 'reject', via: c.via, why: bad });
      // Rejected art is still evidence of the brand's colour. Several strong
      // brands (Nedbank, Woolworths, Sanlam, Satrix) publish only a wordmark, so
      // they can never pass the legibility gate — but their monogram can at
      // least be the right colour instead of a hash of the ticker.
      rememberBrandColour(c.key, img);
      return;
    }
    const arr = perKey.get(c.key) || perKey.set(c.key, []).get(c.key);
    arr.push({ ...c, img, area: img.w * img.h, aspect: (inkAspect(img) || { aspect: 9 }).aspect, rank: i });
  });
  return perKey;
}

// Round 1 — the single cheap lookup per key (provider or favicon service). Most
// keys end here, which is the point: expanding every domain's icon set up front
// meant ~400 site fetches plus a blocking Chrome launch per bot-walled host,
// for art that was about to be thrown away anyway.
const r1 = await round(jobs.map(j => ({ key: j.key, cands: j.chain.filter(c => c.round !== 2) })), 'lookup');
console.log(`round 1 resolved ${r1.size} keys`);

// Round 2 — only for keys with nothing good yet. "Good" means big enough that a
// round-2 source could not meaningfully beat it. Because this round is skipped
// whenever round 1 already produced solid art, a source marked round 2 can only
// ever ADD a mark where there was none; it can never replace an accepted one.
const GOOD_EDGE = 96;
const needMore = jobs.filter((j) => {
  const hit = r1.get(j.key);
  if (!hit) return true;
  const b = bestOf(hit);
  return Math.min(b.img.w, b.img.h) < GOOD_EDGE || b.aspect > 1.35;
}).filter(j => j.chain.some(c => c.round === 2));
console.log(`round 2 for ${needMore.length} keys`);
const r2 = await round(needMore.map(j => ({
  key: j.key,
  cands: j.chain.filter(c => c.round === 2).map(c => (c.source === 'site' ? { ...c, expand: true } : c)),
})), 'round2');

const manifest = {};
const writtenBufs = new Map();
const fileByDigest = new Map();
if (!DRY && !existsSync(LOGOS)) mkdirSync(LOGOS, { recursive: true });

// Sorted so the key that OWNS a shared tile's filename is a property of the
// pack, not of whatever order the universe happened to be collected in.
jobs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

for (const job of jobs) {
  const usable = [...(r1.get(job.key) || []), ...(r2.get(job.key) || [])];
  if (!usable.length) {
    // No legible mark exists for this instrument. Ship the brand's colour if the
    // rejected art revealed one, so the monogram reads as a deliberate chip
    // rather than a gap. A deep ground is used for the same reason composed
    // tiles use one: the monogram's letters are drawn in white on top.
    const bc = brandColour.get(job.key);
    if (bc && bc.score > 0.12) manifest[job.key] = { c: hex(deepen(bc.rgb)) };
    report.push({ key: job.key, status: 'monogram', via: bc ? 'brand-colour' : '-', why: 'no legible mark' });
    continue;
  }
  const best = bestOf(usable);
  const tile = composeTile(best.img, TILE);
  // Gate the OUTPUT as well as the input. Art can pass every input check and
  // still compose to a blank chip — Mirvac's icon is a near-white mark on a
  // white ground, so the tile came out uniformly white and shipped as an empty
  // square. Whatever the input looked like, a tile with no internal contrast is
  // not a logo.
  const ts = colourStats(tile);
  if (ts.lumRange < 0.08) {
    report.push({ key: job.key, status: 'reject', via: best.via, why: `blank tile (lumRange ${ts.lumRange.toFixed(3)})` });
    rememberBrandColour(job.key, best.img);
    const bc2 = brandColour.get(job.key);
    if (bc2 && bc2.score > 0.12) manifest[job.key] = { c: hex(deepen(bc2.rgb)) };
    report.push({ key: job.key, status: 'monogram', via: bc2 ? 'brand-colour' : '-', why: 'composed blank' });
    continue;
  }
  const outBuf = tileToPng(tile);
  // Identical bytes are stored ONCE. Whole issuer families compose to the same
  // tile — 101 iShares funds, 52 Satrix funds — and writing a private copy per
  // ticker was 458 redundant files. The first key (in sorted order, so it is
  // stable across rebuilds) owns the filename; the rest point at it.
  const digest = createHash('sha256').update(outBuf).digest('hex');
  let file = fileByDigest.get(digest);
  if (!file) {
    file = `${job.market}-${job.ticker}.png`;
    fileByDigest.set(digest, file);
    if (!DRY) writeFileSync(join(LOGOS, file), outBuf);
  }
  writtenBufs.set(job.key, outBuf);
  manifest[job.key] = { f: file };
  report.push({ key: job.key, status: 'ok', via: best.via, why: `${best.img.w}x${best.img.h} ${tile.kind}${tile.inked ? '+ink' : ''}`, url: best.url });
}

// One issuer, one mark: point the aliases at the canonical file.
for (const [alias, src] of Object.entries(CANONICAL_ART)) {
  if (!manifest[src] || !manifest[src].f) continue;
  const own = manifest[alias] && manifest[alias].f;
  if (own && own !== manifest[src].f && !DRY && existsSync(join(LOGOS, own))) unlinkSync(join(LOGOS, own));
  manifest[alias] = { f: manifest[src].f };
}

// ─── Same company, same mark ────────────────────────────────────────────────
// A key with no art of its own inherits the art of a key that resolved and
// shares its DOMAIN. Domain equality is the definition of "same company" used
// everywhere else in this pipeline, so this cannot merge two brands: Capitec's
// preference share (CPIP) takes Capitec's mark, Absa's (ABSP, BGA) take Absa's,
// and every Satrix fund that upstream had no slug for takes the Satrix mark its
// siblings already carry.
//
// It only ever FILLS a gap — a key that resolved keeps exactly what it resolved
// — and domainFor() returns null for US keys, so the US pack cannot be touched.
// Alternate JSE codes and the SA fund ranges are almost the whole population.
{
  const fileByDomain = new Map(); // domain -> file, from keys that DID resolve
  for (const job of jobs) {
    const entry = manifest[job.key];
    if (!entry || !entry.f) continue;
    const d = domainFor(job.market, job.ticker);
    if (d && !fileByDomain.has(d)) fileByDomain.set(d, entry.f);
  }
  let filled = 0;
  for (const job of jobs) {
    if (manifest[job.key] && manifest[job.key].f) continue;
    const d = domainFor(job.market, job.ticker);
    const f = d && fileByDomain.get(d);
    if (!f) continue;
    manifest[job.key] = { f };
    // Reported as `alias`, not `ok`: these keys resolved no art of their own, so
    // counting them under ok would inflate the tile-kind histogram with entries
    // that have no tile of their own.
    report.push({ key: job.key, status: 'alias', via: 'domain-sibling', why: `shares ${d}` });
    filled++;
  }
  console.log(`domain-sibling fallback filled ${filled} keys`);
}

// ─── 4. Rewrite the manifest block, bytes-exact outside the markers ─────────
const START = '// <<< LOGO_MANIFEST_START';
const END = '// <<< LOGO_MANIFEST_END';
if (!DRY) {
  const pcPath = join(ROOT, 'pb-content.js');
  const buf = readFileSync(pcPath);
  const s = buf.indexOf(Buffer.from(START));
  const e = buf.indexOf(Buffer.from(END));
  if (s < 0 || e < 0) throw new Error('LOGO_MANIFEST markers not found in pb-content.js');
  // Compact encoding: an entry whose file is the DEFAULT path for its key is
  // written as a bare 1 and rebuilt by logoFor(). The manifest is ~78% of
  // pb-content.js, which the app parses on every cold start, and spelling out
  // "US-AAPL.png" next to the key "US:AAPL" was pure repetition.
  const defaultFile = k => `${k.replace(':', '-')}.png`;
  const entries = Object.keys(manifest).sort().map((k) => {
    const v = manifest[k];
    const encoded = (v.f && v.f === defaultFile(k)) ? '1' : JSON.stringify(v);
    return `  ${JSON.stringify(k)}: ${encoded},`;
  }).join('\n');
  const block = Buffer.from(`${START}\nconst LOGO_MANIFEST = {\n${entries}\n};\n`);
  writeFileSync(pcPath, Buffer.concat([buf.slice(0, s), block, buf.slice(e)]));

  const keep = new Set(Object.values(manifest).map(v => v.f));
  for (const f of readdirSync(LOGOS)) {
    if (f.endsWith('.png') && !keep.has(f)) unlinkSync(join(LOGOS, f));
  }

  // Bump the logo cache. Filenames are stable across rebuilds and sw.js serves
  // /logos/ cache-first, so WITHOUT this an installed PWA keeps serving the old
  // art forever — a rebuild would look correct in a fresh browser and change
  // nothing on the owner's phone. This was a documented manual step; a manual
  // step that is invisible when skipped is a step that gets skipped.
  const swPath = join(ROOT, 'sw.js');
  const sw = readFileSync(swPath, 'utf8');
  const bumped = sw.replace(/(const LOGO_CACHE\s*=\s*'playbook-logos-v)(\d+)(')/,
    (_, a, n, c) => a + (+n + 1) + c);
  if (bumped === sw) throw new Error('could not bump LOGO_CACHE in sw.js — check the constant');
  writeFileSync(swPath, bumped);
  console.log('bumped LOGO_CACHE ->', (bumped.match(/playbook-logos-v\d+/) || [])[0]);
}

// ─── 5. Contact sheet — the acceptance gate ─────────────────────────────────
if (!DRY) {
  const ok = report.filter(r => r.status === 'ok');
  const rows = ok.map(r => {
    const [market, ticker] = r.key.split(':');
    return `<figure><img class="big" src="./${manifest[r.key].f}" alt=""><img class="sm" src="./${manifest[r.key].f}" alt="">
      <figcaption><b>${ticker}</b> <span class="m">${market}</span><br><span class="v">${r.via} · ${r.why}</span></figcaption></figure>`;
  }).join('\n');
  writeFileSync(join(LOGOS, 'contact-sheet.html'), `<!doctype html><meta charset="utf-8">
<title>Logo pack — review</title>
<style>body{background:#09090b;color:#fafafa;font:14px system-ui;padding:24px}
h1{font-size:18px;margin:0 0 4px}p{color:#a1a1aa;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}
figure{background:#18181b;border:1px solid #27272a;border-radius:12px;padding:12px;margin:0;text-align:center}
img{object-fit:contain;border-radius:22%}
.big{width:72px;height:72px}.sm{width:34px;height:34px;margin-left:8px;vertical-align:bottom}
figcaption{margin-top:8px;font-size:12px}.m{color:#71717a}.v{color:#71717a;font-size:10px}</style>
<h1>Logo pack — ${Object.keys(manifest).length} marks</h1>
<p>Check every mark against its ticker. A wrong-company logo returns HTTP 200 and passes every automated check — this page is the only thing that catches it.</p>
<div class="grid">${rows}</div>`);
}

// ─── 6. Summary ─────────────────────────────────────────────────────────────
const byStatus = {};
for (const r of report) (byStatus[r.status] ||= []).push(r);
for (const s of ['reject', 'monogram']) {
  const rows = byStatus[s] || [];
  console.log(`\n${s.toUpperCase()} (${rows.length})`);
  for (const r of rows.slice(0, 120)) console.log('  ', r.key.padEnd(16), (r.via || '').padEnd(24), r.why || '');
  if (rows.length > 120) console.log(`   ...${rows.length - 120} more`);
}
console.log(`\nOK ${(byStatus.ok || []).length} + ${(byStatus.alias || []).length} alias` +
  ` = ${(byStatus.ok || []).length + (byStatus.alias || []).length} instruments with a mark`);
const kinds = {};
for (const r of byStatus.ok || []) { const k = r.why.split(' ')[1] || '?'; kinds[k] = (kinds[k] || 0) + 1; }
console.log('  tile kinds:', JSON.stringify(kinds));
console.log(`\n${DRY ? 'DRY RUN — nothing written' : `wrote ${Object.keys(manifest).length} logos`}`);

// ─── Duplicate-art report ───────────────────────────────────────────────────
// Sharing art across one issuer's funds is CORRECT (a Satrix umbrella logo on
// every Satrix ETF). A group spanning DIFFERENT issuers is not — that is the
// signature of a provider answering with a generated placeholder, which is how
// three unrelated JSE companies came back byte-identical from one service.
{
  const byHash = new Map();
  for (const [key, buf] of writtenBufs) {
    const h = createHash('sha256').update(buf).digest('hex');
    (byHash.get(h) || byHash.set(h, []).get(h)).push(key);
  }
  const groups = [...byHash.values()].filter(g => g.length >= 2).sort((a, b) => b.length - a.length);
  console.log(`\nSHARED ART (${groups.length} groups)`);
  for (const g of groups.slice(0, 40)) {
    const issuers = new Set(g.map(k => {
      const [m, t] = k.split(':');
      return issuerFor(t) || domainFor(m, t) || (CANONICAL_ART[k] ? 'canonical' : k);
    }));
    console.log(`  ${String(g.length).padStart(3)}x ${issuers.size > 1 ? 'MIXED' : '     '} ${g.slice().sort().slice(0, 12).join(' ')}`);
  }
}
// Fail loudly if a non-US market ever resolved through a bare ticker.
const illegal = report.filter(r => r.status === 'ok' && r.via === 'parqet' && !r.key.startsWith('US:'));
if (illegal.length) {
  console.error('\nFATAL: bare-ticker lookups outside US:', illegal.map(r => r.key).join(', '));
  process.exit(1);
}
