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

test('PBContent.RULES is a well-formed section array', () => {
  assert.ok(Array.isArray(PBContent.RULES), 'RULES is an array');
  assert.ok(PBContent.RULES.length > 0, 'RULES non-empty');
  const ids = PBContent.RULES.map(s => s.id);
  assert.ok(ids.every(id => typeof id === 'string' && id.length), 'every section has a string id');
  assert.strictEqual(new Set(ids).size, ids.length, 'section ids are unique');
  for (const s of PBContent.RULES) {
    assert.ok(typeof s.heading === 'string' && s.heading.length, `section ${s.id} has a heading`);
    assert.ok(Array.isArray(s.bullets) && s.bullets.length, `section ${s.id} has bullets`);
    for (const b of s.bullets) {
      assert.ok(typeof b.text === 'string' && b.text.length, `bullet in ${s.id} has text`);
      if ('strong' in b) assert.ok(typeof b.strong === 'string', `strong in ${s.id} is a string`);
    }
  }
});

test('PBContent.RULES has the three expected sections with the right bullet counts', () => {
  const byId = id => PBContent.RULES.find(s => s.id === id);
  assert.deepStrictEqual(PBContent.RULES.map(s => s.id), ['trim', 'thesisBreak', 'saTax'], 'ids in order');
  assert.strictEqual(byId('trim').bullets.length, 5, 'trim has 5 bullets');
  assert.strictEqual(byId('thesisBreak').bullets.length, 5, 'thesisBreak has 5 bullets');
  assert.strictEqual(byId('saTax').bullets.length, 4, 'saTax has 4 bullets');
  assert.ok(byId('trim').bullets.every(b => typeof b.strong === 'string'), 'every trim bullet has a bold lead-in');
});

// ── Anti-drift source guards: the content must live only in pb-content.js ──────
import { readFileSync } from 'node:fs';
const appSrc = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');

test('app.js no longer defines the content blocks inline', () => {
  assert.ok(!appSrc.includes('const RIBBON_CATALOG = ['), 'RIBBON_CATALOG not inline');
  assert.ok(!appSrc.includes('const RIBBON_CATALOG_MAP = Object.fromEntries'), 'RIBBON_CATALOG_MAP not inline');
  assert.ok(!appSrc.includes('const INDICATOR_INFO = {'), 'INDICATOR_INFO not inline');
  assert.ok(!appSrc.includes('const BUILTIN_MACRO_2026 = ['), 'BUILTIN_MACRO_2026 not inline');
  assert.ok(!appSrc.includes('Thesis-break triggers'), 'Rules headings not inline');
  assert.ok(!appSrc.includes('bank profits') && !appSrc.includes('R80k of gains untaxed'), 'Rules prose not inline');
});

test('app.js delegates the content blocks to PBContent', () => {
  assert.ok(appSrc.includes('const RIBBON_CATALOG = PBContent.RIBBON_CATALOG'), 'binds RIBBON_CATALOG');
  assert.ok(appSrc.includes('const RIBBON_CATALOG_MAP = PBContent.RIBBON_CATALOG_MAP'), 'binds RIBBON_CATALOG_MAP');
  assert.ok(appSrc.includes('const INDICATOR_INFO = PBContent.INDICATOR_INFO'), 'binds INDICATOR_INFO');
  assert.ok(appSrc.includes('const BUILTIN_MACRO_2026 = PBContent.BUILTIN_MACRO_2026'), 'binds BUILTIN_MACRO_2026');
  assert.ok(appSrc.includes('const RULES = PBContent.RULES'), 'binds RULES');
});
