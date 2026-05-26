import axios from 'axios';
import WhatsApp from '../models/WhatsApp.js';
import Template from '../models/Template.js';
import { decrypt } from '../utils/encrypt.js';

const getWaCreds = async (userId) => {
  const wa = await WhatsApp.findOne({ userId, isVerified: true });
  if (!wa) throw new Error('WhatsApp not connected');
  return {
    token:          decrypt(wa.encryptedToken),
    wabaId:         wa.wabaId,
    phoneNumberId:  wa.phoneNumberId,
    connectionType: wa.connectionType || 'own',
  };
};

// GET /api/templates
// Returns only templates this user created through WPLeads,
// with live status synced from Meta.
export const listTemplates = async (req, res) => {
  try {
    const userTemplates = await Template.find({ userId: req.user._id }).sort('-createdAt');
    if (userTemplates.length === 0) return res.json([]);

    // Platform users share a WABA — return DB values only (no Meta sync, would pollute with other users' templates)
    const { token, wabaId, connectionType } = await getWaCreds(req.user._id);
    if (connectionType === 'platform') {
      return res.json(userTemplates.map(t => t.toObject()));
    }

    // Fetch live status from Meta in one call (filter by name list)
    const nameSet = new Set(userTemplates.map(t => t.name));

    let metaMap = {};
    try {
      const metaRes = await axios.get(
        `https://graph.facebook.com/v19.0/${wabaId}/message_templates`,
        {
          params: { fields: 'id,name,status,category,language,components', limit: 200 },
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      for (const t of (metaRes.data.data || [])) {
        if (nameSet.has(t.name)) metaMap[t.name] = t;
      }
    } catch (_) {
      // Meta unreachable — return DB data as-is
    }

    // Merge: DB record wins for ownership; Meta wins for live status/components
    const merged = userTemplates.map(t => {
      const live = metaMap[t.name];
      if (live) {
        // Update status in DB (non-blocking)
        if (live.status !== t.status) {
          Template.findByIdAndUpdate(t._id, { status: live.status, components: live.components }).catch(() => {});
        }
        return { ...t.toObject(), status: live.status, components: live.components };
      }
      return t.toObject();
    });

    res.json(merged);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ message: msg });
  }
};

// POST /api/templates
export const createTemplate = async (req, res) => {
  try {
    const { token, wabaId } = await getWaCreds(req.user._id);
    const { name, category, language, header, body, footer, buttons } = req.body;

    if (!name || !category || !language || !body) {
      return res.status(400).json({ message: 'name, category, language and body are required' });
    }

    const safeName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    const components = [];
    if (header?.trim()) components.push({ type: 'HEADER', format: 'TEXT', text: header.trim() });
    components.push({ type: 'BODY', text: body.trim() });
    if (footer?.trim()) components.push({ type: 'FOOTER', text: footer.trim() });
    if (buttons?.length > 0) {
      components.push({
        type: 'BUTTONS',
        buttons: buttons.map(b => ({
          type: b.type || 'QUICK_REPLY',
          text: b.text,
          ...(b.type === 'URL'          ? { url: b.url }                : {}),
          ...(b.type === 'PHONE_NUMBER' ? { phone_number: b.phone }     : {}),
        })),
      });
    }

    const metaRes = await axios.post(
      `https://graph.facebook.com/v19.0/${wabaId}/message_templates`,
      { name: safeName, language, category, components },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    // Save to DB so this user's template list stays isolated
    const saved = await Template.findOneAndUpdate(
      { userId: req.user._id, name: safeName },
      { userId: req.user._id, name: safeName, metaId: metaRes.data.id, category, language, components, status: 'PENDING' },
      { upsert: true, new: true }
    );

    res.json({ success: true, template: { ...saved.toObject(), ...metaRes.data } });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(400).json({ message: msg });
  }
};

// POST /api/templates/sync  — import all Meta templates into this user's DB
// Only available for 'own' account users (platform users share a WABA so sync would pull everyone's templates)
export const syncTemplates = async (req, res) => {
  try {
    const { token, wabaId, connectionType } = await getWaCreds(req.user._id);

    if (connectionType === 'platform') {
      return res.status(403).json({
        message: 'Import from Meta is not available for platform-managed numbers. Templates you create here are already saved automatically.',
      });
    }
    const metaRes = await axios.get(
      `https://graph.facebook.com/v19.0/${wabaId}/message_templates`,
      {
        params: { fields: 'id,name,status,category,language,components', limit: 200 },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const templates = metaRes.data.data || [];
    let imported = 0;

    for (const t of templates) {
      await Template.findOneAndUpdate(
        { userId: req.user._id, name: t.name },
        { userId: req.user._id, name: t.name, metaId: t.id, category: t.category, language: t.language, components: t.components, status: t.status },
        { upsert: true }
      );
      imported++;
    }

    res.json({ success: true, imported });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ message: msg });
  }
};

// DELETE /api/templates/:name
export const deleteTemplate = async (req, res) => {
  try {
    const { token, wabaId } = await getWaCreds(req.user._id);

    // Only allow deleting templates owned by this user
    const owned = await Template.findOne({ userId: req.user._id, name: req.params.name });
    if (!owned) return res.status(403).json({ message: 'Template not found or not owned by you' });

    await axios.delete(
      `https://graph.facebook.com/v19.0/${wabaId}/message_templates`,
      { params: { name: req.params.name }, headers: { Authorization: `Bearer ${token}` } }
    );

    await Template.deleteOne({ _id: owned._id });

    res.json({ success: true });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(400).json({ message: msg });
  }
};
