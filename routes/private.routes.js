import express from "express";
import { protect } from "../middleware/auth.js";
import { superAdmin } from "../middleware/superAdmin.js";
import {
  getAllUsersData,
  getAdminStats,
  getUserDetail,
  creditUserWallet,
  setUserPassword,
  impersonateUser,
  updateUserPlan,
} from '../controllers/adminController.js';

const router = express.Router();

// GET CURRENT USER
router.get("/user/me", protect, async (req, res) => {
  res.json(req.user);
});

// Lets the client confirm the logged-in user is a super admin (gates the UI).
router.get("/admin/whoami", protect, superAdmin, (req, res) => {
  res.json({ superAdmin: true, name: req.user.name, email: req.user.email });
});

// ── Super Admin (all gated by protect + superAdmin) ─────────────────────────
router.get('/admin/stats',                  protect, superAdmin, getAdminStats);
router.get('/admin/users',                  protect, superAdmin, getAllUsersData);
router.get('/admin/users/:id',              protect, superAdmin, getUserDetail);
router.post('/admin/users/:id/credit',      protect, superAdmin, creditUserWallet);
router.post('/admin/users/:id/password',    protect, superAdmin, setUserPassword);
router.post('/admin/users/:id/impersonate', protect, superAdmin, impersonateUser);
router.patch('/admin/users/:id/plan',       protect, superAdmin, updateUserPlan);
// FCM token routes live in auth.routes.js (mounted at /api/auth/fcm-token).

export default router;