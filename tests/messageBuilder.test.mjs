// Regression tests for template payload building (server/services/messageBuilder.js).
// Guards the fix for the broadcast bug: media-header templates were sent with no
// `components`, so Meta rejected every message with #132012 (header format mismatch).
import assert from 'node:assert/strict';
import { buildMetaPayload } from '../services/messageBuilder.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('messageBuilder.test — template send payloads');

const tmpl = (extra) => ({ type: 'template', templateName: 't', templateLanguage: 'en', variables: [], ...extra });

// 1 — THE BUG: an IMAGE-header template must attach the header media (not omit it).
check('IMAGE header attaches header component from example.header_handle', () => {
  const p = buildMetaPayload('911', tmpl({
    templateComponents: [
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://cdn/x.png'] } },
      { type: 'BODY', text: 'Marketing Campaign' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Visit', url: 'https://wpleads.in' }] },
    ],
  }));
  const comps = p.template.components;
  assert.ok(Array.isArray(comps) && comps.length === 1, 'exactly one component (the header)');
  assert.deepEqual(comps[0], { type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn/x.png' } }] });
});

// 2 — example.header_url is preferred when present.
check('IMAGE header uses example.header_url when present', () => {
  const p = buildMetaPayload('911', tmpl({
    templateComponents: [{ type: 'HEADER', format: 'IMAGE', example: { header_url: 'https://cdn/u.png', header_handle: ['https://cdn/h.png'] } }],
  }));
  assert.equal(p.template.components[0].parameters[0].image.link, 'https://cdn/u.png');
});

// 3 — VIDEO / DOCUMENT headers map to the right media type.
check('VIDEO and DOCUMENT headers map correctly', () => {
  const v = buildMetaPayload('911', tmpl({ templateComponents: [{ type: 'HEADER', format: 'VIDEO', example: { header_handle: ['https://cdn/v.mp4'] } }] }));
  assert.deepEqual(v.template.components[0].parameters[0], { type: 'video', video: { link: 'https://cdn/v.mp4' } });
  const d = buildMetaPayload('911', tmpl({ templateComponents: [{ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: ['https://cdn/d.pdf'] } }] }));
  assert.deepEqual(d.template.components[0].parameters[0], { type: 'document', document: { link: 'https://cdn/d.pdf' } });
});

// 4 — explicit per-send media id/url overrides the template example.
check('headerMediaId / headerMediaUrl overrides win', () => {
  const byId = buildMetaPayload('911', tmpl({ headerMediaId: 'MID', templateComponents: [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://cdn/x.png'] } }] }));
  assert.deepEqual(byId.template.components[0].parameters[0], { type: 'image', image: { id: 'MID' } });
  const byUrl = buildMetaPayload('911', tmpl({ headerMediaUrl: 'https://my/own.png', templateComponents: [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://cdn/x.png'] } }] }));
  assert.equal(byUrl.template.components[0].parameters[0].image.link, 'https://my/own.png');
});

// 5 — BODY variables still produce text params.
check('BODY {{n}} variables produce text params', () => {
  const p = buildMetaPayload('911', tmpl({ templateComponents: [{ type: 'BODY', text: 'Hi {{1}}, code {{2}}' }], variables: ['Yash', '42'] }));
  assert.deepEqual(p.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Yash' }, { type: 'text', text: '42' }] }]);
});

// 6 — plain template (no header, no vars) sends with no components.
check('plain template omits components', () => {
  const p = buildMetaPayload('911', tmpl({ templateComponents: [{ type: 'BODY', text: 'Hello' }] }));
  assert.equal(p.template.components, undefined);
  assert.equal(p.template.name, 't');
});

// 7 — media header with no available media link is skipped (no crash).
check('media header with no source is skipped gracefully', () => {
  const p = buildMetaPayload('911', tmpl({ templateComponents: [{ type: 'HEADER', format: 'IMAGE', example: {} }] }));
  assert.equal(p.template.components, undefined);
});

console.log(`\nmessageBuilder.test: ${passed} checks passed ✅`);
