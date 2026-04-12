import User from "../models/User.js";
import bcrypt from "bcryptjs";
import { generateToken } from "../utils/generateToken.js";

// REGISTER

// REGISTER
export const register = async (req, res) => {
  try {
    let { name, email, password, phone } = req.body;

    // ✅ Basic validation
    if (!name || !email || !password || !phone) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // ✅ Clean phone (remove spaces, symbols)
    phone = phone.replace(/\D/g, "");

    // ✅ Normalize to +91
    if (!phone.startsWith("91")) {
      phone = "91" + phone;
    }
    phone = "+" + phone;

    // ✅ Validate phone
    if (!/^\+?[0-9]{10,15}$/.test(phone)) {
      return res.status(400).json({ message: "Invalid phone number" });
    }

    // ✅ Check existing user
    const userExists = await User.findOne({
      $or: [{ email }, { phone }]
    });

    if (userExists) {
      return res.status(400).json({
        message: "User already exists with email or phone"
      });
    }

    // ✅ Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      phone
    });

    // ❌ REMOVE PASSWORD FROM RESPONSE
    const userData = {
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone
    };

    res.status(201).json({
      success: true,
      user: userData,
      token: generateToken(user._id)
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
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