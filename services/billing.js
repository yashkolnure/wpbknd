import Message from '../models/Message.js';
import Campaign from '../models/Campaign.js';
import BulkCampaign from '../models/BulkCampaign.js';
import { deductBalance } from '../controllers/walletController.js';

// Charge the wallet exactly once for a message Meta confirmed as delivered.
//
// Idempotency: the atomic flip of `billing.charged` (false → true) is the
// single source of truth. Whichever webhook wins the flip performs the debit;
// every later webhook for the same WAMID finds charged === true and is a no-op.
// This protects against Meta re-sending `delivered`, and against `read`
// arriving as a second billable signal after `delivered`.
//
// Dependencies are injected (with live defaults) so the logic is unit-testable
// against in-memory fakes — no database required.
export const chargeOnDelivery = async (wamid, newStatus, deps = {}) => {
  const M     = deps.Message       || Message;
  const C     = deps.Campaign      || Campaign;
  const BC    = deps.BulkCampaign  || BulkCampaign;
  const debit = deps.deductBalance || deductBalance;

  // Only delivered (or read, which implies delivered) messages are billable.
  if (newStatus !== 'delivered' && newStatus !== 'read') {
    return { billed: false, reason: 'not-billable-status' };
  }

  // Atomically claim this message for billing. perMsgCharge > 0 skips free /
  // non-campaign messages; charged !== true skips ones already billed.
  const billDoc = await M.findOneAndUpdate(
    { messageId: wamid, 'billing.perMsgCharge': { $gt: 0 }, 'billing.charged': { $ne: true } },
    { $set: { 'billing.charged': true, 'billing.chargedAt': new Date() } },
    { returnDocument: 'after' }
  );
  if (!billDoc) return { billed: false, reason: 'already-charged-or-free' };

  const charge = billDoc.billing.perMsgCharge;
  const { campaignId, bulkCampaignId } = billDoc.metadata || {};
  const label = campaignId ? 'Broadcast' : bulkCampaignId ? 'Cold Outreach' : 'Message';

  const ok = await debit(billDoc.userId, charge, `${label} — delivered message`);
  if (!ok) {
    // Delivered but the wallet couldn't cover it (rare — the pre-flight balance
    // guard should prevent it). Flag for reconciliation; do NOT reset `charged`,
    // so webhook retries don't hammer the wallet.
    await M.updateOne({ _id: billDoc._id }, { $set: { 'billing.chargeFailed': true } });
    return { billed: false, reason: 'insufficient-balance', charge, userId: billDoc.userId };
  }

  // Roll the actual (delivered) spend up onto the campaign for the cost column.
  if (campaignId)          await C.findByIdAndUpdate(campaignId, { $inc: { costPaise: charge } });
  else if (bulkCampaignId) await BC.findByIdAndUpdate(bulkCampaignId, { $inc: { costPaise: charge } });

  return { billed: true, charge, userId: billDoc.userId };
};

// Safety net: bill every message Meta already marked delivered/read that was
// never charged — e.g. a webhook was missed, arrived out of order, or the
// delivery happened before the billing code was deployed. Idempotent (reuses
// the exactly-once flip in chargeOnDelivery), so it's safe to run repeatedly,
// on a schedule, or right after a deploy. `filter` can scope it (e.g. by userId).
export const reconcileUncharged = async (filter = {}, deps = {}) => {
  const M = deps.Message || Message;
  const pending = await M.find({
    status: { $in: ['delivered', 'read'] },
    'billing.perMsgCharge': { $gt: 0 },
    'billing.charged': { $ne: true },
    ...filter,
  }).select('messageId').lean();

  let billed = 0, totalPaise = 0;
  for (const m of pending) {
    const r = await chargeOnDelivery(m.messageId, 'delivered', deps);
    if (r.billed) { billed++; totalPaise += r.charge; }
  }
  return { candidates: pending.length, billed, totalPaise };
};
