import express from "express";
import { protect } from "../middleware/auth.js";
import { updateFCMToken } from "../controllers/auth.controller.js";

const router = express.Router();

// GET CURRENT USER
router.get("/user/me", protect, async (req, res) => {
  res.json(req.user);
});

router.patch("/auth/fcm-token", protect, updateFCMToken);

export default router;