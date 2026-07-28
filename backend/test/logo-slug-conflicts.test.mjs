// One slug, one company.
//
// tools/logo-tv-ids.mjs is HARVESTED, so it carries whatever the upstream
// screener believes today. Upstream is sometimes wrong in a way no eye catches
// on a 2000-tile contact sheet: it mapped Valterra Platinum to its former
// parent Anglo American, the 10X Investments funds to 10x Genomics (a US
// biotech), and one generic ETF slug to Coronation, Reitway and Vunani at once.
//
// All three have the same mechanical signature — a single slug claimed by keys
// whose own company domains disagree — so that is what this file detects. It is
// the only automated check in the pack that can catch a wrong-company mark; the
// contact sheet catches the rest, and it needs a human.
//
// A new conflict is not automatically a bug: a genuine dual listing (Anglo on
// the JSE and the LSE) shares a slug legitimately. It IS always something a
// person must look at, which is why the fix is to add the losing key to
// TV_SLUG_DENY with a reason rather than to widen this test.
import assert from 'node:assert';
import { test } from 'node:test';
import { TV_SLUG } from '../../tools/logo-tv-ids.mjs';
import {
  TV_SLUG_DENY, TV_SLUG_EXTRA, DENY, domainFor, chainFor, isGenericSlug, effectiveSlugFor,
  SLUG_NEVER_FOR_SA_FUND, issuerFor,
} from '../../tools/logo-sources.mjs';

// FUND_MARKETS is private to logo-sources; mirrored here so the scoping of the
// SA-fund rule is stated in the test rather than inferred.
const FUND_MARKETS_TEST = new Set(['JSE', 'TFSA']);

// A key that resolves to no art at all cannot show the wrong company's mark, so
// its slug is moot for every check in this file.
const inert = (key) => TV_SLUG_DENY.has(key) || DENY.has(key);

// slug -> domain -> [keys]. Read through effectiveSlugFor — the same function
// the pipeline uses — so this test can never disagree with what actually
// shipped. Reading the raw map instead would re-flag every fund the
// SLUG_NEVER_FOR_SA_FUND rule already suppresses.
function conflicts() {
  const bySlug = new Map();
  for (const key of new Set([...Object.keys(TV_SLUG), ...Object.keys(TV_SLUG_EXTRA)])) {
    const [market, ticker] = key.split(':');
    const slug = effectiveSlugFor(market, ticker);
    if (!slug) continue;
    const domain = domainFor(market, ticker);
    if (!domain) continue; // US keys have no domain; nothing to compare against
    const perDomain = bySlug.get(slug) || bySlug.set(slug, new Map()).get(slug);
    (perDomain.get(domain) || perDomain.set(domain, []).get(domain)).push(key);
  }
  return [...bySlug.entries()].filter(([, doms]) => doms.size > 1);
}

test('no logo slug is shared by two different companies', () => {
  const bad = conflicts();
  const detail = bad.map(([slug, doms]) => `\n  ${slug}\n` +
    [...doms.entries()].map(([d, ks]) => `    ${d.padEnd(28)}${ks.join(' ')}`).join('\n')).join('');
  assert.strictEqual(bad.length, 0,
    `${bad.length} slug(s) claimed by more than one company. Check each by eye, ` +
    `then add the WRONG key to TV_SLUG_DENY in tools/logo-sources.mjs:${detail}`);
});

test('the detector actually fires — it cannot pass vacuously', () => {
  // If the shape of TV_SLUG or domainFor ever changes so that no key is
  // comparable, conflicts() returns [] for the wrong reason and the test above
  // goes quietly green forever. Prove the machinery still sees real data.
  const comparable = Object.keys(TV_SLUG)
    .filter((k) => {
      const [market, ticker] = k.split(':');
      return !!effectiveSlugFor(market, ticker) && !!domainFor(market, ticker);
    });
  assert.ok(comparable.length > 200,
    `only ${comparable.length} slugs are domain-comparable — the conflict test is near-vacuous`);
});

