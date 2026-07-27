// Manifest ↔ filesystem integrity for the logo pack.
//
// The manifest is generated, so the failure mode is drift: a PNG deleted but
// still listed (broken image in a row), or written but unlisted (dead weight in
// the deploy). Both are caught here. The quality gate is re-asserted from the
// committed bytes so a hand-edit cannot smuggle a 16x16 favicon into the pack.
import assert from 'node:assert';
import { test } from 'node:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { analysePng } from '../../tools/png-analyse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOGOS = join(ROOT, 'logos');
// pb-content.js is a dual-mode classic script (CommonJS branch for Node tests),
// so it is loaded through createRequire rather than `import`.
const { LOGO_MANIFEST, logoFor } = createRequire(import.meta.url)(join(ROOT, 'pb-content.js'));

const onDisk = existsSync(LOGOS)
  ? readdirSync(LOGOS).filter(f => f.endsWith('.png'))
  : [];
// Two entry shapes: { f } is a tile in logos/, { c } is the brand colour for the
// monogram of an instrument that has no legible mark anywhere. Anything else is
// drift — see the shape test below.
const tiles = Object.entries(LOGO_MANIFEST).filter(([, v]) => v.f);
const chips = Object.entries(LOGO_MANIFEST).filter(([, v]) => !v.f);

test('every manifest entry has a file on disk', () => {
  for (const [key, v] of tiles) {
    assert.ok(existsSync(join(LOGOS, v.f)), `${key} → missing file ${v.f}`);
  }
});

test('every PNG on disk is listed in the manifest', () => {
  const listed = new Set(Object.values(LOGO_MANIFEST).map(v => v.f));
  for (const f of onDisk) {
    assert.ok(listed.has(f), `${f} is deployed but unlisted — dead weight`);
  }
});

test('manifest keys are MARKET:TICKER', () => {
  for (const key of Object.keys(LOGO_MANIFEST)) {
    assert.match(key, /^[A-Z]+:[A-Za-z0-9^.\-]+$/, `malformed manifest key: ${key}`);
  }
});

test('every committed logo clears the quality gate', () => {
  for (const [key, v] of tiles) {
    const a = analysePng(readFileSync(join(LOGOS, v.f)));
    assert.ok(a, `${key}: ${v.f} is not a readable PNG`);
    assert.ok(a.w >= 64 && a.h >= 64, `${key}: ${a.w}x${a.h} is below the 64px floor`);
    assert.ok(a.alphaCoverage >= 0.12, `${key}: ${a.alphaCoverage} ink is too sparse to read at 34px`);
  }
});

// THE regression pin for the white-frame defect. The old pipeline square-padded
// an 8% transparent margin around art that was already a finished opaque tile,
// and the stylesheet painted #fff behind it — so every dark brand tile rendered
// as a white frame around a smaller square (US-ASML.png measured 297x297 at
// 0.743 coverage, exactly 256^2/297^2). A tile with no transparent pixel cannot
// show a frame no matter what is painted behind it, and a square tile takes the
// CSS radius identically to every other one. Both halves are asserted from the
// committed bytes, so a rebuild that regresses either one fails here.
test('every committed logo is a square, full-bleed, opaque tile', () => {
  for (const [key, v] of tiles) {
    const a = analysePng(readFileSync(join(LOGOS, v.f)));
    assert.strictEqual(a.w, a.h, `${key}: ${a.w}x${a.h} is not square — the CSS radius would clip it unevenly`);
    assert.ok(a.alphaCoverage >= 0.995,
      `${key}: coverage ${a.alphaCoverage} — a transparent margin lets the tile behind it read as a frame`);
  }
});

test('the manifest carries no per-mark rendering flags', () => {
  // Uniformity is structural: one class, one radius, no per-mark branches. The
  // old b/k flags selected a BACKGROUND per mark, and that per-mark branching is
  // what made the pack look like three styles at once. A tile names its file and
  // nothing else; a chip names its brand colour and nothing else.
  for (const [key, v] of Object.entries(LOGO_MANIFEST)) {
    const shape = Object.keys(v).sort().join(',');
    assert.ok(shape === 'f' || shape === 'c',
      `${key}: manifest entry is ${JSON.stringify(v)} — expected exactly { f } or { c }`);
  }
});

