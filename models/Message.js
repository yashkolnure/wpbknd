import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
    from: { type: String, enum: ["customer", "bot", "admin"], required: true },
    
    // UI State
    isReadByAdmin: { type: Boolean, default: false }, 
    
    type: { 
      type: String, 
      enum: ["text", "image", "video", "audio", "document", "button_reply", "list_reply", "interactive", "template"], 
      default: "text" 
    },
    
    text: { type: String },
    
    // Meta Tracking
    messageId: { type: String, index: true },
    status: { 
      type: String, 
      // Added 'received' for incoming customer messages
      enum: ["pending", "sent", "delivered", "read", "failed", "received"], 
      default: "pending" 
    },
    
    context: {
      quotedMessageId: String, 
    },

    media: {
      url: String,      
      mediaId: String,  
      mimeType: String,
      fileName: String,  
    },

    metadata: mongoose.Schema.Types.Mixed,

    error: mongoose.Schema.Types.Mixed,
    nodeId: String,
    saved: { type: Boolean, default: false },  // user-bookmarked messages

    // Per-message billing. Rates are captured at SEND time (so later .env
    // changes never re-price in-flight campaigns) but the wallet is only
    // charged once Meta confirms `delivered` (see webhookRoutes.js).
    billing: {
      category:       { type: String },                 // marketing | service | utility | authentication
      connectionType: { type: String },                 // platform | own (whose WABA / payment method)
      metaCostPaise:  { type: Number, default: 0 },      // Meta's base cost captured at send
      markupPaise:    { type: Number, default: 0 },      // our platform fee captured at send
      perMsgCharge:   { type: Number, default: 0 },      // amount to debit on delivery (platform: meta+markup, own: markup)
      charged:        { type: Boolean, default: false }, // wallet already debited for this message?
      chargedAt:      { type: Date },
      chargeFailed:   { type: Boolean, default: false }, // delivered but wallet had insufficient balance
    },
  },
  { timestamps: true }
);

// Chat history queries
messageSchema.index({ contactId: 1, createdAt: 1 });
// Deduplication — one wamid per user (Meta can send the same webhook multiple times)
messageSchema.index({ userId: 1, messageId: 1 }, { unique: true, sparse: true });
// Campaign delivery stats — speeds up getCampaigns enrichment queries
messageSchema.index({ 'metadata.campaignId': 1, status: 1 }, { sparse: true });
messageSchema.index({ 'metadata.bulkCampaignId': 1, status: 1 }, { sparse: true });

export default mongoose.model("Message", messageSchema);