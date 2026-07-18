// Tests for forwardFillPortfolio (pb-core.js): the Growth Tracker's date-merge.
// Mixed-exchange portfolios (US/JSE/LSE holiday calendars differ) used to sum
// only the positions that had a bar on each calendar date, so every foreign
// holiday produced a sharp downward spike. The forward-fill carries each
// position's last known value across its gap dates instead.
//   cd backend/test && node portfolio-fill.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';

const { forwardFillPortfolio } = PBCore;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-9) => a != null && b != null && Math.abs(a - b) < eps;
const pts = (...pairs) => pairs.map(([d, v]) => ({ d, v }));

ok('PBCore exports forwardFillPortfolio', typeof forwardFillPortfolio === 'function');

// ── Aligned calendars: identical to the naive per-date sum ──────────────────
const aligned = forwardFillPortfolio([
  { entryDate: null, points: pts(['2026-07-01', 100], ['2026-07-02', 110], ['2026-07-03', 105]) },
  { entryDate: null, points: pts(['2026-07-01', 50], ['2026-07-02', 55], ['2026-07-03', 60]) }
]);
ok('aligned: three dates out', aligned.length === 3);
ok('aligned: plain sums (characterizes the unchanged case)',
  near(aligned[0].value, 150) && near(aligned[1].value, 165) && near(aligned[2].value, 165));
ok('aligned: dates ascending', aligned[0].date === '2026-07-01' && aligned[2].date === '2026-07-03');

// ── Mixed calendars: the spike case ─────────────────────────────────────────
// Position B's exchange is shut on 07-02; its 07-01 value must carry, not drop.
const mixed = forwardFillPortfolio([
  { entryDate: null, points: pts(['2026-07-01', 100], ['2026-07-02', 110], ['2026-07-03', 105]) },
  { entryDate: null, points: pts(['2026-07-01', 50], ['2026-07-03', 60]) }
]);
ok('mixed: holiday gap forward-filled (no downward spike)', near(mixed[1].value, 160));
ok('mixed: shared dates unaffected', near(mixed[0].value, 150) && near(mixed[2].value, 165));

// A position also carries through the END of the union range (its exchange
// closed while another market still trades).
const tail = forwardFillPortfolio([
  { entryDate: null, points: pts(['2026-07-01', 100], ['2026-07-02', 110]) },
  { entryDate: null, points: pts(['2026-07-01', 50], ['2026-07-02', 55], ['2026-07-03', 57]) }
]);
ok('tail: closed-market position carries to the last date', near(tail[2].value, 110 + 57));

// ── Entry date ──────────────────────────────────────────────────────────────
const entry = forwardFillPortfolio([
  { entryDate: null, points: pts(['2026-07-01', 100], ['2026-07-02', 110], ['2026-07-03', 105]) },
  { entryDate: '2026-07-02', points: pts(['2026-07-01', 999], ['2026-07-02', 50], ['2026-07-03', 60]) }
]);
ok('entry: bars before purchase are excluded (no back-fill)', near(entry[0].value, 100));
ok('entry: contributes from purchase date on', near(entry[1].value, 160) && near(entry[2].value, 165));

// ── Robustness ──────────────────────────────────────────────────────────────
ok('single position: passthrough', (() => {
  const one = forwardFillPortfolio([{ entryDate: null, points: pts(['2026-07-01', 42], ['2026-07-02', 43]) }]);
  return one.length === 2 && near(one[0].value, 42) && near(one[1].value, 43);
})());
ok('invalid points are skipped', (() => {
  const r = forwardFillPortfolio([{ entryDate: null, points: [{ d: '2026-07-01', v: 10 }, { d: '2026-07-02', v: NaN }, null, { d: 3, v: 5 }] }]);
  return r.length === 1 && near(r[0].value, 10);
})());
ok('duplicate date: later point wins', (() => {
  const r = forwardFillPortfolio([{ entryDate: null, points: pts(['2026-07-01', 10], ['2026-07-01', 12]) }]);
  return r.length === 1 && near(r[0].value, 12);
})());
ok('empty/malformed input → []',
  forwardFillPortfolio([]).length === 0 && forwardFillPortfolio(null).length === 0 &&
  forwardFillPortfolio([{ entryDate: null, points: [] }, { entryDate: null }]).length === 0);

// ── Source guards: wiring (anti-drift) ──────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
const dataSrc = readFileSync(join(here, '..', '..', 'pb-data.js'), 'utf8');
ok('app.js chart delegates the date-merge to PBCore.forwardFillPortfolio', appSrc.includes('PBCore.forwardFillPortfolio('));
ok('the naive per-date += sum is gone from the chart', !appSrc.includes("if (d < entryDate) return;\r\n        if (!dateMap[d])"));
ok('pb-data history parsers reject non-positive closes', /!isFinite\(c\) \|\| c <= 0/.test(dataSrc));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
