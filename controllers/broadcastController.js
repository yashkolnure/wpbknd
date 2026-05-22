import Campaign from '../models/Campaign.js';
import Contact from '../models/Contact.js';
import Message from '../models/Message.js';
import { sendMessage } from '../services/messageSender.js';
import { deductBalance, getOrCreateWallet } from './walletController.js';
import { PRICING } from '../config/pricing.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const FATAL_META_ERRORS = [131031, 132000, 132001];

const runCampaign = async (campaignId, contacts, userId, message, pricePerMsg) => {
  let sent = 0, failed = 0;

  for (const contact of contacts) {
    try {
      // Send FIRST — deduct wallet only on confirmed delivery
      const result = await sendMessage(userId, contact.phone, message);
      const wamid  = result?.metaMessageId || null;

      const ok = await deductBalance(userId, pricePerMsg, `Broadcast campaign`);
      if (!ok) {
        failed += contacts.length - sent - failed;
        break;
      }

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
      });

      await Contact.findByIdAndUpdate(contact._id, {
        $set: { lastMessage: `Template: ${message.templateName}` },
        $inc: { messageCount: 1 },
      });

      sent++;
      await sleep(250);
    } catch (err) {
      const metaCode = err.response?.data?.error?.code;
      console.error(`Broadcast send failed for ${contact.phone}: [${metaCode}] ${err.message}`);

      if (FATAL_META_ERRORS.includes(metaCode)) {
        failed += contacts.length - sent - failed;
        await Campaign.findByIdAndUpdate(campaignId, {
          status: 'failed',
          failureReason: `Template error (${metaCode}): ${err.response?.data?.error?.message || err.message}`,
        });
        return;
      }
      failed++;
    }
  }

  await Campaign.findByIdAndUpdate(campaignId, {
    status:     'done',
    sentCount:  sent,
    failedCount: failed,
    costPaise:  sent * pricePerMsg,
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

    const query = { userId: req.user._id, optedOut: { $ne: true } };
    if (targetTags?.length > 0) query.tags = { $in: targetTags };
    if (filterLast24hrs) query.lastActive = { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) };

    const contacts = await Contact.find(query).select('_id phone');
    if (contacts.length === 0) {
      return res.status(400).json({ message: 'No contacts match the selected filters' });
    }

    // Price: service rate for 24hr contacts, marketing rate otherwise
    const pricePerMsg = filterLast24hrs ? PRICING.service : PRICING.marketing;
    const totalCost = contacts.length * pricePerMsg;

    const wallet = await getOrCreateWallet(req.user._id);
    if (wallet.balance < totalCost) {
      return res.status(402).json({
        message: `Insufficient balance. Need ₹${(totalCost / 100).toFixed(2)}, have ₹${(wallet.balance / 100).toFixed(2)}`,
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
      pricePerMsg,
    });

    runCampaign(campaign._id, contacts, req.user._id, message, pricePerMsg)
      .catch(() => Campaign.findByIdAndUpdate(campaign._id, { status: 'failed' }));

    res.json({
      success: true,
      campaign,
      totalContacts: contacts.length,
      estimatedCost: `₹${(totalCost / 100).toFixed(2)}`,
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
