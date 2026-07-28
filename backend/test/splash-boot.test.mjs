// Startup-splash boot-path guards
//
// Pins the three defects behind "the loading screen flickers on and off, and only
// one of the three bars moves". All three are boot-path bugs that no existing
// suite could see: the Node suites never load app.js, and the browser harnesses
// embed their own HTML shells (none of them contains #pb-splash), so neither the
// service-worker handshake nor the pre-React splash is exercised anywhere.
//
// What broke, and why each guard exists:
//
//   1. SELF-INFLICTED RELOAD. sw.js calls skipWaiting() on install and
//      clients.claim() on activate. On a first-ever visit the page loads
//      uncontrolled, so the claim fires `controllerchange` -> index.html reloaded
//      the page -> the splash vanished and replayed. That is the flicker. The
//      reload is correct for a real deploy takeover, so the fix is a guard on
//      whether a controller existed at load, not removing the reload.
//   2. FROZEN BARS. `pb-wave` has no animation-fill-mode, so during a POSITIVE
//      animation-delay a bar renders un-animated (scaleY(1), full opacity) -
//      taller and brighter than the one bar already moving. Bars 2 and 3 sat
//      still for the first 160/320ms of every animation start. Negative delays
//      start each bar mid-wave on the first painted frame instead.
//   3. TWO LOADERS. index.html's #pb-splash and app.js's <LoadingScreen> render
//      identical markup. Handing off between them restarted the keyframes from
//      zero part-way through the >=2.5s intro, so the bars visibly jumped. There
//      is now one element for the whole boot; React only decides when it goes.
//
// These are source guards (grep over shipped files), the anti-drift pattern
// CLAUDE.md prescribes. They cannot prove the runtime behaviour - that needs the
// manual first-visit check in DevTools - but they do catch the exact edits that
// would silently reintroduce each bug.
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const indexSrc = read('index.html');
const stylesSrc = read('styles.css');
const appSrc = read('app.js');
const swSrc = read('sw.js');

// Strip line comments so a guard can never be satisfied by prose describing the
// thing it is looking for. Block comments in CSS are handled per-test.
const codeLines = (src) => src.split('\n').filter(l => !l.trim().startsWith('//'));

test('controllerchange reload is guarded on a pre-existing controller', () => {
  const listener = indexSrc.match(
    /addEventListener\('controllerchange'[\s\S]*?\n {6}\}\);/);
  assert.ok(listener, 'index.html should still register a controllerchange listener');
  const body = listener[0];

  assert.match(body, /hadController/,
    'the controllerchange listener must consult whether the page was already ' +
    'controlled at load. Without it, sw.js\'s clients.claim() on a FIRST install ' +
    'reloads the page and replays the splash - the reported flicker.');

  // The guard has to short-circuit before the reload, not merely mention it.
  const guardIdx = body.indexOf('hadController');
  const reloadIdx = body.indexOf('location.reload');
  assert.ok(guardIdx !== -1 && reloadIdx !== -1 && guardIdx < reloadIdx,
    'the hadController check must come BEFORE window.location.reload()');

  // And it must be read at page load, outside the listener, or it would always be
  // true by the time controllerchange fires.
  assert.match(indexSrc, /const hadController = !!navigator\.serviceWorker\.controller;/,
    'hadController must be captured once at load, not read inside the listener');
  assert.ok(
    indexSrc.indexOf('const hadController') < indexSrc.indexOf("addEventListener('controllerchange'"),
    'hadController must be captured before the listener is registered');
});

test('sw.js still self-activates, so the guard above is load-bearing', () => {
  // If either of these ever goes away the first-install controllerchange stops
  // firing and the guard becomes dead code - worth knowing, not worth failing on
  // its own. Asserted so the guard and its cause stay documented together.
  assert.match(swSrc, /self\.skipWaiting\(\)/, 'sw.js install still calls skipWaiting()');
  assert.match(swSrc, /self\.clients\.claim\(\)/, 'sw.js activate still calls clients.claim()');
});

test('all three loader bars carry a negative animation-delay', () => {
  const delays = [...stylesSrc.matchAll(
    /\.pb-bar:nth-child\((\d)\)\s*\{[^}]*animation-delay:\s*(-?[\d.]+)s/g)]
    .map(m => ({ bar: Number(m[1]), delay: Number(m[2]) }));

  assert.strictEqual(delays.length, 3, 'expected exactly three .pb-bar:nth-child rules');

  for (const { bar, delay } of delays) {
    assert.ok(delay < 0,
      `.pb-bar:nth-child(${bar}) has animation-delay: ${delay}s. It must be NEGATIVE. ` +
      'pb-wave has no animation-fill-mode, so a positive delay leaves the bar ' +
      'frozen at scaleY(1) until it elapses - that is the "only one bar moves" bug.');
  }

  // The visual stagger must be unchanged from the original 0 / .16 / .32s. A
  // delay -D starts the animation at phase D, so what the eye reads as "bar N
  // lags bar 1" is (phase1 - phaseN) mod period. That lag is the invariant.
  const period = Number(stylesSrc.match(/animation:\s*pb-wave\s+([\d.]+)s/)[1]);
  assert.strictEqual(period, 1.4, 'pb-wave period changed; the delay values below assume 1.4s');
  const phase = (d) => ((-d % period) + period) % period;
  const phases = delays.sort((a, b) => a.bar - b.bar).map(d => phase(d.delay));
  const lag = (i) => ((phases[0] - phases[i]) % period + period) % period;
  assert.ok(Math.abs(lag(1) - 0.16) < 1e-9,
    `bar 2 should lag bar 1 by 0.16s, got ${lag(1)}s`);
  assert.ok(Math.abs(lag(2) - 0.32) < 1e-9,
    `bar 3 should lag bar 1 by 0.32s, got ${lag(2)}s`);
});

