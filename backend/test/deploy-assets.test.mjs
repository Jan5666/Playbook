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
import { readFileSync, existsSync } from 'node:fs';
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

// ─── the block-scalar guard ─────────────────────────────────────────────────
// Every test above greps static.yml as TEXT, so a workflow that is no longer
// valid YAML sails through all of them — which is exactly what shipped in
// 1002352 and 450b59d (2026-07-28). A wrapped `echo` put its continuation line
// at column 0 inside `run: |`; that ends the YAML block scalar, so GitHub
// rejected the whole file with a startup_failure — zero jobs, no deploy, no
// red step to click into. main moved twice and the live site never changed.
//
// Node has no bundled YAML parser and this suite takes no deps, so instead of
// parsing we assert the one structural rule that broke: within a block scalar,
// every non-blank line must be indented deeper than the key that opened it.
test('no line inside a `run: |` block escapes its indentation', () => {
  const lines = ymlSrc.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)-?\s*run:\s*[|>][-+]?\s*$/);
    if (!open) continue;
    const keyIndent = open[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const indent = line.match(/^\s*/)[0].length;
      if (indent > keyIndent) continue;      // still inside the block
      // Dedented back to the key's level or shallower. That legitimately ends
      // the block only if it starts a new YAML key / list item.
      if (!/^\s*(-\s|[\w.$-]+\s*:)/.test(line)) {
        offenders.push(`line ${j + 1}: ${line.slice(0, 72)}`);
      }
      break;
    }
  }
  assert.deepStrictEqual(offenders, [],
    'these lines end the block scalar and make static.yml invalid YAML — ' +
    'GitHub will reject the workflow at startup and silently skip the deploy:\n  ' +
    offenders.join('\n  '));
});

// ─── the logo-pack sentinel ─────────────────────────────────────────────────
// Guard 1 in static.yml probes one file inside logos/ to prove `cp -r logos`
// actually staged the pack. That sentinel is a real filename, and the pack now
// de-duplicates identical tiles — whole issuer families share one file — so a
// rebuild CAN legitimately delete the file the workflow names. The deploy would
// then fail with nothing having gone wrong locally. Tie the two together here.
test('every logos/ sentinel named by the deploy workflow exists on disk', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'static.yml'), 'utf8');
  const sentinels = [...yml.matchAll(/logos\/[A-Za-z0-9.\-]+\.png/g)].map(m => m[0]);
  assert.ok(sentinels.length > 0, 'static.yml no longer probes the logo pack at all');
  for (const rel of sentinels) {
    assert.ok(existsSync(join(root, rel)),
      `${rel} is the deploy sentinel but no longer exists — the pack de-duplicated it. ` +
      'Point Guard 1 at a file that survives, or the deploy fails on a healthy build.');
  }
});
