import axios from 'axios';
import FormData from 'form-data';
import WhatsApp from '../models/WhatsApp.js';
import { decrypt } from '../utils/encrypt.js';
import { buildMetaPayload } from './messageBuilder.js';

const GRAPH = () => process.env.GRAPH_VERSION || 'v21.0';

// Sensible defaults per media format when the source URL has no content-type.
const FORMAT_DEFAULTS = {
  IMAGE:    { ctype: 'image/png',       name: 'header.png' },
  VIDEO:    { ctype: 'video/mp4',       name: 'header.mp4' },
  DOCUMENT: { ctype: 'application/pdf', name: 'header.pdf' },
};

// Cache of uploaded header media ids so a campaign of N messages uploads the
// image ONCE, not N times. Keyed by phoneNumberId + source URL.
const mediaIdCache = new Map(); // key → { id, ts }
const MEDIA_TTL_MS = 6 * 60 * 60 * 1000; // 6h

// Download a template's header media and (re)upload it to WhatsApp, returning a
// media id. Sending media-header templates by `link` fails with #131053 because
// Meta's send pipeline can't fetch the template's scontent CDN handle — uploading
// the bytes and sending by `id` is the reliable path.
const resolveHeaderMediaId = async (phoneNumberId, accessToken, srcUrl, format) => {
  const key = `${phoneNumberId}|${srcUrl}`;
  const hit = mediaIdCache.get(key);
  if (hit && Date.now() - hit.ts < MEDIA_TTL_MS) return hit.id;

  const def = FORMAT_DEFAULTS[(format || 'IMAGE').toUpperCase()] || FORMAT_DEFAULTS.IMAGE;

  // 1) download the media from its source URL
  const dl = await axios.get(srcUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const buf = Buffer.from(dl.data);
  const ctype = dl.headers['content-type'] || def.ctype;

  // 2) upload bytes to the WhatsApp media endpoint
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', buf, { filename: def.name, contentType: ctype });
  const up = await axios.post(
    `https://graph.facebook.com/${GRAPH()}/${phoneNumberId}/media`,
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${accessToken}` }, maxContentLength: Infinity, maxBodyLength: Infinity },
  );

  const id = up.data?.id;
  if (id) mediaIdCache.set(key, { id, ts: Date.now() });
  return id;
};

// Find a media HEADER component (IMAGE/VIDEO/DOCUMENT) on a template message.
const findMediaHeader = (message) => {
  if (message?.type !== 'template') return null;
  return (message.templateComponents || []).find(c =>
    (c.type || '').toUpperCase() === 'HEADER' &&
    ['IMAGE', 'VIDEO', 'DOCUMENT'].includes((c.format || '').toUpperCase())
  ) || null;
};

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

  // For media-header templates, upload the header image and send by media id.
  // (Cached, so a whole campaign uploads it once.) Falls back to link on error.
  let outgoing = message;
  const mediaHeader = findMediaHeader(message);
  if (mediaHeader && !message.headerMediaId) {
    const srcUrl = message.headerMediaUrl
      || mediaHeader.example?.header_url
      || (Array.isArray(mediaHeader.example?.header_handle) ? mediaHeader.example.header_handle[0] : null);
    if (srcUrl) {
      try {
        const mediaId = await resolveHeaderMediaId(wa.phoneNumberId, accessToken, srcUrl, mediaHeader.format);
        if (mediaId) outgoing = { ...message, headerMediaId: mediaId };
      } catch (e) {
        console.error(`⚠️ Header media upload failed (${mediaHeader.format}) — falling back to link, may fail with #131053:`, e.response?.data?.error?.message || e.message);
      }
    }
  }

  // ── Media messages: upload the file to WhatsApp and send by media id ─────────
  // Sending media by public `link` requires Meta's servers to fetch that URL,
  // which fails for locally-uploaded files (e.g. http://localhost:5002/uploads/…)
  // or any non-public host. Pushing the bytes to Meta and sending by id is
  // reliable regardless of whether the URL is publicly reachable. The server can
  // always read its own /uploads URL. Falls back to link on error.
  if (outgoing.type === 'media' && !outgoing.mediaId && outgoing.mediaUrl) {
    try {
      const fmt = (outgoing.mediaType || 'image').toUpperCase(); // IMAGE | VIDEO | DOCUMENT
      const mediaId = await resolveHeaderMediaId(wa.phoneNumberId, accessToken, outgoing.mediaUrl, fmt);
      if (mediaId) outgoing = { ...outgoing, mediaId };
    } catch (e) {
      console.error('⚠️ Media upload to Meta failed — falling back to link:', e.response?.data?.error?.message || e.message);
    }
  }

  const payload = buildMetaPayload(to, outgoing);

  const url = `https://graph.facebook.com/${GRAPH()}/${wa.phoneNumberId}/messages`;
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
