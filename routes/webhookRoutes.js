import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { executeWorkflow } from '../services/workflowExecutor.js';
import WhatsApp from '../models/WhatsApp.js';
import Contact from '../models/Contact.js';
import Workflow from '../models/Workflow.js';
import Message from '../models/Message.js';
import Campaign from '../models/Campaign.js';
import BulkCampaign from '../models/BulkCampaign.js';
import { sendPushNotification } from '../services/notificationService.js';
import { chargeOnDelivery } from '../services/billing.js';
import { sendMessage } from '../services/messageSender.js';
import { generateDirectReply, sanitizeHistory } from '../services/aiService.js';
import { decrypt } from '../utils/encrypt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const GRAPH_VER = () => process.env.GRAPH_VERSION || 'v21.0';

// Download a WhatsApp media file and store it permanently under /uploads.
// Runs fire-and-forget after the message is saved — updates media.url on the Message.
async function downloadAndStoreMedia(savedMsgId, userId, mediaId, mimeType, accessToken) {
  try {
    const metaRes = await axios.get(
      `https://graph.facebook.com/${GRAPH_VER()}/${mediaId}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    const downloadUrl = metaRes.data?.url;
    if (!downloadUrl) return;

    const mediaRes = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    const mimeToExt = {
      'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
      'image/webp': 'webp', 'image/gif': 'gif',
      'video/mp4': 'mp4', 'video/3gpp': '3gp',
      'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    };
    const ext = mimeToExt[mimeType] || (mimeType?.split('/')?.[1]?.split(';')?.[0]) || 'bin';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const dir = path.join(__dirname, '..', 'uploads', userId.toString());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), Buffer.from(mediaRes.data));

    const BASE_URL = process.env.API_BASE_URL || 'http://localhost:5002';
    const publicUrl = `${BASE_URL}/uploads/${userId}/${filename}`;
    await Message.findByIdAndUpdate(savedMsgId, { 'media.url': publicUrl });
    console.log(`📎 Media saved for message ${savedMsgId}`);
  } catch (err) {
    console.error('📎 Media download error:', err.message);
  }
}

// Verify Meta webhook signature (X-Hub-Signature-256)
const verifyWebhookSignature = (req) => {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return true; // skip in dev if not set
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody || '')
    .digest('hex');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  // timingSafeEqual throws a RangeError when the buffers differ in length (e.g. a
  // malformed/forged signature). Fail closed on a mismatch — never let it throw
  // out of this async handler, which would leave the request hanging.
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
};

// Meta verification handshake
router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Incoming messages & status updates
router.post("/webhook", async (req, res) => {
  // Reject requests that fail signature check
  if (!verifyWebhookSignature(req)) {
    console.warn('⚠️ Webhook signature verification failed — request rejected');
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;

    if (!value) return;
   if (value.statuses && value.statuses.length > 0) {
  const statusUpdate = value.statuses[0];
  const wamid = statusUpdate.id;
  const newStatus = statusUpdate.status;
  const errors = statusUpdate.errors || null;

  try {
    const updateFields = { status: newStatus };
    if (errors && errors.length > 0) {
      updateFields.error = { code: errors[0].code, title: errors[0].title, message: errors[0].message };
      console.error(`Message FAILED for WAMID ${wamid}: code=${errors[0].code} — ${errors[0].title}: ${errors[0].message}`);
    }

    // returnDocument:'before' gives us the status PRIOR to this webhook, so we can
    // tell a real transition apart from a duplicate. Meta retries webhooks, so
    // without this guard a re-sent `delivered` would inc deliveredCount twice.
    const before = await Message.findOneAndUpdate(
      { messageId: wamid, status: { $ne: "read" } }, // never downgrade out of 'read'
      { $set: updateFields },
      { returnDocument: 'before' }
    );

    // Increment the matching campaign counter — but only on the FIRST transition
    // into each state, so duplicate/out-of-order webhooks never over-count.
    if (before?.metadata) {
      const prev = before.status;
      const firstDelivered = newStatus === 'delivered' && prev !== 'delivered' && prev !== 'read';
      const firstRead      = newStatus === 'read'      && prev !== 'read';
      const firstFailed    = newStatus === 'failed'    && prev !== 'failed';

      const inc = {};
      if (firstDelivered) inc.deliveredCount = 1;
      if (firstRead)      inc.readCount = 1;
      if (firstFailed)    inc.failedCount = 1;

      if (Object.keys(inc).length > 0) {
        const { campaignId, bulkCampaignId } = before.metadata;
        if (campaignId) {
          await Campaign.findByIdAndUpdate(campaignId, { $inc: inc });
        } else if (bulkCampaignId) {
          await BulkCampaign.findByIdAndUpdate(bulkCampaignId, { $inc: inc });
        }
      }
    }

    // ── BILLING: charge the wallet exactly once, on delivery ────────────────
    // Only messages Meta confirms as `delivered` (or `read`) are billed, with
    // the rate captured on the Message at send time. Idempotent — safe to run
    // on every webhook retry. See services/billing.js.
    try {
      const result = await chargeOnDelivery(wamid, newStatus);
      if (result.billed) {
        console.log(`💸 Billed ₹${(result.charge / 100).toFixed(2)} for delivered WAMID ${wamid} (user ${result.userId})`);
      } else if (result.reason === 'insufficient-balance') {
        console.error(`⚠️ Wallet deduction failed on delivery for WAMID ${wamid} (user ${result.userId}, ₹${(result.charge / 100).toFixed(2)})`);
      }
    } catch (billErr) {
      console.error('Billing-on-delivery error:', billErr.message);
    }

    console.log(`Status update for WAMID ${wamid}: ${newStatus}. DB update result:`, before ? "Success" : "No matching message found");
  } catch (err) {
    console.error("Error updating status:", err.message);
  }
  return;
}

    // ── 2. INCOMING MESSAGES ─────────────────────────────────────────────────
    if (!value.messages) return;

    const msg                = value.messages[0];
    const fromNumber         = msg.from;
    const phoneNumberId      = value.metadata.phone_number_id;
    const contactProfileName = value.contacts?.[0]?.profile?.name || "";

    // Auth: find which user owns this WhatsApp number
    const wa = await WhatsApp.findOne({ phoneNumberId });
    if (!wa) {
      console.error("⚠️ Message received for unregistered Phone ID:", phoneNumberId);
      return;
    }

    // ── 3. EXTRACT MESSAGE CONTENT ───────────────────────────────────────────
    let incomingTextForWorkflow = "";
    let displaySnippet          = "";
    let messageType             = msg.type;
    let mediaData               = null;
    let interactiveMetadata     = null;

    if (msg.type === "text") {
      incomingTextForWorkflow = msg.text.body;
      displaySnippet          = msg.text.body;
    }
    else if (["image", "video", "audio", "document"].includes(msg.type)) {
      const media             = msg[msg.type];
      incomingTextForWorkflow = media.caption || `[${msg.type.toUpperCase()}]`;
      displaySnippet          = media.caption || `Sent a ${msg.type}`;
      mediaData = {
        mediaId:  media.id,
        mimeType: media.mime_type,
        fileName: media.filename || null,
      };
    }
    else if (msg.type === "interactive") {
      const interactive = msg.interactive;
      if (interactive.type === "button_reply") {
        messageType             = "button_reply";
        incomingTextForWorkflow = interactive.button_reply.id;
        displaySnippet          = interactive.button_reply.title;
        interactiveMetadata     = {
          title: displaySnippet,
          id:    incomingTextForWorkflow,
        };
      } else if (interactive.type === "list_reply") {
        messageType             = "list_reply";
        incomingTextForWorkflow = interactive.list_reply.id;
        displaySnippet          = interactive.list_reply.title;
        interactiveMetadata     = {
          title:       displaySnippet,
          id:          incomingTextForWorkflow,
          description: interactive.list_reply.description,
        };
      }
    }

    if (!incomingTextForWorkflow && !mediaData) return;

    // ── META OPT-OUT: handle STOP / UNSUBSCRIBE ─────────────────────────────
    const stopWords = ['stop', 'unsubscribe', 'optout', 'opt out', 'opt-out', 'cancel'];
    if (stopWords.includes((incomingTextForWorkflow || '').toLowerCase().trim())) {
      await Contact.findOneAndUpdate(
        { userId: wa.userId, phone: fromNumber },
        { $set: { optedOut: true, lastActive: new Date() } },
        { upsert: true }
      );
      console.log(`Contact ${fromNumber} opted out of marketing messages.`);
      return;
    }

    // ── 4. WORKFLOW KEYWORD MATCHING (for contact tagging only) ──────────────

let triggeredWorkflowName = "";
try {
  const workflows = await Workflow.find({ userId: wa.userId, isActive: true });
  
  for (const wf of workflows) {
    const trigger = wf.nodes.find(n => n.type === "trigger");
    if (!trigger || !trigger.data?.keyword) continue;

    const { keyword, matchType } = trigger.data;

    // Button/list replies: check edge handles first to avoid false keyword matches
    // (e.g. button ID "w-btn-demo" contains keyword "demo")
    const isContinuation = wf.edges.some(e => e.sourceHandle && e.sourceHandle === incomingTextForWorkflow.trim());
    if (isContinuation) {
      triggeredWorkflowName = wf.name;
      break;
    }

    if (matchType === "fallback") continue; // handled separately

    const cleanInput = (incomingTextForWorkflow || "").toLowerCase().trim();
    const keywordsArray = keyword.split(",").map(k => k.toLowerCase().trim());
    const matched = keywordsArray.some(kw =>
      matchType === "exact" ? cleanInput === kw : cleanInput.includes(kw)
    );

    if (matched) {
      triggeredWorkflowName = wf.name;
      break;
    }
  }
} catch (wfErr) {
  console.error("Workflow Logic Error:", wfErr.message);
}

    // ── 5. UPDATE / CREATE CONTACT ───────────────────────────────────────────
    const contact = await Contact.findOneAndUpdate(
      { userId: wa.userId, phone: fromNumber },
      {
        $set: {
          lastMessage: displaySnippet.slice(0, 100),
          lastActive:  new Date(),
          ...(contactProfileName && { name: contactProfileName }),
        },
        $inc: { messageCount: 1 },
        ...(triggeredWorkflowName
          ? { $addToSet: { workflows: triggeredWorkflowName } }
          : {}),
      },
      { upsert: true, new: true }
    );

    // ── 6. SAVE INCOMING MESSAGE TO DB (deduplicate by messageId) ───────────
    const alreadyExists = await Message.exists({ userId: wa.userId, messageId: msg.id });
    if (alreadyExists) {
      console.log(`Duplicate webhook ignored for messageId: ${msg.id}`);
      return;
    }
    const savedMsg = await Message.create({
      userId:        wa.userId,
      contactId:     contact._id,
      from:          "customer",
      type:          messageType,
      text:          incomingTextForWorkflow,
      media:         mediaData,
      metadata:      interactiveMetadata,
      messageId:     msg.id,   // incoming wamid — for deduplication
      status:        "read",   // you received it — read from your side
      isReadByAdmin: false,    // admin hasn't opened this chat yet
      timestamp:     new Date(),
    });

    // Fire-and-forget: download the media and store it permanently
    if (mediaData?.mediaId) {
      const token = wa.connectionType === 'platform'
        ? process.env.SYSTEM_USER_TOKEN
        : decrypt(wa.encryptedToken);
      downloadAndStoreMedia(savedMsg._id, wa.userId, mediaData.mediaId, mediaData.mimeType, token)
        .catch(e => console.error('Media store error:', e.message));
    }
try {
  await sendPushNotification(
    wa.userId,
    `New Message: ${contactProfileName || fromNumber}`,
    displaySnippet,
    { contactId: contact._id.toString(), type: "whatsapp_message" }
  );
  console.log("Push notification sent for new message from:", fromNumber);
} catch (pushErr) {
  console.error("Non-blocking Push Error:", pushErr);
}
    const handledByWorkflow = await executeWorkflow(wa.userId, incomingTextForWorkflow, fromNumber, contact._id, contact);

    // ── 7. AI DIRECT-CONNECT: reply with the LLM when no workflow matched ──────
    // Only fires if the user enabled AI + "direct connect". Skips media-only
    // messages (no text to reason over). Conversation context is the recent
    // history with this contact, sanitized for every provider.
    if (!handledByWorkflow && incomingTextForWorkflow && !mediaData) {
      try {
        const history = await Message.find({ userId: wa.userId, contactId: contact._id })
          .sort('-createdAt').limit(10).select('from text').lean();
        const messages = sanitizeHistory(
          history.reverse().map(m => ({
            role: m.from === 'customer' ? 'user' : 'assistant',
            content: m.text || '',
          }))
        );

        const reply = await generateDirectReply(wa.userId, messages);
        if (reply) {
          await sendMessage(wa.userId, fromNumber, { type: 'text', text: reply });
          await Message.create({
            userId: wa.userId, contactId: contact._id, from: 'bot', type: 'text',
            text: reply, status: 'sent', isReadByAdmin: true, timestamp: new Date(),
          });
          console.log(`🤖 [AI direct] Replied to ${fromNumber}`);
        }
      } catch (aiErr) {
        console.error('🤖 [AI direct] error:', aiErr.response?.data?.error?.message || aiErr.message);
      }
    }

  } catch (err) {
    console.error("🔥 Critical Webhook Error:", err);
  }
});

export default router;