import axios from 'axios';
import WhatsApp from '../models/WhatsApp.js';
import ShopCatalog from '../models/ShopCatalog.js';
import { decrypt } from '../utils/encrypt.js';

const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v21.0'}`;

// ── Helpers ─────────────────────────────────────────────────────────────────────
const getWaAndToken = async (userId) => {
  const wa = await WhatsApp.findOne({ userId, isVerified: true });
  if (!wa) throw new Error('WhatsApp not connected. Please connect WhatsApp first.');
  const token = (wa.connectionType === 'platform')
    ? process.env.SYSTEM_USER_TOKEN
    : decrypt(wa.encryptedToken);
  const wabaId = (wa.connectionType === 'platform') ? process.env.WABA_ID : wa.wabaId;
  return { wa, token, wabaId };
};

const metaErr = (err) => {
  const e = err.response?.data?.error;
  return { status: err.response?.status || 500, message: e?.message || err.message, code: e?.code };
};

// Fix #2 & #8: Always use SYSTEM_USER_TOKEN for catalogs owned by the platform.
// For manually-saved catalogs (user pasted their own ID), fall back to user token.
const getCatalogToken = async (userId) => {
  const catalog = await ShopCatalog.findOne({ userId });
  if (!catalog) throw new Error('No catalog found. Please connect a catalog first.');
  // Always use SYSTEM_USER_TOKEN — user tokens never have catalog_management scope.
  // The catalog must be shared with WPLeads Business Manager (706440965371488) in
  // Meta Commerce Manager → Catalog Settings → Share → Add Partner.
  const token = process.env.SYSTEM_USER_TOKEN;
  if (!token) throw new Error('Server misconfiguration: SYSTEM_USER_TOKEN not set.');
  return { catalog, token };
};

// ── POST /api/shop/catalog/create ───────────────────────────────────────────────
// Always uses SYSTEM_USER_TOKEN + BUSINESS_ID — user tokens lack catalog_management scope.
export const createCatalog = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Catalog name is required' });

    const sysToken   = process.env.SYSTEM_USER_TOKEN;
    const businessId = process.env.BUSINESS_ID;
    if (!sysToken || !businessId) {
      return res.status(500).json({
        message: 'Server not configured: SYSTEM_USER_TOKEN and BUSINESS_ID must be set in server/.env.',
      });
    }

    const { wa, wabaId, token: userToken } = await getWaAndToken(req.user._id);

    // 1. Create catalog under platform Business Manager (requires catalog_management)
    const { data: catData } = await axios.post(
      `${GRAPH}/${businessId}/owned_product_catalogs`,
      { name: name.trim(), vertical: 'commerce' },
      { params: { access_token: sysToken } }
    );
    const catalogId = catData?.id;
    if (!catalogId) return res.status(500).json({ message: 'Catalog created but no ID returned from Meta' });

    // 2. Link catalog to user's WABA (WABA level — try system token first, user token as fallback)
    try {
      await axios.post(`${GRAPH}/${wabaId}/product_catalogs`,
        { catalog_id: catalogId },
        { params: { access_token: sysToken } }
      );
    } catch (_) {
      try {
        await axios.post(`${GRAPH}/${wabaId}/product_catalogs`,
          { catalog_id: catalogId },
          { params: { access_token: userToken } }
        );
      } catch (_2) { /* non-fatal */ }
    }

    // Fix #3: Set commerce settings on the phone number level.
    // This enables the Commerce tab in WhatsApp chat (separate from WABA-level linking).
    if (wa.phoneNumberId) {
      try {
        await axios.post(
          `${GRAPH}/${wa.phoneNumberId}/whatsapp_commerce_settings`,
          { catalog_id: catalogId, is_catalog_visible: true, is_cart_enabled: true },
          { params: { access_token: sysToken } }
        );
      } catch (commerceErr) {
        console.warn('whatsapp_commerce_settings update failed (non-fatal):',
          commerceErr.response?.data?.error?.message || commerceErr.message);
      }
    }

    // 3. Save to DB — scoped to this user, marked as platform-owned
    const catalog = await ShopCatalog.findOneAndUpdate(
      { userId: req.user._id },
      { catalogId, name: name.trim(), isActive: true, ownedByPlatform: true },
      { upsert: true, new: true }
    );

    res.status(201).json({ catalog, created: true });
  } catch (err) {
    const e = metaErr(err);
    res.status(e.status).json({ message: e.message, code: e.code });
  }
};

