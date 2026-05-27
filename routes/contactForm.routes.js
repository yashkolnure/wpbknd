import express from "express";
import nodemailer from "nodemailer";
import ContactMessage from "../models/ContactMessage.js";

const router = express.Router();

router.post("/", async (req, res) => {
  const { name, email, phone, message } = req.body;

  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return res.status(400).json({ message: "Name, email, and message are required." });
  }

  try {
    // 1. Save to DB
    await ContactMessage.create({ name, email, phone, message });

    // 2. Send email notification
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `"WPLeads Contact Form" <${process.env.EMAIL_USER}>`,
      to: "admin@avenirya.com",
      replyTo: email,
      subject: `New Contact Form Submission — ${name}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
          <div style="background:#0f172a;padding:20px 28px">
            <h2 style="color:#fff;margin:0;font-size:18px">New Contact Form Submission</h2>
          </div>
          <div style="padding:28px">
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:8px 0;color:#64748b;font-weight:600;width:110px">Name</td><td style="padding:8px 0;color:#0f172a;font-weight:700">${name}</td></tr>
              <tr><td style="padding:8px 0;color:#64748b;font-weight:600">Email</td><td style="padding:8px 0"><a href="mailto:${email}" style="color:#25d366">${email}</a></td></tr>
              <tr><td style="padding:8px 0;color:#64748b;font-weight:600">Phone</td><td style="padding:8px 0;color:#0f172a">${phone || "—"}</td></tr>
              <tr><td style="padding:8px 0;color:#64748b;font-weight:600;vertical-align:top">Message</td><td style="padding:8px 0;color:#0f172a;line-height:1.6">${message.replace(/\n/g, "<br>")}</td></tr>
            </table>
          </div>
        </div>
      `,
    });

    res.json({ message: "Message sent successfully." });
  } catch (err) {
    console.error("Contact form error:", err);
    res.status(500).json({ message: "Failed to send message. Please try again." });
  }
});

export default router;
