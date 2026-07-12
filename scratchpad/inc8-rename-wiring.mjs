// scratchpad/inc8-rename-wiring.mjs - run once from repo root; NOT committed.
// After `git mv pb-view-hot.js pb-views.js`: rewrite the file's 3-line header banner in place
// and re-point the 16 verify-*.mjs harness shells from /pb-view-hot.js to /pb-views.js.
// (index.html, sw.js, static.yml are edited separately as single-line replacements.)
// BOM + CRLF preserved (utf8 read/write, split/join '\r\n').
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BOM = String.fromCharCode(0xFEFF); // U+FEFF, kept ASCII in source via fromCharCode

// 1) rewrite pb-views.js header (3 lines, in place - keeps line count, preserves the BOM on line 0)
{
  const p = 'pb-views.js';
  const lines = readFileSync(p, 'utf8').split('\r\n');
  const h = lines.findIndex(l => l.includes('HotTopicsView, extracted from app.js'));
  if (h < 0) throw new Error('pb-views.js header marker not found');
  const bom = lines[h].charCodeAt(0) === 0xFEFF ? BOM : '';
  lines[h]     = bom + '// pb-views.js - extracted view-component bucket (Phase 4). Browser-only classic script.';
  lines[h + 1] = '// Registers window.PBViews.<View> and reads shared app.js primitives from window.PBApp';
  lines[h + 2] = '// at render time (bridge). data.js/PBStore globals are read directly, not via the bridge.';
  writeFileSync(p, lines.join('\r\n'), 'utf8');
  console.log('rewrote pb-views.js header');
}

// 2) re-point the harness shells (global replace on each; CRLF-safe)
{
  const dir = 'backend/test';
  let n = 0;
  for (const f of readdirSync(dir).filter(f => /^verify-.*\.mjs$/.test(f))) {
    const fp = join(dir, f);
    const s = readFileSync(fp, 'utf8');
    if (!s.includes('/pb-view-hot.js')) continue;
    writeFileSync(fp, s.split('/pb-view-hot.js').join('/pb-views.js'), 'utf8');
    n++; console.log('re-pointed', f);
  }
  console.log('re-pointed', n, 'harnesses');
}
