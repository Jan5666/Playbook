// Tests for the market-rotation math in pb-core.js and the intraday-bar parser
// in pb-data.js (the Rotation tab). All the aggregation/classification/flow/
// series logic is pure and deterministic, so it is characterized here without a
// browser; parseIntradayResult is exercised against crafted Yahoo chart JSON.
//   cd backend/test && node rotation-core.test.mjs
//
// Two layers, same as markets-core.test.mjs:
//   1. Ground-truth math — exact fixtures with hand-computed expected values so
//      a regression in weighting/thresholds/conservation is caught numerically.
//   2. Anti-drift source guards — app.js must register the tab + bind the view
//      (and NOT define the view or re-implement the math), pb-views.js must
//      DELEGATE to PBCore, BACKUP_SKIP must carry the churny cache key, and the
//      service-worker cache must be bumped off v65.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';
import PBData from '../../pb-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
const viewsSrc = readFileSync(join(here, '..', '..', 'pb-views.js'), 'utf8');
const swSrc = readFileSync(join(here, '..', '..', 'sw.js'), 'utf8');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const { aggregateSectorSnapshot, classifyRotation, pairFlows, buildRotationFetchPlan,
        buildIntradaySeries, combineSectorSeries, downsampleRotationSeries,
        rotationSummary, ROTATION_THRESHOLDS, priceKey } = PBCore;

// ── 1. aggregateSectorSnapshot ───────────────────────────────────────────────
{
  const rows = [
    { ticker: 'A', sector: 'Tech', m: 100, changePct: 2 },
    { ticker: 'B', sector: 'Tech', m: 50, changePct: -1 },
    { ticker: 'C', sector: 'Energy', m: 30, changePct: -3 },
  ];
  const { sectors, market } = aggregateSectorSnapshot(rows);
  const tech = sectors.find(s => s.sector === 'Tech');
  const energy = sectors.find(s => s.sector === 'Energy');
  // wPct = (100*2 + 50*-1) / 150 = 150/150 = 1.0
  ok('aggregate: Tech wPct = +1.0', near(tech.wPct, 1.0));
  // deltaCap = 100*2/100 + 50*-1/100 = 2 - 0.5 = 1.5
  ok('aggregate: Tech deltaCap = 1.5', near(tech.deltaCap, 1.5));
  ok('aggregate: Energy deltaCap = -0.9', near(energy.deltaCap, -0.9));
  ok('aggregate: market deltaCap = sum of sectors (0.6)', near(market.deltaCap, 0.6) && near(market.deltaCap, tech.deltaCap + energy.deltaCap));
  ok('aggregate: Tech breadth 1 adv / 1 dec', tech.adv === 1 && tech.dec === 1);
  ok('aggregate: sectors sorted by deltaCap desc', sectors[0].sector === 'Tech');
  ok('aggregate: Tech top=A bottom=B', tech.top.ticker === 'A' && tech.bottom.ticker === 'B');
}
{
  // Null-pct row: counted in count/weight, excluded from quoted/wPct/deltaCap.
  const rows = [
    { ticker: 'A', sector: 'Tech', m: 100, changePct: 2 },
    { ticker: 'B', sector: 'Tech', m: 50, changePct: null },
  ];
  const { sectors, market } = aggregateSectorSnapshot(rows);
  const tech = sectors[0];
  ok('null-pct: count includes it (2), quoted excludes (1)', tech.count === 2 && tech.quoted === 1);
  ok('null-pct: weight 150, quotedWeight 100', near(tech.weight, 150) && near(tech.quotedWeight, 100));
  ok('null-pct: wPct from quoted only (+2.0)', near(tech.wPct, 2.0));
  ok('null-pct: market totalWeight 150, quotedWeight 100', near(market.totalWeight, 150) && near(market.quotedWeight, 100));
}
{
  // Single-constituent sector: top === bottom.
  const { sectors } = aggregateSectorSnapshot([{ ticker: 'Z', sector: 'RE', m: 20, changePct: 1.5 }]);
  ok('single-constituent: top and bottom same ticker', sectors[0].top.ticker === 'Z' && sectors[0].bottom.ticker === 'Z');
  ok('single-constituent: wPct = its pct', near(sectors[0].wPct, 1.5));
}
{
  // Sector with zero quoted rows: wPct null, deltaCap 0.
  const { sectors } = aggregateSectorSnapshot([{ ticker: 'Q', sector: 'Util', m: 10, changePct: undefined }]);
  ok('zero-quoted: wPct null', sectors[0].wPct === null);
  ok('zero-quoted: deltaCap 0', sectors[0].deltaCap === 0);
}

