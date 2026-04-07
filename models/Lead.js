import mongoose from 'mongoose';

const LeadSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  data: { type: Object, required: true }, // Flexible object to store any form fields
  sourceUrl: { type: String },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Lead', LeadSchema);