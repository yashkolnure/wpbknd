import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
    from: { type: String, enum: ["customer", "bot", "admin"], required: true },
    
    // UI State
    isReadByAdmin: { type: Boolean, default: false }, // For unread badge in dashboard
    
    type: { 
      type: String, 
      enum: ["text", "image", "video", "audio", "document", "button_reply", "list_reply", "interactive", "template"], 
      default: "text" 
    },
    
    text: { type: String },
    
    // Meta Tracking
    messageId: { type: String, unique: true }, // WhatsApp 'wamid' - unique to prevent duplicates
    status: { 
      type: String, 
      enum: ["pending", "sent", "delivered", "read", "failed"], 
      default: "pending" 
    },
    
    // Context (Replies to specific messages)
    context: {
      quotedMessageId: String, // The ID of the message being replied to
    },

    media: {
      url: String,      
      mediaId: String,  
      mimeType: String,
      fileName: String,  
    },

    metadata: mongoose.Schema.Types.Mixed, 
    
    // For Debugging
    error: mongoose.Schema.Types.Mixed, // Stores Axios error details if status is 'failed'
    nodeId: String, // Which workflow node sent this?
  },
  { timestamps: true }
);

// Indexing for faster Chat History loading
messageSchema.index({ contactId: 1, createdAt: 1 });

export default mongoose.model("Message", messageSchema);