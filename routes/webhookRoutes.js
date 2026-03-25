import express from 'express';
import { executeWorkflow } from '../services/workflowExecutor.js';
import WhatsApp from '../models/WhatsApp.js';
import Contact from '../models/Contact.js';
import Workflow from '../models/Workflow.js';
import Message from '../models/Message.js';

const router = express.Router();
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

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

// Incoming messages
router.post("/webhook", async (req, res) => {
  // 1. Immediate ACK to Meta (Prevents duplicate retries)
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Filter: Only process incoming messages (ignore read receipts/status updates)
    if (!value?.messages) return;

    const msg = value.messages[0];
    const fromNumber = msg.from;
    const phoneNumberId = value.metadata.phone_number_id;
    const contactProfileName = value.contacts?.[0]?.profile?.name || "";

    // 2. Auth: Identify which user owns this WhatsApp account
    const wa = await WhatsApp.findOne({ phoneNumberId });
    if (!wa) {
      console.error("⚠️ Message received for unregistered Phone ID:", phoneNumberId);
      return;
    }

    // 3. Extract Message Content & Type
    let incomingTextForWorkflow = ""; // Used to trigger keywords
    let displaySnippet = "";          // Used for the "Last Message" UI
    let messageType = msg.type;
    let mediaData = null;
    let interactiveMetadata = null;

    if (msg.type === "text") {
      incomingTextForWorkflow = msg.text.body;
      displaySnippet = msg.text.body;
    } 
    else if (["image", "video", "audio", "document"].includes(msg.type)) {
      const media = msg[msg.type];
      incomingTextForWorkflow = media.caption || `[${msg.type.toUpperCase()}]`;
      displaySnippet = media.caption || `Sent a ${msg.type}`;
      mediaData = {
        mediaId: media.id,
        mimeType: media.mime_type,
        fileName: media.filename || null
      };
    } 
    else if (msg.type === "interactive") {
      const interactive = msg.interactive;
      if (interactive.type === "button_reply") {
        messageType = "button_reply";
        incomingTextForWorkflow = interactive.button_reply.id; // Trigger workflow by ID
        displaySnippet = interactive.button_reply.title;      // Show title in Chat List
        interactiveMetadata = { title: displaySnippet, id: incomingTextForWorkflow };
      } else if (interactive.type === "list_reply") {
        messageType = "list_reply";
        incomingTextForWorkflow = interactive.list_reply.id;
        displaySnippet = interactive.list_reply.title;
        interactiveMetadata = { 
          title: displaySnippet, 
          id: incomingTextForWorkflow, 
          description: interactive.list_reply.description 
        };
      }
    }

    // Stop if there is absolutely no content
    if (!incomingTextForWorkflow && !mediaData) return;

    // 4. Workflow Matching
    let triggeredWorkflowName = "";
    try {
      const workflows = await Workflow.find({ userId: wa.userId, isActive: true });
      for (const wf of workflows) {
        const trigger = wf.nodes.find(n => n.type === "trigger");
        if (!trigger) continue;

        const { keyword, matchType } = trigger.data;
        const cleanInput = incomingTextForWorkflow.toLowerCase().trim();
        const cleanKw = keyword.toLowerCase().trim();

        const matched = matchType === "exact" ? cleanInput === cleanKw : cleanInput.includes(cleanKw);
        if (matched) {
          triggeredWorkflowName = wf.name;
          break;
        }
      }
    } catch (wfErr) {
      console.error("Workflow Logic Error:", wfErr.message);
    }

    // 5. Update/Create Contact
    const contact = await Contact.findOneAndUpdate(
      { userId: wa.userId, phone: fromNumber },
      {
        $set: {
          lastMessage: displaySnippet.slice(0, 100),
          lastActive: new Date(),
          ...(contactProfileName && { name: contactProfileName })
        },
        $inc: { messageCount: 1 },
        ...(triggeredWorkflowName ? { $addToSet: { workflows: triggeredWorkflowName } } : {})
      },
      { upsert: true, new: true }
    );

    // 6. Save Detailed Message to DB (For the "Chats" Tab)
    await Message.create({
      userId: wa.userId,
      contactId: contact._id,
      from: "customer",
      type: messageType,
      text: incomingTextForWorkflow,
      media: mediaData,
      metadata: interactiveMetadata,
      messageId: msg.id,
      timestamp: new Date()
    });

    console.log(`✅ Chat updated: ${fromNumber} | Type: ${messageType} | Trigger: ${triggeredWorkflowName || "None"}`);

    // 7. Execute Automation
    // Passing contact._id ensures bot replies are linked to this specific chat
    await executeWorkflow(wa.userId, incomingTextForWorkflow, fromNumber, contact._id);

  } catch (err) {
    console.error("🔥 Critical Webhook Error:", err);
  }
});

export default router;