import axios from 'axios';
import WhatsApp from '../models/WhatsApp.js';
import { decrypt } from '../utils/encrypt.js';
import { buildMetaPayload } from './messageBuilder.js';

export const sendMessage = async (userId, to, message) => {
    console.log('Preparing to send message. User ID:', userId, 'To:', to, 'Message:', message);
  // Get user's WA credentials
  const wa = await WhatsApp.findOne({ userId, isVerified: true });
  console.log('WhatsApp credentials found for user:', userId, wa ? 'Yes' : 'No');
  if (!wa) throw new Error('WhatsApp not connected for this user');

  const accessToken = decrypt(wa.encryptedToken);
  console.log('Decrypted access token for user:', userId, 'Token starts with:', accessToken.slice(0, 10));
  const payload     = buildMetaPayload(to, message);
console.log('Built message payload:', JSON.stringify(payload).slice(0, 200));
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
  console.log('Message sent response:', response.data);
  console.log('paload', payload);

  return response.data;
};