// ── 2. classifyRotation boundaries ───────────────────────────────────────────
// Helper: synth a snapshot from sector specs {sector, wPct, m, deltaCap?} with
// breadth we control via adv/dec, so we exercise the classifier directly.
function synthSnapshot(specs, marketOverride) {
  const sectors = specs.map(s => ({
    sector: s.sector, count: s.count ?? 10, quoted: s.quoted ?? 10,
    weight: s.m, quotedWeight: s.m, wPct: s.wPct,
    deltaCap: s.deltaCap != null ? s.deltaCap : s.m * s.wPct / 100,
    adv: s.adv ?? (s.wPct > 0 ? 8 : 2), dec: s.dec ?? (s.wPct > 0 ? 2 : 8), flat: 0,
    top: null, bottom: null,
  }));
  const totW = sectors.reduce((t, s) => t + s.quotedWeight, 0);
  const wPct = totW ? sectors.reduce((t, s) => t + s.wPct * s.quotedWeight, 0) / totW : 0;
  const market = Object.assign({
    count: sectors.reduce((t, s) => t + s.count, 0),
    quoted: sectors.reduce((t, s) => t + s.quoted, 0),
    totalWeight: totW, quotedWeight: totW,
    deltaCap: sectors.reduce((t, s) => t + s.deltaCap, 0),
    adv: sectors.reduce((t, s) => t + s.adv, 0),
    dec: sectors.reduce((t, s) => t + s.dec, 0),
    flat: 0, wPct,
  }, marketOverride || {});
  return { sectors, market };
}
{
  // Net boundary inclusive: marketPct exactly +0.25 with broad breadth -> inflow.
  const snap = synthSnapshot([{ sector: 'A', wPct: 0.25, m: 100, adv: 7, dec: 3 }]);
  ok('classify: +0.25 is net-in inflow', classifyRotation(snap).verdict === 'inflow');
  const snap2 = synthSnapshot([{ sector: 'A', wPct: 0.24, m: 100, adv: 7, dec: 3 }]);
  ok('classify: +0.24 is not net-in (mixed)', classifyRotation(snap2).net === 'flat');
}
{
  // Narrow-rally guard: strong market up but breadth below BREADTH_LO -> mixed.
  const snap = synthSnapshot([
    { sector: 'A', wPct: 1.2, m: 100, adv: 2, dec: 8 },
    { sector: 'B', wPct: 0.05, m: 40, adv: 3, dec: 7 },
  ]);
  const c = classifyRotation(snap);
  ok('classify: net-up + weak breadth -> mixed', c.net === 'in' && c.verdict === 'mixed');
}
{
  // Pure rotation: market ~0, one sector up (gaining cap), one down (losing cap),
  // dispersion >= DISP -> 'rotation'.
  const snap = synthSnapshot([
    { sector: 'Up', wPct: 1.5, m: 100, adv: 8, dec: 2 },
    { sector: 'Down', wPct: -1.5, m: 100, adv: 2, dec: 8 },
  ]);
  const c = classifyRotation(snap);
  ok('classify: two-sided high-dispersion -> rotation', c.verdict === 'rotation' && c.rotating);
  ok('classify: inflows[0]=Up, outflows[0]=Down', c.inflows[0].sector === 'Up' && c.outflows[0].sector === 'Down');
}
{
  // Rotation biased net-in / net-out.
  const inBias = synthSnapshot([
    { sector: 'Up', wPct: 1.8, m: 110, adv: 8, dec: 2 },
    { sector: 'Down', wPct: -1.2, m: 100, adv: 2, dec: 8 },
  ]);
  ok('classify: net-in rotation -> inflow-rotation', classifyRotation(inBias).verdict === 'inflow-rotation');
  const outBias = synthSnapshot([
    { sector: 'Up', wPct: 1.2, m: 100, adv: 8, dec: 2 },
    { sector: 'Down', wPct: -1.8, m: 110, adv: 2, dec: 8 },
  ]);
  ok('classify: net-out rotation -> outflow-rotation', classifyRotation(outBias).verdict === 'outflow-rotation');
}
{
  // Quiet: tiny moves, low dispersion.
  const snap = synthSnapshot([
    { sector: 'A', wPct: 0.05, m: 100, adv: 5, dec: 5 },
    { sector: 'B', wPct: -0.05, m: 100, adv: 5, dec: 5 },
  ]);
  ok('classify: flat + low dispersion -> quiet', classifyRotation(snap).verdict === 'quiet');
}
{
  // twoSided edge: negative side only reaches -0.29 (below SIDE 0.30) -> not rotating.
  const snap = synthSnapshot([
    { sector: 'Up', wPct: 1.5, m: 100, adv: 8, dec: 2 },
    { sector: 'Down', wPct: -0.29, m: 100, adv: 4, dec: 6 },
  ]);
  const c = classifyRotation(snap);
  ok('classify: down side -0.29 below SIDE -> not rotating', !c.rotating);
}
{
  // confidence: 100% quoted -> high; ~50% -> low.
  const hi = synthSnapshot([{ sector: 'A', wPct: 0.5, m: 100, count: 10, quoted: 10 }]);
  ok('classify: full coverage -> high confidence', classifyRotation(hi).confidence === 'high');
  const lo = synthSnapshot([{ sector: 'A', wPct: 0.5, m: 100, count: 10, quoted: 5 }],
                           { count: 10, quoted: 5 });
  ok('classify: half coverage -> low confidence', classifyRotation(lo).confidence === 'low');
}

