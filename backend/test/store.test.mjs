import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PBStore = require('../../pb-store.js');

test('createStore: getState returns initial, setState shallow-merges', () => {
  const s = createStoreOf({ a: 1, b: 2 });
  assert.deepStrictEqual(s.getState(), { a: 1, b: 2 });
  s.setState({ b: 9 });
  assert.deepStrictEqual(s.getState(), { a: 1, b: 9 });
});

test('createStore: setState accepts an updater fn', () => {
  const s = createStoreOf({ n: 1 });
  s.setState(prev => ({ n: prev.n + 1 }));
  assert.strictEqual(s.getState().n, 2);
});

test('createStore: setState replaces the top-level reference', () => {
  const s = createStoreOf({ a: 1 });
  const before = s.getState();
  s.setState({ a: 2 });
  assert.notStrictEqual(s.getState(), before);
});

test('createStore: subscribe fires on change; unsubscribe stops it', () => {
  const s = createStoreOf({ a: 1 });
  let hits = 0;
  const unsub = s.subscribe(() => { hits++; });
  s.setState({ a: 2 });
  s.setState({ a: 3 });
  assert.strictEqual(hits, 2);
  unsub();
  s.setState({ a: 4 });
  assert.strictEqual(hits, 2);
});

test('mergePrices: merges and preserves unchanged quote references', () => {
  PBStore.setPricesMap({});
  const aQuote = { price: 10 };
  const bQuote = { price: 20 };
  PBStore.mergePrices({ 'US:A': aQuote, 'US:B': bQuote });
  // a tick on B only
  const bQuote2 = { price: 21 };
  PBStore.mergePrices({ 'US:B': bQuote2 });
  const prices = PBStore.getPrices();
  assert.strictEqual(prices['US:A'], aQuote, 'unchanged symbol keeps its ref');
  assert.strictEqual(prices['US:B'], bQuote2, 'changed symbol updated');
});

test('setPricesMap: replaces the whole prices slice', () => {
  PBStore.setPricesMap({ 'US:X': { price: 1 } });
  assert.deepStrictEqual(Object.keys(PBStore.getPrices()), ['US:X']);
});

// helper: expose createStore via the public API
function createStoreOf(init) { return PBStore.createStore(init); }

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(__dir, '..', '..', 'app.js'), 'utf8');

test('anti-drift: usePriceFeed no longer owns prices in React state', () => {
  // The prices map must live in PBStore, not a useState inside usePriceFeed.
  assert.ok(!/const \[prices, setPrices\] = useState/.test(appSrc),
    'usePriceFeed should not hold prices in useState anymore');
});

test('anti-drift: usePriceFeed does not return a prices field', () => {
  const m = appSrc.match(/return \{ loading, lastUpdate, failStreak, refresh, refreshNow, mergePrices \};/);
  assert.ok(m, 'usePriceFeed return bundle should omit prices');
});

test('anti-drift: useAlertEngine no longer takes a prices param', () => {
  assert.ok(/function useAlertEngine\(alerts, fireNotification\)/.test(appSrc),
    'useAlertEngine signature should be (alerts, fireNotification)');
});

// ─── settings slice (Increment 2) ────────────────────────────────────────────
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  return {
    get: (k, d) => (map.has(k) ? map.get(k) : d),
    set: (k, v) => { map.set(k, v); writes.push([k, v]); },
    _map: map, _writes: writes,
  };
}

test('configureSettings: seeds from storage, falling back to default', () => {
  const storage = fakeStorage({ 'pb.theme.v2': 'light' });
  PBStore.configureSettings({ storage, schema: [
    { name: 'theme', key: 'pb.theme.v2', default: 'dark' },
    { name: 'displayCurrency', key: 'pb.displayCurrency.v1', default: 'USD' },
  ]});
  assert.strictEqual(PBStore.getSetting('theme'), 'light');          // stored value wins
  assert.strictEqual(PBStore.getSetting('displayCurrency'), 'USD');  // default when absent
});

test('getSettings: returns the whole settings object', () => {
  const storage = fakeStorage();
  PBStore.configureSettings({ storage, schema: [
    { name: 'theme', key: 'pb.theme.v2', default: 'dark' },
    { name: 'donutTopN', key: 'pb.donutTopN.v1', default: 10 },
  ]});
  assert.deepStrictEqual(PBStore.getSettings(), { theme: 'dark', donutTopN: 10 });
});

test('setSetting: write-through to storage + updates slice + notifies subscribers', () => {
  const storage = fakeStorage();
  PBStore.configureSettings({ storage, schema: [
    { name: 'theme', key: 'pb.theme.v2', default: 'dark' },
  ]});
  let hits = 0;
  const unsub = PBStore.subscribe(() => { hits++; });
  PBStore.setSetting('theme', 'light');
  assert.strictEqual(PBStore.getSetting('theme'), 'light');
  assert.deepStrictEqual(storage._writes, [['pb.theme.v2', 'light']]);
  assert.strictEqual(hits, 1);
  unsub();
});

test('setSetting: unchanged settings keep their reference (selector stability)', () => {
  const storage = fakeStorage();
  PBStore.configureSettings({ storage, schema: [
    { name: 'ribbonItems', key: 'pb.ribbonItems.v1', default: ['US:^SPX'] },
    { name: 'theme', key: 'pb.theme.v2', default: 'dark' },
  ]});
  const ribbonBefore = PBStore.getSetting('ribbonItems');
  PBStore.setSetting('theme', 'light');
  assert.strictEqual(PBStore.getSetting('ribbonItems'), ribbonBefore,
    'untouched setting keeps its reference after a sibling changes');
});

test('setSetting: unknown name is a safe no-op', () => {
  const storage = fakeStorage();
  PBStore.configureSettings({ storage, schema: [
    { name: 'theme', key: 'pb.theme.v2', default: 'dark' },
  ]});
  assert.doesNotThrow(() => PBStore.setSetting('nope', 1));
  assert.strictEqual(PBStore.getSetting('nope'), undefined);
  assert.strictEqual(storage._writes.length, 0, 'no write for unknown setting');
});

test('anti-drift: migrated settings no longer use usePersistedState', () => {
  for (const k of ['pb.theme.v2','pb.iconTheme.v1','pb.perplexityKey.v1','pb.pushBackend.v1',
    'pb.displayCurrency.v1','pb.donutPalette.v1','pb.donutTopN.v1','pb.ribbonItems.v1',
    'pb.ribbonMode.v1','pb.tabOrder.v2','pb.hiddenTabs.v1']) {
    const re = new RegExp("usePersistedState\\('" + k.replace(/\./g, '\\.') + "'");
    assert.ok(!re.test(appSrc), `${k} should be migrated off usePersistedState into PBStore`);
  }
});

test('anti-drift: app.js configures PBStore settings with the LS adapter', () => {
  assert.ok(/PBStore\.configureSettings\(\{\s*schema:\s*SETTINGS_SCHEMA,\s*storage:\s*LS\s*\}\)/.test(appSrc),
    'app.js should call PBStore.configureSettings({ schema: SETTINGS_SCHEMA, storage: LS })');
});

test('anti-drift: fxRates stays usePersistedState (out of scope)', () => {
  assert.ok(/usePersistedState\('pb\.fxRates\.v1'/.test(appSrc),
    'fxRates must remain usePersistedState this increment');
});
