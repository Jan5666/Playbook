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
