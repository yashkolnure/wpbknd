import axios from 'axios';
import WhatsApp from '../models/WhatsApp.js';
import { decrypt } from '../utils/encrypt.js';
import { buildMetaPayload } from './messageBuilder.js';

export const sendMessage = async (userId, to, message) => {
  const wa = await WhatsApp.findOne({ userId, isVerified: true });
  if (!wa) throw new Error('WhatsApp not connected for this user');

  // Billing is always charged to the WABA that owns the phone number — NOT based on which token is used.
  // Platform users  → phoneNumberId belongs to WPLeads' WABA → Meta bills WPLeads' payment method
  // Own/Embedded    → phoneNumberId belongs to user's own WABA → Meta bills user's own Meta account
  // NO credit line sharing — each account pays via its own respective Meta payment method.
  const accessToken = (wa.connectionType === 'platform')
    ? process.env.SYSTEM_USER_TOKEN
    : decrypt(wa.encryptedToken);

  if (!accessToken) throw new Error('No access token available for this account');

  const payload = buildMetaPayload(to, message);

  const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v21.0'}/${wa.phoneNumberId}/messages`;
  console.log(`\n📤 [Meta API] POST ${url}`);
  console.log(`📦 Payload:`, JSON.stringify(payload, null, 2));

  let response;
  try {
    response = await axios.post(url, payload, {
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`✅ [Meta API] Response (${response.status}):`, JSON.stringify(response.data, null, 2));
  } catch (err) {
    console.error(`❌ [Meta API] Error (${err.response?.status}):`, JSON.stringify(err.response?.data, null, 2));
    throw err;
  }

  // ✅ extract wamid and return it alongside the raw response
  const metaMessageId = response.data?.messages?.[0]?.id || null;

  return { ...response.data, metaMessageId };
};