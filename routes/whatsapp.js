import express from "express";
import https from "https";
import { protect } from "../middleware/auth.js";
import WhatsApp from '../models/WhatsApp.js';
import { encrypt } from '../utils/encrypt.js';

const router = express.Router();

// ══════════════════════════════════════════════════════════════════════════════
// META API CLIENT
// ══════════════════════════════════════════════════════════════════════════════

const BASE = `https://graph.facebook.com/${process.env.GRAPH_VERSION || "v19.0"}`;
const sys    = () => process.env.SYSTEM_USER_TOKEN;
const appTok = () => process.env.APP_ACCESS_TOKEN;
const wabaId = () => process.env.WABA_ID;
const appId  = () => process.env.APP_ID;

// ── Meta error code → human-readable message map ──────────────────────────
const META_ERROR_MAP = {
  100:    "Invalid parameter or missing required field.",
  190:    "Access token is invalid or expired. Check your SYSTEM_USER_TOKEN.",
  200:    "Permission denied. Ensure your system user has whatsapp_business_management permission.",
  10:     "Permission denied. Check your app permissions.",
  133010: "Phone number is already registered on WhatsApp. Ask the user to delete their WhatsApp account first, wait 5–10 minutes, then retry.",
  133015: "Phone number re-registration is blocked for 24 hours. Please wait and try again tomorrow.",
  133016: "Too many registration attempts in a short time. Wait 24 hours before retrying.",
  133006: "Phone number verification code is incorrect or expired. Request a new OTP.",
  133008: "Phone number is already registered on WhatsApp Business Cloud API.",
  133009: "Phone number PIN is incorrect.",
  133012: "Phone number certificate is invalid.",
  133020: "Phone number is blocked from registration.",
  1:      "An unknown error occurred. Please try again.",
};

function getHumanError(code, fallbackMessage) {
  return META_ERROR_MAP[code] || fallbackMessage || "An unexpected error occurred.";
}

