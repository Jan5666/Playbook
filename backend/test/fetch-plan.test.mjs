// Unit tests for the pure buildFetchPlan kernel in pb-core.js (Phase 2 inc 3).
//   cd backend/test && node fetch-plan.test.mjs
import PBCore from '../../pb-core.js';

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const keys = (order) => order.map(o => o.market + ':' + o.ticker);

const fast = [['US:AAPL', 'US:GOOGL'], ['JSE:NPN'], [], ['US:^SPX']]; // positions, watchlist, alerts, ribbon
const lazy = { picks: ['US:NVDA', 'US:AMD'], hedges: ['US:GLD'], overview: ['US:C'] };

ok('PBCore exports buildFetchPlan', typeof PBCore.buildFetchPlan === 'function');

// No active lazy view, nothing warmed → fast tiers only, in tier order, deduped.
let p = PBCore.buildFetchPlan({ fastTiers: fast, lazyLists: lazy, warmed: new Set(), activeView: 'dashboard' });
ok('cold: order is fast tiers in order', keys(p.order).join(',') === 'US:AAPL,US:GOOGL,JSE:NPN,US:^SPX');
ok('cold: no lazy symbols present', !keys(p.order).some(k => ['US:NVDA','US:AMD','US:GLD','US:C'].includes(k)));

// Active = picks → picks float to the FRONT, then fast tiers.
p = PBCore.buildFetchPlan({ fastTiers: fast, lazyLists: lazy, warmed: new Set(['picks']), activeView: 'picks' });
ok('active picks floats to front', keys(p.order).slice(0, 2).join(',') === 'US:NVDA,US:AMD');
ok('fast tiers follow the floated list', keys(p.order).join(',') === 'US:NVDA,US:AMD,US:AAPL,US:GOOGL,JSE:NPN,US:^SPX');

// Warmed-but-inactive list is included AFTER the fast tiers (active=picks, hedges warmed).
p = PBCore.buildFetchPlan({ fastTiers: fast, lazyLists: lazy, warmed: new Set(['picks', 'hedges']), activeView: 'picks' });
ok('warmed inactive list trails the fast tiers', keys(p.order).join(',') === 'US:NVDA,US:AMD,US:AAPL,US:GOOGL,JSE:NPN,US:^SPX,US:GLD');

// Dedupe: a ticker in both the active lazy list and the fast tier appears once, in the floated slot.
let p2 = PBCore.buildFetchPlan({ fastTiers: [['US:NVDA', 'US:AAPL']], lazyLists: lazy, warmed: new Set(['picks']), activeView: 'picks' });
ok('dedupe keeps first occurrence (floated)', keys(p2.order).join(',') === 'US:NVDA,US:AMD,US:AAPL');

// key = fast-tier membership only, sorted, joined.
ok('key is fast-tier price-keys sorted', p.key === ['US:AAPL','US:GOOGL','JSE:NPN','US:^SPX'].sort().join(','));

// ANTI-THRASH INVARIANT: key is identical under reorder (different activeView) and
// under lazy-list warming, but differs when fast-tier membership changes.
const kPicks = PBCore.buildFetchPlan({ fastTiers: fast, lazyLists: lazy, warmed: new Set(['picks']), activeView: 'picks' }).key;
const kHedges = PBCore.buildFetchPlan({ fastTiers: fast, lazyLists: lazy, warmed: new Set(['picks','hedges']), activeView: 'hedges' }).key;
ok('key stable under reorder + warming', kPicks === kHedges);
const kMore = PBCore.buildFetchPlan({ fastTiers: [['US:AAPL','US:GOOGL','US:TSLA'], ['JSE:NPN'], [], ['US:^SPX']], lazyLists: lazy, warmed: new Set(), activeView: 'dashboard' }).key;
ok('key changes when fast-tier membership changes', kMore !== kPicks);

// Tolerates array warmed + missing/empty inputs.
let p3 = PBCore.buildFetchPlan({ fastTiers: [['US:AAPL']], lazyLists: {}, warmed: ['picks'], activeView: 'dashboard' });
ok('array warmed + empty lazyLists is safe', keys(p3.order).join(',') === 'US:AAPL' && p3.key === 'US:AAPL');

// (The anti-drift guard rows are added in Task 3, once app.js is wired — keeping
// this suite fully green at its own commit.)

console.log(failures ? `\n${failures} test(s) failed` : '\nAll fetch-plan tests passed');
process.exit(failures ? 1 : 0);
