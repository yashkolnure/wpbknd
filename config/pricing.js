// All money values are in paise (₹1 = 100 paise) unless stated otherwise.
//
// ── Billing model (charged per DELIVERED message only) ──────────────────────
//  • Meta charges a base cost per message that depends on the message CATEGORY
//    (marketing / utility / authentication / service). These rates are NOT
//    fixed — Meta revises them periodically — so they live in .env and can be
//    updated without a code change.
//  • On top of Meta's base cost we add a PLATFORM MARKUP (default 25%).
//  • WHO already paid Meta depends on whose WhatsApp number sent the message
//    (see WhatsApp.connectionType — set on the "Connect WhatsApp" screen):
//      - 'platform' → the number sits on WPLeads' shared WABA, so Meta bills
//        WPLeads' payment method. We recover the FULL cost from the user's
//        wallet:  meta base + markup.
//      - 'own'      → the number sits on the user's own WABA (e.g. Facebook
//        embedded signup), so Meta bills the user's own payment method
//        directly. We only charge our platform fee: the MARKUP alone.
//  • Charges apply ONLY to messages Meta confirms as `delivered`. Sent-but-not
//    -delivered and failed messages are never billed.

// Parse an env value as a non-negative number, falling back when unset/invalid.
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// Platform markup, as a percentage of Meta's base cost. Editable via .env.
export const MARKUP_PCT = num(process.env.PLATFORM_MARKUP_PCT, 25);

// Meta's base cost per message by category, in paise. Editable via .env —
// update these whenever Meta revises its WhatsApp pricing.
export const META_BASE = {
  marketing:      num(process.env.META_COST_MARKETING_PAISE, 72),
  utility:        num(process.env.META_COST_UTILITY_PAISE, 22),
  authentication: num(process.env.META_COST_AUTHENTICATION_PAISE, 22),
  service:        num(process.env.META_COST_SERVICE_PAISE, 16),
};

// Platform fee (the markup) for one message of `category`, in paise.
export const markupPaise = (category) =>
  Math.round((META_BASE[category] ?? 0) * MARKUP_PCT / 100);

// What WE deduct from the user's wallet for ONE delivered message:
//   platform → meta base + markup  (we paid Meta — recover cost + our fee)
//   own      → markup only         (user paid Meta — we take only our fee)
export const chargeForMessage = (category, connectionType) => {
  const base   = META_BASE[category] ?? 0;
  const markup = markupPaise(category);
  return connectionType === 'platform' ? base + markup : markup;
};

// Full retail price (meta base + markup) per category — used for display and
// worst-case pre-flight estimates.
export const PRICING = {
  marketing:      META_BASE.marketing      + markupPaise('marketing'),
  utility:        META_BASE.utility        + markupPaise('utility'),
  authentication: META_BASE.authentication + markupPaise('authentication'),
  service:        META_BASE.service        + markupPaise('service'),
};

// Minimum wallet balance (in paise) required to launch a campaign of `count`
// messages charged at `perMsgCharge` each — the worst case where every message
// is delivered (and therefore billed). Used as the pre-broadcast balance gate.
export const requiredBalance = (count, perMsgCharge) =>
  Math.max(0, count) * Math.max(0, perMsgCharge);

// True if `balancePaise` can cover launching `count` messages at `perMsgCharge`.
export const hasSufficientBalance = (balancePaise, count, perMsgCharge) =>
  balancePaise >= requiredBalance(count, perMsgCharge);

// Full per-category breakdown (paise) for both connection types — handy for
// the wallet/pricing API and the billing UI.
export const breakdown = (category) => {
  const metaBase = META_BASE[category] ?? 0;
  const markup   = markupPaise(category);
  return {
    category,
    metaBase,                          // what Meta charges
    markup,                            // our platform fee (markup only)
    markupPct: MARKUP_PCT,
    platformCharge: metaBase + markup, // wallet charge for 'platform' users
    ownCharge:      markup,            // wallet charge for 'own' users
  };
};
