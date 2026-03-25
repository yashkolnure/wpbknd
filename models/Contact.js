import mongoose from 'mongoose';

const contactSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  phone:         { type: String, required: true },
  name:          { type: String, default: '' },
  lastMessage:   { type: String, default: '' },
  lastActive:    { type: Date, default: Date.now },
  messageCount:  { type: Number, default: 1 },
  workflows:     [{ type: String }], // workflow names triggered
  tags:          [{ type: String }],
  notes:         { type: String, default: '' },
}, { timestamps: true });

// One contact per phone per user
contactSchema.index({ userId: 1, phone: 1 }, { unique: true });

export default mongoose.model('Contact', contactSchema);