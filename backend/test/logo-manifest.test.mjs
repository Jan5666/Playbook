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

test('every manifest entry has a file on disk', () => {
  for (const [key, v] of Object.entries(LOGO_MANIFEST)) {
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
  for (const [key, v] of Object.entries(LOGO_MANIFEST)) {
    const a = analysePng(readFileSync(join(LOGOS, v.f)));
    assert.ok(a, `${key}: ${v.f} is not a readable PNG`);
    assert.ok(a.w >= 64 && a.h >= 64, `${key}: ${a.w}x${a.h} is below the 64px floor`);
    assert.ok(a.alphaCoverage >= 0.12, `${key}: ${a.alphaCoverage} ink is too sparse to read at 34px`);
  }
});

test('manifest flags agree with the committed bytes', () => {
  for (const [key, v] of Object.entries(LOGO_MANIFEST)) {
    const a = analysePng(readFileSync(join(LOGOS, v.f)));
    assert.strictEqual(!!v.b, a.bleed, `${key}: bleed flag disagrees with the art`);
    assert.strictEqual(!!v.k, a.needsBacking, `${key}: needsBacking flag disagrees with the art`);
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
  for (const [key, v] of Object.entries(LOGO_MANIFEST)) {
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
