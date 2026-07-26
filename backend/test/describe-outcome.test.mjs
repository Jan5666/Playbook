// describeOutcome message-mapping characterization (GAPS #13)
//
// CLAUDE.md's convention: "Mutators return {ok, code, ...} outcomes — never call
// toast in the data layer. All user-facing copy lives in describeOutcome."
// `describeOutcome` is therefore the single place every toast string in the app
// is decided, and GAPS #13 recorded its coverage as "copy-only" — i.e. nothing
// checked the mapping, only that the strings existed.
//
// Two things are worth pinning, and only one of them is the copy:
//
//   1. The PARAMETERIZED branches. Fourteen cases interpolate or pluralize
//      (`Imported 1 position` vs `2 positions`, `entry` vs `entries`, the
//      `d.list === 'default'` fork, the `d.isIOS` fork, the `d.detail || 'error'`
//      and `d.status || '?'` fallbacks). These are the ones a refactor can break
//      silently, because the code still returns a string — just the wrong one.
//   2. The BIDIRECTIONAL code/case correspondence. A mutator returning a code
//      with no `case` is a silent no-toast: the action succeeds and the user sees
//      nothing. A `case` with no producer is dead copy. Neither is detectable by
//      reading either file alone, so this suite cross-checks both directions
//      across all 8 runtime files.
//
// HONEST NOTE ON WHAT THIS FOUND: nothing. Measured at the time of writing, the
// correspondence is already perfect — 37 producers, 37 cases, zero orphans in
// either direction. Unlike backup-roundtrip.test.mjs (which found real drift in
// verify-cloud-backup.mjs), this suite pins a clean state rather than fixing a
// broken one. That is still worth having: `describeOutcome` is 50+ lines of
// switch that grows every time a mutator is added, and the failure mode is
// invisible in the UI (a missing toast looks like a slow app, not a bug).
//
// Mechanism: Node suites never load app.js (it is a browser classic script that
// mounts React at the bottom), so the function is sliced out by source marker and
// evaluated in a `vm` — the pattern established by backup-roundtrip.test.mjs.
// `describeOutcome` is pure and has no free identifiers, so the context is empty.
//
// Note on encoding: app.js holds literal UTF-8 em dashes (U+2014) and right
// single quotes (U+2019) in its copy. Expected values here are written as \u
// escapes so this file stays ASCII-only and cannot drift by re-encoding.
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = f => readFileSync(join(ROOT, f), 'utf8');
const appSrc = read('app.js');

// Every runtime file that could return an outcome. If a new pb-*.js is added,
// add it here — the correspondence guard is only as complete as this list.
const RUNTIME_FILES = [
  'app.js', 'pb-core.js', 'pb-data.js', 'pb-store.js',
  'pb-content.js', 'pb-import.js', 'pb-views.js', 'pb-modals.js',
];

// ─── Slice the real describeOutcome out of app.js ────────────────────────────
function sliceDescribeOutcome(src) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.startsWith('function describeOutcome('));
  assert.ok(start >= 0, 'app.js still declares describeOutcome at top level');
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') { end = i; break; }   // column-0 brace closes the fn
  }
  assert.ok(end > start, 'found the end of describeOutcome');
  return lines.slice(start, end + 1).join('\n');
}
const BLOCK = sliceDescribeOutcome(appSrc);

const ctx = vm.createContext({});
vm.runInContext(BLOCK, ctx);
const describeOutcome = vm.runInContext('describeOutcome', ctx);

// All `case '...'` codes, in source order.
const CASES = [...BLOCK.matchAll(/case '([a-z0-9-]+)':/g)].map(m => m[1]);

// Every code any runtime file can actually produce. Bound to `code:` and cut at
// the first , ; or } so that same-line neighbours are not swept up: line 2025's
// `detail: e.message || 'error'` and line 2016's `notifPerm !== 'granted'` are
// NOT codes. The open-ended capture is deliberate — it is what catches codes
// built by a ternary, e.g. `code: existedBefore ? 'shares-added' : 'position-added'`.
function producedCodes() {
  const out = new Map();   // code -> "file:line"
  for (const f of RUNTIME_FILES) {
    read(f).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\bcode:([^,;}]*)/g)) {
        for (const q of m[1].matchAll(/'([a-z0-9-]+)'/g)) {
          if (!out.has(q[1])) out.set(q[1], `${f}:${i + 1}`);
        }
      }
    });
  }
  return out;
}

// ─── Contract ────────────────────────────────────────────────────────────────

test('returns null for anything that is not an outcome', () => {
  // null means "do not toast" — the App edge checks `if (m)` before toasting.
  assert.strictEqual(describeOutcome(null), null);
  assert.strictEqual(describeOutcome(undefined), null);
  assert.strictEqual(describeOutcome({}), null, 'no code field');
  assert.strictEqual(describeOutcome({ code: null }), null, 'null code');
  assert.strictEqual(describeOutcome({ code: 5 }), null, 'non-string code');
  assert.strictEqual(describeOutcome({ code: ['watch-added'] }), null, 'array code');
  assert.strictEqual(describeOutcome('watch-added'), null, 'bare string is not an outcome');
  assert.strictEqual(describeOutcome({ ok: true }), null, 'ok without a code');
});

