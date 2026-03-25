import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";

import publicRoutes from "./routes/public.routes.js";
import privateRoutes from "./routes/private.routes.js";
import whatsappRoutes from './routes/whatsappRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import workflowRoutes from './routes/workflowRoutes.js';
import contactRoutes from './routes/contactRoutes.js';
import chatRoutes from './routes/chatRoutes.js';

dotenv.config();

const app = express();

app.use(cors({ origin:  ['http://localhost:3000', 'http://wpleads.in', 'https://wpleads.in', 'http://localhost:5173']}));
app.use(express.json());

// Routes
app.use("/api", publicRoutes);
app.use("/api", privateRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api', webhookRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api', chatRoutes);

// DB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.log(err));

// Start
app.listen(5004, () => console.log("🚀 Server running"));