import BulkCampaign from '../models/BulkCampaign.js';
import Message from '../models/Message.js';
import Contact from '../models/Contact.js';
import WhatsApp from '../models/WhatsApp.js';
import { sendMessage } from '../services/messageSender.js';
import { getOrCreateWallet } from './walletController.js';
import { META_BASE, markupPaise, chargeForMessage, requiredBalance, hasSufficientBalance } from '../config/pricing.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Meta API error codes that mean we should stop the campaign
const FATAL_META_ERRORS = [131031, 132000, 132001]; // template not found/approved

// `billing` = { category, connectionType, metaCostPaise, markupPaise, perMsgCharge }
const runBulkCampaign = async (campaign, userId, billing) => {
  let sent = 0, failed = 0, lastError = null;

  for (const phone of campaign.phoneNumbers) {
    try {
      // Send the message. The wallet is NOT debited here — billing happens only
      // when Meta confirms `delivered` (see webhookRoutes.js).
      const result = await sendMessage(userId, phone, campaign.message);
      const wamid  = result?.metaMessageId || null;

      let contact = await Contact.findOne({ userId, phone });
      if (!contact) contact = await Contact.create({ userId, phone, messageCount: 0 });

      await Message.create({
        userId,
        contactId:     contact._id,
        from:          'bot',
        type:          'template',
        text:          campaign.message.templateName,
        messageId:     wamid,
        status:        'sent',
        isReadByAdmin: true,
        timestamp:     new Date(),
        metadata:      { bulkCampaignId: campaign._id },
        billing: {
          category:       billing.category,
          connectionType: billing.connectionType,
          metaCostPaise:  billing.metaCostPaise,
          markupPaise:    billing.markupPaise,
          perMsgCharge:   billing.perMsgCharge,
          charged:        false,
        },
      });

      await Contact.findByIdAndUpdate(contact._id, {
        $set: { lastMessage: `Template: ${campaign.message.templateName}` },
        $inc: { messageCount: 1 },
      });

      sent++;
      await sleep(250); // 4 msgs/sec — well under Meta's 80/sec limit
    } catch (err) {
      const metaErr  = err.response?.data?.error;
      const metaCode = metaErr?.code;
      lastError = `#${metaCode ?? '?'}: ${metaErr?.error_data?.details || metaErr?.message || err.message}`;
      console.error(`Bulk send failed for ${phone}: [${metaCode}] ${lastError}`);

      // Stop campaign on fatal template errors (template not approved, not found)
      if (FATAL_META_ERRORS.includes(metaCode)) {
        failed += campaign.phoneNumbers.length - sent - failed;
        await BulkCampaign.findByIdAndUpdate(campaign._id, {
          status: 'failed',
          failureReason: `Template error (${metaCode}): ${metaErr?.message || err.message}`,
        });
        return;
      }
      failed++;
    }
  }

  // NOTE: costPaise is intentionally NOT set here — it accumulates in the
  // delivery webhook as each delivered message is billed.
  // Surface the Meta reason and mark a 0-sent campaign as failed so the user
  // isn't left guessing why nothing went out.
  await BulkCampaign.findByIdAndUpdate(campaign._id, {
    status:      (sent === 0 && failed > 0) ? 'failed' : 'done',
    sentCount:   sent,
    failedCount: failed,
    ...(lastError ? { failureReason: lastError } : {}),
  });
};

export const createBulkCampaign = async (req, res) => {
  try {
    const { name, message, phoneNumbers } = req.body;

    if (!name?.trim() || !message || !phoneNumbers?.length) {
      return res.status(400).json({ message: 'name, message and phoneNumbers are required' });
    }

    // Per Meta policy: only approved templates can be sent outside the 24-hr service window
    if (message.type !== 'template' || !message.templateName) {
      return res.status(400).json({
        message: 'Cold Outreach requires an approved WhatsApp template. Free-form messages can only be sent within the 24-hour service window.',
      });
    }

    // Cold outreach to brand-new numbers is always charged at the MARKETING rate.
    // Connection type decides whether the user pays full Meta cost + markup
    // ('platform') or only the platform markup ('own' / Facebook-connected).
    const wa = await WhatsApp.findOne({ userId: req.user._id, isVerified: true });
    if (!wa) return res.status(400).json({ message: 'Connect your WhatsApp number before launching cold outreach.' });
    const connectionType = wa.connectionType || 'own';

    const category      = 'marketing';
    const metaCostPaise = META_BASE[category];
    const markup        = markupPaise(category);
    const perMsgCharge  = chargeForMessage(category, connectionType);

    // Deduplicate, clean, and remove opted-out contacts
    const rawClean = [...new Set(phoneNumbers.map(p => p.toString().replace(/\D/g, '')).filter(p => p.length >= 10))];
    const optedOutDocs = await Contact.find({ userId: req.user._id, optedOut: true }).select('phone');
    const optedOutSet = new Set(optedOutDocs.map(c => c.phone.replace(/\D/g, '')));
    const cleanNumbers = rawClean.filter(p => !optedOutSet.has(p));
    if (cleanNumbers.length === 0) return res.status(400).json({ message: 'No valid phone numbers' });

    // Pre-flight balance gate: the account holder must be able to cover every
    // message being delivered (worst case) BEFORE the campaign starts. Actual
    // debits still happen per delivery.
    const totalCost = requiredBalance(cleanNumbers.length, perMsgCharge);
    const wallet = await getOrCreateWallet(req.user._id);
    if (!hasSufficientBalance(wallet.balance, cleanNumbers.length, perMsgCharge)) {
      return res.status(402).json({
        message: `Insufficient wallet balance to message ${cleanNumbers.length} numbers. Need ₹${(totalCost / 100).toFixed(2)}, have ₹${(wallet.balance / 100).toFixed(2)}. Please recharge your wallet.`,
        required: totalCost,
        available: wallet.balance,
      });
    }

    const campaign = await BulkCampaign.create({
      userId: req.user._id,
      name: name.trim(),
      message,
      phoneNumbers: cleanNumbers,
      status: 'running',
      totalCount: cleanNumbers.length,
      connectionType,
      metaCostPerMsg: metaCostPaise,
      pricePerMsg: perMsgCharge,
    });

    const billing = { category, connectionType, metaCostPaise, markupPaise: markup, perMsgCharge };
    runBulkCampaign(campaign, req.user._id, billing)
      .catch(() => BulkCampaign.findByIdAndUpdate(campaign._id, { status: 'failed' }));

    res.json({
      success: true,
      campaign,
      totalNumbers: cleanNumbers.length,
      connectionType,
      pricePerMsg: perMsgCharge,
      estimatedCost: `₹${(totalCost / 100).toFixed(2)}`,
      billingNote: connectionType === 'platform'
        ? `Charged per delivered message: Meta cost ₹${(metaCostPaise / 100).toFixed(2)} + ₹${(markup / 100).toFixed(2)} platform fee = ₹${(perMsgCharge / 100).toFixed(2)}.`
        : `Meta bills your own WhatsApp account directly. We charge only the platform fee of ₹${(perMsgCharge / 100).toFixed(2)} per delivered message.`,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getBulkCampaigns = async (req, res) => {
  try {
    const campaigns = await BulkCampaign.find({ userId: req.user._id }).sort('-createdAt').limit(50);

    // deliveredCount and readCount are stored on the BulkCampaign doc,
    // incremented in real-time by the webhook status handler
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
