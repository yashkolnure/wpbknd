import Workflow from '../models/Workflow.js';
import Contact  from '../models/Contact.js';
import { sendMessage } from './messageSender.js';
import { generateAIReply } from './aiService.js';
import Message from "../models/Message.js";

// ── Condition evaluator ─────────────────────────────────────────────────────
const evalCondition = (node, variables) => {
  const { variable = '', operator = 'equals', value = '' } = node.data || {};
  const actual = (variables?.get?.(variable) || variables?.[variable] || '').toString().toLowerCase().trim();
  const target = (value || '').toLowerCase().trim();
  switch (operator) {
    case 'equals':       return actual === target;
    case 'not_equals':   return actual !== target;
    case 'contains':     return actual.includes(target);
    case 'not_contains': return !actual.includes(target);
    case 'starts_with':  return actual.startsWith(target);
    case 'ends_with':    return actual.endsWith(target);
    case 'greater_than': return parseFloat(actual) > parseFloat(target);
    case 'less_than':    return parseFloat(actual) < parseFloat(target);
    case 'is_set':       return actual !== '' && actual !== 'undefined';
    case 'is_not_set':   return actual === '' || actual === 'undefined';
    default:             return false;
  }
};

// ── Validation helpers ──────────────────────────────────────────────────────
const validators = {
  phone:  v => /^[\d\s\+\-\(\)]{7,15}$/.test(v.trim()),
  email:  v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
  number: v => !isNaN(Number(v.trim())) && v.trim() !== '',
  text:   () => true,
};

// ── Variable interpolation ──────────────────────────────────────────────────
const interpolate = (text, variables) => {
  if (!text || !variables) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => variables.get?.(key) ?? variables[key] ?? `{{${key}}}`);
};

export const executeWorkflow = async (userId, incomingText, fromNumber, contactId) => {
  // ── 0. Load contact (needed for pending-input state + variables) ───────────
  // Returns true when a workflow handled the message (resume / keyword / fallback),
  // false otherwise — the caller uses this to decide whether to hand off to AI.
  const contact = await Contact.findById(contactId);
  if (!contact) return false;

  // ── 1. RESUME: contact is awaiting collect_input answer ────────────────────
  if (contact.awaitingInput && contact.activeWorkflowId && contact.currentNodeId) {
    const workflow = await Workflow.findById(contact.activeWorkflowId);
    if (workflow) {
      const varName    = contact.awaitingInputVar || 'input';
      const inputType  = contact.awaitingInputType || 'text';
      const retryMsg   = contact.awaitingRetryMsg;
      const validate   = validators[inputType] || validators.text;

      // Validate the answer
      if (!validate(incomingText)) {
        // Send retry message
        const retryText = retryMsg || `Please enter a valid ${inputType}.`;
        await sendMessage(userId, fromNumber, { type: 'text', text: retryText });
        return; // keep awaitingInput = true
      }

      // Store variable
      contact.variables.set(varName, incomingText.trim());
      contact.awaitingInput    = false;
      contact.awaitingInputVar = null;
      await contact.save();

      // Continue from the collect_input node itself as startNodeId.
      // executeFromNode will find its outgoing edge and execute the next node
      // (which may itself be another collect_input, a message, condition, etc.)
      await executeFromNode(workflow, contact.currentNodeId, incomingText, fromNumber, userId, contactId, contact);
      return true; // done — don't check other workflows
    }
  }

  // ── 2. KEYWORD MATCH: find and start a workflow ────────────────────────────
  const workflows = await Workflow.find({ userId, isActive: true });

  let matched       = false;
  let fallbackFlow  = null;

  for (const workflow of workflows) {
    const triggerNode = workflow.nodes.find(n => n.type === 'trigger');
    if (!triggerNode || !triggerNode.data?.keyword) continue;

    const { keyword, matchType } = triggerNode.data;

    // Store fallback workflow for later — only use it if nothing else matches
    if (matchType === 'fallback') {
      fallbackFlow = { workflow, triggerNode };
      continue;
    }

    // ── Button/list reply: check continuationEdge FIRST ─────────────────────
    // Button IDs and list row IDs may accidentally contain keywords (e.g.
    // "w-btn-demo" contains "demo", "row-features" contains "features").
    // If we find a matching edge handle, treat this as a button/list reply
    // and follow that edge — never re-trigger the keyword flow.
    const continuationEdge = workflow.edges.find(e =>
      e.sourceHandle && e.sourceHandle === incomingText.trim()
    );
    if (continuationEdge) {
      matched = true;
      if (contact.awaitingInput) {
        contact.awaitingInput    = false;
        contact.awaitingInputVar = null;
        await contact.save();
      }
      await executeFromNode(workflow, continuationEdge.source, incomingText, fromNumber, userId, contactId, contact);
      break;
    }

    // ── Plain text: keyword match ─────────────────────────────────────────────
    const text           = (incomingText || '').toLowerCase().trim();
    const keywordsArray  = keyword.split(',').map(k => k.toLowerCase().trim());
    const isKeywordMatch = keywordsArray.some(kw =>
      matchType === 'exact' ? text === kw : text.includes(kw)
    );

    if (!isKeywordMatch) continue;

    matched = true;
    if (contact.awaitingInput) {
      contact.awaitingInput    = false;
      contact.awaitingInputVar = null;
      await contact.save();
    }
    await executeFromNode(workflow, triggerNode.id, incomingText, fromNumber, userId, contactId, contact);
    break;
  }

  // ── 3. FALLBACK: fire default-reply workflow if nothing matched ────────────
  if (!matched && fallbackFlow) {
    console.log(`🔁 [Fallback] No keyword matched — firing fallback workflow for ${fromNumber}`);
    await executeFromNode(fallbackFlow.workflow, fallbackFlow.triggerNode.id, incomingText, fromNumber, userId, contactId, contact);
    return true;
  }

  return matched;
};

