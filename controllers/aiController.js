import AIConfig from '../models/AIConfig.js';
import { encrypt, decrypt } from '../utils/encrypt.js';
import { runChat, aiErrorMessage, sanitizeHistory, DEFAULT_MODELS } from '../services/aiService.js';

// Strip the secret before any config leaves the server. The client only learns
// WHETHER a key is set (hasApiKey), never the key itself.
const toSafe = (cfg) => {
  if (!cfg) return null;
  const obj = cfg.toObject ? cfg.toObject() : cfg;
  const { encryptedApiKey, __v, ...rest } = obj;
  return { ...rest, hasApiKey: !!encryptedApiKey };
};

// GET /api/ai/providers — unauthenticated build probe. If this lists "openrouter"
// you're hitting the new code; if it 404s or omits it, the server is stale.
export const getAIProviders = (req, res) => {
  res.json({ build: 'ai-v2-openrouter', providers: ['openai', 'gemini', 'anthropic', 'openrouter', 'custom'] });
};

// GET /api/ai/config
export const getAIConfig = async (req, res) => {
  try {
    const cfg = await AIConfig.findOne({ userId: req.user._id });
    res.json({ config: toSafe(cfg), defaultModels: DEFAULT_MODELS });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/ai/config  — upsert. apiKey is only updated when a non-empty value is sent.
export const saveAIConfig = async (req, res) => {
  try {
    const { provider, model, apiKey, baseUrl, systemPrompt, temperature, maxTokens, enabled, directConnect } = req.body;

    const update = {};
    if (provider     !== undefined) update.provider = provider;
    if (model        !== undefined) update.model = model;
    if (baseUrl      !== undefined) update.baseUrl = baseUrl;
    if (systemPrompt !== undefined) update.systemPrompt = systemPrompt;
    if (temperature  !== undefined) update.temperature = Number(temperature);
    if (maxTokens    !== undefined) update.maxTokens = Number(maxTokens);
    if (enabled      !== undefined) update.enabled = !!enabled;
    if (directConnect!== undefined) update.directConnect = !!directConnect;
    if (apiKey && apiKey.trim())    update.encryptedApiKey = encrypt(apiKey.trim());

    // Can't enable AI without a key on file (either being set now or already stored).
    const existing = await AIConfig.findOne({ userId: req.user._id });
    const willHaveKey = update.encryptedApiKey || existing?.encryptedApiKey;
    if ((update.enabled || update.directConnect) && !willHaveKey) {
      return res.status(400).json({ message: 'Add an API key before enabling AI.' });
    }

    const cfg = await AIConfig.findOneAndUpdate(
      { userId: req.user._id },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ config: toSafe(cfg) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/ai/test  — send one prompt so the user can confirm the key/model work.
// Uses values from the request body when present (test before saving), else the
// stored config. The stored key is used only if no apiKey is supplied.
export const testAIConfig = async (req, res) => {
  try {
    const stored = await AIConfig.findOne({ userId: req.user._id });

    const provider     = req.body.provider     ?? stored?.provider;
    const model        = req.body.model        ?? stored?.model;
    const baseUrl      = req.body.baseUrl      ?? stored?.baseUrl;
    const systemPrompt = req.body.systemPrompt ?? stored?.systemPrompt;
    const apiKey = (req.body.apiKey && req.body.apiKey.trim())
      ? req.body.apiKey.trim()
      : (stored?.encryptedApiKey ? decrypt(stored.encryptedApiKey) : null);

    if (!provider) return res.status(400).json({ message: 'Choose a provider first' });
    if (!model)    return res.status(400).json({ message: 'Enter a model name first' });
    if (!apiKey)   return res.status(400).json({ message: 'Add an API key first' });

    // Accept a full conversation (live preview chat) or a single one-off message.
    const messages = (Array.isArray(req.body.messages) && req.body.messages.length)
      ? sanitizeHistory(req.body.messages)
      : [{ role: 'user', content: (req.body.message && req.body.message.trim()) || 'Reply with a short, friendly hello to confirm you are working.' }];
    if (!messages.length) return res.status(400).json({ message: 'Type a message to send' });

    const temperature = req.body.temperature !== undefined ? Number(req.body.temperature) : (stored?.temperature ?? 0.7);
    const maxTokens   = Math.min(Number(req.body.maxTokens) || stored?.maxTokens || 300, 800);

    const reply = await runChat({ provider, model, apiKey, baseUrl, systemPrompt, temperature, maxTokens, messages });

    if (!reply) return res.status(400).json({ ok: false, message: 'The model returned an empty response.' });
    res.json({ ok: true, reply });
  } catch (err) {
    res.status(400).json({ ok: false, message: aiErrorMessage(err) });
  }
};

// DELETE /api/ai/config — disconnect: removes the stored key + all AI settings.
export const deleteAIConfig = async (req, res) => {
  try {
    await AIConfig.findOneAndDelete({ userId: req.user._id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
