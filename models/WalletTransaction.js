import mongoose from 'mongoose';

const txSchema = new mongoose.Schema({
  userId:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:              { type: String, enum: ['credit', 'debit'], required: true },
  amount:            { type: Number, required: true }, // in paise
  description:       { type: String },
  razorpayOrderId:   { type: String },
  razorpayPaymentId: { type: String },
  meta:              { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

txSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model('WalletTransaction', txSchema);
