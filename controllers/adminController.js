// controllers/adminController.js — Super Admin operations (gated by superAdmin middleware)
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";
import Campaign from "../models/Campaign.js";
import BulkCampaign from "../models/BulkCampaign.js";
import Message from "../models/Message.js";
import { generateToken } from "../utils/generateToken.js";

// GET /admin/users — every user with wallet balance, lifetime spend, msg count, WA info
export const getAllUsersData = async (req, res) => {
  try {
    const data = await User.aggregate([
      { $sort: { createdAt: -1 } },
      { $lookup: { from: "whatsapps", localField: "_id", foreignField: "userId", as: "waInfo" } },
      { $lookup: { from: "wallets", localField: "_id", foreignField: "userId", as: "walletInfo" } },
      {
        $lookup: {
          from: "wallettransactions",
          let: { uid: "$_id" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$userId", "$$uid"] }, { $eq: ["$type", "debit"] }] } } },
            { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
          ],
          as: "spendInfo",
        },
      },
      {
        $project: {
          name: 1, email: 1, phone: 1, createdAt: 1, plan: 1, planExpiresAt: 1,
          whatsapp: { $arrayElemAt: ["$waInfo", 0] },
          balancePaise: { $ifNull: [{ $arrayElemAt: ["$walletInfo.balance", 0] }, 0] },
          spentPaise: { $ifNull: [{ $arrayElemAt: ["$spendInfo.total", 0] }, 0] },
          debitCount: { $ifNull: [{ $arrayElemAt: ["$spendInfo.count", 0] }, 0] },
        },
      },
    ]);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: "Fetch failed", error: error.message });
  }
};

// GET /admin/stats — platform-wide totals
export const getAdminStats = async (req, res) => {
  try {
    const [totalUsers, proUsers, connected, msgTotal, walletAgg, spendAgg] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ plan: "pro" }),
      (await import("../models/WhatsApp.js")).default.countDocuments({ isVerified: true }),
      Message.countDocuments({ from: { $in: ["bot", "admin"] } }),
      Wallet.aggregate([{ $group: { _id: null, total: { $sum: "$balance" } } }]),
      WalletTransaction.aggregate([{ $match: { type: "debit" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
    ]);
    res.json({
      totalUsers,
      proUsers,
      connectedAccounts: connected,
      totalMessages: msgTotal,
      totalBalancePaise: walletAgg[0]?.total || 0,
      totalSpentPaise: spendAgg[0]?.total || 0,
    });
  } catch (error) {
    res.status(500).json({ message: "Stats failed", error: error.message });
  }
};

// GET /admin/users/:id — full profile + wallet + transactions + campaign spend
export const getUserDetail = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid user id" });

    const user = await User.findById(id).select("-password").lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    const WhatsApp = (await import("../models/WhatsApp.js")).default;
    const [wallet, transactions, whatsapp, campaigns, bulkCampaigns, msgCount] = await Promise.all([
      Wallet.findOne({ userId: id }).lean(),
      WalletTransaction.find({ userId: id }).sort("-createdAt").limit(50).lean(),
      WhatsApp.findOne({ userId: id }).select("-encryptedToken").lean(),
      Campaign.find({ userId: id }).select("name status sentCount deliveredCount costPaise createdAt").sort("-createdAt").limit(20).lean(),
      BulkCampaign.find({ userId: id }).select("name status sentCount deliveredCount costPaise createdAt").sort("-createdAt").limit(20).lean(),
      Message.countDocuments({ userId: id, from: { $in: ["bot", "admin"] } }),
    ]);

    const spend = await WalletTransaction.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(id), type: "debit" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    res.json({
      user,
      balancePaise: wallet?.balance || 0,
      spentPaise: spend[0]?.total || 0,
      messageCount: msgCount,
      whatsapp,
      transactions,
      campaigns,
      bulkCampaigns,
    });
  } catch (error) {
    res.status(500).json({ message: "Detail failed", error: error.message });
  }
};

// POST /admin/users/:id/credit  { amount } (rupees)  — top up a wallet
export const creditUserWallet = async (req, res) => {
  try {
    const { id } = req.params;
    const amount = Number(req.body.amount); // rupees
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid user id" });
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ message: "Enter a non-zero amount (₹)" });

    const paise = Math.round(amount * 100);
    const user = await User.findById(id).select("name email");
    if (!user) return res.status(404).json({ message: "User not found" });

    const wallet = await Wallet.findOneAndUpdate(
      { userId: id },
      { $inc: { balance: paise } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await WalletTransaction.create({
      userId: id,
      type: paise >= 0 ? "credit" : "debit",
      amount: Math.abs(paise),
      description: `Admin ${paise >= 0 ? "credit" : "adjustment"} by ${req.user.email}`,
    });

    res.json({ success: true, balancePaise: wallet.balance, balanceRupees: (wallet.balance / 100).toFixed(2) });
  } catch (error) {
    res.status(500).json({ message: "Credit failed", error: error.message });
  }
};

// POST /admin/users/:id/password  { password }  — force-set a user's password
export const setUserPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid user id" });
    if (!password || password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.password = await bcrypt.hash(password, 10);
    await user.save();

    res.json({ success: true, message: `Password updated for ${user.email}` });
  } catch (error) {
    res.status(500).json({ message: "Password update failed", error: error.message });
  }
};

// POST /admin/users/:id/impersonate — mint a login token for that user
export const impersonateUser = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid user id" });
    const user = await User.findById(id).select("name email");
    if (!user) return res.status(404).json({ message: "User not found" });

    console.log(`🔐 Admin ${req.user.email} impersonating ${user.email}`);
    res.json({ token: generateToken(user._id), user: { name: user.name, email: user.email } });
  } catch (error) {
    res.status(500).json({ message: "Impersonate failed", error: error.message });
  }
};

// PATCH /admin/users/:id/plan  { plan, planExpiresAt? }
export const updateUserPlan = async (req, res) => {
  try {
    const { id } = req.params;
    const { plan, planExpiresAt } = req.body;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid user id" });
    if (!["free", "pro"].includes(plan)) return res.status(400).json({ message: "plan must be 'free' or 'pro'" });

    const user = await User.findByIdAndUpdate(
      id,
      { plan, ...(planExpiresAt !== undefined ? { planExpiresAt } : {}) },
      { new: true }
    ).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ message: "Plan update failed", error: error.message });
  }
};
