import mongoose from 'mongoose';

const whatsappSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  
  // Meta Identifiers (Filled as the wizard progresses)
  phoneNumberId:  { type: String },
  displayNumber:  { type: String },
  verifiedName:   { type: String },
  wabaId:         { type: String }, // Optional: If you want to track the business account ID

  // Registration State
  registrationStep: { type: Number, default: 1 }, 
  status: { 
    type: String, 
    enum: ['PENDING', 'OTP_SENT', 'VERIFIED', 'ACTIVE'], 
    default: 'PENDING' 
  },

  // Security & Finalization
  encryptedToken: { type: String }, // If storing per-user tokens
  isVerified:     { type: Boolean, default: false },
  connectedAt:    { type: Date },
}, { timestamps: true });

export default mongoose.model('WhatsApp', whatsappSchema);