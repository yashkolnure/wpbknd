import mongoose from 'mongoose';

const whatsappSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  // Meta Identifiers
  phoneNumberId:  { type: String },
  displayNumber:  { type: String },
  verifiedName:   { type: String },
  wabaId:         { type: String },

  // 'own' = user brought their own Meta Business WABA
  // 'platform' = WPLeads added their number to WPLeads' shared WABA
  connectionType: { type: String, enum: ['own', 'platform'], default: 'own' },

  // Security & Finalization
  encryptedToken: { type: String },
  isVerified:     { type: Boolean, default: false },
  connectedAt:    { type: Date },

  // Platform-number onboarding wizard progress
  onboarding: {
    step:          { type: Number, default: 1 },   // 1-4
    phoneNumberId: { type: String },               // returned by Meta after step 1
    countryCode:   { type: String },
    phoneNumber:   { type: String },
    verifiedName:  { type: String },
    otpMethod:     { type: String, default: 'SMS' },
    status:        { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
    updatedAt:     { type: Date },
  },
}, { timestamps: true });

export default mongoose.model('WhatsApp', whatsappSchema);