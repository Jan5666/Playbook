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