test('returns null for an unrecognised code rather than throwing', () => {
  // A mutator inventing a code must degrade to silence, not a crash.
  assert.strictEqual(describeOutcome({ code: 'not-a-real-code' }), null);
  assert.strictEqual(describeOutcome({ code: '' }), null);
});

test('every case yields a non-empty string for a plausible payload', () => {
  // Blanket coverage over all 37 codes, so a case returning undefined (a missing
  // `return`, say) cannot hide behind the targeted assertions below.
  const payload = { added: 2, merged: 1, count: 2, ticker: 'NVDA', name: 'Core',
                    list: 'default', isIOS: false, detail: 'boom', status: 500 };
  for (const code of CASES) {
    const msg = describeOutcome({ ...payload, code });
    assert.strictEqual(typeof msg, 'string', `${code} returns a string`);
    assert.ok(msg.length > 0, `${code} returns a non-empty string`);
  }
  assert.strictEqual(CASES.length, 37, 'case count is 37 (update this if copy is added)');
});

// ─── Pluralization and interpolation — the breakable branches ────────────────

test('positions-imported: pluralizes added, and appends merged only when truthy', () => {
  assert.strictEqual(describeOutcome({ code: 'positions-imported', added: 1 }),
    'Imported 1 position');
  assert.strictEqual(describeOutcome({ code: 'positions-imported', added: 2 }),
    'Imported 2 positions');
  assert.strictEqual(describeOutcome({ code: 'positions-imported', added: 0 }),
    'Imported 0 positions', 'zero takes the plural form');
  assert.strictEqual(describeOutcome({ code: 'positions-imported', added: 3, merged: 2 }),
    'Imported 3 positions, merged 2');
  assert.strictEqual(describeOutcome({ code: 'positions-imported', added: 1, merged: 1 }),
    'Imported 1 position, merged 1', 'singular added with a merge suffix');
  // merged is gated on truthiness, so 0 and undefined both omit the clause.
  assert.strictEqual(describeOutcome({ code: 'positions-imported', added: 3, merged: 0 }),
    'Imported 3 positions', 'merged 0 omits the clause');
});

test('holdings-deleted: singular has no count, plural does', () => {
  assert.strictEqual(describeOutcome({ code: 'holdings-deleted', count: 1 }), 'Holding deleted');
  assert.strictEqual(describeOutcome({ code: 'holdings-deleted', count: 4 }), '4 holdings deleted');
});

test('deposits-removed: same singular/plural shape as holdings', () => {
  assert.strictEqual(describeOutcome({ code: 'deposits-removed', count: 1 }), 'Deposit removed');
  assert.strictEqual(describeOutcome({ code: 'deposits-removed', count: 3 }), '3 deposits removed');
});

test('contributions-imported: entry vs entries', () => {
  assert.strictEqual(describeOutcome({ code: 'contributions-imported', count: 1 }),
    'Imported 1 entry');
  assert.strictEqual(describeOutcome({ code: 'contributions-imported', count: 5 }),
    'Imported 5 entries');
});

test('watchlist codes interpolate the ticker', () => {
  assert.strictEqual(describeOutcome({ code: 'watch-added', ticker: 'NVDA' }), 'Added NVDA');
  assert.strictEqual(describeOutcome({ code: 'watch-removed', ticker: 'ASML' }), 'Removed ASML');
});

test('watch-already: the default list is named "watchlist", others are not named', () => {
  // The fork exists because "Already on Growth" reads wrong for the unnamed
  // default list; it must stay keyed on the literal 'default'.
  assert.strictEqual(describeOutcome({ code: 'watch-already', list: 'default' }),
    'Already on watchlist');
  assert.strictEqual(describeOutcome({ code: 'watch-already', list: 'Growth' }),
    'Already on that list');
  assert.strictEqual(describeOutcome({ code: 'watch-already' }),
    'Already on that list', 'a missing list is not the default list');
});

test('watchgroup-created: quotes the list name', () => {
  assert.strictEqual(describeOutcome({ code: 'watchgroup-created', name: 'Core' }),
    'List "Core" created');
});

test('push-unsupported: iOS gets the Add-to-Home-Screen instruction', () => {
  // The whole reason this fork exists: iOS cannot do web push in a Safari tab,
  // so the generic "not supported" message would be a dead end for Jan's phone.
  assert.strictEqual(describeOutcome({ code: 'push-unsupported', isIOS: true }),
    'On iPhone, install to Home Screen first');
  assert.strictEqual(describeOutcome({ code: 'push-unsupported', isIOS: false }),
    'Push not supported in this browser');
  assert.strictEqual(describeOutcome({ code: 'push-unsupported' }),
    'Push not supported in this browser', 'absent isIOS takes the generic branch');
});

