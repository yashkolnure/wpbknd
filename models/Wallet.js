import mongoose from 'mongoose';

// Balance stored in paise (₹1 = 100 paise) to avoid floating point issues
const walletSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  balance: { type: Number, default: 0 }, // in paise
}, { timestamps: true });

export default mongoose.model('Wallet', walletSchema);
