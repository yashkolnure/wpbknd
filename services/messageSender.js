import axios from 'axios';
import WhatsApp from '../models/WhatsApp.js';
import { decrypt } from '../utils/encrypt.js';
import { buildMetaPayload } from './messageBuilder.js';

export const sendMessage = async (userId, to, message) => {
  const wa = await WhatsApp.findOne({ userId, isVerified: true });
  if (!wa) throw new Error('WhatsApp not connected for this user');

  const accessToken = decrypt(wa.encryptedToken);
  const payload     = buildMetaPayload(to, message);

  const response = await axios.post(
    `https://graph.facebook.com/v19.0/${wa.phoneNumberId}/messages`,
    payload,
    {
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  // ✅ extract wamid and return it alongside the raw response
  const metaMessageId = response.data?.messages?.[0]?.id || null;

  return { ...response.data, metaMessageId };
};