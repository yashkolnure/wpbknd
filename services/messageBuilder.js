// Build component parameters array from variable values
const buildTemplateComponents = (components, variables = []) => {
  const result = [];
  for (const comp of components) {
    const paramCount = (comp.text || '').match(/\{\{\d+\}\}/g)?.length || 0;
    if (paramCount === 0) continue;
    const params = Array.from({ length: paramCount }, (_, i) => ({
      type: 'text',
      text: variables[i] ?? `{{${i + 1}}}`,
    }));
    result.push({ type: comp.type.toLowerCase(), parameters: params });
  }
  return result;
};

export const buildMetaPayload = (to, message) => {
  switch (message.type) {

    // ── TEMPLATE — only type allowed outside 24-hr service window ─────────────
    case 'template': {
      const components = buildTemplateComponents(
        message.templateComponents || [],
        message.variables || []
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
            ? { type: 'text', text: message.buttonHeader }
            : undefined,
          body:   { text: message.buttonBody },
          footer: message.buttonFooter
            ? { text: message.buttonFooter }
            : undefined,
          action: {
            buttons: message.buttons.map(btn => ({
              type:  'reply',
              reply: { id: btn.id, title: btn.title },
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
            ? { type: 'text', text: message.listHeader }
            : undefined,
          body:   { text: message.listBody },
          footer: message.listFooter
            ? { text: message.listFooter }
            : undefined,
          action: {
            button:   message.listButtonText || 'View options',
            sections: message.sections.map(sec => ({
              title: sec.title,
              rows:  sec.rows.map(row => ({
                id:          row.id,
                title:       row.title,
                description: row.description || '',
              })),
            })),
          },
        },
      };

    case 'media':
      return {
        messaging_product: 'whatsapp',
        to,
        type: message.mediaType,   // 'image' | 'video' | 'document'
        [message.mediaType]: message.mediaId
          ? { id: message.mediaId, caption: message.mediaCaption || '', ...(message.mediaType === 'document' ? { filename: message.mediaFilename || 'file' } : {}) }
          : { link: message.mediaUrl, caption: message.mediaCaption || '' },
      };

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

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
};