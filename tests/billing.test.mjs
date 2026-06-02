// Unit tests for delivery-time billing (server/services/billing.js).
// Uses in-memory fakes for the models + wallet, so NO database is touched.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { chargeOnDelivery, reconcileUncharged } from '../services/billing.js';
import { chargeForMessage, requiredBalance, hasSufficientBalance } from '../config/pricing.js';

// ── Minimal in-memory fakes that mimic the exact Mongoose ops billing.js uses ─
class FakeMessages {
  constructor(docs = []) { this.docs = docs; }
  async findOneAndUpdate(query, update) {
    // mirrors: { messageId, 'billing.perMsgCharge': {$gt:0}, 'billing.charged': {$ne:true} }
    const doc = this.docs.find(d =>
      d.messageId === query.messageId &&
      (d.billing?.perMsgCharge || 0) > 0 &&
      d.billing?.charged !== true
    );
    if (!doc) return null;
    for (const [k, v] of Object.entries(update.$set || {})) {
      if (k === 'billing.charged')      doc.billing.charged = v;
      if (k === 'billing.chargedAt')    doc.billing.chargedAt = v;
      if (k === 'billing.chargeFailed') doc.billing.chargeFailed = v;
    }
    return doc; // {new:true}
  }
  async updateOne(filter, update) {
    const doc = this.docs.find(d => d._id === filter._id);
    if (!doc) return;
    for (const [k, v] of Object.entries(update.$set || {})) {
      if (k === 'billing.chargeFailed') doc.billing.chargeFailed = v;
    }
  }
  // used by reconcileUncharged: find delivered/read & not-yet-charged messages
  find() {
    const docs = this.docs.filter(d =>
      ['delivered', 'read'].includes(d.status) &&
      (d.billing?.perMsgCharge || 0) > 0 &&
      d.billing?.charged !== true
    );
    return { select: () => ({ lean: async () => docs }) };
  }
}
class FakeCampaignStore {
  constructor() { this.byId = {}; }
  async findByIdAndUpdate(id, update) {
    if (!this.byId[id]) this.byId[id] = { _id: id, costPaise: 0 };
    const inc = (update.$inc || {}).costPaise || 0;
    this.byId[id].costPaise += inc;
    return this.byId[id];
  }
}
const makeDebit = (wallets, txns) => async (userId, paise, description) => {
  const w = wallets[userId];
  if (!w || w.balance < paise) return false;   // atomic "only if sufficient"
  w.balance -= paise;
  txns.push({ userId, paise, description });
  return true;
};

const msg = (id, perMsgCharge, meta, userId = 'u1', status = 'sent') => ({
  _id: 'm_' + id, messageId: id, userId, status, metadata: meta,
  billing: { perMsgCharge, charged: false, chargeFailed: false },
});

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('billing.test — charge on delivery, exactly once, per connection type');

const MKT_PLATFORM = chargeForMessage('marketing', 'platform'); // 90
const MKT_OWN      = chargeForMessage('marketing', 'own');      // 18

// 1 — platform user, delivered once → charged meta+markup; idempotent after.
await check('platform marketing delivered → charge once (meta + markup)', async () => {
  const M = new FakeMessages([msg('A', MKT_PLATFORM, { campaignId: 'c1' })]);
  const C = new FakeCampaignStore(), BC = new FakeCampaignStore();
  const wallets = { u1: { balance: 1000 } }, txns = [];
  const deps = { Message: M, Campaign: C, BulkCampaign: BC, deductBalance: makeDebit(wallets, txns) };

  const r1 = await chargeOnDelivery('A', 'delivered', deps);
  assert.equal(r1.billed, true);
  assert.equal(r1.charge, MKT_PLATFORM);
  assert.equal(wallets.u1.balance, 1000 - MKT_PLATFORM, 'wallet debited once');
  assert.equal(C.byId.c1.costPaise, MKT_PLATFORM, 'campaign cost rolled up');
  assert.equal(M.docs[0].billing.charged, true);

  // duplicate delivered + later read must NOT charge again
  const r2 = await chargeOnDelivery('A', 'delivered', deps);
  const r3 = await chargeOnDelivery('A', 'read', deps);
  assert.equal(r2.billed, false);
  assert.equal(r3.billed, false);
  assert.equal(wallets.u1.balance, 1000 - MKT_PLATFORM, 'no double charge');
  assert.equal(txns.length, 1, 'exactly one wallet transaction');
});