const executeFromNode = async (workflow, startNodeId, incomingText, fromNumber, userId, contactId, contact) => {
  const nodeMap = Object.fromEntries(workflow.nodes.map(n => [n.id, n]));
  // Re-fetch contact if not passed (keep variables fresh)
  if (!contact) contact = await Contact.findById(contactId);
  const vars = contact?.variables || {};
  let currentId = startNodeId;

  while (true) {
    const outgoingEdges = workflow.edges.filter(e => e.source === currentId);
    if (!outgoingEdges.length) break;

    let nextEdge;
    if (outgoingEdges.length === 1) {
      nextEdge = outgoingEdges[0];
    } else {
      nextEdge = outgoingEdges.find(e => e.sourceHandle === incomingText.trim());
      if (!nextEdge) {
        nextEdge = outgoingEdges[0]; // Fallback to first edge if no handle matches
      }
    }

    const nextNode = nodeMap[nextEdge.target];
    if (!nextNode) break;

    // ── Handle condition node ──
    if (nextNode.type === 'condition') {
      const result = evalCondition(nextNode, vars);
      const handle = result ? 'true' : 'false';
      console.log(`🔀 [Condition] ${nextNode.data?.variable} ${nextNode.data?.operator} "${nextNode.data?.value}" → ${result ? 'TRUE' : 'FALSE'}`);
      // Find the edge for this branch (true/false handle)
      const branchEdge = workflow.edges.find(e => e.source === nextNode.id && e.sourceHandle === handle)
                      || workflow.edges.find(e => e.source === nextNode.id); // fallback
      if (!branchEdge) break;
      const branchNode = nodeMap[branchEdge.target];
      if (!branchNode) break;
      currentId = branchNode.id;
      continue; // don't send condition node as a message
    }

    // ── Handle delay node ──
    if (nextNode.type === 'delay') {
      await sleep(nextNode.data.delayMinutes * 60 * 1000);
      currentId = nextNode.id;
      continue;
    }

    // ── Handle collect_input node ──
    if (nextNode.type === 'collect_input') {
      const { question, variableName = 'input', inputType = 'text', retryMessage } = nextNode.data;

      // Build the prompt — always send something so the user knows exactly what to type
      const baseQuestion = question
        ? interpolate(question, vars)
        : `Please share your ${variableName || 'answer'}.`;

      // Hint is specific to both inputType AND the variable name
      let hint;
      if (inputType === 'phone') {
        hint = `📱 Please reply with your WhatsApp number (e.g. 9876543210).`;
      } else if (inputType === 'email') {
        hint = `📧 Please reply with your email address.`;
      } else if (inputType === 'number') {
        hint = `🔢 Please reply with a number.`;
      } else if (variableName && variableName !== 'input') {
        // Capitalise first letter of variable name for display: "name" → "Name"
        const displayVar = variableName.charAt(0).toUpperCase() + variableName.slice(1);
        hint = `✏️ Please type your ${displayVar} and send.`;
      } else {
        hint = `✏️ Please type your reply and send.`;
      }

      // Don't double-hint if the question already tells the user what to do
      const alreadyHasHint = /type|enter|share|reply|send|number|email|phone/i.test(baseQuestion);
      const fullPrompt = alreadyHasHint ? baseQuestion : `${baseQuestion}\n\n${hint}`;

      await sendMessage(userId, fromNumber, { type: 'text', text: fullPrompt });

      // Save awaiting-input state on the contact
      if (contact) {
        contact.awaitingInput     = true;
        contact.awaitingInputVar  = variableName;
        contact.awaitingInputType = inputType;
        contact.awaitingRetryMsg  = retryMessage || `Please enter a valid ${inputType}.`;
        contact.activeWorkflowId  = workflow._id;
        contact.currentNodeId     = nextNode.id;
        await contact.save();
      }
      break; // Stop — wait for user's reply
    }

    // ── Handle AI node ──
    // Replies using the user's configured LLM. Uses an explicit prompt (with
    // {{variable}} interpolation) when set, otherwise the customer's last message.
    if (nextNode.type === 'ai') {
      const { aiPrompt, aiSystemPrompt, aiSaveAs } = nextNode.data || {};
      const userContent = (aiPrompt && aiPrompt.trim())
        ? interpolate(aiPrompt, vars)
        : (incomingText || 'Hello');

      try {
        const reply = await generateAIReply(
          userId,
          [{ role: 'user', content: userContent }],
          { systemPrompt: (aiSystemPrompt && aiSystemPrompt.trim()) ? aiSystemPrompt : undefined },
        );

        if (reply) {
          await sendMessage(userId, fromNumber, { type: 'text', text: reply });
          try {
            await Message.create({
              userId, contactId, from: 'bot', type: 'text', text: reply,
              status: 'sent', isReadByAdmin: true, timestamp: new Date(),
            });
          } catch (dbErr) { console.error('❌ AI message save error:', dbErr.message); }

          // Make the reply reusable downstream as {{aiSaveAs}}.
          if (aiSaveAs && contact?.variables) {
            contact.variables.set(aiSaveAs, reply);
            await contact.save();
          }
        } else {
          console.warn(`🤖 [Workflow] AI node skipped — AI not configured/enabled for user ${userId}`);
        }
      } catch (e) {
        console.error('🤖 [Workflow] AI node error:', e.response?.data?.error?.message || e.message);
      }

      currentId = nextNode.id;
      continue;
    }

    // ── Handle message node ──
    if (nextNode.type === 'message') {
      // Convert Mongoose subdocument → plain JS object
      let msgData = nextNode.data.message?.toObject
        ? nextNode.data.message.toObject()
        : nextNode.data.message;
      if (!msgData) { currentId = nextNode.id; continue; }

      // ── Variable interpolation: replace {{var}} in all text fields ──────────
      if (msgData.text)         msgData = { ...msgData, text:         interpolate(msgData.text,         vars) };
      if (msgData.buttonBody)   msgData = { ...msgData, buttonBody:   interpolate(msgData.buttonBody,   vars) };
      if (msgData.listBody)     msgData = { ...msgData, listBody:     interpolate(msgData.listBody,     vars) };
      if (msgData.mediaCaption) msgData = { ...msgData, mediaCaption: interpolate(msgData.mediaCaption, vars) };
      if (msgData.body)         msgData = { ...msgData, body:         interpolate(msgData.body,         vars) };
      if (msgData.header)       msgData = { ...msgData, header:       interpolate(msgData.header,       vars) };
      if (msgData.footer)       msgData = { ...msgData, footer:       interpolate(msgData.footer,       vars) };

      console.log(`\n🔁 [Workflow] Executing node: ${nextNode.id}`);
      console.log(`📨 [Workflow] msgData:`, JSON.stringify(msgData, null, 2));

      try {
        // 1. Send via Meta API
        const result = await sendMessage(userId, fromNumber, msgData);
        const metaMessageId = result?.metaMessageId || null;

        // 2. Build message record with type-specific fields
        let messageRecord = {
          userId,
          contactId,
          from: 'bot',
          type: msgData.type === 'text' ? 'text' : 'interactive',
          messageId: metaMessageId,   // wamid — required for delivery/read status updates via webhook
          status: 'sent',
          isReadByAdmin: true,
          timestamp: new Date(),
        };

        // 3. Store complete message data based on type
        if (msgData.type === 'text') {
          messageRecord.text = msgData.text;
        } 
        else if (msgData.type === 'button') {
          messageRecord.text = msgData.buttonBody || 'Button Message';
          messageRecord.metadata = {
            type: 'button',
            header: msgData.buttonHeader || null,
            footer: msgData.buttonFooter || null,
            buttons: msgData.buttons, // Store complete buttons array with id, title
          };
        } 
        else if (msgData.type === 'list') {
          messageRecord.text = msgData.listBody || 'List Message';
          messageRecord.metadata = {
            type: 'list',
            header: msgData.listHeader || null,
            footer: msgData.listFooter || null,
            buttonText: msgData.listButtonText || 'View options',
            sections: msgData.sections, // Store complete sections with rows (id, title, description)
          };
        } 
        else if (msgData.type === 'media') {
          messageRecord.text = msgData.mediaCaption || 'Media Message';
          messageRecord.metadata = {
            type: 'media',
            mediaType: msgData.mediaType,
            mediaUrl: msgData.mediaUrl,
          };
        }
        else if (msgData.type === 'product') {
          messageRecord.text = msgData.body || 'Product Message';
          messageRecord.metadata = {
            type: 'product',
            catalogId: msgData.catalogId,
            productRetailerId: msgData.productRetailerId,
          };
        }
        else if (msgData.type === 'product_list') {
          messageRecord.text = msgData.body || 'Product List Message';
          messageRecord.metadata = {
            type: 'product_list',
            catalogId: msgData.catalogId,
            header: msgData.header,
            sections: msgData.productSections || msgData.sections,
          };
        }
        else if (msgData.type === 'cta_url') {
          messageRecord.text = msgData.body || 'Link Button';
          messageRecord.metadata = {
            type: 'cta_url',
            header: msgData.header || null,
            footer: msgData.footer || null,
            buttonText: msgData.buttonText,
            url: msgData.url,
          };
        }
        else if (msgData.type === 'flow') {
          messageRecord.text = msgData.body || 'Form';
          messageRecord.metadata = {
            type: 'flow',
            header: msgData.header || null,
            footer: msgData.footer || null,
            flowCta: msgData.flowCta,
            flowId: msgData.flowId,
          };
        }

        // 4. Save to Message DB
       try {
    const savedMsg = await Message.create(messageRecord);
    console.log("✅ Message saved successfully:", savedMsg._id);
} catch (dbErr) {
    console.error("❌ Database Save Error:", dbErr.message);
    console.error("Data attempted:", JSON.stringify(messageRecord, null, 2));
}

      } catch (err) {
        console.error('🔥 Send error:', err.message);
      }

      currentId = nextNode.id;

      // Stop loop if it's an interactive message requiring user input
      // Fix #5: product and product_list also need user interaction — break here too
      if (['button', 'list', 'product', 'product_list'].includes(msgData.type)) {
        break;
      }
      continue;
    }

    currentId = nextNode.id;
  }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));