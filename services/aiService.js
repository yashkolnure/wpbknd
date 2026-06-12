import axios from 'axios';
import AIConfig from '../models/AIConfig.js';
import { decrypt } from '../utils/encrypt.js';

// Suggested default model per provider — used when switching providers in the UI.
export const DEFAULT_MODELS = {
  openai:     'gpt-4o-mini',
  anthropic:  'claude-haiku-4-5',
  gemini:     'gemini-1.5-flash',
  openrouter: 'openai/gpt-4o-mini',
  custom:     '',
};

const stripSlash = (u) => (u || '').replace(/\/+$/, '');

// Pull a human-readable reason out of a provider's error response.
export const aiErrorMessage = (e) => {
  const d = e?.response?.data;
  return (
    d?.error?.message ||
    d?.error?.[0]?.message ||
    d?.message ||
    (typeof d === 'string' ? d : null) ||
    e?.message ||
    'AI request failed'
  );
};

// ── Provider-agnostic chat ────────────────────────────────────────────────────
// messages: [{ role: 'user' | 'assistant', content: string }]  (system is separate)
// Returns the assistant's reply text. Throws on transport/API error.
export const runChat = async ({ provider, model, apiKey, baseUrl, systemPrompt = '', temperature = 0.7, maxTokens = 500, messages = [] }) => {
  if (!apiKey) throw new Error('Missing API key');
  if (!messages.length) throw new Error('No messages to send');

  // ── OpenAI-compatible (Bearer auth): OpenAI, OpenRouter, and custom endpoints ──
  // A Base URL is honored ONLY for providers meant to have one (openrouter/custom),
  // so a leftover Base URL can never redirect official OpenAI/Anthropic/Gemini
  // traffic to the wrong host with the wrong auth scheme.
  if (provider === 'openai' || provider === 'custom' || provider === 'openrouter') {
    const root =
        provider === 'openrouter' ? (stripSlash(baseUrl) || 'https://openrouter.ai/api/v1')
      : provider === 'custom'     ? (stripSlash(baseUrl) || 'https://api.openai.com/v1')
      :                             'https://api.openai.com/v1';
    const url = `${root}/chat/completions`;

    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    if (provider === 'openrouter') {
      // Optional attribution headers OpenRouter recommends (not required to auth).
      headers['HTTP-Referer'] = process.env.CLIENT_URL || 'https://wpleads.in';
      headers['X-Title']      = 'WPLeads';
    }

    const body = {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ],
    };
    const r = await axios.post(url, body, { headers, timeout: 30000 });
    return r.data?.choices?.[0]?.message?.content?.trim() || '';
  }

  // ── Anthropic (Claude) — always the official endpoint ──
  if (provider === 'anthropic') {
    const url  = 'https://api.anthropic.com/v1/messages';
    const body = {
      model,
      max_tokens: maxTokens,
      temperature,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    };
    const r = await axios.post(url, body, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    return (r.data?.content || []).map(b => b.text || '').join('').trim();
  }

  // ── Google Gemini — always the official endpoint ──
  if (provider === 'gemini') {
    const url  = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    };
    const r = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    return (r.data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  }

  throw new Error(`Unknown AI provider: ${provider}`);
};

// ── High-level helper used by the workflow executor (AI node) ─────────────────
// Loads the user's saved config, decrypts the key, and runs a chat.
// Returns null when AI is not configured/enabled (callers treat null as "skip").
export const generateAIReply = async (userId, messages, opts = {}) => {
  const cfg = await AIConfig.findOne({ userId });
  if (!cfg || !cfg.enabled || !cfg.encryptedApiKey) return null;

  const apiKey = decrypt(cfg.encryptedApiKey);
  return runChat({
    provider:     cfg.provider,
    model:        cfg.model,
    apiKey,
    baseUrl:      cfg.baseUrl,
    systemPrompt: opts.systemPrompt || cfg.systemPrompt,
    temperature:  opts.temperature ?? cfg.temperature,
    maxTokens:    opts.maxTokens ?? cfg.maxTokens,
    messages,
  });
};

// ── Direct-connect helper (webhook: AI replies when no workflow matches) ──────
// Same as above but ALSO requires the directConnect toggle. Returns null when
// direct connect is off, so a user can use the AI node without auto-replying to
// every unmatched message.
export const generateDirectReply = async (userId, messages, opts = {}) => {
  const cfg = await AIConfig.findOne({ userId });
  if (!cfg || !cfg.enabled || !cfg.directConnect || !cfg.encryptedApiKey) return null;

  const apiKey = decrypt(cfg.encryptedApiKey);
  return runChat({
    provider:     cfg.provider,
    model:        cfg.model,
    apiKey,
    baseUrl:      cfg.baseUrl,
    systemPrompt: opts.systemPrompt || cfg.systemPrompt,
    temperature:  opts.temperature ?? cfg.temperature,
    maxTokens:    opts.maxTokens ?? cfg.maxTokens,
    messages,
  });
};

// Turn stored chat history into a clean LLM message list: drops empties, ensures
// it starts with a user turn, and merges consecutive same-role turns. This keeps
// every provider happy (Anthropic in particular requires strict user/assistant
// alternation starting with the user).
export const sanitizeHistory = (history) => {
  const out = [];
  for (const m of history) {
    const content = (m.content || '').trim();
    if (!content) continue;
    if (out.length === 0 && m.role !== 'user') continue; // skip leading assistant turns
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n' + content;
    else out.push({ role: m.role, content });
  }
  return out;
};
