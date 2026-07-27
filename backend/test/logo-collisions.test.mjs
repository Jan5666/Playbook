// The wrong-company regression pin.
//
// Bare-ticker logo endpoints are US-centric: they resolve `MTN` to Vail Resorts
// and `SOL` to ReneSola, and return HTTP 200 while doing it. A 404 is a missing
// logo; this is a CONFIDENTLY WRONG logo, which is worse — nothing in the
// response distinguishes it. These tests pin the rule that prevents it: outside
// the US market, the lookup key is never a bare ticker.
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chainFor, ISIN_BY_TICKER, CRYPTO_ID } from '../../tools/logo-sources.mjs';
import * as chainForModule from '../../tools/logo-sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('JSE resolution never uses a bare ticker', () => {
  for (const t of ['SOL', 'MTN', 'NPN', 'SHP', 'PRX']) {
    const chain = chainFor('JSE', t);
    assert.ok(chain.length > 0, `${t}: expected at least one candidate`);
    for (const c of chain) {
      assert.notStrictEqual(c.key, 'ticker',
        `JSE:${t} used a bare-ticker lookup — this is the Vail Resorts bug`);
    }
  }
});

test('every market except US forbids the ticker key', () => {
  for (const m of ['JSE', 'TFSA', 'LSE', 'ASX', 'FRA', 'PAR', 'AMS', 'CRYPTO']) {
    for (const c of chainFor(m, 'SOL')) {
      assert.notStrictEqual(c.key, 'ticker', `${m}:SOL used a bare-ticker lookup`);
    }
  }
});

test('crypto never routes through a stock API', () => {
  const hosts = chainFor('CRYPTO', 'SOL').map(c => new URL(c.url).hostname);
  for (const h of hosts) {
    assert.ok(!/financialmodelingprep|parqet/.test(h),
      `crypto resolved via a stock API (${h}) — FMP's SOL is ReneSola, not Solana`);
  }
});

test('the same ticker in different markets resolves differently', () => {
  const jse = chainFor('JSE', 'SOL')[0].url;
  const crypto = chainFor('CRYPTO', 'SOL')[0].url;
  assert.notStrictEqual(jse, crypto, 'SOL must not share a URL across markets');
});

test('US keeps the ticker key (its listings are the ones these APIs index)', () => {
  assert.ok(chainFor('US', 'AAPL').some(c => c.key === 'ticker'));
});

test('the ISIN table covers the JSE tickers measured in the spec', () => {
  for (const t of ['NPN', 'SOL', 'MTN', 'SHP', 'PRX', 'FSR', 'CPI', 'BVT', 'KIO', 'DSY']) {
    assert.ok(ISIN_BY_TICKER[`JSE:${t}`], `missing ISIN for JSE:${t}`);
    assert.match(ISIN_BY_TICKER[`JSE:${t}`], /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/, `JSE:${t} ISIN malformed`);
  }
});

test('crypto ids are lower-case slugs', () => {
  for (const [t, id] of Object.entries(CRYPTO_ID)) {
    assert.strictEqual(id, id.toLowerCase(), `${t} → ${id} must be lower-case`);
  }
});

