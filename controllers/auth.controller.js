import User from "../models/User.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { generateToken } from "../utils/generateToken.js";

// REGISTER
// controllers/auth.controller.js

export const register = async (req, res) => {
  try {
    let { name, email, password, phone } = req.body;

    if (!name || !email || !password || !phone) {
      return res.status(400).json({ message: "All fields are required" });
    }

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
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user)
      return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });

    res.json({
      user,
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

// FORGOT PASSWORD
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
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

    const resetURL = `${process.env.CLIENT_URL || "http://localhost:3000"}/reset-password/${token}`;

    // Send email
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `"WPLeads" <${process.env.EMAIL_USER}>`,
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