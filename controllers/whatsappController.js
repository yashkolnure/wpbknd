import WhatsApp from '../models/WhatsApp.js';
import { encrypt, decrypt } from '../utils/encrypt.js';
import axios from 'axios';

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
      { phoneNumberId, wabaId, encryptedToken, isVerified: true, connectedAt: new Date() },
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
      connected: true,
      isVerified: wa.isVerified,
      phoneNumberId: wa.phoneNumberId,
      wabaId: wa.wabaId,
      connectedAt: wa.connectedAt,
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