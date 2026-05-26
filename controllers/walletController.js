import Razorpay from 'razorpay';
import crypto from 'crypto';
import Wallet from '../models/Wallet.js';
import WalletTransaction from '../models/WalletTransaction.js';
import { PRICING, META_BASE, MARKUP_PCT } from '../config/pricing.js';

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Ensure wallet exists for user, return it
export const getOrCreateWallet = async (userId) => {
  let wallet = await Wallet.findOne({ userId });
  if (!wallet) wallet = await Wallet.create({ userId, balance: 0 });
  return wallet;
};

// Deduct balance — atomic, returns false if insufficient (prevents race conditions)
export const deductBalance = async (userId, paise, description) => {
  const updated = await Wallet.findOneAndUpdate(
    { userId, balance: { $gte: paise } }, // only update if balance is sufficient
    { $inc: { balance: -paise } },
    { new: true }
  );
  if (!updated) return false; // insufficient balance or wallet not found
  await WalletTransaction.create({ userId, type: 'debit', amount: paise, description });
  return true;
};

// GET /api/wallet — balance + recent transactions + pricing info
export const getWallet = async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.user._id);
    const transactions = await WalletTransaction.find({ userId: req.user._id })
      .sort('-createdAt').limit(30);

    res.json({
      balancePaise: wallet.balance,
      balanceRupees: (wallet.balance / 100).toFixed(2),
      transactions,
      pricing: {
        marketing: { paise: PRICING.marketing, rupees: (PRICING.marketing / 100).toFixed(2) },
        service:   { paise: PRICING.service,   rupees: (PRICING.service   / 100).toFixed(2) },
        metaBase:  { marketing: (META_BASE.marketing / 100).toFixed(2), service: (META_BASE.service / 100).toFixed(2) },
        markupPct: MARKUP_PCT,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/wallet/recharge/create-order
export const createRechargeOrder = async (req, res) => {
  try {
    const { amount } = req.body; // amount in rupees
    if (!amount || amount < 10) return res.status(400).json({ message: 'Minimum recharge is ₹10' });

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // convert to paise for Razorpay
      currency: 'INR',
      receipt: `wallet_${req.user._id}_${Date.now()}`,
      notes: { userId: req.user._id.toString(), type: 'wallet_recharge' },
    });

    res.json({ orderId: order.id, amount: order.amount, currency: order.currency });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/wallet/recharge/verify
export const verifyRecharge = async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ message: 'Missing payment fields' });
  }

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ message: 'Invalid payment signature' });
  }

  try {
    const paise = Math.round(amount); // amount already in paise from Razorpay
    await Wallet.findOneAndUpdate(
      { userId: req.user._id },
      { $inc: { balance: paise } },
      { upsert: true }
    );
    await WalletTransaction.create({
      userId:            req.user._id,
      type:              'credit',
      amount:            paise,
      description:       `Wallet recharge via Razorpay`,
      razorpayOrderId:   razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
    });

    const wallet = await Wallet.findOne({ userId: req.user._id });
    res.json({ success: true, balancePaise: wallet.balance, balanceRupees: (wallet.balance / 100).toFixed(2) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
