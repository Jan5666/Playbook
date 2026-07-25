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

test('PBContent.SECTOR_ETF maps sector names to {etf, name}', () => {
  assert.ok(PBContent.SECTOR_ETF && typeof PBContent.SECTOR_ETF === 'object', 'SECTOR_ETF is an object');
  const entries = Object.entries(PBContent.SECTOR_ETF);
  assert.ok(entries.length > 0, 'SECTOR_ETF non-empty');
  for (const [sector, v] of entries) {
    assert.ok(typeof v.etf === 'string' && v.etf.length, `${sector} has a non-empty etf`);
    assert.ok(typeof v.name === 'string' && v.name.length, `${sector} has a non-empty name`);
  }
});

test('PBContent.SECTOR_TREND_WINDOWS is a list of {key, days>0}', () => {
  assert.ok(Array.isArray(PBContent.SECTOR_TREND_WINDOWS), 'SECTOR_TREND_WINDOWS is an array');
  assert.ok(PBContent.SECTOR_TREND_WINDOWS.length > 0, 'non-empty');
  for (const w of PBContent.SECTOR_TREND_WINDOWS) {
    assert.ok(typeof w.key === 'string' && w.key.length, `window has a string key`);
    assert.ok(typeof w.days === 'number' && w.days > 0, `window ${w.key} has days > 0`);
  }
});

test('PBContent.SECTOR_FWD_PE maps lowercased sectors to numbers', () => {
  assert.ok(PBContent.SECTOR_FWD_PE && typeof PBContent.SECTOR_FWD_PE === 'object', 'SECTOR_FWD_PE is an object');
  const entries = Object.entries(PBContent.SECTOR_FWD_PE);
  assert.ok(entries.length > 0, 'non-empty');
  for (const [k, v] of entries) {
    assert.strictEqual(k, k.toLowerCase(), `key "${k}" is lowercase (consumer lowercases the lookup)`);
    assert.ok(typeof v === 'number' && isFinite(v), `${k} maps to a finite number`);
  }
});

test('PBContent.MARKETS is a list of {value,label,country,exchange}', () => {
  assert.ok(Array.isArray(PBContent.MARKETS), 'MARKETS is an array');
  assert.ok(PBContent.MARKETS.length > 0, 'MARKETS non-empty');
  const values = PBContent.MARKETS.map(m => m.value);
  assert.strictEqual(new Set(values).size, values.length, 'market values are unique');
  for (const need of ['US', 'JSE', 'TFSA', 'CRYPTO']) {
    assert.ok(values.includes(need), `MARKETS includes ${need}`);
  }
  for (const m of PBContent.MARKETS) {
    for (const f of ['value', 'label', 'country', 'exchange']) {
      assert.ok(typeof m[f] === 'string' && m[f].length, `market ${m.value} has non-empty ${f}`);
    }
  }
});

test('PBContent.DISPLAY_CURRENCIES is a list of {code,sym,label} with intact symbols', () => {
  assert.ok(Array.isArray(PBContent.DISPLAY_CURRENCIES), 'DISPLAY_CURRENCIES is an array');
  const codes = PBContent.DISPLAY_CURRENCIES.map(c => c.code);
  assert.strictEqual(new Set(codes).size, codes.length, 'currency codes are unique');
  for (const need of ['USD', 'ZAR', 'GBP', 'AUD', 'EUR']) {
    assert.ok(codes.includes(need), `DISPLAY_CURRENCIES includes ${need}`);
  }
  for (const c of PBContent.DISPLAY_CURRENCIES) {
    for (const f of ['code', 'sym', 'label']) {
      assert.ok(typeof c[f] === 'string' && c[f].length, `${c.code} has non-empty ${f}`);
    }
  }
  const byCode = Object.fromEntries(PBContent.DISPLAY_CURRENCIES.map(c => [c.code, c.sym]));
  assert.strictEqual(byCode.GBP.length, 1, 'GBP symbol is a single codepoint');
  assert.strictEqual(byCode.GBP.codePointAt(0), 0x00a3, 'GBP symbol is U+00A3 (pound), not mangled');
  assert.strictEqual(byCode.EUR.codePointAt(0), 0x20ac, 'EUR symbol is U+20AC (euro), not mangled');
});

