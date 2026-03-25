import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: String,
    email: { type: String, unique: true },
    password: String,
    googleId: { type: String }, // New field for Google users
    avatar: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);