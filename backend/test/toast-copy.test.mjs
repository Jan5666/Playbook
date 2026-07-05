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

// ── anti-drift: usePortfolio decoupled from toast (Task 2) ────────────────────
function sliceFn(marker) {
  const s = src.indexOf(marker);
  if (s < 0) return null;
  const e = src.indexOf('\n}', s);
  return src.slice(s, e);
}

test('anti-drift: usePortfolio takes no toast param and calls no toast()', () => {
  assert.ok(/function usePortfolio\(fxRates\)\s*\{/.test(src), 'usePortfolio signature should be (fxRates)');
  const body = sliceFn('function usePortfolio(fxRates)');
  assert.ok(body && !/\btoast\(/.test(body), 'usePortfolio body must not call toast()');
});

test('anti-drift: Piece 1 — useToastEvents replaces the per-render withToast wrappers', () => {
  // the standalone withToast factory and all its per-render wrappers are gone
  assert.ok(!/const withToast = useCallback\(/.test(src), 'the standalone withToast useCallback helper must be gone');
  assert.ok(!/=\s*withToast\(/.test(src), 'no per-render withToast(...) wrappers may remain');
  // the helper exists and builds its wrappers once, keeping impls+toast current via refs
  assert.ok(/function useToastEvents\(impls, toast\)\s*\{/.test(src), 'useToastEvents(impls, toast) helper should exist');
  const body = sliceFn('function useToastEvents(');
  assert.ok(body && /useMemo\(\(\)\s*=>/.test(body) && /\},\s*\[\]\);/.test(body),
    'useToastEvents should build its wrappers in a useMemo([]) (stable identity)');
  assert.ok(body && /implsRef\.current\s*=\s*impls/.test(body) && /toastRef\.current\s*=\s*toast/.test(body),
    'useToastEvents should keep impls + toast current via refs');
  // App wires actions through the helper and still calls usePortfolio at the CALL SITE (fixes nit #2)
  assert.ok(/useToastEvents\(/.test(src), 'App should wire actions through useToastEvents(...)');
  assert.ok(/const _p = usePortfolio\(fxRates\);/.test(src), 'App should call usePortfolio(fxRates) at the call site');
  assert.ok(!/usePortfolio\(fxRates, toast\)/.test(src), 'the old usePortfolio(fxRates, toast) call must be gone');
});

test('anti-drift: addPosition reads live store for C4, not the stale closure', () => {
  const body = sliceFn('const addPosition = async');
  assert.ok(body && /PBStore\.getCollection\('positions'\)/.test(body),
    'addPosition should derive existed from the live store');
  assert.ok(body && !/toast\(positions\.find/.test(body), 'the C4 stale-closure toast must be gone');
});

// ── anti-drift: usePushBackend decoupled (Task 3) ─────────────────────────────
test('anti-drift: usePushBackend takes no toast param and calls no toast()', () => {
  assert.ok(/function usePushBackend\(pushBackend, setPushBackend, alerts, notifPerm\)\s*\{/.test(src),
    'usePushBackend signature should drop the toast param');
  const body = sliceFn('function usePushBackend(');
  assert.ok(body && !/\btoast\(/.test(body), 'usePushBackend body must not call toast()');
});

// ── anti-drift: usePriceFeed + saveBackupFile decoupled (Task 4) ──────────────
test('anti-drift: usePriceFeed takes no toast param and calls no toast()', () => {
  assert.ok(/function usePriceFeed\(order, fetchKey\)\s*\{/.test(src),
    'usePriceFeed signature should be (order, fetchKey)');
  const body = sliceFn('function usePriceFeed(');
  assert.ok(body && !/\btoast\(/.test(body), 'usePriceFeed body must not call toast()');
});

test('anti-drift: saveBackupFile takes no toast param and calls no toast()', () => {
  assert.ok(/async function saveBackupFile\(jsonString\)\s*\{/.test(src),
    'saveBackupFile signature should be (jsonString)');
  const body = sliceFn('async function saveBackupFile(');
  assert.ok(body && !/\btoast\(/.test(body), 'saveBackupFile body must not call toast()');
});

test('anti-drift: App toasts the one feed-unreachable message off failStreak', () => {
  assert.ok(/failStreak === 2/.test(src), 'App should key the feed toast off failStreak === 2');
  assert.ok(!/toast\('Price refresh failed'\)/.test(src), "the separate 'Price refresh failed' toast must be gone");
});
