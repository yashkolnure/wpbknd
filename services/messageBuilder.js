// ── Meta-limit safety net ─────────────────────────────────────────────────
// Belt-and-suspenders: even if the UI lets something through, truncate to
// Meta's limits so a single over-long field never causes a 400 that silences
// the whole bot. Unicode code-point aware (emoji count as 1, like Meta).
const clamp = (str, limit) => {
  if (str == null) return str;
  const s = String(str);
  const cps = [...s];
  if (cps.length <= limit) return s;
  console.warn(`⚠️  [messageBuilder] Truncated field from ${cps.length} → ${limit} chars: "${s.slice(0, 30)}…"`);
  return cps.slice(0, limit).join('');
};

// Resolve a usable media link for a media HEADER from the template definition
// (or an explicit per-send override on the message).
const headerMediaLink = (comp, message = {}) => {
  if (message.headerMediaUrl) return message.headerMediaUrl;          // explicit override
  if (comp?.example?.header_url) return comp.example.header_url;
  const h = comp?.example?.header_handle;
  if (Array.isArray(h) && /^https?:\/\//.test(h[0] || '')) return h[0];
  if (typeof h === 'string' && /^https?:\/\//.test(h)) return h;
  return null;
};

// Build the `components` array a template SEND requires.
//  • Media headers (IMAGE/VIDEO/DOCUMENT) MUST carry the media at send time —
//    omitting them is what caused Meta to reject every send with (#100).
//  • TEXT header / BODY components carry their {{n}} variable values.
const buildTemplateComponents = (components, variables = [], message = {}) => {
  const result = [];
  for (const comp of components) {
    const type   = (comp.type || '').toUpperCase();
    const format = (comp.format || '').toUpperCase();

    // Media header — attach the image/video/document so Meta can render it.
    if (type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
      const kind    = format.toLowerCase();           // image | video | document
      const mediaId = message.headerMediaId;
      const link    = headerMediaLink(comp, message);
      if (!mediaId && !link) continue;                // nothing to attach — skip
      const media = mediaId ? { id: mediaId } : { link };
      result.push({ type: 'header', parameters: [{ type: kind, [kind]: media }] });
      continue;
    }

    // Text components with {{n}} placeholders (TEXT header or BODY).
    const paramCount = (comp.text || '').match(/\{\{\d+\}\}/g)?.length || 0;
    if (paramCount === 0) continue;
    const params = Array.from({ length: paramCount }, (_, i) => ({
      type: 'text',
      text: variables[i] ?? `{{${i + 1}}}`,
    }));
    result.push({ type: type.toLowerCase(), parameters: params });
  }
  return result;
};

export const buildMetaPayload = (to, message) => {
  switch (message.type) {

    // ── TEMPLATE — only type allowed outside 24-hr service window ─────────────
    case 'template': {
      const components = buildTemplateComponents(
        message.templateComponents || [],
        message.variables || [],
        message
      );
      return {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name:     message.templateName,
          language: { code: message.templateLanguage || 'en' },
          ...(components.length > 0 ? { components } : {}),
        },
      };
    }

    case 'text':
      return {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message.text },
      };

    case 'button':
      return {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          header: message.buttonHeader
            ? { type: 'text', text: clamp(message.buttonHeader, 60) }
            : undefined,
          body:   { text: clamp(message.buttonBody, 1024) },
          footer: message.buttonFooter
            ? { text: clamp(message.buttonFooter, 60) }
            : undefined,
          action: {
            buttons: (message.buttons || []).slice(0, 3).map(btn => ({
              type:  'reply',
              reply: { id: btn.id, title: clamp(btn.title, 20) },
            })),
          },
        },
      };

    case 'list':
      return {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: message.listHeader
            ? { type: 'text', text: clamp(message.listHeader, 60) }
            : undefined,
          body:   { text: clamp(message.listBody, 4096) },
          footer: message.listFooter
            ? { text: clamp(message.listFooter, 60) }
            : undefined,
          action: {
            button:   clamp(message.listButtonText || 'View options', 20),
            sections: (message.sections || []).slice(0, 10).map(sec => ({
              title: clamp(sec.title, 24),
              rows:  (sec.rows || []).map(row => ({
                id:          row.id,
                title:       clamp(row.title, 24),
                description: clamp(row.description || '', 72),
              })),
            })),
          },
        },
      };

    case 'media': {
      // Meta requires 'filename' for document messages (both id and link paths)
      const isDoc = message.mediaType === 'document';
      const docFilename = message.mediaFilename
        || (message.mediaUrl ? message.mediaUrl.split('/').pop().split('?')[0] : null)
        || 'document.pdf';
      const mediaObject = message.mediaId
        ? {
            id: message.mediaId,
            caption: message.mediaCaption || '',
            ...(isDoc ? { filename: docFilename } : {}),
          }
        : {
            link: message.mediaUrl,
            caption: message.mediaCaption || '',
            ...(isDoc ? { filename: docFilename } : {}),
          };
      return {
        messaging_product: 'whatsapp',
        to,
        type: message.mediaType,
        [message.mediaType]: mediaObject,
      };
    }

    // ── SINGLE PRODUCT — one product card with Buy button ─────────────────────
    case 'product':
      return {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'product',
          body: { text: message.body || '' },
          action: {
            catalog_id: message.catalogId,
            product_retailer_id: message.productRetailerId,
          },
        },
      };

    // ── MULTI-PRODUCT — up to 30 products in sections ──────────────────────────
    case 'product_list': {
      // Fix #6 & #7: Validate required fields and Meta limits
      const _sections = message.productSections || message.sections || [];
      if (!message.body?.trim())    throw new Error('product_list requires a non-empty body text');
      if (!_sections.length)        throw new Error('product_list requires at least one section');
      if (_sections.length > 10)    throw new Error('product_list cannot have more than 10 sections');
      const totalProducts = _sections.reduce((sum, s) => sum + (s.products?.length || 0), 0);
      if (totalProducts > 30) throw new Error('product_list cannot have more than 30 products total');
      if (totalProducts === 0) throw new Error('product_list requires at least one product');

      return {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'product_list',
          header: { type: 'text', text: message.header || 'Our Products' },
          body:   { text: message.body.trim() },
          ...(message.footer ? { footer: { text: message.footer } } : {}),
          action: {
            catalog_id: message.catalogId,
            sections: (message.productSections || message.sections || []).map(sec => ({
              title: sec.title || '',
              product_items: (sec.products || []).map(p => ({
                product_retailer_id: p.retailerId,
              })),
            })),
          },
        },
      };
    }

    // ── CTA URL — native button that opens a website ─────────────────────────
    case 'cta_url':
      return {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          ...(message.header ? { header: { type: 'text', text: clamp(message.header, 60) } } : {}),
          body: { text: clamp(message.body || '', 1024) },
          ...(message.footer ? { footer: { text: clamp(message.footer, 60) } } : {}),
          action: {
            name: 'cta_url',
            parameters: {
              display_text: clamp(message.buttonText || 'Open', 20),
              url: message.url,
            },
          },
        },
      };

    // ── FLOW — native in-app form (appointments, lead forms, surveys) ─────────
    case 'flow': {
      if (!message.flowId) throw new Error('Flow message requires a flowId');
      return {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'flow',
          ...(message.header ? { header: { type: 'text', text: clamp(message.header, 60) } } : {}),
          body: { text: clamp(message.body || ' ', 1024) },
          ...(message.footer ? { footer: { text: clamp(message.footer, 60) } } : {}),
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3',
              flow_token: message.flowToken || `wpl_${Date.now()}`,
              flow_id: message.flowId,
              flow_cta: clamp(message.flowCta || 'Open Form', 20),
              flow_action: message.flowAction || 'navigate',
              ...(message.flowScreen
                ? { flow_action_payload: { screen: message.flowScreen, ...(message.flowData ? { data: message.flowData } : {}) } }
                : {}),
            },
          },
        },
      };
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
};