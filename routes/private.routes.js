import express from "express";
import { protect } from "../middleware/auth.js";
import { getAllUsersData } from '../controllers/adminController.js';

const router = express.Router();

// GET CURRENT USER
router.get("/user/me", protect, async (req, res) => {
  res.json(req.user);
});


router.get('/admin/users', protect, getAllUsersData);
// FCM token routes live in auth.routes.js (mounted at /api/auth/fcm-token).

export default router;