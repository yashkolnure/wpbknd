import express from "express";
import { protect } from "../middleware/auth.js";

const router = express.Router();

// GET CURRENT USER
router.get("/user/me", protect, async (req, res) => {
  res.json(req.user);
});

export default router;