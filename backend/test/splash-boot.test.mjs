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
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// The generator is the single source of truth for the device list, the media
// queries and the fill colours; these guards assert index.html and the built
// files still agree with it.
import { DEVICES, THEMES, fileFor, mediaFor } from '../../tools/build-splash.mjs';

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
  assert.ok(Number(m[1]) >= 93,
    `CACHE_NAME is v${m[1]}; this change set requires at least v93 (main shipped v92)`);
});

// ─── iOS launch images ───────────────────────────────────────────────────────
// The fourth cause of "the app flickers on open", and the only one that lives
// outside the page: Safari ignores the manifest's background_color, so an
// installed PWA with no <link rel="apple-touch-startup-image"> gets a plain
// WHITE screen for the 300-800ms WebKit takes to boot. The three guards above
// are all in-page and could never have caught it.
//
// iOS honours ONLY an image whose pixel size matches the device exactly, so the
// failure mode for every one of these is silent: a typo'd media query or a file
// one pixel off does not error, it just goes back to flashing white.

test('every device in the splash pack has a matching startup-image link', () => {
  const links = [...indexSrc.matchAll(
    /<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)">/g)]
    .map(m => ({ media: m[1], href: m[2] }));

  assert.strictEqual(links.length, DEVICES.length,
    `index.html has ${links.length} startup-image links but tools/build-splash.mjs ` +
    `builds ${DEVICES.length} sizes. Re-run \`node tools/build-splash.mjs\` and ` +
    're-wire index.html - a device with no link falls back to the white screen.');

  for (const d of DEVICES) {
    const want = './brand/splash/' + fileFor('dark', d);
    const hit = links.find(l => l.href === want);
    assert.ok(hit, `no startup-image link for ${d.w}x${d.h}@${d.dpr}x (${d.note})`);
    assert.strictEqual(hit.media, mediaFor(d),
      `the media query for ${d.note} does not match tools/build-splash.mjs. iOS ` +
      'ignores a launch image whose query does not match the device exactly.');
  }
});

test('every referenced launch image exists at its exact declared size', () => {
  for (const theme of ['dark', 'light']) {
    for (const d of DEVICES) {
      const rel = join('brand', 'splash', fileFor(theme, d));
      const file = join(ROOT, rel);
      assert.ok(existsSync(file), `missing ${rel} - run \`node tools/build-splash.mjs\``);

      // Read the PNG IHDR directly: the filename is a claim, the header is the
      // fact, and iOS only cares about the fact.
      const buf = readFileSync(file);
      assert.strictEqual(buf.toString('ascii', 12, 16), 'IHDR', `${rel} is not a PNG`);
      assert.strictEqual(buf.readUInt32BE(16), d.w * d.dpr,
        `${rel} is ${buf.readUInt32BE(16)}px wide, iOS needs exactly ${d.w * d.dpr}px`);
      assert.strictEqual(buf.readUInt32BE(20), d.h * d.dpr,
        `${rel} is ${buf.readUInt32BE(20)}px tall, iOS needs exactly ${d.h * d.dpr}px`);
    }
  }
});

test('launch-image fill colours match the loader background they hand off to', () => {
  // The whole point of the pack is that the launch image and the loader's first
  // painted frame are the SAME colour. If --pb-bg is retuned and these are not,
  // the white flash is merely traded for a coloured one.
  const block = stylesSrc.slice(stylesSrc.indexOf('--pb-bg'));
  const scope = block.slice(0, block.indexOf('.pb-loader'));
  const darkCss = scope.match(/--pb-bg:\s*(#[0-9A-Fa-f]{6})/)[1].toLowerCase();
  const lightCss = scope.slice(scope.indexOf('data-theme="light"'))
    .match(/--pb-bg:\s*(#[0-9A-Fa-f]{6})/)[1].toLowerCase();
  const hex = (rgb) => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');

  assert.strictEqual(hex(THEMES.dark), darkCss,
    'tools/build-splash.mjs THEMES.dark must equal --pb-bg in the dark splash palette');
  assert.strictEqual(hex(THEMES.light), lightCss,
    'tools/build-splash.mjs THEMES.light must equal --pb-bg under [data-theme="light"]');
});

test('launch images follow the UI theme, pre-paint and on switch', () => {
  const head = indexSrc.slice(0, indexSrc.indexOf('</head>'));
  assert.match(head, /function applySplashTheme\(/,
    'index.html must define applySplashTheme in the pre-paint script');
  assert.match(head, /window\.applySplashTheme = applySplashTheme;/,
    'applySplashTheme must be exposed so app.js can call it on a theme switch');

  // It has to run off the UI theme (pb.theme.v2), not the home-screen icon theme
  // (pb.iconTheme.v1) - those are independent settings, and only the UI theme
  // decides what colour the loader paints.
  const uiBlock = head.slice(head.indexOf("localStorage.getItem('pb.theme.v2')"));
  assert.match(uiBlock, /applySplashTheme\(uiTheme\)/,
    'applySplashTheme must be called with the UI theme, in the pre-paint script');

  // Shipped hrefs must be the dark ones: that is the default theme, and it is
  // what a first-ever visit (nothing in localStorage yet) will launch with.
  assert.doesNotMatch(indexSrc, /href="\.\/brand\/splash\/light-/,
    'index.html should ship the dark hrefs; light is applied at runtime');

  assert.match(appSrc, /window\.applySplashTheme === 'function'/,
    'app.js must repoint the launch images when the theme changes, guarded for ' +
    'the verify-*.mjs harness shells (which have no such links)');
});
