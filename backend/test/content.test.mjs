import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PBContent = require('../../pb-content.js');

test('PBContent exposes the four content blocks', () => {
  assert.ok(Array.isArray(PBContent.RIBBON_CATALOG), 'RIBBON_CATALOG is an array');
  assert.ok(PBContent.RIBBON_CATALOG.length > 0, 'RIBBON_CATALOG non-empty');
  assert.ok(PBContent.RIBBON_CATALOG_MAP && typeof PBContent.RIBBON_CATALOG_MAP === 'object', 'RIBBON_CATALOG_MAP is an object');
  assert.ok(PBContent.INDICATOR_INFO && typeof PBContent.INDICATOR_INFO === 'object', 'INDICATOR_INFO is an object');
  assert.ok(Array.isArray(PBContent.BUILTIN_MACRO_2026), 'BUILTIN_MACRO_2026 is an array');
});

test('RIBBON_CATALOG keys are unique and RIBBON_CATALOG_MAP is keyed by them', () => {
  const keys = PBContent.RIBBON_CATALOG.map(r => r.key);
  assert.ok(keys.every(k => typeof k === 'string' && k.length), 'every entry has a string key');
  assert.strictEqual(new Set(keys).size, keys.length, 'keys are unique');
  assert.deepStrictEqual(new Set(Object.keys(PBContent.RIBBON_CATALOG_MAP)), new Set(keys), 'map keys === catalog keys');
});

test('INDICATOR_INFO keys are a subset of RIBBON_CATALOG keys', () => {
  const catalog = new Set(PBContent.RIBBON_CATALOG.map(r => r.key));
  for (const k of Object.keys(PBContent.INDICATOR_INFO)) {
    assert.ok(catalog.has(k), `INDICATOR_INFO key ${k} exists in RIBBON_CATALOG`);
  }
});

test('BUILTIN_MACRO_2026 entries are well-formed', () => {
  assert.ok(PBContent.BUILTIN_MACRO_2026.length > 0, 'non-empty');
  for (const e of PBContent.BUILTIN_MACRO_2026) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, `date ${e.date} is YYYY-MM-DD`);
    assert.ok(typeof e.title === 'string' && e.title.length, 'has title');
    assert.ok(typeof e.type === 'string' && e.type.length, 'has type');
  }
});

// ── Anti-drift source guards: the content must live only in pb-content.js ──────
import { readFileSync } from 'node:fs';
const appSrc = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');

test('app.js no longer defines the content blocks inline', () => {
  assert.ok(!appSrc.includes('const RIBBON_CATALOG = ['), 'RIBBON_CATALOG not inline');
  assert.ok(!appSrc.includes('const RIBBON_CATALOG_MAP = Object.fromEntries'), 'RIBBON_CATALOG_MAP not inline');
  assert.ok(!appSrc.includes('const INDICATOR_INFO = {'), 'INDICATOR_INFO not inline');
  assert.ok(!appSrc.includes('const BUILTIN_MACRO_2026 = ['), 'BUILTIN_MACRO_2026 not inline');
});

test('app.js delegates the content blocks to PBContent', () => {
  assert.ok(appSrc.includes('const RIBBON_CATALOG = PBContent.RIBBON_CATALOG'), 'binds RIBBON_CATALOG');
  assert.ok(appSrc.includes('const RIBBON_CATALOG_MAP = PBContent.RIBBON_CATALOG_MAP'), 'binds RIBBON_CATALOG_MAP');
  assert.ok(appSrc.includes('const INDICATOR_INFO = PBContent.INDICATOR_INFO'), 'binds INDICATOR_INFO');
  assert.ok(appSrc.includes('const BUILTIN_MACRO_2026 = PBContent.BUILTIN_MACRO_2026'), 'binds BUILTIN_MACRO_2026');
});
