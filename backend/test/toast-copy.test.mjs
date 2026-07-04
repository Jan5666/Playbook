// Unit tests for describeOutcome — the single toast-copy map in app.js.
//   node backend/test/toast-copy.test.mjs
//
// app.js is a browser global script (no exports); slice out the self-contained
// describeOutcome fn and eval just that block in a vm sandbox (it has no external
// refs, so the sandbox is empty). Also anti-drift source guards for the hooks
// (added in Tasks 2-4).
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '..', '..', 'app.js'), 'utf8');

const start = src.indexOf('function describeOutcome(');
if (start < 0) { console.error('FAIL: describeOutcome not found in app.js'); process.exit(1); }
const endIdx = src.indexOf('\n}', start);
const block = src.slice(start, endIdx + 2);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(block + '\nglobalThis.describeOutcome = describeOutcome;', sandbox);
const { describeOutcome } = sandbox;

test('describeOutcome: null/garbage → null (no toast)', () => {
  assert.strictEqual(describeOutcome(undefined), null);
  assert.strictEqual(describeOutcome(null), null);
  assert.strictEqual(describeOutcome({}), null);
  assert.strictEqual(describeOutcome({ code: 'nope' }), null);
});

test('describeOutcome: C4 both branches', () => {
  assert.strictEqual(describeOutcome({ ok: true, code: 'position-added' }), 'Position added');
  assert.strictEqual(describeOutcome({ ok: true, code: 'shares-added' }), 'Shares added to existing position');
});

test('describeOutcome: dynamic import counts', () => {
  assert.strictEqual(describeOutcome({ code: 'positions-imported', added: 1, merged: 0 }), 'Imported 1 position');
  assert.strictEqual(describeOutcome({ code: 'positions-imported', added: 3, merged: 2 }), 'Imported 3 positions, merged 2');
  assert.strictEqual(describeOutcome({ code: 'contributions-imported', count: 1 }), 'Imported 1 entry');
  assert.strictEqual(describeOutcome({ code: 'contributions-imported', count: 4 }), 'Imported 4 entries');
});

test('describeOutcome: pluralised deletes', () => {
  assert.strictEqual(describeOutcome({ code: 'holdings-deleted', count: 1 }), 'Holding deleted');
  assert.strictEqual(describeOutcome({ code: 'holdings-deleted', count: 3 }), '3 holdings deleted');
  assert.strictEqual(describeOutcome({ code: 'deposits-removed', count: 1 }), 'Deposit removed');
  assert.strictEqual(describeOutcome({ code: 'deposits-removed', count: 2 }), '2 deposits removed');
});

test('describeOutcome: watchlist + data fields', () => {
  assert.strictEqual(describeOutcome({ code: 'watch-added', ticker: 'AAPL' }), 'Added AAPL');
  assert.strictEqual(describeOutcome({ code: 'watch-already', list: 'default' }), 'Already on watchlist');
  assert.strictEqual(describeOutcome({ code: 'watch-already', list: 'growth' }), 'Already on that list');
  assert.strictEqual(describeOutcome({ code: 'watchgroup-created', name: 'Growth' }), 'List "Growth" created');
});

test('describeOutcome: push variants', () => {
  assert.strictEqual(describeOutcome({ code: 'push-unsupported', isIOS: true }), 'On iPhone, install to Home Screen first');
  assert.strictEqual(describeOutcome({ code: 'push-unsupported', isIOS: false }), 'Push not supported in this browser');
  assert.strictEqual(describeOutcome({ code: 'push-connect-failed', detail: 'timeout' }), 'Could not connect: timeout');
  assert.strictEqual(describeOutcome({ code: 'push-test-failed', status: 500 }), 'Test failed (500)');
  assert.strictEqual(describeOutcome({ code: 'push-test-failed' }), 'Test failed (?)');
});

test('describeOutcome: preview-* copy preserved exactly (curly apostrophe + em-dash)', () => {
  assert.strictEqual(describeOutcome({ code: 'preview-readonly' }),
    'Preview mode is on — turn it off in Settings to edit your real portfolio.');
  assert.strictEqual(describeOutcome({ code: 'preview-load-failed' }),
    'Couldn’t load the demo portfolio — check your connection and toggle Preview again.');
});

test('describeOutcome: every emitted code has copy (catalog guard)', () => {
  const codes = ['position-added','shares-added','positions-imported','sale-recorded','position-updated',
    'position-removed','holdings-deleted','contribution-logged','contribution-removed','contributions-imported',
    'deposit-missing-fields','deposit-logged','deposit-updated','deposit-removed','deposits-removed',
    'watch-added','watch-already','watch-removed','watch-removed-list','watch-added-list',
    'watchgroup-created','watchgroup-deleted','alert-set','preview-readonly','preview-load-failed',
    'push-no-url','push-not-https','push-unsupported','push-no-perm','push-connected','push-connect-failed',
    'push-test-sent','push-test-failed','push-test-error','push-disconnected','feed-unreachable','backup-saved'];
  for (const code of codes) {
    const s = describeOutcome({ code, added: 1, count: 1, ticker: 'X', list: 'default', name: 'N', status: 1, detail: 'e' });
    assert.ok(typeof s === 'string' && s.length > 0, `${code} must map to non-empty copy`);
  }
});
