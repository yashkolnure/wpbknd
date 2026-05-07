export const buildMetaPayload = (to, message) => {
  switch (message.type) {

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
        [message.mediaType]: {
          link:    message.mediaUrl,
          caption: message.mediaCaption || '',
        },
      };

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
};