test('brand-colour chips are deep enough for their white letters to read', () => {
  for (const [key, v] of chips) {
    assert.match(v.c, /^#[0-9a-f]{6}$/, `${key}: ${v.c} is not a hex colour`);
    const [r, g, b] = [1, 3, 5].map(i => parseInt(v.c.slice(i, i + 2), 16));
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    assert.ok(lum < 0.55, `${key}: ${v.c} (luminance ${lum.toFixed(2)}) is too light for white text`);
  }
});

test('logoFor is market-scoped and returns null for unknowns', () => {
  assert.strictEqual(logoFor('DEFINITELYNOTATICKER', 'US'), null);
  assert.strictEqual(logoFor('AAPL', null), null);
  assert.strictEqual(logoFor(null, 'US'), null);
});

// The gate now rejects all-white art (blank QQQ/ARKK tiles were the symptom),
// so no committed logo should ever measure as whiteOnly — every opaque pixel
// pure white, rendering as an empty square on the app's white tile.
test('no committed logo is whiteOnly', () => {
  for (const [key, v] of tiles) {
    const a = analysePng(readFileSync(join(LOGOS, v.f)));
    assert.ok(!a.whiteOnly, `${key}: ${v.f} is all-white — renders as a blank tile`);
  }
});

// ─── logoFor: the runtime entry point ───────────────────────────────────────
// The final review mutation-proved that the previous logoFor tests were all
// null-cases: replacing the function with `() => null`, or swapping its two
// arguments, kept every suite green. The feature could have been entirely dead
// (every instrument monogramming) with CI none the wiser. These fail on both.
test('logoFor resolves a known entry, market-scoped, arguments not swappable', () => {
  assert.deepStrictEqual(logoFor('NPN', 'JSE'), LOGO_MANIFEST['JSE:NPN']);
  assert.ok(logoFor('NPN', 'JSE'), 'a known holding must resolve — a dead logoFor fails here');
  assert.strictEqual(logoFor('JSE', 'NPN'), null, 'arguments are (ticker, market), not (market, ticker)');
});

test('the same ticker in two markets ships DIFFERENT art on disk', () => {
  // This feature exists because bare-ticker logo APIs return the wrong company:
  // MTN resolved to Vail Resorts and SOL to ReneSola, both with HTTP 200. The
  // guard belongs on the shipped bytes, not on the build-time URL.
  const jse = logoFor('SOL', 'JSE'), crypto = logoFor('SOL', 'CRYPTO');
  assert.ok(jse && crypto, 'both SOL entries must exist');
  assert.notStrictEqual(jse.f, crypto.f, 'JSE SOL (Sasol) and CRYPTO SOL (Solana) share a filename');
  const a = readFileSync(join(LOGOS, jse.f)), b = readFileSync(join(LOGOS, crypto.f));
  assert.ok(!a.equals(b), 'Sasol and Solana ship byte-identical art');
});

test('denied keys resolve to nothing rather than another company mark', () => {
  // JSE:KIO — every source returns the parent Anglo American mark for Kumba.
  assert.strictEqual(logoFor('KIO', 'JSE'), null, 'KIO must monogram, not show Anglo American');
});

test('one issuer is never rendered as several different marks', () => {
  // State Street shipped five variants across its nine funds, two of them
  // generic clipart. Any issuer family listed here must share one file.
  const FAMILIES = {
    'State Street': ['SPY', 'DIA', 'GLD', 'XLB', 'XLC', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY'],
  };
  for (const [issuer, tickers] of Object.entries(FAMILIES)) {
    const files = new Set(tickers.map(t => logoFor(t, 'US')).filter(Boolean).map(v => v.f));
    assert.strictEqual(files.size, 1,
      `${issuer} renders as ${files.size} different marks: ${[...files].join(', ')}`);
  }
});
