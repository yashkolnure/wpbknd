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