// 1. MUST BE THE VERY FIRST LINE
import 'dotenv/config'; 

import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import passport from "passport";

// 2. Import Passport Config (Environment variables are now safely loaded)
import "./config/passport.js"; 

// 3. Import Controllers and Routes
import { googleAuthSuccess } from "./controllers/auth.controller.js";
import publicRoutes from "./routes/public.routes.js";
import privateRoutes from "./routes/private.routes.js";
import whatsappRoutes from './routes/whatsappRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import workflowRoutes from './routes/workflowRoutes.js';
import contactRoutes from './routes/contactRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import paymentRoutes from './routes/payments.js';
import admin from "firebase-admin";
import fs from "fs";
import path from "path";

const app = express();
// Load the JSON file manually because of ES Modules (import)
const serviceAccount = JSON.parse(
  fs.readFileSync(new URL("./serviceAccountKey.json", import.meta.url))
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log("🔥 Firebase Admin SDK initialized successfully");

// --- MIDDLEWARE ---
app.use(cors({ 
  origin: ['http://localhost:3000', 'http://localhost:5173', 'http://wpleads.in', 'https://wpleads.in'],
  credentials: true 
}));
app.use(express.json());
app.use(passport.initialize());

// --- GOOGLE AUTH ROUTES ---

/**
 * @route   GET /api/auth/google
 * @desc    Triggers the Google OAuth2 login flow
 */
app.get("/api/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

/**
 * @route   GET /api/auth/google/callback
 * @desc    Google redirects here after user authorization
 */
app.get(
  "/api/auth/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: "http://localhost:3000/login" }),
  googleAuthSuccess
);

// --- EXISTING APP ROUTES ---
app.use("/api", publicRoutes);
app.use("/api", privateRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api', webhookRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api', chatRoutes);
app.use('/api/payments', paymentRoutes);

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected & Environment Variables Loaded"))
  .catch(err => {
    console.error("❌ MongoDB connection error:");
    console.error(err);
  });

// --- SERVER START ---
const PORT = 5004;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔗 Google Auth URL: http://localhost:${PORT}/api/auth/google`);
});