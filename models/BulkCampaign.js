import mongoose from 'mongoose';

const bulkCampaignSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:           { type: String, required: true },
  message:        { type: mongoose.Schema.Types.Mixed, required: true }, // supports all message types
  phoneNumbers:   [{ type: String }],
  status:         { type: String, enum: ['running', 'done', 'failed'], default: 'running' },
  totalCount:     { type: Number, default: 0 },
  sentCount:      { type: Number, default: 0 },
  failedCount:    { type: Number, default: 0 },
  deliveredCount: { type: Number, default: 0 },
  readCount:      { type: Number, default: 0 },
  costPaise:      { type: Number, default: 0 },
  failureReason:  { type: String, default: null },
}, { timestamps: true });

export default mongoose.model('BulkCampaign', bulkCampaignSchema);
