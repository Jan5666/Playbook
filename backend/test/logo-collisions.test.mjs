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