test('splash theming follows data-theme, not the OS', () => {
  const block = stylesSrc.slice(stylesSrc.indexOf('--pb-bg'));
  const scope = block.slice(0, block.indexOf('.pb-loader'));
  assert.match(scope, /:root\[data-theme="light"\]/,
    'the splash light palette must key off :root[data-theme="light"]');
  assert.doesNotMatch(scope, /prefers-color-scheme/,
    'the splash must NOT be themed by prefers-color-scheme: it would disagree ' +
    'with the app\'s saved pb.theme.v2 and flash at the handoff.');
});

test('the UI theme is applied before first paint, read-only', () => {
  const head = indexSrc.slice(0, indexSrc.indexOf('</head>'));
  assert.match(head, /localStorage\.getItem\('pb\.theme\.v2'\)/,
    'index.html must read pb.theme.v2 in <head> so data-theme is set pre-paint');
  assert.match(head, /document\.documentElement\.dataset\.theme = /,
    'the pre-paint script must set data-theme on documentElement');

  // CLAUDE.md rule #5: durable state goes through the LS adapter. Reading here is
  // fine (index.html already does it for pb.iconTheme.v1); writing would give the
  // key a second writer and put backup byte-compatibility at risk.
  assert.doesNotMatch(indexSrc, /setItem\('pb\.theme\.v2'/,
    'index.html must never WRITE pb.theme.v2 - app.js owns it through LS');
});

test('index.html owns the one splash and exposes its dismissal', () => {
  assert.match(indexSrc, /window\.hidePbSplash = function/,
    'index.html must expose window.hidePbSplash for <LoadingScreen> to call');
  assert.ok(
    indexSrc.indexOf('window.hidePbSplash = function') < indexSrc.indexOf('src="./app.js"'),
    'hidePbSplash must be defined before app.js loads so LoadingScreen can reach it');

  const code = codeLines(indexSrc).join('\n');
  assert.doesNotMatch(code, /new MutationObserver/,
    'the MutationObserver that retired the splash on React\'s first commit is what ' +
    'caused the mid-boot handoff. The splash now rides the whole boot; React ' +
    'dismisses it when the dashboard is ready.');

  // The 8s fail-safe is the only thing standing between a dead app.js and a
  // permanently covered screen.
  assert.match(indexSrc, /setTimeout\(function \(\) \{ window\.hidePbSplash\(\); \}, 8000\)/,
    'the 8s splash fail-safe must survive');
});

test('LoadingScreen defers to the existing splash instead of rendering a second', () => {
  const start = appSrc.indexOf('function LoadingScreen(');
  assert.ok(start !== -1, 'LoadingScreen should still exist in app.js');
  const fn = appSrc.slice(start, appSrc.indexOf('\nfunction App(', start));

  assert.match(fn, /getElementById\('pb-splash'\)/,
    'LoadingScreen must detect the pre-React splash');
  assert.match(fn, /if \(!mounted \|\| ownsSplash\) return null;/,
    'LoadingScreen must render nothing when the page already has a splash - ' +
    'a second .pb-loader restarts the keyframes and makes the bars jump.');
  assert.match(fn, /window\.hidePbSplash\(\)/,
    'LoadingScreen must dismiss the splash it defers to');

  // The fallback render must survive: it is the path the 16 verify-*.mjs harness
  // shells take (none of them contains #pb-splash), and verify-chart-axes.mjs
  // polls for .pb-loader disappearing.
  assert.match(fn, /className: "pb-loader"/,
    'the React-rendered loader must remain as the no-splash fallback');
});

test('a first-render crash is not left hidden behind the splash', () => {
  const start = appSrc.indexOf('class ErrorBoundary');
  const fn = appSrc.slice(start, appSrc.indexOf('window.PBApp', start));
  assert.match(fn, /hidePbSplash/,
    'ErrorBoundary must dismiss the splash: with the MutationObserver gone, a ' +
    'crash during the first render would sit behind it until the 8s fail-safe.');
});

test('shipped-file changes came with a CACHE_NAME bump', () => {
  // The wiring checklist in CLAUDE.md: any change to shipped files needs a bump,
  // or installed PWAs serve the old index.html/styles.css/app.js offline.
  // The floor tracks whatever main last shipped: raise it whenever this branch is
  // brought up to date, or a merge that silently took the older side would pass.
  const m = swSrc.match(/const CACHE_NAME\s*=\s*'playbook-shell-v(\d+)'/);
  assert.ok(m, 'sw.js must define CACHE_NAME as playbook-shell-vN');
  assert.ok(Number(m[1]) >= 92,
    `CACHE_NAME is v${m[1]}; this change set requires at least v92 (main shipped v91)`);
});
