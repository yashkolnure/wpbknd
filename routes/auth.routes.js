import express from "express";
import passport from "passport";
import { register, login, googleAuthSuccess } from "../controllers/auth.controller.js";
import "../config/passport.js"; // Import the config we just made

const router = express.Router();

router.post("/register", register);
router.post("/login", login);

// Start Google Login
router.get("/google", passport.authenticate("google", { scope: ["profile", "email"] }));

// Google Callback
router.get(
  "/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: "/login" }),
  googleAuthSuccess // We will write this controller next
);

export default router;