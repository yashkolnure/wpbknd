import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: String,
    // lowercase + trim so "Yash@Gmail.com" and "yash@gmail.com" are the SAME
    // account (Mongoose normalizes on save; queries are normalized in controllers).
    email: { type: String, unique: true, lowercase: true, trim: true },
    password: String,
    googleId: { type: String }, // New field for Google users
    avatar: { type: String },
    plan:          { type: String, enum: ["free", "pro"], default: "pro" },
    planExpiresAt: { type: Date, default: null },
    planOrderId:   { type: String, default: null },
    fcmTokens: [{ type: String }],
    phone: {
      type: String,
      sparse: true,
      unique: true
    },
    resetPasswordToken:   { type: String },
    resetPasswordExpires: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);