// Hot Topics date math characterization (GAPS #13)
//
// `hotToDate` / `hotDayDiff` / `hotDateKey` (app.js) turn earnings + macro event
// dates into "today / tomorrow / in 3 days" copy on the Hot Topics tab. They are
// small, pure, and were untested — and they sit on the two classic date traps:
//
//   1. UTC-offset day rolling. `hotDateKey` formats a LOCAL midnight Date by
//      hand (getFullYear/getMonth/getDate) precisely because `toISOString()`
//      would roll it back a day in any positive-offset zone — Jan's own zone is
//      SAST (UTC+2), so an event on the 26th would render as the 25th. The
//      source comment says this outright; nothing enforced it. Now it does.
//   2. DST. `hotDayDiff` divides a millisecond delta by 86,400,000 and rounds.
//      Across a spring-forward boundary "tomorrow" is only 23 real hours away
//      (0.958 days) and across fall-back it is 25 (1.042). `Math.round` is what
//      makes both answer 1 — with `Math.floor` the 23-hour case would report 0
//      and tomorrow's earnings would render as "today". That rounding is
//      load-bearing and is pinned here in both directions.
//
// Mechanism: Node suites never load app.js (it is a browser classic script that
// mounts React at the bottom), so the block is sliced out by source marker and
// evaluated in a `vm` context — the pattern established by
// backup-roundtrip.test.mjs. Markers, not line numbers, so it survives drift.
//
// The vm context receives a Date subclass frozen at a chosen instant, which is
// what makes `hotDayDiff` (it reads `new Date()` internally, with no seam to
// inject) testable at all. It is a real Date subclass, so timezone and DST
// arithmetic stay real — only "now" is fixed.
//
// Timezone coverage: the TZ-sensitive assertions are re-run in three zones by
// re-spawning this file with TZ set (Node resolves the zone at startup, so a
// child process is the honest way to do it): Africa/Johannesburg (UTC+2, Jan's
// zone and the one that breaks toISOString), UTC (offset 0, where the bug hides),
// and America/Los_Angeles (negative offset, and the DST source for trap 2).
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..', '..');
const appSrc = readFileSync(join(ROOT, 'app.js'), 'utf8');

// ─── Slice the real date block out of app.js ─────────────────────────────────
// From `function hotToDate(` through the column-0 brace closing `hotDateKey`.
// That span is exactly the three functions and nothing else; they have no free
// identifiers beyond `Date`, so the vm context needs nothing else in it.
function sliceDateBlock(src) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.startsWith('function hotToDate('));
  assert.ok(start >= 0, 'app.js still declares hotToDate at top level');
  const keyAt = lines.findIndex(l => l.startsWith('function hotDateKey('));
  assert.ok(keyAt > start, 'app.js still declares hotDateKey after hotToDate');
  let end = -1;
  for (let i = keyAt + 1; i < lines.length; i++) {
    if (lines[i] === '}') { end = i; break; }   // column-0 brace closes the fn
  }
  assert.ok(end > keyAt, 'found the end of hotDateKey');
  const block = lines.slice(start, end + 1).join('\n');
  assert.ok(/function hotDayDiff\(/.test(block), 'hotDayDiff travels inside the slice');
  return block;
}
const BLOCK = sliceDateBlock(appSrc);

// Load the block with "now" frozen at a given local wall-clock instant.
// FrozenDate extends the real Date, so getFullYear/getMonth/getDate, the
// timezone offset and DST transitions all behave exactly as in the browser.
function load(nowMs) {
  class FrozenDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(nowMs);
      else super(...args);
    }
    static now() { return nowMs; }
  }
  const ctx = vm.createContext({ Date: FrozenDate });
  vm.runInContext(BLOCK + '\n;({ hotToDate, hotDayDiff, hotDateKey })', ctx);
  return vm.runInContext('({ hotToDate, hotDayDiff, hotDateKey })', ctx);
}

// Local midnight of a Y-M-D, as an epoch ms — the anchor for "today" in tests.
const localMidnight = (y, m, d) => new Date(y, m - 1, d).getTime();
const FIXED = localMidnight(2026, 7, 26);   // a quiet Sunday, no DST nearby

const TZ_ZONES = ['Africa/Johannesburg', 'UTC', 'America/Los_Angeles'];
const isChild = process.env.PB_HOT_TZ_CHILD === '1';

