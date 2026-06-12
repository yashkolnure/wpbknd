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

// A Razorpay payment may be credited to a wallet at most ONCE. The partial filter
// limits the unique constraint to recharge rows (where razorpayPaymentId is a
// string) so the many debit/credit rows without a payment id don't collide.
// This insert is the idempotency gate that blocks replayed /recharge/verify calls.
txSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } }
);

export default mongoose.model('WalletTransaction', txSchema);
