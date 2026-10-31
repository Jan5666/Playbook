// Unit tests for PBCore.extMoveEstimate — the rough portfolio effect of the
// pre-market / after-hours moves that the Holdings summary shows while its
// pre-market toggle is on (2026-10-31).
//   node backend/test/ext-move-estimate.test.mjs
//
// What is pinned:
//   - it is the share-weighted sum of EXACTLY the ext chips the rows show (same
//     gate: extKind + finite extChangePct), so the summary can't disagree with them;
//   - the % is measured against each reading's own session baseline (extPrice -
//     extChange), never against q.price or prevClose;
//   - a holding with no reading contributes nothing (no guess, no day-move
//     fallback) but still counts in `priced`, so the caller can say "N of M";
//   - pence/cents never need dividing here: ext fields are already in display units.
import PBCore from '../../pb-core.js';

let failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-9) => typeof a === 'number' && Math.abs(a - b) <= eps;
const { extMoveEstimate } = PBCore;

ok('exported', typeof extMoveEstimate === 'function');

// A quote with a live pre-market reading. prevClose 100 -> pre-market 102.
const pre = (price, extPrice, extra = {}) => ({
  price, prevClose: price, extKind: 'pre', extLive: true,
  extPrice, extChange: extPrice - price, extChangePct: (extPrice - price) / price * 100, ...extra
});

// ── 1. Two holdings, both with readings ─────────────────────────────────────
{
  const r = extMoveEstimate([
    { shares: 10, quote: pre(100, 102) },   // +20 on a 1000 base
    { shares: 5,  quote: pre(200, 196) }    // -20 on a 1000 base
  ]);
  ok('1: change is share-weighted sum', near(r.change, 0), String(r.change));
  ok('1: base is the session baseline value', near(r.base, 2000), String(r.base));
  ok('1: pct 0', near(r.pct, 0), String(r.pct));
  ok('1: counted 2 of priced 2', r.counted === 2 && r.priced === 2);
  ok('1: kind pre, not final', r.kind === 'pre' && r.final === false);
}
{
  const r = extMoveEstimate([
    { shares: 10, quote: pre(100, 103) },   // +30
    { shares: 4,  quote: pre(50, 51) }      // +4
  ]);
  ok('1b: change +34', near(r.change, 34), String(r.change));
  ok('1b: pct = 34 / 1200', near(r.pct, 34 / 1200 * 100), String(r.pct));
}

// ── 2. A holding with no reading contributes nothing but counts as priced ───
{
  const noExt = { price: 80, prevClose: 79, changePct: 1.27, extKind: null, extPrice: null, extChange: null, extChangePct: null };
  const r = extMoveEstimate([
    { shares: 10, quote: pre(100, 101) },
    { shares: 100, quote: noExt }
  ]);
  ok('2: only the reading counts toward change', near(r.change, 10), String(r.change));
  ok('2: base excludes the holding with no reading', near(r.base, 1000), String(r.base));
  ok('2: does NOT fall back to the day move', near(r.pct, 1), String(r.pct));
  ok('2: counted 1 of priced 2', r.counted === 1 && r.priced === 2, `${r.counted}/${r.priced}`);
}

// ── 3. Nothing carries a reading -> null figures, priced still reported ─────
{
  const r = extMoveEstimate([{ shares: 3, quote: { price: 10, extKind: null } }]);
  ok('3: change null', r.change === null && r.pct === null);
  ok('3: counted 0, priced 1', r.counted === 0 && r.priced === 1);
  ok('3: kind null', r.kind === null);
}
ok('3b: empty list', extMoveEstimate([]).change === null && extMoveEstimate([]).priced === 0);
ok('3c: non-array tolerated', extMoveEstimate(null).change === null);

// ── 4. Unpriced / invalid rows are skipped entirely ─────────────────────────
{
  const r = extMoveEstimate([
    { shares: 10, quote: null },
    { shares: 10, quote: { price: NaN, extKind: 'pre', extPrice: 1, extChange: 0.1, extChangePct: 11 } },
    { shares: 0, quote: pre(100, 110) },
    { shares: -5, quote: pre(100, 110) },
    { shares: 2, quote: pre(100, 110) }
  ]);
  ok('4: only the valid holding counts', near(r.change, 20) && r.counted === 1 && r.priced === 1, `${r.change} ${r.counted}/${r.priced}`);
}

// ── 5. Same gate as the row chip: extChangePct must be finite ───────────────
{
  const q = pre(100, 105); q.extChangePct = null;   // isFinite(null) is TRUE — the typeof guard matters
  const r = extMoveEstimate([{ shares: 1, quote: q }]);
  ok('5: null extChangePct is not a reading', r.change === null && r.counted === 0);
}

// ── 6. POST is measured from TODAY's close, not prevClose ───────────────────
// Day: prevClose 90 -> close 100 (+11%). After hours 101 (+1% on the close).
{
  const q = { price: 100, prevClose: 90, extKind: 'post', extLive: true, extPrice: 101, extChange: 1, extChangePct: 1 };
  const r = extMoveEstimate([{ shares: 10, quote: q }]);
  ok('6: post change uses the close baseline', near(r.change, 10), String(r.change));
  ok('6: post pct +1%, NOT the +12.2% since prevClose', near(r.pct, 1), String(r.pct));
  ok('6: kind post, live', r.kind === 'post' && r.final === false);
  const f = extMoveEstimate([{ shares: 10, quote: { ...q, extLive: false } }]);
  ok('6b: overnight after-close reading is final', f.kind === 'post' && f.final === true);
}

// ── 7. Mixed sessions say so instead of claiming one ────────────────────────
{
  const post = { price: 100, extKind: 'post', extLive: false, extPrice: 99, extChange: -1, extChangePct: -1 };
  const r = extMoveEstimate([{ shares: 1, quote: pre(100, 101) }, { shares: 1, quote: post }]);
  ok('7: mixed kind', r.kind === 'mixed', r.kind);
  ok('7: mixed not final while any reading is live', r.final === false);
  ok('7: mixed change nets out', near(r.change, 0), String(r.change));
}

// ── 8. Older stored quote without extChange falls back to the % exactly ─────
{
  const q = { price: 100, extKind: 'pre', extLive: true, extPrice: 104, extChangePct: 4 };
  const r = extMoveEstimate([{ shares: 5, quote: q }]);
  ok('8: baseline derived from extChangePct', near(r.base, 500, 1e-9) && near(r.change, 20, 1e-9), `${r.base} ${r.change}`);
  ok('8: pct preserved', near(r.pct, 4, 1e-9), String(r.pct));
}

// ── 9. Agrees with the rows: weighted mean of the chips the rows display ────
{
  const qs = [pre(10, 10.5), pre(250, 247.5), pre(42, 42.84)];
  const shares = [100, 3, 20];
  const r = extMoveEstimate(qs.map((q, i) => ({ shares: shares[i], quote: q })));
  const w = qs.map((q, i) => shares[i] * (q.extPrice - q.extChange));
  const mean = qs.reduce((s, q, i) => s + q.extChangePct * w[i], 0) / w.reduce((a, b) => a + b, 0);
  ok('9: pct = baseline-weighted mean of the row chips', near(r.pct, mean, 1e-9), `${r.pct} vs ${mean}`);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures ? 1 : 0);
