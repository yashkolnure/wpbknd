import BulkCampaign from '../models/BulkCampaign.js';
import Message from '../models/Message.js';
import Contact from '../models/Contact.js';
import { sendMessage } from '../services/messageSender.js';
import { deductBalance, getOrCreateWallet } from './walletController.js';
import { PRICING } from '../config/pricing.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Meta API error codes that mean we should stop the campaign
const FATAL_META_ERRORS = [131031, 132000, 132001]; // template not found/approved

const runBulkCampaign = async (campaign, userId) => {
  let sent = 0, failed = 0;
  const pricePerMsg = PRICING.marketing;

  for (const phone of campaign.phoneNumbers) {
    try {
      // Send FIRST — only deduct wallet on confirmed delivery
      const result = await sendMessage(userId, phone, campaign.message);
      const wamid  = result?.metaMessageId || null;

      // Deduct after confirmed send
      const ok = await deductBalance(userId, pricePerMsg, `Cold Outreach: ${campaign.name}`);
      if (!ok) {
        failed += campaign.phoneNumbers.length - sent - failed;
        break;
      }

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
      });

      await Contact.findByIdAndUpdate(contact._id, {
        $set: { lastMessage: `Template: ${campaign.message.templateName}` },
        $inc: { messageCount: 1 },
      });

      sent++;
      await sleep(250); // 4 msgs/sec — well under Meta's 80/sec limit
    } catch (err) {
      const metaCode = err.response?.data?.error?.code;
      console.error(`Bulk send failed for ${phone}: [${metaCode}] ${err.message}`);

      // Stop campaign on fatal template errors (template not approved, not found)
      if (FATAL_META_ERRORS.includes(metaCode)) {
        failed += campaign.phoneNumbers.length - sent - failed;
        await BulkCampaign.findByIdAndUpdate(campaign._id, {
          status: 'failed',
          failureReason: `Template error (${metaCode}): ${err.response?.data?.error?.message || err.message}`,
        });
        return;
      }
      failed++;
    }
  }

  await BulkCampaign.findByIdAndUpdate(campaign._id, {
    status:    'done',
    sentCount: sent,
    failedCount: failed,
    costPaise: sent * pricePerMsg,
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

    // Deduplicate, clean, and remove opted-out contacts
    const rawClean = [...new Set(phoneNumbers.map(p => p.toString().replace(/\D/g, '')).filter(p => p.length >= 10))];
    const optedOutDocs = await Contact.find({ userId: req.user._id, optedOut: true }).select('phone');
    const optedOutSet = new Set(optedOutDocs.map(c => c.phone.replace(/\D/g, '')));
    const cleanNumbers = rawClean.filter(p => !optedOutSet.has(p));
    if (cleanNumbers.length === 0) return res.status(400).json({ message: 'No valid phone numbers' });

    // Check wallet balance
    const totalCost = cleanNumbers.length * PRICING.marketing;
    const wallet = await getOrCreateWallet(req.user._id);
    if (wallet.balance < totalCost) {
      return res.status(402).json({
        message: `Insufficient wallet balance. Need ₹${(totalCost / 100).toFixed(2)}, have ₹${(wallet.balance / 100).toFixed(2)}`,
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
    });

    runBulkCampaign(campaign, req.user._id)
      .catch(() => BulkCampaign.findByIdAndUpdate(campaign._id, { status: 'failed' }));

    res.json({ success: true, campaign, totalNumbers: cleanNumbers.length, estimatedCost: `₹${(totalCost / 100).toFixed(2)}` });
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
