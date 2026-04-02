import express from "express";
import Message from "../models/Message.js";
import Contact from "../models/Contact.js";
import { protect } from '../middleware/auth.js';
import { sendMessage } from "../services/messageSender.js";

const router = express.Router();

// --- 1. GET ALL CHATS (For Sidebar List) ---
// Returns a list of contacts sorted by the most recent activity
router.get("/chats", protect, async (req, res) => {
  try {
    const contacts = await Contact.find({ userId: req.user._id })
      .sort({ lastActive: -1 }) // Newest conversations at the top
      .select("name phone lastMessage lastActive messageCount"); // Only send what UI needs

    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch chat list" });
  }
});

// --- 2. GET MESSAGE HISTORY (For Main Chat Window) ---
// Returns all messages between you/bot and a specific contact
router.get("/chats/:contactId/messages", protect, async (req, res) => {
  try {
    const { contactId } = req.params;
    const messages = await Message.find({
      contactId: contactId, // Mongoose usually handles string-to-objectid conversion here automatically
      userId: req.user._id,
    }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: "Failed to load message history" });
  }
});

router.post("/chats/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const { text, type } = req.body;
    const userId = req.user?._id; 
    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }
    const messagePayload = {
      type: type || "text",
      text: text
    };
    const metaResponse = await sendMessage(contact.userId, contact.phone, messagePayload);
    const newMessage = await Message.create({
      userId: contact.userId,
      contactId: contact._id,
      from: "admin", // Crucial for your Dashboard UI
      type: "text",
      text: text,
      messageId: metaResponse.messages?.[0]?.id || `admin-${Date.now()}`,
      timestamp: new Date()
    });
    await Contact.findByIdAndUpdate(id, {
      $set: {
        lastMessage: text.slice(0, 100),
        lastActive: new Date()
      }
    });

    // 7. Return the new message to the frontend for optimistic UI updates
    res.status(201).json(newMessage);

  } catch (err) {
    console.error("Manual Send Error:", err.response?.data || err.message);
    res.status(500).json({ 
      error: "Failed to send message", 
      details: err.response?.data || err.message 
    });
  }
});

export default router;