test('PBContent.CURRENCY_SYMBOLS agrees with DISPLAY_CURRENCIES', () => {
  assert.ok(PBContent.CURRENCY_SYMBOLS && typeof PBContent.CURRENCY_SYMBOLS === 'object', 'CURRENCY_SYMBOLS is an object');
  const byCode = Object.fromEntries(PBContent.DISPLAY_CURRENCIES.map(c => [c.code, c.sym]));
  assert.deepStrictEqual(
    new Set(Object.keys(PBContent.CURRENCY_SYMBOLS)),
    new Set(Object.keys(byCode)),
    'CURRENCY_SYMBOLS keys === DISPLAY_CURRENCIES codes');
  for (const [code, sym] of Object.entries(PBContent.CURRENCY_SYMBOLS)) {
    assert.strictEqual(sym, byCode[code], `CURRENCY_SYMBOLS.${code} matches the DISPLAY_CURRENCIES sym`);
  }
});

// ── Anti-drift source guards: the content must live only in pb-content.js ──────
import { readFileSync } from 'node:fs';
const appSrc = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
const modSrc = readFileSync(new URL('../../pb-modals.js', import.meta.url), 'utf8');

test('app.js no longer defines the content blocks inline', () => {
  assert.ok(!appSrc.includes('const RIBBON_CATALOG = ['), 'RIBBON_CATALOG not inline');
  assert.ok(!appSrc.includes('const RIBBON_CATALOG_MAP = Object.fromEntries'), 'RIBBON_CATALOG_MAP not inline');
  assert.ok(!appSrc.includes('const INDICATOR_INFO = {'), 'INDICATOR_INFO not inline');
  assert.ok(!appSrc.includes('const BUILTIN_MACRO_2026 = ['), 'BUILTIN_MACRO_2026 not inline');
  assert.ok(!appSrc.includes('Thesis-break triggers'), 'Rules headings not inline');
  assert.ok(!appSrc.includes('bank profits') && !appSrc.includes('R80k of gains untaxed'), 'Rules prose not inline');
  assert.ok(!appSrc.includes('const SECTOR_ETF = {'), 'SECTOR_ETF not inline');
  assert.ok(!appSrc.includes('const SECTOR_TREND_WINDOWS = ['), 'SECTOR_TREND_WINDOWS not inline');
  assert.ok(!appSrc.includes('const SECTOR_FWD_PE = {'), 'SECTOR_FWD_PE not inline');
  assert.ok(!appSrc.includes('const MARKETS = ['), 'MARKETS not inline');
  assert.ok(!appSrc.includes('const DISPLAY_CURRENCIES = ['), 'DISPLAY_CURRENCIES not inline');
  assert.ok(!appSrc.includes('const CURRENCY_SYMBOLS = {'), 'CURRENCY_SYMBOLS not inline');
});

test('app.js delegates the content blocks to PBContent', () => {
  assert.ok(appSrc.includes('const RIBBON_CATALOG = PBContent.RIBBON_CATALOG'), 'binds RIBBON_CATALOG');
  assert.ok(appSrc.includes('const RIBBON_CATALOG_MAP = PBContent.RIBBON_CATALOG_MAP'), 'binds RIBBON_CATALOG_MAP');
  assert.ok(appSrc.includes('const INDICATOR_INFO = PBContent.INDICATOR_INFO'), 'binds INDICATOR_INFO');
  assert.ok(appSrc.includes('const BUILTIN_MACRO_2026 = PBContent.BUILTIN_MACRO_2026'), 'binds BUILTIN_MACRO_2026');
  assert.ok(appSrc.includes('const RULES = PBContent.RULES'), 'binds RULES');
  // SECTOR_ETF / SECTOR_TREND_WINDOWS's only consumer (fetchSectorTrend -> SectorDetailModal)
  // moved to pb-modals.js in inc-35, so their PBContent delegation now lives in the bucket —
  // still delegated, not inlined.
  assert.ok((appSrc + modSrc).includes('const SECTOR_ETF = PBContent.SECTOR_ETF'), 'binds SECTOR_ETF');
  assert.ok((appSrc + modSrc).includes('const SECTOR_TREND_WINDOWS = PBContent.SECTOR_TREND_WINDOWS'), 'binds SECTOR_TREND_WINDOWS');
  // SECTOR_FWD_PE's only consumer (FundamentalsBlock -> sectorForwardPE) moved to pb-modals.js
  // in inc-16, so its PBContent delegation now lives in the bucket — still delegated, not inlined.
  assert.ok((appSrc + modSrc).includes('const SECTOR_FWD_PE = PBContent.SECTOR_FWD_PE'), 'binds SECTOR_FWD_PE');
  assert.ok(appSrc.includes('const MARKETS = PBContent.MARKETS'), 'binds MARKETS');
  assert.ok(appSrc.includes('const DISPLAY_CURRENCIES = PBContent.DISPLAY_CURRENCIES'), 'binds DISPLAY_CURRENCIES');
  assert.ok(appSrc.includes('const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS'), 'binds CURRENCY_SYMBOLS');
});
