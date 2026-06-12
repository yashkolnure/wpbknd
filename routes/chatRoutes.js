import express from "express";
import multer from "multer";
import axios from "axios";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import FormData from "form-data";
import Message from "../models/Message.js";
import Contact from "../models/Contact.js";
import WhatsApp from "../models/WhatsApp.js";
import { protect } from '../middleware/auth.js';
import { sendMessage } from "../services/messageSender.js";
import { decrypt } from "../utils/encrypt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB limit

// --- 1. GET ALL CHATS (For Sidebar List) ---
router.get("/chats", protect, async (req, res) => {
  try {
    const contacts = await Contact.find({ userId: req.user._id })
      .sort({ lastActive: -1 })
      .select("name phone lastMessage lastActive messageCount tags")
      .lean();

    // Unread = incoming customer messages the admin hasn't viewed yet
    const unreadAgg = await Message.aggregate([
      { $match: { userId: req.user._id, from: "customer", isReadByAdmin: false } },
      { $group: { _id: "$contactId", count: { $sum: 1 } } },
    ]);
    const unreadMap = {};
    for (const u of unreadAgg) unreadMap[String(u._id)] = u.count;

    res.json(contacts.map(c => ({ ...c, unreadCount: unreadMap[String(c._id)] || 0 })));
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

    // Viewing a chat marks its incoming messages as read (only on the latest page,
    // not when paginating older history via ?before=)
    if (!before) {
      Message.updateMany(
        { contactId, userId: req.user._id, from: "customer", isReadByAdmin: false },
        { $set: { isReadByAdmin: true } }
      ).catch(() => {});
    }

    res.json({ messages: raw.reverse(), hasMore });
  } catch (err) {
    res.status(500).json({ error: "Failed to load message history" });
  }
});

// --- 3. UPLOAD MEDIA to WhatsApp (returns media_id + permanent local url) ---
router.post("/chats/upload-media", protect, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const wa = await WhatsApp.findOne({ userId: req.user._id, isVerified: true });
    if (!wa) return res.status(400).json({ error: "WhatsApp not connected" });

    const accessToken = wa.connectionType === "platform"
      ? process.env.SYSTEM_USER_TOKEN
      : decrypt(wa.encryptedToken);

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

    // Save a permanent local copy so chat can display the sent file without re-fetching from Meta
    const ext = MIME_TO_EXT[req.file.mimetype] || req.file.mimetype?.split("/")?.[1]?.split(";")?.[0] || "bin";
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const dir = path.join(__dirname, "..", "uploads", req.user._id.toString());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), req.file.buffer);
    const BASE_URL = process.env.API_BASE_URL || "http://localhost:5002";
    const publicUrl = `${BASE_URL}/uploads/${req.user._id}/${filename}`;

    res.json({ mediaId: response.data.id, url: publicUrl, mimeType: req.file.mimetype, filename: req.file.originalname });
  } catch (err) {
    console.error("Media upload error:", err.response?.data || err.message);
    res.status(500).json({ error: "Media upload failed", details: err.response?.data || err.message });
  }
});

// --- 4. SEND MESSAGE (text or media) ---
router.post("/chats/:id/messages", protect, async (req, res) => {
  try {
    const { id } = req.params;
    const { text, type, mediaId, mediaType, mediaCaption, mediaFilename, mediaUrl } = req.body;

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
      ...(isMedia ? { media: { mediaId, url: mediaUrl || null, mimeType: mediaType, fileName: mediaFilename } } : {}),
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

// --- 5. FETCH AND STORE INCOMING MEDIA (for customer messages without a stored URL) ---
router.post("/chats/messages/:messageId/fetch-media", protect, async (req, res) => {
  try {
    const msg = await Message.findOne({ _id: req.params.messageId, userId: req.user._id });
    if (!msg) return res.status(404).json({ error: "Not found" });
    if (!msg.media?.mediaId) return res.status(400).json({ error: "No mediaId on this message" });

    // Already downloaded — just return the URL
    if (msg.media.url) return res.json({ url: msg.media.url });

    const wa = await WhatsApp.findOne({ userId: req.user._id, isVerified: true });
    if (!wa) return res.status(400).json({ error: "WhatsApp not connected" });

    const accessToken = wa.connectionType === "platform"
      ? process.env.SYSTEM_USER_TOKEN
      : decrypt(wa.encryptedToken);

    const GRAPH_VER = process.env.GRAPH_VERSION || "v21.0";

    // 1. Get the temporary download URL from Meta
    const metaRes = await axios.get(
      `https://graph.facebook.com/${GRAPH_VER}/${msg.media.mediaId}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    const downloadUrl = metaRes.data?.url;
    if (!downloadUrl) return res.status(404).json({ error: "Meta returned no download URL" });

    // 2. Download the bytes
    const mediaRes = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: "arraybuffer",
      timeout: 30000,
    });

    // 3. Save locally
    const mimeType = msg.media.mimeType;
    const ext = MIME_TO_EXT[mimeType] || mimeType?.split("/")?.[1]?.split(";")?.[0] || "bin";
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const dir = path.join(__dirname, "..", "uploads", req.user._id.toString());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), Buffer.from(mediaRes.data));

    const BASE_URL = process.env.API_BASE_URL || "http://localhost:5002";
    const publicUrl = `${BASE_URL}/uploads/${req.user._id}/${filename}`;

    await Message.findByIdAndUpdate(msg._id, { "media.url": publicUrl });

    res.json({ url: publicUrl });
  } catch (err) {
    console.error("fetch-media error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch media" });
  }
});

export default router;
