import WhatsApp from '../models/WhatsApp.js';
import { encrypt, decrypt } from '../utils/encrypt.js';
import axios from 'axios';

// GET /api/whatsapp/onboarding — fetch saved wizard progress
export const getOnboardingProgress = async (req, res) => {
  try {
    const wa = await WhatsApp.findOne({ userId: req.user._id });
    if (!wa?.onboarding || wa.onboarding.status === 'completed') {
      return res.json({ progress: null });
    }
    res.json({ progress: wa.onboarding });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/whatsapp/onboarding — save wizard progress
export const saveOnboardingProgress = async (req, res) => {
  try {
    const { step, phoneNumberId, countryCode, phoneNumber, verifiedName, otpMethod } = req.body;
    await WhatsApp.findOneAndUpdate(
      { userId: req.user._id },
      {
        $set: {
          'onboarding.step':          step,
          'onboarding.phoneNumberId': phoneNumberId || null,
          'onboarding.countryCode':   countryCode,
          'onboarding.phoneNumber':   phoneNumber,
          'onboarding.verifiedName':  verifiedName,
          'onboarding.otpMethod':     otpMethod || 'SMS',
          'onboarding.status':        'in_progress',
          'onboarding.updatedAt':     new Date(),
        }
      },
      { upsert: true, new: true }
    );
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/whatsapp/onboarding — clear progress after completion
export const clearOnboardingProgress = async (req, res) => {
  try {
    await WhatsApp.findOneAndUpdate(
      { userId: req.user._id },
      { $set: { 'onboarding.status': 'completed', 'onboarding.step': 1 } }
    );
    res.json({ cleared: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


export const connect = async (req, res) => {
  try {
    const { phoneNumberId, wabaId, accessToken } = req.body;

    if (!phoneNumberId || !wabaId || !accessToken) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const metaRes = await axios.get(
      `https://graph.facebook.com/v19.0/${phoneNumberId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!metaRes.data?.id) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const encryptedToken = encrypt(accessToken);

    const wa = await WhatsApp.findOneAndUpdate(
      { userId: req.user._id },
      { phoneNumberId, wabaId, encryptedToken, isVerified: true, connectedAt: new Date(), connectionType: 'own' },
      { upsert: true, new: true }
    );

    res.json({ message: 'WhatsApp connected successfully', isVerified: wa.isVerified });
  } catch (err) {
    if (err.response?.status === 401) {
      return res.status(401).json({ message: 'Meta rejected the credentials' });
    }
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

export const getStatus = async (req, res) => {
  try {
    const wa = await WhatsApp.findOne({ userId: req.user._id });
    if (!wa) return res.json({ connected: false });

    res.json({
      connected:      true,
      isVerified:     wa.isVerified,
      phoneNumberId:  wa.phoneNumberId,
      wabaId:         wa.wabaId,
      connectedAt:    wa.connectedAt,
      connectionType: wa.connectionType || 'own',
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

export const disconnect = async (req, res) => {
  try {
    await WhatsApp.findOneAndDelete({ userId: req.user._id });
    res.json({ message: 'Disconnected successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// POST /api/whatsapp/numbers/add
// Adds a phone number to the connected WABA via Meta Graph API
// Uses platform SYSTEM_USER_TOKEN + WABA_ID (this wizard is for platform-managed numbers)
export const addPhoneNumber = async (req, res) => {
  try {
    const { countryCode, phoneNumber, verifiedName } = req.body;
    if (!countryCode || !phoneNumber || !verifiedName) {
      return res.status(400).json({ message: 'countryCode, phoneNumber and verifiedName are required' });
    }

    const token  = process.env.SYSTEM_USER_TOKEN;
    const wabaId = process.env.WABA_ID;
    if (!token || !wabaId) {
      return res.status(500).json({ message: 'Platform WhatsApp credentials not configured' });
    }

    const metaRes = await axios.post(
      `https://graph.facebook.com/v19.0/${wabaId}/phone_numbers`,
      {
        cc: countryCode,
        phone_number: phoneNumber,
        verified_name: verifiedName,
        migrate_from_another_bsp: false,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ success: true, phoneNumberId: metaRes.data.id, data: metaRes.data });
  } catch (err) {
    const metaErr = err.response?.data?.error;
    res.status(err.response?.status || 500).json({
      message: metaErr?.message || err.message,
      code: metaErr?.code,
    });
  }
};

// POST /api/whatsapp/numbers/request-otp
// Requests OTP via SMS or VOICE for a pending phone number
export const requestOtp = async (req, res) => {
  try {
    const { phoneNumberId, method } = req.body;
    if (!phoneNumberId || !method) {
      return res.status(400).json({ message: 'phoneNumberId and method (SMS|VOICE) are required' });
    }

    const token = process.env.SYSTEM_USER_TOKEN;
    if (!token) return res.status(500).json({ message: 'Platform credentials not configured' });

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/request_code`,
      { code_method: method, language: 'en_US' },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ success: true, message: `OTP sent via ${method}` });
  } catch (err) {
    const metaErr = err.response?.data?.error;
    res.status(err.response?.status || 500).json({
      message: metaErr?.message || err.message,
      code: metaErr?.code,
    });
  }
};

// POST /api/whatsapp/numbers/verify-otp
// Verifies the OTP received on the phone
export const verifyOtp = async (req, res) => {
  try {
    const { phoneNumberId, code } = req.body;
    if (!phoneNumberId || !code) {
      return res.status(400).json({ message: 'phoneNumberId and code are required' });
    }

    const token = process.env.SYSTEM_USER_TOKEN;
    if (!token) return res.status(500).json({ message: 'Platform credentials not configured' });

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/verify_code`,
      { code },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ success: true, message: 'Phone number verified' });
  } catch (err) {
    const metaErr = err.response?.data?.error;
    res.status(err.response?.status || 500).json({
      message: metaErr?.message || err.message,
      code: metaErr?.code,
    });
  }
};

// POST /api/whatsapp/numbers/register
// Registers the verified number with WhatsApp (sets 2FA PIN)
export const registerPhoneNumber = async (req, res) => {
  try {
    const { phoneNumberId, pin } = req.body;
    if (!phoneNumberId || !pin) {
      return res.status(400).json({ message: 'phoneNumberId and pin are required' });
    }

    const token = process.env.SYSTEM_USER_TOKEN;
    if (!token) return res.status(500).json({ message: 'Platform credentials not configured' });

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/register`,
      { messaging_product: 'whatsapp', pin },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Mark as platform-managed and store their phoneNumberId
    await WhatsApp.findOneAndUpdate(
      { userId: req.user._id },
      { connectionType: 'platform', phoneNumberId, wabaId: process.env.WABA_ID, isVerified: true, connectedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Phone number registered successfully' });
  } catch (err) {
    const metaErr = err.response?.data?.error;
    res.status(err.response?.status || 500).json({
      message: metaErr?.message || err.message,
      code: metaErr?.code,
    });
  }
};

// POST /api/whatsapp/embedded-connect
// Called after user completes the Facebook Embedded Signup popup.
// As a Tech Provider, our SYSTEM_USER_TOKEN already has access to the user's WABA
// after Embedded Signup — no code exchange needed. We subscribe the WABA to our
// webhook and store the WABA/phone credentials.
export const embeddedConnect = async (req, res) => {
  try {
    const { wabaId, phoneNumberId } = req.body;
    if (!wabaId || !phoneNumberId) {
      return res.status(400).json({ message: 'wabaId and phoneNumberId are required' });
    }

    const systemToken = process.env.SYSTEM_USER_TOKEN;
    if (!systemToken) {
      return res.status(500).json({ message: 'Platform credentials not configured on server' });
    }

    // Subscribe app to this WABA so webhooks flow to wpleads.in/api/webhook
    await axios.post(
      `https://graph.facebook.com/v19.0/${wabaId}/subscribed_apps`,
      {},
      { headers: { Authorization: `Bearer ${systemToken}` } }
    ).catch(() => {}); // non-fatal

    // Verify our system token can access this phone number (confirms ES completed)
    const metaRes = await axios.get(
      `https://graph.facebook.com/v19.0/${phoneNumberId}`,
      { headers: { Authorization: `Bearer ${systemToken}` } }
    );
    if (!metaRes.data?.id) {
      return res.status(401).json({ message: 'Could not access this WhatsApp number. Please complete the Facebook signup again.' });
    }

    // Store with system token — same as platform users but with their own WABA/phone
    const encryptedToken = encrypt(systemToken);
    const wa = await WhatsApp.findOneAndUpdate(
      { userId: req.user._id },
      { phoneNumberId, wabaId, encryptedToken, isVerified: true,
        connectedAt: new Date(), connectionType: 'own' },
      { upsert: true, new: true }
    );

    res.json({
      connected:      true,
      message:        'WhatsApp connected successfully',
      isVerified:     wa.isVerified,
      connectionType: 'own',
      phoneNumberId,
      wabaId,
      connectedAt:    wa.connectedAt,
    });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(err.response?.status || 500).json({ message: msg });
  }
};