// ── GET /api/shop/catalog ────────────────────────────────────────────────────────
export const getCatalog = async (req, res) => {
  try {
    const catalog = await ShopCatalog.findOne({ userId: req.user._id });
    res.json({ catalog: catalog || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/shop/catalog ───────────────────────────────────────────────────────
// Manual save — user pastes an existing catalog ID (ownedByPlatform stays false)
export const saveCatalog = async (req, res) => {
  try {
    const { catalogId, name } = req.body;
    if (!catalogId) return res.status(400).json({ message: 'catalogId is required' });
    const catalog = await ShopCatalog.findOneAndUpdate(
      { userId: req.user._id },
      { catalogId, name: name || '', isActive: true, ownedByPlatform: false },
      { upsert: true, new: true }
    );
    res.json({ catalog });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /api/shop/catalog ─────────────────────────────────────────────────────
export const deleteCatalog = async (req, res) => {
  try {
    await ShopCatalog.deleteOne({ userId: req.user._id });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/shop/products ───────────────────────────────────────────────────────
export const getProducts = async (req, res) => {
  try {
    // Fix #2: Use getCatalogToken — picks SYSTEM_USER_TOKEN for platform-owned catalogs
    const { catalog, token } = await getCatalogToken(req.user._id);
    const fields = 'id,retailer_id,name,description,price,currency,image_url,availability,condition';
    const { data } = await axios.get(`${GRAPH}/${catalog.catalogId}/products`, {
      params: { fields, limit: 100, access_token: token },
    });
    res.json({ products: data.data || [], paging: data.paging });
  } catch (err) {
    const e = metaErr(err);
    res.status(e.status).json({ message: e.message, code: e.code });
  }
};

// ── POST /api/shop/products ──────────────────────────────────────────────────────
export const addProduct = async (req, res) => {
  try {
    // Fix #2: Use getCatalogToken
    const { catalog, token } = await getCatalogToken(req.user._id);
    const { retailer_id, name, description, price, currency, image_url, availability, condition } = req.body;

    if (!retailer_id || !name || !price || !currency) {
      return res.status(400).json({ message: 'retailer_id, name, price, currency are required' });
    }

    const { data } = await axios.post(
      `${GRAPH}/${catalog.catalogId}/products`,
      {
        retailer_id,
        name,
        description:  description  || '',
        price:        parseInt(price),
        currency,
        image_url:    image_url    || '',
        availability: availability || 'in stock',
        condition:    condition    || 'new',
      },
      { params: { access_token: token } }
    );

    res.json({ product: data });
  } catch (err) {
    const e = metaErr(err);
    res.status(e.status).json({ message: e.message, code: e.code });
  }
};

// ── PATCH /api/shop/products/:productId ─────────────────────────────────────────
export const updateProduct = async (req, res) => {
  try {
    // Fix #2: Use getCatalogToken
    const { token } = await getCatalogToken(req.user._id);
    const { productId } = req.params;

    const allowed = ['name', 'description', 'price', 'currency', 'image_url', 'availability', 'condition'];
    const payload = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        payload[key] = key === 'price' ? parseInt(req.body[key]) : req.body[key];
      }
    }

    await axios.post(`${GRAPH}/${productId}`, payload, { params: { access_token: token } });
    res.json({ updated: true });
  } catch (err) {
    const e = metaErr(err);
    res.status(e.status).json({ message: e.message, code: e.code });
  }
};

// ── DELETE /api/shop/products/:productId ─────────────────────────────────────────
export const deleteProduct = async (req, res) => {
  try {
    // Fix #2: Use getCatalogToken
    const { token } = await getCatalogToken(req.user._id);
    await axios.delete(`${GRAPH}/${req.params.productId}`, { params: { access_token: token } });
    res.json({ deleted: true });
  } catch (err) {
    const e = metaErr(err);
    res.status(e.status).json({ message: e.message });
  }
};

// ── GET /api/shop/commerce-settings ─────────────────────────────────────────────
// Fix #4: Query phone number ID, not WABA ID
export const getCommerceSettings = async (req, res) => {
  try {
    const { token } = await getWaAndToken(req.user._id);
    const wa = await WhatsApp.findOne({ userId: req.user._id, isVerified: true });
    if (!wa?.phoneNumberId) return res.status(400).json({ message: 'Phone number not configured' });
    const { data } = await axios.get(`${GRAPH}/${wa.phoneNumberId}/whatsapp_commerce_settings`, {
      params: { access_token: token },
    });
    res.json({ settings: data.data?.[0] || data });
  } catch (err) {
    const e = metaErr(err);
    res.status(e.status).json({ message: e.message });
  }
};

// ── POST /api/shop/commerce-settings ────────────────────────────────────────────
// Fix #10: New endpoint — update commerce settings after catalog creation
export const updateCommerceSettings = async (req, res) => {
  try {
    const { token } = await getWaAndToken(req.user._id);
    const wa = await WhatsApp.findOne({ userId: req.user._id, isVerified: true });
    if (!wa?.phoneNumberId) return res.status(400).json({ message: 'Phone number not configured' });

    const { catalog_id, is_catalog_visible, is_cart_enabled } = req.body;
    const payload = {};
    if (catalog_id          !== undefined) payload.catalog_id          = catalog_id;
    if (is_catalog_visible  !== undefined) payload.is_catalog_visible  = is_catalog_visible;
    if (is_cart_enabled     !== undefined) payload.is_cart_enabled     = is_cart_enabled;

    await axios.post(`${GRAPH}/${wa.phoneNumberId}/whatsapp_commerce_settings`, payload, {
      params: { access_token: token },
    });
    res.json({ updated: true });
  } catch (err) {
    const e = metaErr(err);
    res.status(e.status).json({ message: e.message });
  }
};