function metaRequest({ path, method = "GET", body = null, token }) {
  const url  = `${BASE}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(url, opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);

          if (parsed.error) {
            const code    = parsed.error.code;
            const subcode = parsed.error.error_subcode;
            const human   = getHumanError(subcode || code, parsed.error.message);

            console.error(`❌ Meta API Error [${code}${subcode ? "/" + subcode : ""}]:`, parsed.error.message);
            console.error("   Human message:", human);
            console.error("   Full error object:", JSON.stringify(parsed.error, null, 2));

            const err       = new Error(human);
            err.metaCode    = code;
            err.metaSubcode = subcode;
            err.metaRaw     = parsed.error;
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch (parseErr) {
          console.error("❌ Failed to parse Meta API response:", data);
          reject(new Error("Failed to parse Meta API response."));
        }
      });
    });

    req.on("error", (err) => {
      console.error("❌ Network error calling Meta API:", err.message);
      reject(new Error("Network error while calling Meta API. Check your internet connection."));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPER — standardised error response
// ══════════════════════════════════════════════════════════════════════════════

function sendError(res, err, context = "") {
  const message = err.message || "An unexpected error occurred.";
  const code    = err.metaCode    || null;
  const subcode = err.metaSubcode || null;

  console.error(`❌ [${context}] ${message}`, { code, subcode });

  // Determine retry guidance
  let retryAfter = null;
  if ([133015, 133016].includes(subcode || code)) retryAfter = "24 hours";
  if ([133010].includes(subcode || code))          retryAfter = "5–10 minutes after deleting WhatsApp account";

  return res.status(500).json({
    error:      message,
    code,
    subcode,
    retryAfter,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── GET All Phone Numbers ──────────────────────────────────────────────────

router.get("/numbers", protect, async (req, res) => {
  console.log("📋 Fetching all WABA phone numbers...");
  try {
    const data = await metaRequest({
      path:  `/${wabaId()}/phone_numbers?fields=id,display_phone_number,verified_name,status,quality_rating`,
      token: sys(),
    });
    console.log(`✅ Found ${data.data?.length || 0} numbers`);
    res.json({ success: true, numbers: data.data });
  } catch (err) {
    sendError(res, err, "GET /numbers");
  }
});

// ── ADD NEW PHONE NUMBER ───────────────────────────────────────────────────

router.post("/numbers/add", protect, async (req, res) => {
  const { countryCode, phoneNumber, verifiedName } = req.body;

  if (!countryCode || !phoneNumber || !verifiedName) {
    return res.status(400).json({ error: "countryCode, phoneNumber, and verifiedName are required." });
  }
  if (!/^\d+$/.test(countryCode)) {
    return res.status(400).json({ error: "countryCode must be digits only (e.g. 91 for India)." });
  }
  if (!/^\d+$/.test(phoneNumber)) {
    return res.status(400).json({ error: "phoneNumber must be digits only, without country code or spaces." });
  }

  try {
    // ── Check if number was already added in a previous attempt ───────────
    const existing = await WhatsApp.findOne({ userId: req.user._id, isVerified: true });

    if (existing?.phoneNumberId) {
      console.log("⚠️ Number already added in a prior attempt, reusing phoneNumberId:", existing.phoneNumberId);
      return res.json({
        success:            true,
        phoneNumberId:      existing.phoneNumberId,
        displayPhoneNumber: existing.displayPhoneNumber,
        resumed:            true,   // frontend can use this to skip straight to OTP step
      });
    }
    // ──────────────────────────────────────────────────────────────────────

    const data = await metaRequest({
      path:   `/${wabaId()}/phone_numbers`,
      method: "POST",
      token:  sys(),
      body: {
        cc:                   countryCode,
        phone_number:         phoneNumber,
        verified_name:        verifiedName,
        migrate_phone_number: false,
      },
    });

    console.log("✅ Number added successfully:", data.id);

    const encryptedToken = encrypt(sys());

    await WhatsApp.findOneAndUpdate(
      { userId: req.user._id },
      {
        phoneNumberId:      data.id,
        wabaId:             wabaId(),
        encryptedToken,
        displayPhoneNumber: data.display_phone_number,
        verifiedName,
        isVerified:         true,
        connectedAt:        new Date(),
      },
      { upsert: true, new: true }
    );

    console.log("✅ Saved to DB for user:", req.user._id);

    res.json({
      success:            true,
      phoneNumberId:      data.id,
      displayPhoneNumber: data.display_phone_number,
      resumed:            false,
    });
  } catch (err) {
    if ([133015, 133016].includes(err.metaCode || err.metaSubcode)) {
      return res.status(409).json({
        error:      err.error_user_msg || "This phone number is already registered on WhatsApp.",
        code:       err.metaCode,
        resolution: "The user must open WhatsApp → Settings → Account → Delete Account, wait 5–10 minutes, then retry.",
        retryAfter: "5–10 minutes",
      });
    }
    sendError(res, err, "POST /numbers/add");
  }
});

// ── REQUEST OTP ────────────────────────────────────────────────────────────

router.post("/numbers/request-otp", protect, async (req, res) => {
  const { phoneNumberId, method = "SMS" } = req.body;
  console.log("📨 Requesting OTP:", { phoneNumberId, method });

  if (!phoneNumberId) {
    return res.status(400).json({ error: "phoneNumberId is required." });
  }
  if (!["SMS", "VOICE"].includes(method)) {
    return res.status(400).json({ error: "method must be SMS or VOICE." });
  }

  try {
    await metaRequest({
      path:   `/${phoneNumberId}/request_code`,
      method: "POST",
      token:  sys(),
      body:   { code_method: method, language: "en_US" },
    });

    console.log(`✅ OTP sent via ${method} to phoneNumberId: ${phoneNumberId}`);
    res.json({ success: true, message: `OTP sent via ${method}. It expires in 10 minutes.` });
  } catch (err) {
    sendError(res, err, "POST /numbers/request-otp");
  }
});

// ── VERIFY OTP ─────────────────────────────────────────────────────────────

router.post("/numbers/verify-otp", protect, async (req, res) => {
  const { phoneNumberId, code } = req.body;
  console.log("🔐 Verifying OTP:", { phoneNumberId, code });

  if (!phoneNumberId || !code) {
    return res.status(400).json({ error: "phoneNumberId and code are required." });
  }

  const parsedCode = parseInt(code, 10);
  if (isNaN(parsedCode)) {
    return res.status(400).json({ error: "code must be a number." });
  }

  try {
    await metaRequest({
      path:   `/${phoneNumberId}/verify_code`,
      method: "POST",
      token:  sys(),
      body:   { code: parsedCode },
    });

    console.log("✅ OTP verified for phoneNumberId:", phoneNumberId);
    res.json({ success: true, message: "OTP verified successfully." });
  } catch (err) {
    if ([133006].includes(err.metaCode || err.metaSubcode)) {
      return res.status(400).json({
        error:      "Incorrect or expired OTP. Please request a new one.",
        code:       err.metaCode,
        resolution: "Click 'Resend Code' to get a fresh OTP.",
      });
    }
    sendError(res, err, "POST /numbers/verify-otp");
  }
});

// ── REGISTER NUMBER + AUTO-CONFIGURE WEBHOOKS ──────────────────────────────

router.post("/numbers/register", protect, async (req, res) => {
  const { phoneNumberId, pin } = req.body;
  console.log("📝 Registering number:", { phoneNumberId, pin: "******" });

  if (!phoneNumberId || !pin) {
    return res.status(400).json({ error: "phoneNumberId and pin are required." });
  }
  if (!/^\d{6}$/.test(pin)) {
    return res.status(400).json({ error: "pin must be exactly 6 digits." });
  }

  try {
    // 1. Register number on WhatsApp Cloud API
    console.log("   Step 1/3: Registering number with Meta...");
    await metaRequest({
      path:   `/${phoneNumberId}/register`,
      method: "POST",
      token:  sys(),
      body:   { messaging_product: "whatsapp", pin },
    });
    console.log("   ✅ Number registered");

    // 2. Register Webhook on App
    console.log("   Step 2/3: Registering webhook subscription on App...");
    const fields = ["messages"];
    await metaRequest({
      path:   `/${appId()}/subscriptions`,
      method: "POST",
      token:  appTok(),
      body: {
        object:        "whatsapp_business_account",
        callback_url:  process.env.CALLBACK_URL,
        verify_token:  process.env.VERIFY_TOKEN,
        fields:        fields.join(","),
        include_values: true,
        active:        true,
      },
    });
    console.log("   ✅ App webhook subscription registered");

    // 3. Subscribe App to WABA
    console.log("   Step 3/3: Subscribing App to WABA...");
    await metaRequest({
      path:   `/${wabaId()}/subscribed_apps`,
      method: "POST",
      token:  sys(),
      body:   { subscribed_fields: fields },
    });
    console.log("   ✅ App subscribed to WABA");

    console.log("🎉 Number fully registered and webhooks configured:", phoneNumberId);
    res.json({
      success: true,
      message: "Number registered and webhooks configured successfully.",
    });
  } catch (err) {
    if ([133015, 133016].includes(err.metaCode || err.metaSubcode)) {
      return res.status(429).json({
        error:      err.message,
        code:       err.metaCode,
        resolution: "Wait 24 hours before attempting registration again.",
        retryAfter: "24 hours",
      });
    }
    if ([133009].includes(err.metaCode || err.metaSubcode)) {
      return res.status(400).json({
        error:      "Incorrect PIN. Please enter the correct 6-digit PIN.",
        code:       err.metaCode,
        resolution: "Enter the correct PIN you set during a previous registration, or contact Meta support.",
      });
    }
    sendError(res, err, "POST /numbers/register");
  }
});

// ── GET WEBHOOK STATUS ─────────────────────────────────────────────────────

router.get("/webhook/status", protect, async (req, res) => {
  console.log("🔗 Fetching webhook status...");
  try {
    const data = await metaRequest({
      path:  `/${appId()}/subscriptions?object=whatsapp_business_account`,
      token: appTok(),
    });
    console.log("✅ Webhook subscriptions fetched:", data.data?.length || 0);
    res.json({ success: true, subscriptions: data.data || [] });
  } catch (err) {
    sendError(res, err, "GET /webhook/status");
  }
});

// ── SYNC WEBHOOKS MANUALLY ─────────────────────────────────────────────────

router.post("/webhook/register", protect, async (req, res) => {
  console.log("🔄 Syncing webhooks manually...");
  try {
    const fields = ["messages", "message_deliveries", "message_reads"];

    await metaRequest({
      path:   `/${appId()}/subscriptions`,
      method: "POST",
      token:  appTok(),
      body: {
        object:         "whatsapp_business_account",
        callback_url:   process.env.CALLBACK_URL,
        verify_token:   process.env.VERIFY_TOKEN,
        fields:         fields.join(","),
        include_values: true,
        active:         true,
      },
    });

    await metaRequest({
      path:   `/${wabaId()}/subscribed_apps`,
      method: "POST",
      token:  sys(),
      body:   { subscribed_fields: fields },
    });

    console.log("✅ Webhooks synced successfully");
    res.json({ success: true, message: "Webhooks synced successfully." });
  } catch (err) {
    sendError(res, err, "POST /webhook/register");
  }
});

// ── WEBHOOK VERIFICATION (GET) ─────────────────────────────────────────────

router.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully");
    return res.status(200).send(challenge);
  }

  console.warn("❌ Webhook verification failed — token mismatch");
  res.sendStatus(403);
});

// ── WEBHOOK INCOMING EVENTS (POST) ────────────────────────────────────────

router.post("/webhook", (req, res) => {
  res.sendStatus(200); // Always respond 200 immediately

  const body = req.body;
  if (body.object !== "whatsapp_business_account") return;

  console.log("📨 Incoming Webhook Event:", JSON.stringify(body, null, 2));

  try {
    body.entry?.forEach((entry) => {
      entry.changes?.forEach((change) => {
        if (change.field !== "messages") return;

        const value = change.value;

        if (value.messages) {
          value.messages.forEach((message) => {
            console.log(`📩 New message from ${message.from}:`, message.text?.body || `[${message.type}]`);
            // TODO: Save to DB, trigger workflows, auto-reply, etc.
          });
        }

        if (value.statuses) {
          value.statuses.forEach((status) => {
            console.log(`✓ Message ${status.id} status: ${status.status}`);
          });
        }
      });
    });
  } catch (err) {
    console.error("❌ Error processing webhook event:", err.message);
  }
});

// ── SEND MESSAGE ───────────────────────────────────────────────────────────

router.post("/send", protect, async (req, res) => {
  const { phoneNumberId, to, message } = req.body;
  console.log("📤 Sending message:", { phoneNumberId, to, preview: message?.slice(0, 30) });

  if (!phoneNumberId || !to || !message) {
    return res.status(400).json({ error: "phoneNumberId, to, and message are required." });
  }
  if (!/^\d+$/.test(to)) {
    return res.status(400).json({ error: "to must be digits only with country code, e.g. 919876543210." });
  }

  try {
    const data = await metaRequest({
      path:   `/${phoneNumberId}/messages`,
      method: "POST",
      token:  sys(),
      body: {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message },
      },
    });

    console.log("✅ Message sent, ID:", data.messages?.[0]?.id);
    res.json({ success: true, messageId: data.messages?.[0]?.id });
  } catch (err) {
    sendError(res, err, "POST /send");
  }
});

export default router;