// ─────────────────────────────────────────────────────────────────────────────
// TZ-sensitive assertions. Run once per zone (in-process for the ambient zone,
// then re-spawned per zone below). Everything here must hold in EVERY zone.
// ─────────────────────────────────────────────────────────────────────────────
function tzSensitive() {
  const { hotToDate, hotDayDiff, hotDateKey } = load(FIXED);
  const zone = process.env.TZ || '(ambient)';
  const where = m => `${m} [TZ=${zone}]`;

  // ── Trap 1: a date-only string must survive the round trip unchanged. ──
  // This is the assertion that fails if anyone "simplifies" hotDateKey to
  // toISOString().slice(0,10): under UTC+2, local midnight of the 26th is
  // 22:00 UTC on the 25th, so ISO would answer '2026-07-25'.
  for (const s of ['2026-07-26', '2026-01-01', '2026-12-31', '2026-01-05', '2026-10-04']) {
    assert.strictEqual(hotDateKey(s), s, where(`hotDateKey round-trips ${s}`));
  }

  // Zero padding is explicit (padStart), not incidental.
  assert.strictEqual(hotDateKey('2026-01-05'), '2026-01-05', where('single-digit month and day stay padded'));

  // A full ISO timestamp is truncated to its date part — the time and the
  // trailing Z are ignored, so a UTC-evening event cannot shift a day.
  assert.strictEqual(hotToDate('2026-07-26T23:30:00Z').getDate(), 26, where('ISO timestamp keeps its date part'));
  assert.strictEqual(hotDateKey('2026-07-26T23:30:00Z'), '2026-07-26', where('ISO timestamp formats to its own date'));

  // ── hotToDate produces LOCAL midnight, never UTC midnight. ──
  const d = hotToDate('2026-07-26');
  assert.strictEqual(d.getHours(), 0, where('hours zeroed'));
  assert.strictEqual(d.getMinutes(), 0, where('minutes zeroed'));
  assert.strictEqual(d.getSeconds(), 0, where('seconds zeroed'));
  assert.strictEqual(d.getMilliseconds(), 0, where('ms zeroed'));
  assert.strictEqual(d.getFullYear(), 2026, where('year preserved'));
  assert.strictEqual(d.getMonth(), 6, where('month is 0-indexed July'));
  assert.strictEqual(d.getDate(), 26, where('day preserved'));

  // ── A ms timestamp is floored to the local day that contains it. ──
  const noonish = FIXED + 12 * 3600 * 1000;
  assert.strictEqual(hotDateKey(noonish), '2026-07-26', where('midday timestamp keys to its own day'));
  assert.strictEqual(hotToDate(noonish).getTime(), FIXED, where('timestamp floors to local midnight'));
  const lateNight = FIXED + 23 * 3600 * 1000 + 59 * 60 * 1000;
  assert.strictEqual(hotDateKey(lateNight), '2026-07-26', where('23:59 stays on the same local day'));

  // ── hotDayDiff, relative to the frozen today. ──
  assert.strictEqual(hotDayDiff(hotToDate('2026-07-26')), 0, where('today is 0'));
  assert.strictEqual(hotDayDiff(hotToDate('2026-07-27')), 1, where('tomorrow is 1'));
  assert.strictEqual(hotDayDiff(hotToDate('2026-07-25')), -1, where('yesterday is -1'));
  assert.strictEqual(hotDayDiff(hotToDate('2026-08-02')), 7, where('a week out is 7'));
  assert.strictEqual(hotDayDiff(hotToDate('2026-07-19')), -7, where('a week back is -7'));
  // Month and year boundaries are ordinary subtraction, not calendar math.
  assert.strictEqual(hotDayDiff(hotToDate('2026-08-01')), 6, where('crossing into August'));
  // New Year needs its own frozen clock — and its own hotDayDiff, since each
  // load() closes over its own "today".
  const ny = load(localMidnight(2026, 12, 31));
  assert.strictEqual(ny.hotDayDiff(ny.hotToDate('2027-01-01')), 1, where('crossing into the new year'));
  assert.strictEqual(ny.hotDayDiff(ny.hotToDate('2026-12-31')), 0, where('New Year\'s Eve is today'));

  // A mid-day timestamp still reads as "today" (it is floored first).
  assert.strictEqual(hotDayDiff(hotToDate(noonish)), 0, where('midday today is still 0'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Trap 2: DST. Only meaningful in a zone that observes it, so this runs in
// America/Los_Angeles only. 2026-03-08 is spring forward, 2026-11-01 fall back.
// ─────────────────────────────────────────────────────────────────────────────
function dstSensitive() {
  if ((process.env.TZ || '') !== 'America/Los_Angeles') return;

  // US DST 2026: forward on Mar 8, back on Nov 1. The SHORT day is the
  // transition day itself — Mar 8 00:00 → Mar 9 00:00 is 23 hours (Mar 7 → Mar 8
  // is an ordinary 24). Verified empirically, not assumed.
  //
  // This is THE case that makes Math.round load-bearing: 23/24 = 0.958, so
  // Math.floor would report 0 and tomorrow's earnings would render as "today".
  const springDay = load(localMidnight(2026, 3, 8));
  const gapSpring = springDay.hotToDate('2026-03-09') - localMidnight(2026, 3, 8);
  assert.strictEqual(gapSpring, 23 * 3600 * 1000, 'spring-forward "tomorrow" really is 23 hours away');
  assert.strictEqual(springDay.hotDayDiff(springDay.hotToDate('2026-03-09')), 1,
    'spring forward: tomorrow still reports 1 (Math.floor would say 0 — "today")');
  assert.strictEqual(springDay.hotDayDiff(springDay.hotToDate('2026-03-08')), 0, 'spring forward: today is 0');
  assert.strictEqual(springDay.hotDayDiff(springDay.hotToDate('2026-03-07')), -1,
    'spring forward: yesterday reports -1 across the 24h side');

  // Fall back: 2026-11-01 00:00 → 2026-11-02 00:00 is 25 real hours (1.042 days).
  const fallDay = load(localMidnight(2026, 11, 1));
  const gapFall = fallDay.hotToDate('2026-11-02') - localMidnight(2026, 11, 1);
  assert.strictEqual(gapFall, 25 * 3600 * 1000, 'fall-back "tomorrow" really is 25 hours away');
  assert.strictEqual(fallDay.hotDayDiff(fallDay.hotToDate('2026-11-02')), 1,
    'fall back: tomorrow still reports 1 (the 25-hour day does not become 2)');
  assert.strictEqual(fallDay.hotDayDiff(fallDay.hotToDate('2026-11-01')), 0, 'fall back: today is 0');

  // A week spanning spring forward is 167 hours, not 168 — still 7 days
  // (6.958 rounds to 7; Math.floor would report 6).
  assert.strictEqual(springDay.hotDayDiff(springDay.hotToDate('2026-03-15')), 7,
    'a week spanning spring forward is still 7');
  // Date keys never shift across a DST boundary either.
  assert.strictEqual(springDay.hotDateKey('2026-03-08'), '2026-03-08', 'DST-day key does not shift');
  assert.strictEqual(springDay.hotDateKey('2026-03-09'), '2026-03-09', 'day-after-DST key does not shift');
  assert.strictEqual(fallDay.hotDateKey('2026-11-01'), '2026-11-01', 'fall-back-day key does not shift');
}

if (isChild) {
  // Spawned per zone: run only the zone-dependent blocks and exit non-zero on
  // failure so the parent's assertion is meaningful.
  test(`TZ-sensitive date math [TZ=${process.env.TZ}]`, () => { tzSensitive(); });
  test(`DST rounding [TZ=${process.env.TZ}]`, () => { dstSensitive(); });
} else {
  // ── TZ-independent contracts ──────────────────────────────────────────────
  test('hotToDate: null-ish input yields null', () => {
    const { hotToDate } = load(FIXED);
    assert.strictEqual(hotToDate(null), null);
    assert.strictEqual(hotToDate(undefined), null);
  });

  test('hotToDate: shape is validated, range is not (characterization)', () => {
    const { hotToDate } = load(FIXED);
    // Rejected: anything not exactly ####-##-## in the first 10 chars.
    for (const bad of ['', '2026-7-1', '20260701', 'not-a-date', '2026-07', '26-07-2026',
                       '2026/07/26', ' 2026-07-26', 'NaN', 'true', '{}']) {
      assert.strictEqual(hotToDate(bad), null, `rejects ${JSON.stringify(bad)}`);
    }
    // Non-finite numbers fall through to the string path and are rejected there.
    assert.strictEqual(hotToDate(NaN), null, 'NaN rejected');
    assert.strictEqual(hotToDate(Infinity), null, 'Infinity rejected');
    assert.strictEqual(hotToDate(-Infinity), null, '-Infinity rejected');
    // Non-string non-number values stringify and are rejected.
    assert.strictEqual(hotToDate(true), null, 'boolean rejected');
    assert.strictEqual(hotToDate({}), null, 'object rejected');
    assert.strictEqual(hotToDate([]), null, 'array rejected');

    // BUT: the regex only checks SHAPE, so out-of-range parts are accepted and
    // roll over via the Date constructor. This is current behaviour, pinned so a
    // future "add validation" change is a deliberate decision, not a surprise.
    const rolled = hotToDate('2026-13-01');
    assert.notStrictEqual(rolled, null, 'month 13 is shape-valid, so it is accepted');
    assert.strictEqual(rolled.getFullYear(), 2027, 'month 13 rolls into the next year');
    assert.strictEqual(rolled.getMonth(), 0, 'month 13 becomes January');
    const rolledDay = hotToDate('2026-02-30');
    assert.strictEqual(rolledDay.getMonth(), 2, 'Feb 30 rolls into March');
    assert.strictEqual(rolledDay.getDate(), 2, 'Feb 30 becomes March 2');
  });

  test('hotToDate: zero is a valid timestamp, not a falsy reject', () => {
    const { hotToDate } = load(FIXED);
    const d = hotToDate(0);   // typeof 0 === 'number' && isFinite(0) → epoch
    assert.notStrictEqual(d, null, '0 takes the numeric branch');
    assert.strictEqual(d.getHours(), 0, 'and is floored to local midnight');
  });

  test('hotDayDiff: null-ish and unparsed input yields NaN', () => {
    const { hotDayDiff, hotToDate } = load(FIXED);
    assert.ok(Number.isNaN(hotDayDiff(null)), 'null → NaN');
    assert.ok(Number.isNaN(hotDayDiff(undefined)), 'undefined → NaN');
    // The composition that matters: an unparseable date flows through as NaN
    // rather than throwing or silently reading as 0 ("today").
    assert.ok(Number.isNaN(hotDayDiff(hotToDate('garbage'))), 'hotToDate miss → NaN, not 0');
  });

  test('hotDateKey: unparseable input yields empty string, never a bogus date', () => {
    const { hotDateKey } = load(FIXED);
    for (const bad of [null, undefined, '', 'garbage', '2026-7-1', NaN, {}]) {
      assert.strictEqual(hotDateKey(bad), '', `empty for ${JSON.stringify(bad) ?? String(bad)}`);
    }
  });

  test('TZ-sensitive date math holds in the ambient zone', () => { tzSensitive(); });

  test('TZ-sensitive date math holds in +2 / 0 / -8 zones (re-spawned)', () => {
    for (const TZ of TZ_ZONES) {
      const r = spawnSync(process.execPath, [SELF], {
        env: { ...process.env, TZ, PB_HOT_TZ_CHILD: '1' },
        encoding: 'utf8',
      });
      assert.strictEqual(r.status, 0,
        `TZ=${TZ} run failed:\n${r.stdout || ''}\n${r.stderr || ''}`);
    }
  });

  // ── Anti-drift source guards ──────────────────────────────────────────────
  test('anti-drift: the date seam still lives in app.js and formats locally', () => {
    assert.ok(/^function hotToDate\(/m.test(appSrc), 'hotToDate still defined in app.js');
    assert.ok(/^function hotDayDiff\(/m.test(appSrc), 'hotDayDiff still defined in app.js');
    assert.ok(/^function hotDateKey\(/m.test(appSrc), 'hotDateKey still defined in app.js');

    // The whole point of hotDateKey: it must never format via toISOString.
    // Checked against CODE only — the block's own comment names toISOString in
    // order to warn against it, so a naive substring check would always fail.
    const codeOnly = BLOCK.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/toISOString/.test(codeOnly),
      'no toISOString in the date block — it rolls local midnight back a day in +offset zones');
    assert.ok(/toISOString/.test(BLOCK),
      'the warning comment about toISOString is still there (delete the guard if the comment goes)');
    assert.ok(/getFullYear\(\)/.test(BLOCK) && /getMonth\(\)/.test(BLOCK) && /getDate\(\)/.test(BLOCK),
      'hotDateKey still formats from local getters');

    // Math.round (not floor/ceil/trunc) is what survives DST — see dstSensitive.
    assert.ok(/Math\.round\(\(date - t0\)/.test(BLOCK),
      'hotDayDiff still rounds the day delta (floor/trunc would misreport across DST)');
  });
}