// 2 — own (Facebook) user pays ONLY the platform markup.
await check('own marketing delivered → charge markup only', async () => {
  const M = new FakeMessages([msg('B', MKT_OWN, { campaignId: 'c1' })]);
  const C = new FakeCampaignStore(), BC = new FakeCampaignStore();
  const wallets = { u1: { balance: 1000 } }, txns = [];
  const deps = { Message: M, Campaign: C, BulkCampaign: BC, deductBalance: makeDebit(wallets, txns) };

  const r = await chargeOnDelivery('B', 'delivered', deps);
  assert.equal(r.billed, true);
  assert.equal(r.charge, MKT_OWN, 'own user charged markup only');
  assert.equal(wallets.u1.balance, 1000 - MKT_OWN);
  assert.ok(MKT_OWN < MKT_PLATFORM, 'own charge is strictly less than platform charge');
});

// 3 — non-delivery statuses are never billed.
await check('sent / failed / pending are not billable', async () => {
  const M = new FakeMessages([msg('C', MKT_PLATFORM, { campaignId: 'c1' })]);
  const wallets = { u1: { balance: 1000 } }, txns = [];
  const deps = { Message: M, Campaign: new FakeCampaignStore(), BulkCampaign: new FakeCampaignStore(), deductBalance: makeDebit(wallets, txns) };

  for (const s of ['sent', 'failed', 'pending']) {
    const r = await chargeOnDelivery('C', s, deps);
    assert.equal(r.billed, false, `${s} must not bill`);
    assert.equal(r.reason, 'not-billable-status');
  }
  assert.equal(wallets.u1.balance, 1000, 'wallet untouched');
  assert.equal(M.docs[0].billing.charged, false, 'message not marked charged');
});

// 4 — delivered but wallet can't cover it → flagged, never goes negative.
await check('insufficient balance → chargeFailed flagged, wallet not negative', async () => {
  const M = new FakeMessages([msg('D', MKT_PLATFORM, { campaignId: 'c1' })]);
  const C = new FakeCampaignStore();
  const wallets = { u1: { balance: 50 } }, txns = []; // 50 < 90
  const deps = { Message: M, Campaign: C, BulkCampaign: new FakeCampaignStore(), deductBalance: makeDebit(wallets, txns) };

  const r = await chargeOnDelivery('D', 'delivered', deps);
  assert.equal(r.billed, false);
  assert.equal(r.reason, 'insufficient-balance');
  assert.equal(wallets.u1.balance, 50, 'balance unchanged (never negative)');
  assert.equal(M.docs[0].billing.chargeFailed, true, 'flagged for reconciliation');
  assert.equal(C.byId.c1, undefined, 'campaign cost NOT incremented on failed charge');

  // retry on webhook re-send must not keep hammering the wallet
  const r2 = await chargeOnDelivery('D', 'delivered', deps);
  assert.equal(r2.billed, false);
  assert.equal(txns.length, 0, 'no successful debit ever recorded');
});

// 5 — read can arrive first (no prior delivered) and still bills exactly once.
await check('read-first ordering still bills exactly once', async () => {
  const M = new FakeMessages([msg('E', MKT_PLATFORM, { campaignId: 'c1' })]);
  const wallets = { u1: { balance: 1000 } }, txns = [];
  const deps = { Message: M, Campaign: new FakeCampaignStore(), BulkCampaign: new FakeCampaignStore(), deductBalance: makeDebit(wallets, txns) };

  const r1 = await chargeOnDelivery('E', 'read', deps);
  const r2 = await chargeOnDelivery('E', 'delivered', deps);
  assert.equal(r1.billed, true);
  assert.equal(r2.billed, false);
  assert.equal(txns.length, 1);
});

// 6 — free / non-campaign messages (perMsgCharge 0) are never billed.
await check('zero-charge messages are skipped', async () => {
  const M = new FakeMessages([msg('F', 0, null)]);
  const wallets = { u1: { balance: 1000 } }, txns = [];
  const deps = { Message: M, Campaign: new FakeCampaignStore(), BulkCampaign: new FakeCampaignStore(), deductBalance: makeDebit(wallets, txns) };

  const r = await chargeOnDelivery('F', 'delivered', deps);
  assert.equal(r.billed, false);
  assert.equal(r.reason, 'already-charged-or-free');
  assert.equal(wallets.u1.balance, 1000);
});

// 7 — cold-outreach (bulk) deliveries roll up onto the bulk campaign.
await check('bulk (cold outreach) delivery increments bulk campaign cost', async () => {
  const M = new FakeMessages([
    msg('G1', MKT_PLATFORM, { bulkCampaignId: 'b1' }),
    msg('G2', MKT_PLATFORM, { bulkCampaignId: 'b1' }),
  ]);
  const C = new FakeCampaignStore(), BC = new FakeCampaignStore();
  const wallets = { u1: { balance: 1000 } }, txns = [];
  const deps = { Message: M, Campaign: C, BulkCampaign: BC, deductBalance: makeDebit(wallets, txns) };

  await chargeOnDelivery('G1', 'delivered', deps);
  await chargeOnDelivery('G2', 'delivered', deps);
  assert.equal(BC.byId.b1.costPaise, 2 * MKT_PLATFORM, 'two deliveries accumulate');
  assert.equal(wallets.u1.balance, 1000 - 2 * MKT_PLATFORM);
  assert.equal(txns.length, 2);
  assert.equal(Object.keys(C.byId).length, 0, 'broadcast store untouched for bulk msgs');
});

