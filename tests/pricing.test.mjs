// Unit tests for the env-driven pricing math (server/config/pricing.js).
// Runs the pricing module in child processes with different env so we can prove
// the numbers come from .env (and that fallbacks kick in when env is unset).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const printer = path.join(here, '_print-pricing.mjs');

// Run the printer with a specific env (billing vars stripped, then overlaid).
const runWith = (overrides) => {
  const env = { ...process.env };
  // strip any billing vars inherited from the shell / .env so each case is clean
  for (const k of ['META_COST_MARKETING_PAISE','META_COST_SERVICE_PAISE','META_COST_UTILITY_PAISE','META_COST_AUTHENTICATION_PAISE','PLATFORM_MARKUP_PCT']) delete env[k];
  Object.assign(env, overrides);
  const stdout = execFileSync(process.execPath, [printer], { env, cwd: path.join(here, '..') });
  return JSON.parse(stdout.toString());
};

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('pricing.test — env-driven Meta cost + markup');

// ── Case 1: no billing env set → built-in fallbacks (72/16/22/22, 25%) ──────
check('fallback defaults when env unset', () => {
  const r = runWith({});
  assert.equal(r.MARKUP_PCT, 25, 'markup % fallback');
  assert.equal(r.META_BASE.marketing, 72, 'marketing meta base fallback');
  assert.equal(r.META_BASE.service, 16, 'service meta base fallback');
  // markup = round(base * 25%)
  assert.equal(r.perCategory.marketing.markup, 18, 'marketing markup = 18');
  assert.equal(r.perCategory.service.markup, 4, 'service markup = 4');
});

// ── Case 2: the connection-type rule (the heart of the feature) ─────────────
check('platform user pays meta base + markup; own user pays markup only', () => {
  const r = runWith({});
  // marketing: base 72, markup 18
  assert.equal(r.perCategory.marketing.platform, 90, 'marketing platform = 72 + 18');
  assert.equal(r.perCategory.marketing.own, 18, 'marketing own = markup only');
  // service: base 16, markup 4
  assert.equal(r.perCategory.service.platform, 20, 'service platform = 16 + 4');
  assert.equal(r.perCategory.service.own, 4, 'service own = markup only');
});

// ── Case 3: values are read from .env (operator can change them) ────────────
check('custom env rates flow through to charges', () => {
  const r = runWith({ META_COST_MARKETING_PAISE: '100', META_COST_SERVICE_PAISE: '40', PLATFORM_MARKUP_PCT: '50' });
  assert.equal(r.MARKUP_PCT, 50);
  assert.equal(r.META_BASE.marketing, 100);
  assert.equal(r.perCategory.marketing.markup, 50, '50% of 100');
  assert.equal(r.perCategory.marketing.platform, 150, '100 + 50');
  assert.equal(r.perCategory.marketing.own, 50, 'markup only');
  assert.equal(r.perCategory.service.platform, 60, '40 + 20');
  assert.equal(r.perCategory.service.own, 20, '50% of 40');
});

// ── Case 4: zero markup → own users pay nothing, platform pays exact meta ───
check('zero markup edge case', () => {
  const r = runWith({ PLATFORM_MARKUP_PCT: '0' });
  assert.equal(r.perCategory.marketing.markup, 0);
  assert.equal(r.perCategory.marketing.own, 0, 'own pays 0 when markup is 0');
  assert.equal(r.perCategory.marketing.platform, 72, 'platform still pays meta base');
});

// ── Case 5: fractional paise rates are preserved (Meta rates not round) ─────
check('fractional meta cost in paise is supported', () => {
  const r = runWith({ META_COST_MARKETING_PAISE: '78.46', PLATFORM_MARKUP_PCT: '25' });
  assert.equal(r.META_BASE.marketing, 78.46);
  assert.equal(r.perCategory.marketing.markup, 20, 'round(78.46 * 0.25) = round(19.615) = 20');
  assert.equal(r.perCategory.marketing.platform, 98.46, '78.46 + 20');
});

// ── Case 6: breakdown() shape used by the wallet API ────────────────────────
check('breakdown() exposes both connection-type charges', () => {
  const r = runWith({});
  const b = r.perCategory.marketing.breakdown;
  assert.equal(b.metaBase, 72);
  assert.equal(b.markup, 18);
  assert.equal(b.platformCharge, 90);
  assert.equal(b.ownCharge, 18);
  assert.equal(b.markupPct, 25);
});

console.log(`\npricing.test: ${passed} checks passed ✅`);
