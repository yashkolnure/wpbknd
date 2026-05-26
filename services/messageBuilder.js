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

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
};