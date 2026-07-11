// Deploy-allowlist guard — kills the GAPS.md #1 class of bug for good.
//   node backend/test/deploy-assets.test.mjs
//
// The Pages workflow (static.yml) stages an explicit ALLOWLIST of runtime files.
// If a file is loaded by index.html or precached by sw.js but missing from that
// allowlist, the live site 404s it — and because cache.addAll(SHELL_ASSETS)
// rejects on any non-OK response, the service worker's install silently fails
// forever (this is exactly what shipped with demo-data.js in v42–v50, breaking
// Preview mode on the live site). These tests cross-check the three lists so a
// new script can never be wired into the app but left out of the deploy.
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..', '..');
const swSrc = readFileSync(join(root, 'sw.js'), 'utf8');
const htmlSrc = readFileSync(join(root, 'index.html'), 'utf8');
const ymlSrc = readFileSync(join(root, '.github', 'workflows', 'static.yml'), 'utf8');

// SHELL_ASSETS entries from sw.js: the './x' strings inside the array literal.
const shellBlock = swSrc.slice(swSrc.indexOf('SHELL_ASSETS'), swSrc.indexOf('];'));
const shellAssets = [...shellBlock.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);

// Local <script src="./x.js"> files from index.html (CDN scripts excluded).
const htmlScripts = [...htmlSrc.matchAll(/<script[^>]*\bsrc="\.\/([^"]+)"/g)].map(m => m[1]);

// static.yml with comment lines stripped, so a filename mentioned only in a
// comment can't satisfy the check.
const ymlCode = ymlSrc.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
// Directories staged wholesale via `cp -r <dir> _site/` cover everything inside.
const copiedDirs = [...ymlCode.matchAll(/cp -r (\S+)/g)].map(m => m[1].replace(/\/$/, ''));

const staged = (asset) =>
  copiedDirs.some(d => asset.startsWith(d + '/')) ||
  new RegExp('(^|[\\s/])' + asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)', 'm').test(ymlCode);

test('sanity: all three sources parsed', () => {
  assert.ok(shellAssets.length >= 10, 'SHELL_ASSETS parsed from sw.js');
  assert.ok(htmlScripts.length >= 5, 'local <script src> tags parsed from index.html');
  assert.ok(ymlCode.includes('_site'), 'static.yml staging step present');
});

test('every sw.js SHELL_ASSETS entry is staged by static.yml', () => {
  const missing = shellAssets.filter(a => a !== '' && a !== 'index.html' ? !staged(a) : false);
  assert.deepStrictEqual(missing, [], 'precached but never deployed (sw install will fail on the live site): ' + missing.join(', '));
});

test('every local <script src> in index.html is staged by static.yml', () => {
  const missing = htmlScripts.filter(a => !staged(a));
  assert.deepStrictEqual(missing, [], 'loaded by index.html but never deployed (404 on the live site): ' + missing.join(', '));
});

test('every local <script src> in index.html is precached in SHELL_ASSETS', () => {
  const missing = htmlScripts.filter(a => !shellAssets.includes(a));
  assert.deepStrictEqual(missing, [], 'loaded by index.html but not offline-cached: ' + missing.join(', '));
});