test('anti-drift: build-logos.mjs contains no bare-ticker URL builder', () => {
  // If someone reintroduces a ticker-keyed fetch in the orchestrator, the guard
  // in logo-sources.mjs can be bypassed entirely. Grep for it.
  const src = readFileSync(join(ROOT, 'tools', 'build-logos.mjs'), 'utf8');
  assert.ok(!/image-stock\/\$\{/.test(src),
    'build-logos.mjs builds an FMP ticker URL directly — it must go through chainFor()');
  assert.ok(!/logos\/symbol\/\$\{/.test(src),
    'build-logos.mjs builds a Parqet symbol URL directly — it must go through chainFor()');
});

test('anti-drift: the orchestrator builds no logo URL of its own', () => {
  // The Vail Resorts bug returns HTTP 200, so nothing downstream can catch it.
  // The only defence is that build-logos.mjs never constructs a provider URL —
  // every candidate must come from chainFor(), which enforces the market rule.
  // Grepping for one string shape is dodgeable (proven in Task 3 review); assert
  // the absence of provider hosts entirely, in any spelling.
  const src = readFileSync(join(ROOT, 'tools', 'build-logos.mjs'), 'utf8');
  const HOSTS = ['financialmodelingprep', 'assets.parqet.com', 'parqet.com', 'cryptocurrency-icons', 'jsdelivr'];
  for (const h of HOSTS) {
    assert.ok(!src.includes(h),
      `build-logos.mjs names the provider host "${h}" — provider URLs must come from chainFor() only`);
  }
  // And it must actually import the resolver rather than rolling its own.
  assert.match(src, /from\s+['"]\.\/logo-sources\.mjs['"]/,
    'build-logos.mjs must import its candidates from logo-sources.mjs');
  assert.match(src, /chainFor\s*\(/, 'build-logos.mjs must resolve candidates via chainFor()');
});

test('denied keys resolve to no candidate at all', () => {
  // DENY is the escape hatch for a key whose every available source returns the
  // WRONG company — a monogram beats another company's mark. Kumba Iron Ore is
  // the standing case: it is an Anglo American subsidiary and every source,
  // including angloamericankumba.com's own icon, returns the parent's blue/red
  // triangle (re-verified by eye 2026-07-27). Also asserted on a key that WOULD
  // resolve, so the test cannot pass vacuously if DENY is ever emptied.
  const { DENY } = chainForModule;
  assert.ok(DENY.has('JSE:KIO'), 'JSE:KIO must stay denied');
  assert.ok(chainFor('JSE', 'SOL').length > 0, 'precondition: JSE:SOL normally resolves');
  DENY.add('JSE:SOL');
  try {
    assert.deepStrictEqual(chainFor('JSE', 'SOL'), [], 'DENY did not suppress the chain');
  } finally {
    DENY.delete('JSE:SOL');
  }
  for (const key of DENY) {
    const [market, ticker] = key.split(':');
    assert.deepStrictEqual(chainFor(market, ticker), [],
      `${key} is denied but still produced candidates`);
  }
});

test('non-US keys resolve through a domain, never a bare ticker', () => {
  // The domain map is what replaced ISIN-only resolution for the non-US
  // universe. A domain is human-checkable in the source file and a
  // domain-keyed icon service can only answer with that company's own art.
  const { DOMAIN_BY_KEY, domainFor } = chainForModule;
  for (const key of ['JSE:CPI', 'JSE:SHP', 'LSE:HSBA', 'ASX:CBA', 'AMS:ASML', 'PAR:MC', 'FRA:SAP']) {
    const [market, ticker] = key.split(':');
    assert.ok(domainFor(market, ticker), `${key} has no domain`);
    for (const c of chainFor(market, ticker)) {
      assert.notStrictEqual(c.key, 'ticker', `${key} used a bare-ticker lookup`);
    }
  }
  for (const [key, domain] of Object.entries(DOMAIN_BY_KEY)) {
    assert.match(key, /^[A-Z]{3,6}:[A-Za-z0-9.\-]+$/, `malformed domain key: ${key}`);
    assert.match(domain, /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/,
      `${key} maps to "${domain}", which is not a bare hostname`);
  }
});

test('SA fund issuer prefixes never claim a US ticker', () => {
  // GLD is NewGold on the JSE and SPDR Gold Shares in New York; CS*/CTOP are
  // 10X funds in Johannesburg and unrelated symbols elsewhere. The prefix rules
  // must be scoped to the markets that actually list those funds.
  const { domainFor } = chainForModule;
  for (const t of ['GLD', 'CSP500', 'ETF500', 'NFSWIX', 'STX40', 'SYGWD']) {
    assert.strictEqual(domainFor('US', t), null, `US:${t} was claimed by an SA fund-issuer rule`);
  }
  assert.ok(domainFor('JSE', 'GLD'), 'JSE:GLD should still resolve to NewGold');
});
