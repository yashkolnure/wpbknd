import express from 'express';
import crypto from 'crypto';
import { executeWorkflow } from '../services/workflowExecutor.js';
import WhatsApp from '../models/WhatsApp.js';
import Contact from '../models/Contact.js';
import Workflow from '../models/Workflow.js';
import Message from '../models/Message.js';
import Campaign from '../models/Campaign.js';
import BulkCampaign from '../models/BulkCampaign.js';
import { sendPushNotification } from '../services/notificationService.js';

const router = express.Router();
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

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
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
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

    const updated = await Message.findOneAndUpdate(
      { messageId: wamid, status: { $ne: "read" } },
      { $set: updateFields },
      { returnDocument: 'after' }
    );

    // On every status update, increment the matching counter on the campaign doc
    if (updated?.metadata && ['delivered', 'read', 'failed'].includes(newStatus)) {
      const { campaignId, bulkCampaignId } = updated.metadata;
      const prevStatus = updated.status; // status BEFORE this update (returnDocument:'after' gives new, so check what changed)

      // Meta fires webhooks in order: sent → delivered → read
      // deliveredCount counts every message that reached the device (delivered OR later read)
      // readCount counts messages the user opened
      // 'delivered' webhook always arrives before 'read', so:
      //   delivered → inc deliveredCount only
      //   read      → inc readCount only (deliveredCount was already incremented earlier)
      //   failed    → inc failedCount only
      const inc = {};
      if (newStatus === 'delivered') inc.deliveredCount = 1;
      if (newStatus === 'read')      inc.readCount = 1;
      if (newStatus === 'failed')    inc.failedCount = 1;

      if (Object.keys(inc).length > 0) {
        if (campaignId) {
          await Campaign.findByIdAndUpdate(campaignId, { $inc: inc });
        } else if (bulkCampaignId) {
          await BulkCampaign.findByIdAndUpdate(bulkCampaignId, { $inc: inc });
        }
      }
    }

    console.log(`Status update for WAMID ${wamid}: ${newStatus}. DB update result:`, updated ? "Success" : "No matching message found");
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
    const cleanInput = (incomingTextForWorkflow || "").toLowerCase().trim();
    
    // Split keywords by comma and clean them up
    const keywordsArray = keyword.split(",").map(k => k.toLowerCase().trim());

    // Check if ANY keyword in the array matches
    const matched = keywordsArray.some(kw => {
      if (matchType === "exact") {
        return cleanInput === kw;
      } else {
        return cleanInput.includes(kw);
      }
    });

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
    await Message.create({
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
    await executeWorkflow(wa.userId, incomingTextForWorkflow, fromNumber, contact._id, contact);

  } catch (err) {
    console.error("🔥 Critical Webhook Error:", err);
  }
});

export default router;