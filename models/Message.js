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
    messageId: { type: String, unique: true, sparse: true }, // Added sparse: true in case some internal notes don't have IDs
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
  },
  { timestamps: true }
);

// CRITICAL: Index for Webhook Lookups
messageSchema.index({ messageId: 1 }); 

// Index for Chat History
messageSchema.index({ contactId: 1, createdAt: 1 });

export default mongoose.model("Message", messageSchema);