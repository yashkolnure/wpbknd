import User from "../models/User.js";
import bcrypt from "bcryptjs";
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
      phone: finalPhone
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

export const googleAuthSuccess = (req, res) => {
  if (req.user) {
    const token = generateToken(req.user._id);
    // Use localhost:3000 (React) or localhost:5173 (Vite) depending on what you use
    res.redirect(`https://wpleads.in/login-success?token=${token}`);
  } else {
    res.redirect("https://wpleads.in/login?error=auth_failed");
  }
};