// Helper: imports the REAL pricing module and prints its computed values as
// JSON. Run as a child process with different env vars to prove the billing
// math is fully driven by .env. Intentionally does NOT load dotenv, so it sees
// only the env explicitly passed by the parent test.
import { META_BASE, MARKUP_PCT, markupPaise, chargeForMessage, PRICING, breakdown } from '../config/pricing.js';

const cats = ['marketing', 'service', 'utility', 'authentication'];
const out = { MARKUP_PCT, META_BASE, PRICING, perCategory: {} };
for (const c of cats) {
  out.perCategory[c] = {
    markup:   markupPaise(c),
    platform: chargeForMessage(c, 'platform'),
    own:      chargeForMessage(c, 'own'),
    breakdown: breakdown(c),
  };
}
process.stdout.write(JSON.stringify(out));