// ── 3. pairFlows ─────────────────────────────────────────────────────────────
{
  const sectors = [
    { sector: 'O1', deltaCap: -4 },
    { sector: 'O2', deltaCap: -2 },
    { sector: 'O3', deltaCap: -1 },
    { sector: 'I1', deltaCap: 3 },
    { sector: 'I2', deltaCap: 1.5 },
  ];
  const { totalIn, totalOut, matched, flows } = pairFlows(sectors);
  ok('pairFlows: totalIn 4.5, totalOut 7', near(totalIn, 4.5) && near(totalOut, 7));
  ok('pairFlows: matched = min = 4.5', near(matched, 4.5));
  const sum = flows.reduce((t, f) => t + f.amount, 0);
  ok('pairFlows: conservation sum(amount) === matched', near(sum, matched));
  // Sub-conservation for one source O1 (share 4/7 of matched).
  const o1 = flows.filter(f => f.from === 'O1').reduce((t, f) => t + f.amount, 0);
  ok('pairFlows: O1 allocation = matched * 4/7', near(o1, matched * 4 / 7));
}
{
  // One-sided (all up): no outflow -> flows empty, net = totalIn.
  const { flows, totalOut, net, totalIn } = pairFlows([{ sector: 'A', deltaCap: 2 }, { sector: 'B', deltaCap: 1 }]);
  ok('pairFlows: one-sided -> flows []', flows.length === 0);
  ok('pairFlows: one-sided totalOut 0, net = totalIn', totalOut === 0 && near(net, totalIn));
}
{
  // Proportionality: out A twice out B -> A allocated exactly 2x B.
  const { flows } = pairFlows([{ sector: 'A', deltaCap: -2 }, { sector: 'B', deltaCap: -1 }, { sector: 'I', deltaCap: 5 }]);
  const a = flows.filter(f => f.from === 'A').reduce((t, f) => t + f.amount, 0);
  const b = flows.filter(f => f.from === 'B').reduce((t, f) => t + f.amount, 0);
  ok('pairFlows: A allocation = 2x B', near(a, 2 * b));
}

