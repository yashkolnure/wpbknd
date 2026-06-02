import Campaign from '../models/Campaign.js';
import Contact from '../models/Contact.js';
import Message from '../models/Message.js';
import WhatsApp from '../models/WhatsApp.js';
import { sendMessage } from '../services/messageSender.js';
import { getOrCreateWallet } from './walletController.js';
import { META_BASE, markupPaise, chargeForMessage, requiredBalance, hasSufficientBalance } from '../config/pricing.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const FATAL_META_ERRORS = [131031, 132000, 132001];

// `billing` = { category, connectionType, metaCostPaise, markupPaise, perMsgCharge }
const runCampaign = async (campaignId, contacts, userId, message, billing) => {
  let sent = 0, failed = 0, lastError = null;

  for (const contact of contacts) {
    try {
      // Send the message. The wallet is NOT debited here — billing happens only
      // when Meta confirms `delivered` (see webhookRoutes.js). The rate captured
      // on each Message below is what gets charged on delivery.
      const result = await sendMessage(userId, contact.phone, message);
      const wamid  = result?.metaMessageId || null;

      await Message.create({
        userId,
        contactId:     contact._id,
        from:          'bot',
        type:          'template',
        text:          message.templateName,
        messageId:     wamid,
        status:        'sent',
        isReadByAdmin: true,
        timestamp:     new Date(),
        metadata:      { campaignId },
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
        $set: { lastMessage: `Template: ${message.templateName}` },
        $inc: { messageCount: 1 },
      });

      sent++;
      await sleep(250);
    } catch (err) {
      const metaErr  = err.response?.data?.error;
      const metaCode = metaErr?.code;
      lastError = `#${metaCode ?? '?'}: ${metaErr?.error_data?.details || metaErr?.message || err.message}`;
      console.error(`Broadcast send failed for ${contact.phone}: [${metaCode}] ${lastError}`);

      if (FATAL_META_ERRORS.includes(metaCode)) {
        failed += contacts.length - sent - failed;
        await Campaign.findByIdAndUpdate(campaignId, {
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
  // If nothing went out, mark the campaign failed and surface the Meta reason
  // so the user isn't left guessing (previously it showed "done" with no reason).
  await Campaign.findByIdAndUpdate(campaignId, {
    status:      (sent === 0 && failed > 0) ? 'failed' : 'done',
    sentCount:   sent,
    failedCount: failed,
    ...(lastError ? { failureReason: lastError } : {}),
  });
};

export const createCampaign = async (req, res) => {
  try {
    const { name, message, targetTags, filterLast24hrs } = req.body;

    if (!name?.trim() || !message) {
      return res.status(400).json({ message: 'Name and message are required' });
    }

    // Per Meta policy: only approved templates can be sent outside the 24-hr service window
    if (message.type !== 'template' || !message.templateName) {
      return res.status(400).json({
        message: 'Broadcast requires an approved WhatsApp template. Free-form messages can only be sent within the 24-hour service window.',
      });
    }

    // Determine whose WABA / payment method is in play. 'platform' users are
    // billed full Meta cost + markup; 'own' (Facebook-connected) users only pay
    // the markup, because Meta already billed their own payment method.
    const wa = await WhatsApp.findOne({ userId: req.user._id, isVerified: true });
    if (!wa) return res.status(400).json({ message: 'Connect your WhatsApp number before sending a broadcast.' });
    const connectionType = wa.connectionType || 'own';

    const query = { userId: req.user._id, optedOut: { $ne: true } };
    if (targetTags?.length > 0) query.tags = { $in: targetTags };
    if (filterLast24hrs) query.lastActive = { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) };

    const contacts = await Contact.find(query).select('_id phone');
    if (contacts.length === 0) {
      return res.status(400).json({ message: 'No contacts match the selected filters' });
    }

    // Category drives the Meta base rate: service for the 24-hr window, else marketing.
    const category      = filterLast24hrs ? 'service' : 'marketing';
    const metaCostPaise = META_BASE[category];
    const markup        = markupPaise(category);
    const perMsgCharge  = chargeForMessage(category, connectionType);

    // Pre-flight balance gate: the account holder must be able to cover every
    // message being delivered (worst case) BEFORE the broadcast starts. Actual
    // debits still happen per delivery.
    const totalCost = requiredBalance(contacts.length, perMsgCharge);
    const wallet = await getOrCreateWallet(req.user._id);
    if (!hasSufficientBalance(wallet.balance, contacts.length, perMsgCharge)) {
      return res.status(402).json({
        message: `Insufficient balance to broadcast to ${contacts.length} contacts. Need ₹${(totalCost / 100).toFixed(2)}, have ₹${(wallet.balance / 100).toFixed(2)}. Please recharge your wallet.`,
        required: totalCost,
        available: wallet.balance,
      });
    }

    const campaign = await Campaign.create({
      userId: req.user._id,
      name: name.trim(),
      message,
      targetTags: targetTags || [],
      filterLast24hrs: !!filterLast24hrs,
      status: 'running',
      totalCount: contacts.length,
      connectionType,
      metaCostPerMsg: metaCostPaise,
      pricePerMsg: perMsgCharge,
    });

    const billing = { category, connectionType, metaCostPaise, markupPaise: markup, perMsgCharge };
    runCampaign(campaign._id, contacts, req.user._id, message, billing)
      .catch(() => Campaign.findByIdAndUpdate(campaign._id, { status: 'failed' }));

    res.json({
      success: true,
      campaign,
      totalContacts: contacts.length,
      connectionType,
      pricePerMsg: perMsgCharge,
      estimatedCost: `₹${(totalCost / 100).toFixed(2)}`,
      billingNote: connectionType === 'platform'
        ? `Charged per delivered message: Meta cost ₹${(metaCostPaise / 100).toFixed(2)} + ${markup ? `₹${(markup / 100).toFixed(2)} ` : ''}platform fee = ₹${(perMsgCharge / 100).toFixed(2)}.`
        : `Meta bills your own WhatsApp account directly. We charge only the platform fee of ₹${(perMsgCharge / 100).toFixed(2)} per delivered message.`,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getCampaigns = async (req, res) => {
  try {
    const campaigns = await Campaign.find({ userId: req.user._id }).sort('-createdAt').limit(50);
    // deliveredCount and readCount are stored directly on the Campaign doc,
    // incremented in real-time by the webhook status handler
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getContactTags = async (req, res) => {
  try {
    const contacts = await Contact.find({ userId: req.user._id }).select('tags');
    const tags = [...new Set(contacts.flatMap(c => c.tags))].filter(Boolean).sort();
    res.json(tags);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET count of contacts active in last 24hrs
export const getActive24Count = async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await Contact.countDocuments({ userId: req.user._id, lastActive: { $gte: since } });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
