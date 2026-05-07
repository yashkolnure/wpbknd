// routes/payments.js
import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── GET current plan ──────────────────────────────────────────────────────────
router.get("/plan", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("plan planExpiresAt");
    res.json({
      plan:          user.plan,
      planExpiresAt: user.planExpiresAt,
      isActive:      user.plan === "pro" && (!user.planExpiresAt || user.planExpiresAt > new Date()),
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch plan" });
  }
});

// ── CREATE order (amount comes from frontend) ─────────────────────────────────
router.post("/create-order", protect, async (req, res) => {
  try {
    const { amount, currency = "INR" } = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt: `r_${Date.now()}`,
      notes:    { userId: req.user.id },
    });

    res.json({ orderId: order.id, amount: order.amount, currency: order.currency });
  } catch (err) {
    console.error("Razorpay order error:", err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// ── VERIFY payment + upgrade plan ─────────────────────────────────────────────
router.post("/verify", protect, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing payment fields" });
  }

  // Verify signature
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: "Invalid payment signature" });
  }

  try {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await User.findByIdAndUpdate(req.user.id, {
      plan:          "pro",
      planExpiresAt: expiresAt,
      planOrderId:   razorpay_order_id,
    });

    res.json({ success: true, plan: "pro", planExpiresAt: expiresAt });
  } catch {
    res.status(500).json({ error: "Failed to upgrade plan" });
  }
});

export default router;