// ── 4. buildIntradaySeries / combineSectorSeries ─────────────────────────────
{
  // Two series; one missing a middle bar -> forward-filled at that grid point.
  const inputs = [
    { key: 'X', weight: 1, prevClose: 100, points: [{ t: 1, p: 100 }, { t: 2, p: 101 }, { t: 3, p: 102 }] },
    { key: 'Y', weight: 1, prevClose: 100, points: [{ t: 1, p: 100 }, { t: 3, p: 103 }] }, // no t=2 bar
  ];
  const b = buildIntradaySeries(inputs);
  const y = b.series.find(s => s.key === 'Y');
  ok('series: grid is union {1,2,3}', b.ts.length === 3 && b.ts[1] === 2);
  ok('series: Y forward-filled at t=2 (still 0%)', near(y.cum[1], 0));
  ok('series: Y at t=3 is +3%', near(y.cum[2], 3));
}
{
  // Series starting 3 bars late -> nulls before first bar; benchmark uses only present series.
  const inputs = [
    { key: 'Full', weight: 1, prevClose: 100, points: [{ t: 1, p: 101 }, { t: 2, p: 102 }, { t: 3, p: 103 }] },
    { key: 'Late', weight: 1, prevClose: 100, points: [{ t: 3, p: 110 }] },
  ];
  const b = buildIntradaySeries(inputs);
  const late = b.series.find(s => s.key === 'Late');
  ok('series: late series null before first bar', late.cum[0] === null && late.cum[1] === null);
  // benchmark at t=1 = only Full present = +1%
  ok('series: benchmark renormalizes to present series (t1 = +1%)', near(b.benchmark[0], 1));
  // benchmark at t=3 = (1*3 + 1*10)/2 = 6.5%
  ok('series: benchmark at t=3 = 6.5%', near(b.benchmark[2], 6.5));
}
{
  // cum-from-prevClose exact vs fallback base = first regular bar.
  const withPrev = buildIntradaySeries([{ key: 'A', weight: 1, prevClose: 100, points: [{ t: 1, p: 101 }] }]);
  ok('series: prevClose base -> +1.00 exact', near(withPrev.series[0].cum[0], 1));
  const noPrev = buildIntradaySeries(
    [{ key: 'B', weight: 1, prevClose: null, points: [{ t: 1, p: 90, session: 'pre' }, { t: 2, p: 100, session: 'regular' }, { t: 3, p: 105, session: 'regular' }] }],
    { regularStart: 2, regularEnd: 9 });
  // base = first regular bar (p=100): pre bar shows -10%, close shows +5%.
  ok('series: no prevClose -> base = first regular bar (pre bar -10%)', near(noPrev.series[0].cum[0], -10));
  ok('series: no prevClose -> +5% at close', near(noPrev.series[0].cum[2], 5));
  ok('series: sessionAt tags pre/regular from bounds', noPrev.sessionAt[0] === 'pre' && noPrev.sessionAt[1] === 'regular');
}
{
  // All-regular when bounds null.
  const b = buildIntradaySeries([{ key: 'A', weight: 1, prevClose: 100, points: [{ t: 1, p: 100 }, { t: 2, p: 101 }] }]);
  ok('series: no bounds -> all sessionAt regular', b.sessionAt.every(s => s === 'regular'));
}
{
  // combineSectorSeries stocks mode: 1 sector, 2 constituents (m 100/50) cap-weighted.
  const plan = { mode: 'stocks', legs: [{ key: 'Tech', weight: 150, symbols: [{ ticker: 'A', market: 'US', w: 100 }, { ticker: 'B', market: 'US', w: 50 }] }] };
  const bars = {
    [priceKey('US', 'A')]: { points: [{ t: 1, p: 100, v: 10 }, { t: 2, p: 102, v: 10 }], prevClose: 100, regularStart: 1, regularEnd: 2 },
    [priceKey('US', 'B')]: { points: [{ t: 1, p: 100, v: 5 }, { t: 2, p: 100, v: 5 }], prevClose: 100, regularStart: 1, regularEnd: 2 },
  };
  const c = combineSectorSeries(plan, bars);
  const tech = c.series.find(s => s.key === 'Tech');
  // sector line at t=2 = (100*2% + 50*0%)/150 = 1.333%
  ok('combine: stocks-mode sector line cap-weighted (t2 ~1.333%)', near(tech.cum[1], (100 * 2 + 50 * 0) / 150, 1e-6));
  ok('combine: activity share computed when volume present', c.activity.find(a => a.key === 'Tech').share != null);
}
{
  // A null barsBySymbol entry drops that symbol; all-null leg omitted from series.
  const plan = { mode: 'stocks', legs: [
    { key: 'Good', weight: 100, symbols: [{ ticker: 'A', market: 'US', w: 100 }, { ticker: 'Missing', market: 'US', w: 50 }] },
    { key: 'Empty', weight: 40, symbols: [{ ticker: 'Gone', market: 'US', w: 40 }] },
  ] };
  const bars = { [priceKey('US', 'A')]: { points: [{ t: 1, p: 100, v: null }, { t: 2, p: 101, v: null }], prevClose: 100, regularStart: 1, regularEnd: 2 } };
  const c = combineSectorSeries(plan, bars);
  ok('combine: leg with all-missing symbols omitted from series', !c.series.find(s => s.key === 'Empty'));
  ok('combine: good leg present, missing symbol dropped', !!c.series.find(s => s.key === 'Good'));
  ok('combine: null volume -> share null (activity hidden)', c.activity.find(a => a.key === 'Good').share === null);
}