test('every denied slug key still resolves to art some other way', () => {
  // Denying a slug must not silently create a gap: the point is to route the key
  // to its own company's art, not to delete its mark. Each denied key must still
  // have at least one candidate (its domain, its ISIN or its issuer sibling).
  for (const key of TV_SLUG_DENY) {
    if (DENY.has(key)) continue; // deliberately artless; the DENY tests cover it
    const [market, ticker] = key.split(':');
    assert.ok(chainFor(market, ticker).length > 0,
      `${key} is denied its slug and has no other source — it would lose its logo`);
  }
});

test('a hand-added slug never silently shadows a harvested one', () => {
  // TV_SLUG_EXTRA exists for instruments the screener does not list. If a
  // re-harvest starts listing one, the hand-written entry is stale and the
  // generated value should take over — so an override that merely repeats what
  // was harvested is dead weight, and one that CONTRADICTS it needs a human.
  for (const [key, slug] of Object.entries(TV_SLUG_EXTRA)) {
    if (!TV_SLUG[key]) continue;
    assert.notStrictEqual(slug, TV_SLUG[key],
      `${key} is in TV_SLUG_EXTRA but the harvester now returns the same slug — delete the override`);
  }
});

test('a denied key never emits its TradingView candidate', () => {
  for (const key of TV_SLUG_DENY) {
    const [market, ticker] = key.split(':');
    const tv = chainFor(market, ticker).filter(c => c.source === 'tradingview');
    assert.deepStrictEqual(tv, [], `${key} is in TV_SLUG_DENY but still offers a tradingview candidate`);
  }
});

test('no key resolves through a generic category slug', () => {
  // `sector/energy` is a pictogram for the energy sector, not State Street's
  // mark — the same file every issuer's energy fund would get. XLE shipped it.
  // Nine sibling funds hid the bug because CANONICAL_ART pinned them to SPY,
  // so the rule is enforced at the source rather than per-ticker.
  const leaked = Object.entries({ ...TV_SLUG, ...TV_SLUG_EXTRA })
    .filter(([key, slug]) => {
      if (!isGenericSlug(slug)) return false;
      const [market, ticker] = key.split(':');
      return chainFor(market, ticker).some(c => c.source === 'tradingview');
    });
  assert.deepStrictEqual(leaked, [], 'a generic category slug reached the chain');
});

test('a parent-company slug never reaches an SA fund', () => {
  // The rule that replaced a hand-maintained key list. Asserted from both sides:
  // no fund carries one of these marks, and the parent that legitimately owns
  // the mark still does — otherwise the rule could "pass" by suppressing FSR too.
  for (const key of new Set([...Object.keys(TV_SLUG), ...Object.keys(TV_SLUG_EXTRA)])) {
    const [market, ticker] = key.split(':');
    const slug = effectiveSlugFor(market, ticker);
    if (!slug || !SLUG_NEVER_FOR_SA_FUND.has(slug)) continue;
    assert.ok(!(FUND_MARKETS_TEST.has(market) && issuerFor(ticker)),
      `${key} is an SA fund still carrying the parent mark ${slug}`);
  }
  assert.strictEqual(effectiveSlugFor('JSE', 'FSR'), 'firstrand-ltd',
    'FirstRand itself must keep its own mark — the rule is scoped to funds');
});

test('isGenericSlug rejects category namespaces and keeps real ones', () => {
  for (const s of ['sector/energy', 'country/us', 'provider/vanguard', 'type/etf']) {
    assert.ok(isGenericSlug(s), `${s} should be treated as category art`);
  }
  // crypto/ is per-coin art, and a bare slug is a company.
  for (const s of ['crypto/XTVCBTC', 'anglo-american', 'satrix-40-portfolio', '']) {
    assert.ok(!isGenericSlug(s), `${s} must not be treated as category art`);
  }
});
