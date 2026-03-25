import mongoose from 'mongoose';

const whatsappSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  phoneNumberId:  { type: String, required: true },
  wabaId:         { type: String, required: true },
  encryptedToken: { type: String, required: true },
  isVerified:     { type: Boolean, default: false },
  connectedAt:    { type: Date, default: Date.now },
});

export default mongoose.model('WhatsApp', whatsappSchema);