// ── 5. downsampleRotationSeries ──────────────────────────────────────────────
{
  const ts = Array.from({ length: 192 }, (_, i) => i);
  const built = { ts, sessionAt: ts.map(() => 'regular'),
    series: [{ key: 'A', weight: 1, cum: ts.map(i => i / 3 + 0.005) }],
    benchmark: ts.map(i => i / 3 + 0.005), regularStart: 0, regularEnd: 191, activity: [] };
  const ds = downsampleRotationSeries(built, 48);
  ok('downsample: 192 -> <= 48 points', ds.ts.length <= 48);
  ok('downsample: last ts preserved', ds.ts[ds.ts.length - 1] === 191);
  ok('downsample: values rounded to 2dp', ds.series[0].cum.every(v => v == null || Math.abs(v * 100 - Math.round(v * 100)) < 1e-9));
}

// ── 6. buildRotationFetchPlan ────────────────────────────────────────────────
const SECTOR_ETF = { Technology: { etf: 'XLK' }, Energy: { etf: 'XLE' }, Financials: { etf: 'XLF' }, 'Financial Services': { etf: 'XLF' } };
{
  const usDef = { id: 'mini', market: 'US', constituents: [
    { t: 'AAPL', s: 'Technology', m: 100 }, { t: 'MSFT', s: 'Technology', m: 80 },
    { t: 'XOM', s: 'Energy', m: 50 },
  ] };
  const plan = buildRotationFetchPlan(usDef, { sectorEtf: SECTOR_ETF, topN: 3 });
  ok('plan: US + SECTOR_ETF -> etf mode', plan.mode === 'etf');
  ok('plan: one leg per present sector (2)', plan.legs.length === 2);
  const tech = plan.legs.find(l => l.key === 'Technology');
  ok('plan: etf leg weight = full-sector sum (180)', near(tech.weight, 180));
  ok('plan: etf leg symbol is the SPDR', tech.symbols[0].ticker === 'XLK' && tech.symbols[0].market === 'US');
}
{
  // Alias sectors collapse to one ETF leg.
  const aliasDef = { id: 'al', market: 'US', constituents: [
    { t: 'JPM', s: 'Financials', m: 60 }, { t: 'BAC', s: 'Financial Services', m: 40 },
  ] };
  const plan = buildRotationFetchPlan(aliasDef, { sectorEtf: SECTOR_ETF, topN: 3 });
  const xlf = plan.legs.filter(l => l.symbols[0].ticker === 'XLF');
  ok('plan: alias sectors dedupe to one XLF leg', xlf.length === 1);
}
{
  // Non-US -> stocks mode, top-3 by m; a 2-constituent sector yields 2 symbols.
  const jseDef = { id: 'jse40', market: 'JSE', constituents: [
    { t: 'NPN', s: 'Technology', m: 600 }, { t: 'PRX', s: 'Technology', m: 400 }, { t: 'AVV', s: 'Technology', m: 30 }, { t: 'X4', s: 'Technology', m: 10 },
    { t: 'SOL', s: 'Energy', m: 80 }, { t: 'EXX', s: 'Energy', m: 40 },
  ] };
  const plan = buildRotationFetchPlan(jseDef, { sectorEtf: SECTOR_ETF, topN: 3 });
  ok('plan: non-US -> stocks mode', plan.mode === 'stocks');
  const tech = plan.legs.find(l => l.key === 'Technology');
  ok('plan: top-3 by m (NPN,PRX,AVV) drops X4', tech.symbols.length === 3 && tech.symbols.map(s => s.ticker).sort().join() === 'AVV,NPN,PRX');
  ok('plan: stocks leg carries market JSE + cap weights', tech.symbols[0].market === 'JSE' && tech.symbols[0].w === 600);
  const energy = plan.legs.find(l => l.key === 'Energy');
  ok('plan: 2-constituent sector -> 2 symbols', energy.symbols.length === 2);
}

