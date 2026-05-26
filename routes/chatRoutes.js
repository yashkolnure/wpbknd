import express from "express";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import Message from "../models/Message.js";
import Contact from "../models/Contact.js";
import WhatsApp from "../models/WhatsApp.js";
import { protect } from '../middleware/auth.js';
import { sendMessage } from "../services/messageSender.js";
import { decrypt } from "../utils/encrypt.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB limit

// --- 1. GET ALL CHATS (For Sidebar List) ---
router.get("/chats", protect, async (req, res) => {
  try {
    const contacts = await Contact.find({ userId: req.user._id })
      .sort({ lastActive: -1 })
      .select("name phone lastMessage lastActive messageCount tags");

    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch chat list" });
  }
});

// --- 1b. GET SAVED MESSAGES (must be before /:contactId to avoid param collision) ---
router.get("/chats/saved", protect, async (req, res) => {
  try {
    const msgs = await Message.find({ userId: req.user._id, saved: true })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate("contactId", "name phone");
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: "Failed to load saved messages" });
  }
});

// --- 1c. TOGGLE SAVED on a message ---
router.patch("/chats/messages/:messageId/save", protect, async (req, res) => {
  try {
    const msg = await Message.findOne({ _id: req.params.messageId, userId: req.user._id });
    if (!msg) return res.status(404).json({ error: "Message not found" });
    msg.saved = !msg.saved;
    await msg.save();
    res.json({ saved: msg.saved });
  } catch (err) {
    res.status(500).json({ error: "Failed to toggle saved" });
  }
});

// --- 2. GET MESSAGE HISTORY (paginated) ---
// ?limit=30&before=<messageId>  → returns oldest-first slice ending before that id
router.get("/chats/:contactId/messages", protect, async (req, res) => {
  try {
    const { contactId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const before = req.query.before; // cursor: oldest message id the client already has

    const query = { contactId, userId: req.user._id };
    if (before) {
      const pivot = await Message.findById(before).select("createdAt");
      if (pivot) query.createdAt = { $lt: pivot.createdAt };
    }

    // fetch newest-first so we can slice, then reverse for display
    const raw = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1);

    const hasMore = raw.length > limit;
    if (hasMore) raw.pop();

    res.json({ messages: raw.reverse(), hasMore });
  } catch (err) {
    res.status(500).json({ error: "Failed to load message history" });
  }
});

// --- 3. UPLOAD MEDIA to WhatsApp (returns media_id) ---
router.post("/chats/upload-media", protect, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const wa = await WhatsApp.findOne({ userId: req.user._id, isVerified: true });
    if (!wa) return res.status(400).json({ error: "WhatsApp not connected" });

    const accessToken = decrypt(wa.encryptedToken);

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${wa.phoneNumberId}/media`,
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${accessToken}` } }
    );

    res.json({ mediaId: response.data.id, mimeType: req.file.mimetype, filename: req.file.originalname });
  } catch (err) {
    console.error("Media upload error:", err.response?.data || err.message);
    res.status(500).json({ error: "Media upload failed", details: err.response?.data || err.message });
  }
});

// --- 4. SEND MESSAGE (text or media) ---
router.post("/chats/:id/messages", protect, async (req, res) => {
  try {
    const { id } = req.params;
    const { text, type, mediaId, mediaType, mediaCaption, mediaFilename } = req.body;

    const contact = await Contact.findById(id);
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const isMedia = type === "media" && mediaId && mediaType;

    const messagePayload = isMedia
      ? { type: "media", mediaType, mediaId, mediaCaption: mediaCaption || "", mediaFilename }
      : { type: "text", text };

    const metaResponse = await sendMessage(contact.userId, contact.phone, messagePayload);

    const lastMsgPreview = isMedia ? `📎 ${mediaType}` : (text || "").slice(0, 100);

    const newMessage = await Message.create({
      userId: contact.userId,
      contactId: contact._id,
      from: "admin",
      type: isMedia ? mediaType : "text",
      text: isMedia ? (mediaCaption || "") : text,
      messageId: metaResponse.messages?.[0]?.id || `admin-${Date.now()}`,
      timestamp: new Date(),
      ...(isMedia ? { media: { id: mediaId, type: mediaType, filename: mediaFilename } } : {}),
    });

    await Contact.findByIdAndUpdate(id, {
      $set: { lastMessage: lastMsgPreview, lastActive: new Date() },
    });

    res.status(201).json(newMessage);
  } catch (err) {
    console.error("Send error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to send message", details: err.response?.data || err.message });
  }
});

export default router;
