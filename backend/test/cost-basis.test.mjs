// Tests for the blended-average-cost kernel now in the shared core (pb-core.js):
// mergeCostBasis.
//   cd backend/test && node cost-basis.test.mjs
//
// The averaging formula (exShares·exCost + addShares·addCost)/(exShares+addShares)
// was inlined in THREE places in app.js — the startup dedup pass, addPosition
// (top-up), and importPositions (bulk merge) — each a slightly different hand copy
// of the same math. This is the one true copy. The two FX-bearing call site
// (addPosition) converts the incoming lot's cost into the existing holding's cost
// currency with convertCcy BEFORE blending; mergeCostBasis stays pure arithmetic
// and the caller does that conversion, so we also prove the composition here.
//
// Ground-truth values below are exactly what the old inlined expressions produced
// for the same inputs (hand-computed), so this pins behavior, not just an API.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import PBCore from '../../pb-core.js';

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-9) => a != null && b != null && Math.abs(a - b) < eps;

ok('PBCore exports mergeCostBasis', typeof PBCore.mergeCostBasis === 'function');

if (typeof PBCore.mergeCostBasis === 'function') {
  const m = PBCore.mergeCostBasis;

  // Same price in/out → cost basis unchanged, shares add.
  let r = m(10, 100, 10, 100);
  ok('equal price: shares add, cost unchanged', r.shares === 20 && near(r.costBasis, 100));

  // Top-up at a higher price blends halfway when shares are equal.
  r = m(10, 100, 10, 200);
  ok('equal shares, higher top-up: cost = midpoint', r.shares === 20 && near(r.costBasis, 150));

  // Share-weighted average (not a naive midpoint).
  r = m(30, 100, 10, 200);
  ok('share-weighted: 30@100 + 10@200 → 40@125', r.shares === 40 && near(r.costBasis, 125));

  // Fractional shares (crypto): 0.5@40000 + 1.5@60000 → 2@55000.
  r = m(0.5, 40000, 1.5, 60000);
  ok('fractional shares blend correctly', near(r.shares, 2) && near(r.costBasis, 55000));

  // Adding to a zero-cost lot (e.g. transferred-in shares) still averages.
  r = m(10, 0, 10, 50);
  ok('zero-cost existing + paid top-up → 20@25', r.shares === 20 && near(r.costBasis, 25));

  // Guard: total shares <= 0 falls back to existing cost (import's behavior), no
  // divide-by-zero NaN.
  r = m(10, 100, -10, 100);
  ok('total shares 0 → keeps existing cost, no NaN', r.shares === 0 && near(r.costBasis, 100));

  // ── Composition: addPosition's cross-currency top-up = convertCcy + merge ────
  // Slice the REAL convertCcy out of app.js (same technique as money-math) and
  // reproduce a top-up entered in USD against a holding whose cost basis is in ZAR.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
  const start = src.indexOf('function convertCcy(');
  const end = src.indexOf('function fmtCcy(', start);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src.slice(start, end) + '\nglobalThis.__c = convertCcy;', sandbox);
  const convertCcy = sandbox.__c;
  const rates = { USD: 1, ZAR: 18.5 };
  // Existing 10 shares @ R100; top-up 5 shares @ $8 → $8 = R148 → blended:
  // (10·100 + 5·148)/15 = 1740/15 = 116.
  const addCostZar = convertCcy(8, 'USD', 'ZAR', rates);
  ok('convertCcy $8 → R148', near(addCostZar, 148));
  const blended = m(10, 100, 5, addCostZar);
  ok('cross-ccy top-up composes to 15@116', blended.shares === 15 && near(blended.costBasis, 116));

  // ── Anti-drift guard: app.js delegates and no longer inlines the formula ─────
  ok('app.js binds mergeCostBasis from PBCore', /const\s+mergeCostBasis\s*=\s*PBCore\.mergeCostBasis/.test(src));
  // 1 binding + 3 call sites (dedup, addPosition, importPositions) = 4 references.
  ok('app.js routes all 3 sites through mergeCostBasis', (src.match(/mergeCostBasis/g) || []).length >= 4);
  // The old inlined blend divided a costBasis-weighted sum by a running total —
  // it must be gone from all three sites.
  ok('app.js no longer inlines the avgCost formula', !/costBasis\s*\)\s*\/\s*totalShares/.test(src));
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll cost-basis tests passed');
process.exit(failures ? 1 : 0);
