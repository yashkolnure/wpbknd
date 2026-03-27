import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: String,
    email: { type: String, unique: true },
    password: String,
    googleId: { type: String }, // New field for Google users
    avatar: { type: String },
    plan:          { type: String, enum: ["free", "pro"], default: "free" },
    planExpiresAt: { type: Date, default: null },
    planOrderId:   { type: String, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);