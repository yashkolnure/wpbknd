import User from "../models/User.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { generateToken } from "../utils/generateToken.js";

// Normalize emails so case/whitespace never splits one person into two accounts
// or blocks login (e.g. "Yash@Gmail.com " === "yash@gmail.com").
const normalizeEmail = (e) => (e || "").trim().toLowerCase();

// REGISTER
// controllers/auth.controller.js

export const register = async (req, res) => {
  try {
    let { name, email, password, phone } = req.body;

    if (!name || !email || !password || !phone) {
      return res.status(400).json({ message: "All fields are required" });
    }

    email = normalizeEmail(email);

    // Normalize phone to +91XXXXXXXXXX
    const cleanPhone = "+" + phone.replace(/\D/g, "").replace(/^0+/, "");
    // If the user didn't include 91, add it
    const finalPhone = cleanPhone.startsWith("+91") ? cleanPhone : "+91" + cleanPhone.slice(1);

    const userExists = await User.findOne({ $or: [{ email }, { phone: finalPhone }] });

    if (userExists) {
      return res.status(400).json({ message: "Email or Phone already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      phone: finalPhone,
      plan: 'pro',
      planExpiresAt: null,
    });

    res.status(201).json({
      success: true,
      token: generateToken(user._id),
      user: { id: user._id, name: user.name, email: user.email }
    });

  } catch (error) {
    console.error("Reg Error:", error);
    res.status(500).json({ message: "Server error during registration" });
  }
};

// LOGIN
export const login = async (req, res) => {
  try {
    const { password } = req.body;
    const email = normalizeEmail(req.body.email);

    const user = await User.findOne({ email });
    if (!user)
      return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });

    // Never ship the bcrypt hash or reset-token to the client. (We can't use
    // .select("-password") on the query above because bcrypt.compare needs it.)
    const safeUser = user.toObject();
    delete safeUser.password;
    delete safeUser.resetPasswordToken;
    delete safeUser.resetPasswordExpires;

    res.json({
      user: safeUser,
      token: generateToken(user._id)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateFCMToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    console.log("Received FCM token:", fcmToken);

    if (!fcmToken) {
      return res.status(400).json({ message: "Token is required" });
    }

    // A device token must belong to exactly ONE user. If this device was
    // previously signed in as someone else, detach the token from every other
    // user first — otherwise a shared phone would receive both users' pushes.
    await User.updateMany(
      { _id: { $ne: req.user._id }, fcmTokens: fcmToken },
      { $pull: { fcmTokens: fcmToken } }
    );

    // req.user._id comes from your protect/auth middleware
    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { fcmTokens: fcmToken },
    });

    res.status(200).json({ message: "FCM token updated successfully" });
    console.log("FCM token updated for user:", req.user._id);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Remove a device token from the current user — called on logout so a
// signed-out device stops receiving that user's push notifications.
export const removeFCMToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ message: "Token is required" });
    }

    await User.findByIdAndUpdate(req.user._id, {
      $pull: { fcmTokens: fcmToken },
    });

    res.status(200).json({ message: "FCM token removed successfully" });
    console.log("FCM token removed for user:", req.user._id);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// FORGOT PASSWORD
export const forgotPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const user = await User.findOne({ email });

    if (!user) {
      // Don't reveal whether email exists
      return res.json({ message: "If that email exists, a reset link has been sent." });
    }

    // Generate token
    const token = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = crypto.createHash("sha256").update(token).digest("hex");
    user.resetPasswordExpires = Date.now() + 60 * 60 * 1000; // 1 hour
    await user.save();

    const resetURL = `${process.env.CLIENT_URL || "https://wpleads.in"}/reset-password/${token}`;

    // Send email via the WPLeads SMTP relay (credentials in .env, not committed).
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === "true", // false for STARTTLS on 587
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || "WPleads Notifications <admin@wpleads.in>",
      to: user.email,
      subject: "Reset your WPLeads password",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#0f172a">Reset your password</h2>
          <p>Click the button below to reset your password. This link expires in <b>1 hour</b>.</p>
          <a href="${resetURL}" style="display:inline-block;padding:12px 24px;background:#0f172a;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">
            Reset Password
          </a>
          <p style="color:#64748b;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    res.json({ message: "If that email exists, a reset link has been sent." });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ message: "Failed to send reset email. Try again later." });
  }
};

// RESET PASSWORD
export const resetPassword = async (req, res) => {
  try {
    const hashedToken = crypto.createHash("sha256").update(req.params.token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: "Reset link is invalid or has expired." });
    }

    user.password = await bcrypt.hash(req.body.password, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: "Password reset successful. You can now log in." });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ message: "Server error. Try again later." });
  }
};

export const googleAuthSuccess = (req, res) => {
  if (req.user) {
    const token = generateToken(req.user._id);
    // Use localhost:3000 (React) or localhost:5173 (Vite) depending on what you use
    res.redirect(`https://wpleads.in/login-success?token=${token}`);
  } else {
    res.redirect("https://wpleads.in/login?error=auth_failed");
  }
};