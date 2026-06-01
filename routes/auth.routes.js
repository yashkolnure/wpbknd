// routes/auth.route.js
import express from "express";
import { register, login, updateFCMToken, removeFCMToken, forgotPassword, resetPassword } from "../controllers/auth.controller.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password/:token", resetPassword);

// Protected routes: user must be logged in to add / remove a device token
router.patch("/fcm-token", protect, updateFCMToken);
router.delete("/fcm-token", protect, removeFCMToken);

export default router;