// ── 7. parseIntradayResult (PBData) ──────────────────────────────────────────
{
  // Crafted JSE (ZAc = cents) payload: closes divided by 100, volume kept as-is.
  const result = {
    timestamp: [1000, 1300, 1600],
    meta: { currency: 'ZAc', chartPreviousClose: 9900,
      currentTradingPeriod: { regular: { start: 1200, end: 1500 } } },
    indicators: { quote: [{ close: [9800, 10100, 10200], volume: [5000, null, 7000] }] },
  };
  const parsed = PBData.parseIntradayResult(result, 'NPN', 'JSE');
  ok('parseIntraday: cents divided by 100 (98, 101, 102)', near(parsed.points[0].p, 98) && near(parsed.points[1].p, 101));
  ok('parseIntraday: prevClose divided (99)', near(parsed.prevClose, 99));
  ok('parseIntraday: volume kept, null preserved', parsed.points[0].v === 5000 && parsed.points[1].v === null);
  ok('parseIntraday: session tags pre/regular/post', parsed.points[0].session === 'pre' && parsed.points[1].session === 'regular' && parsed.points[2].session === 'post');
}
{
  // US payload with no volume array -> every point v === null; USD no divisor.
  const result = {
    timestamp: [1000, 1300],
    meta: { currency: 'USD', chartPreviousClose: 100, currentTradingPeriod: { regular: { start: 900, end: 1600 } } },
    indicators: { quote: [{ close: [101, 102] }] },
  };
  const parsed = PBData.parseIntradayResult(result, 'AAPL', 'US');
  ok('parseIntraday: USD undivided (101,102)', near(parsed.points[0].p, 101) && near(parsed.points[1].p, 102));
  ok('parseIntraday: no volume array -> all v null', parsed.points.every(p => p.v === null));
}

// ── 8. rotationSummary (sentence assembly) ───────────────────────────────────
{
  const snap = synthSnapshot([
    { sector: 'Technology', wPct: 1.5, m: 100, adv: 8, dec: 2 },
    { sector: 'Energy', wPct: -1.5, m: 100, adv: 2, dec: 8 },
  ]);
  const c = classifyRotation(snap);
  const sum = rotationSummary(c);
  ok('summary: rotation sentence names both sides + net', /Out of/.test(sum) && /into/.test(sum) && /Market net/.test(sum));
}

// ── 9. Anti-drift source guards ──────────────────────────────────────────────
ok('guard: app.js registers the rotation tab', /\['rotation',\s*'Rotation'\]/.test(appSrc));
ok('guard: app.js binds MarketRotationView from PBViews', /const\s+MarketRotationView\s*=\s*PBViews\.MarketRotationView/.test(appSrc));
ok('guard: app.js does NOT define function MarketRotationView', !/function\s+MarketRotationView\s*\(/.test(appSrc));
ok('guard: app.js mounts rotation in the views map', /rotation:\s*React\.createElement\(MarketRotationView/.test(appSrc));
ok('guard: BACKUP_SKIP carries pb.rotation.lastgood.v1', /pb\.rotation\.lastgood\.v1/.test(appSrc));
ok('guard: pb-views.js delegates to PBCore.aggregateSectorSnapshot', /PBCore\.aggregateSectorSnapshot/.test(viewsSrc));
ok('guard: pb-views.js delegates to PBCore.pairFlows', /PBCore\.pairFlows/.test(viewsSrc));
ok('guard: pb-views.js does not re-implement the math', !/function\s+(aggregateSectorSnapshot|pairFlows|classifyRotation)\s*\(/.test(viewsSrc));
ok('guard: sw.js CACHE_NAME bumped off v65', !/playbook-shell-v65/.test(swSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll rotation-core tests passed');
process.exit(failures ? 1 : 0);
