import mongoose from 'mongoose';

// Per-user "bring your own LLM" configuration. The API key is stored AES-encrypted
// (utils/encrypt.js) and is NEVER returned to the client — controllers strip it.
const aiConfigSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  provider: { type: String, enum: ['openai', 'gemini', 'anthropic', 'openrouter', 'custom'], default: 'openai' },
  model:    { type: String, default: 'gpt-4o-mini' },

  encryptedApiKey: { type: String },                 // AES-256-CBC, "iv:cipher"
  baseUrl:         { type: String, default: '' },    // custom / OpenAI-compatible endpoints

  systemPrompt: {
    type: String,
    default: 'You are a helpful customer-support assistant for our business, replying on WhatsApp. Keep answers short, friendly and clear. If you do not know something, offer to connect the customer with a human.',
  },
  temperature: { type: Number, default: 0.7, min: 0, max: 2 },
  maxTokens:   { type: Number, default: 500, min: 1, max: 4000 },

  enabled:       { type: Boolean, default: false },  // master switch (node + direct both require this)
  directConnect: { type: Boolean, default: false },  // auto-reply to WA messages with no workflow match
}, { timestamps: true });

export default mongoose.model('AIConfig', aiConfigSchema);