test('push failure codes fall back rather than printing undefined', () => {
  assert.strictEqual(describeOutcome({ code: 'push-connect-failed', detail: 'DNS' }),
    'Could not connect: DNS');
  assert.strictEqual(describeOutcome({ code: 'push-connect-failed' }),
    'Could not connect: error', 'missing detail falls back to "error"');
  assert.strictEqual(describeOutcome({ code: 'push-connect-failed', detail: '' }),
    'Could not connect: error', 'empty detail falls back too');

  assert.strictEqual(describeOutcome({ code: 'push-test-failed', status: 502 }),
    'Test failed (502)');
  assert.strictEqual(describeOutcome({ code: 'push-test-failed' }),
    'Test failed (?)', 'missing status falls back to "?"');
  assert.strictEqual(describeOutcome({ code: 'push-test-failed', status: 0 }),
    'Test failed (?)', 'status 0 is falsy, so it also falls back');
});

test('fixed-copy codes are stable, including the non-ASCII ones', () => {
  // These four carry literal U+2014 / U+2019 in app.js. Asserted via \u escapes
  // so a re-encoding of app.js (mojibake, BOM churn) fails here loudly.
  assert.strictEqual(describeOutcome({ code: 'preview-readonly' }),
    'Preview mode is on \u2014 turn it off in Settings to edit your real portfolio.');
  assert.strictEqual(describeOutcome({ code: 'preview-load-failed' }),
    'Couldn\u2019t load the demo portfolio \u2014 check your connection and toggle Preview again.');
  assert.strictEqual(describeOutcome({ code: 'push-test-sent' }),
    'Test push sent \u2014 check your lock screen');
  assert.strictEqual(describeOutcome({ code: 'feed-unreachable' }),
    'Price feed unreachable \u2014 showing last known prices');

  // And a sample of the plain ones, incl. the money-path confirmations.
  assert.strictEqual(describeOutcome({ code: 'position-added' }), 'Position added');
  assert.strictEqual(describeOutcome({ code: 'shares-added' }), 'Shares added to existing position');
  assert.strictEqual(describeOutcome({ code: 'sale-recorded' }), 'Sale recorded');
  assert.strictEqual(describeOutcome({ code: 'deposit-missing-fields' }), 'Enter an amount and date');
  assert.strictEqual(describeOutcome({ code: 'alert-set' }), 'Alert set');
  assert.strictEqual(describeOutcome({ code: 'backup-saved' }), 'Backup saved');
});

test('an outcome carrying extra fields is unaffected by them', () => {
  // Mutators return richer objects than describeOutcome reads; extra keys must
  // not change the message.
  assert.strictEqual(
    describeOutcome({ ok: true, code: 'sale-recorded', proceeds: 1234.56, realized: -7.5 }),
    'Sale recorded');
});

// ─── Bidirectional correspondence + anti-drift ───────────────────────────────

test('every code a mutator can return has a case (no silent missing toast)', () => {
  const produced = producedCodes();
  const caseSet = new Set(CASES);
  const orphans = [...produced.entries()].filter(([code]) => !caseSet.has(code));
  assert.deepStrictEqual(orphans, [],
    'these codes are returned but have no describeOutcome case, so the action ' +
    'silently shows no toast:\n' +
    orphans.map(([c, at]) => `  ${c} (${at})`).join('\n'));
});

test('every case has a producer (no dead copy)', () => {
  const produced = producedCodes();
  const dead = CASES.filter(c => !produced.has(c));
  assert.deepStrictEqual(dead, [],
    `these describeOutcome cases are unreachable dead copy: ${dead.join(', ')}`);
});

test('the correspondence is exact in both directions', () => {
  const produced = producedCodes();
  assert.strictEqual(produced.size, new Set(CASES).size,
    'producer count equals case count');
  assert.strictEqual(new Set(CASES).size, CASES.length, 'no duplicate cases');
});

test('anti-drift: the copy seam stays in app.js and the data layer never toasts', () => {
  assert.ok(/^function describeOutcome\(/m.test(appSrc),
    'describeOutcome still defined in app.js');
  assert.ok(/default:\s*return null;/.test(BLOCK),
    'unknown codes still fall through to null rather than a placeholder string');

  // CLAUDE.md: user-facing copy lives ONLY here. The buckets and the data layer
  // must not resolve outcome copy themselves.
  for (const f of RUNTIME_FILES.filter(x => x !== 'app.js')) {
    assert.ok(!/describeOutcome/.test(read(f)),
      `${f} must not call describeOutcome — the App edge owns toasting`);
  }
  // And app.js only toasts at the edge: inside useToastEvents plus the two
  // direct App-level calls (preview-load-failed, feed-unreachable). Counted over
  // real code only — the declaration line and the three explanatory comments that
  // mention describeOutcome() must not inflate the count.
  const callSites = appSrc.split('\n').filter(l =>
    !l.trim().startsWith('//') &&
    !l.startsWith('function describeOutcome(') &&
    /describeOutcome\(/.test(l)
  );
  assert.strictEqual(callSites.length, 4,
    'describeOutcome has 4 call sites (2 in useToastEvents, 2 at the App edge); ' +
    'a new one means copy resolution is leaking away from the edge. Found:\n' +
    callSites.map(l => '  ' + l.trim()).join('\n'));
});