// 8 — full campaign lifecycle: only the DELIVERED messages get billed.
await check('broadcast lifecycle: bill delivered, skip failed, no double on read', async () => {
  const M = new FakeMessages([
    msg('L1', MKT_PLATFORM, { campaignId: 'camp' }), // will be delivered
    msg('L2', MKT_PLATFORM, { campaignId: 'camp' }), // delivered then read
    msg('L3', MKT_PLATFORM, { campaignId: 'camp' }), // fails — never delivered
  ]);
  const C = new FakeCampaignStore(), BC = new FakeCampaignStore();
  const wallets = { u1: { balance: 1000 } }, txns = [];
  const deps = { Message: M, Campaign: C, BulkCampaign: BC, deductBalance: makeDebit(wallets, txns) };

  // Meta fires status webhooks (possibly with duplicates / out of order)
  await chargeOnDelivery('L1', 'delivered', deps);
  await chargeOnDelivery('L2', 'delivered', deps);
  await chargeOnDelivery('L2', 'read', deps);      // must NOT bill again
  await chargeOnDelivery('L1', 'delivered', deps); // duplicate — must NOT bill again
  await chargeOnDelivery('L3', 'failed', deps);    // never billed

  assert.equal(txns.length, 2, 'exactly 2 of 3 messages billed (the delivered ones)');
  assert.equal(wallets.u1.balance, 1000 - 2 * MKT_PLATFORM, 'wallet charged for 2 deliveries');
  assert.equal(C.byId.camp.costPaise, 2 * MKT_PLATFORM, 'campaign cost = delivered only');
  assert.equal(M.docs[2].billing.charged, false, 'failed message never charged');
});

// 9 — pre-broadcast balance gate: account holder must afford every message.
await check('balance gate: blocks when balance < count × perMsgCharge', async () => {
  // own marketing = 18 paise/msg; 86 contacts → need ₹15.48 (1548 paise)
  assert.equal(requiredBalance(86, MKT_OWN), 1548);
  assert.equal(hasSufficientBalance(42740, 86, MKT_OWN), true,  '₹427.40 covers ₹15.48');
  assert.equal(hasSufficientBalance(1000, 86, MKT_OWN), false, '₹10 cannot cover ₹15.48');
  // platform marketing = 90 paise/msg; 100 contacts → need ₹90
  assert.equal(requiredBalance(100, MKT_PLATFORM), 9000);
  assert.equal(hasSufficientBalance(8999, 100, MKT_PLATFORM), false, 'one paise short blocks');
  assert.equal(hasSufficientBalance(9000, 100, MKT_PLATFORM), true,  'exact balance passes');
  // no recipients → no balance required
  assert.equal(requiredBalance(0, MKT_PLATFORM), 0);
  assert.equal(hasSufficientBalance(0, 0, MKT_PLATFORM), true);
});

// 10 — reconciliation safety net: bills delivered-but-uncharged messages once.
await check('reconcileUncharged bills delivered/read leftovers, idempotently', async () => {
  const M = new FakeMessages([
    msg('R1', MKT_OWN, { campaignId: 'c' }, 'u1', 'delivered'),
    msg('R2', MKT_OWN, { campaignId: 'c' }, 'u1', 'read'),
    msg('R3', MKT_OWN, { campaignId: 'c' }, 'u1', 'failed'),   // not delivered → skip
    msg('R4', MKT_OWN, { campaignId: 'c' }, 'u1', 'sent'),     // not delivered → skip
  ]);
  const C = new FakeCampaignStore(), BC = new FakeCampaignStore();
  const wallets = { u1: { balance: 1000 } }, txns = [];
  const deps = { Message: M, Campaign: C, BulkCampaign: BC, deductBalance: makeDebit(wallets, txns) };

  const r1 = await reconcileUncharged({}, deps);
  assert.equal(r1.candidates, 2, 'only delivered + read are candidates');
  assert.equal(r1.billed, 2);
  assert.equal(r1.totalPaise, 2 * MKT_OWN);
  assert.equal(wallets.u1.balance, 1000 - 2 * MKT_OWN);
  assert.equal(C.byId.c.costPaise, 2 * MKT_OWN);

  // running again charges nothing (already billed)
  const r2 = await reconcileUncharged({}, deps);
  assert.equal(r2.billed, 0, 'idempotent — nothing left to bill');
  assert.equal(txns.length, 2, 'still exactly two debits total');
});

console.log(`\nbilling.test: ${passed} checks passed ✅`);
