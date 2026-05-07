// routes/auth.route.js
import express from "express";
import { register, login, updateFCMToken } from "../controllers/auth.controller.js";
import { protect } from "../middleware/auth.middleware.js"; // Assuming this is your JWT middleware

const router = express.Router();

router.post("/register", register);
router.post("/login", login);

// Protected route: user must be logged in to save a token
router.patch("/fcm-token", protect, updateFCMToken);

export default router;