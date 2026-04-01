import Workflow from '../models/Workflow.js';
import { sendMessage } from './messageSender.js';
import Message from "../models/Message.js";

export const executeWorkflow = async (userId, incomingText, fromNumber, contactId) => {
  const workflows = await Workflow.find({ userId, isActive: true });

  for (const workflow of workflows) {
    const triggerNode = workflow.nodes.find(n => n.type === 'trigger');
    if (!triggerNode || !triggerNode.data?.keyword) continue;

    const { keyword, matchType } = triggerNode.data;
    const text = (incomingText || "").toLowerCase().trim();
    const kw   = keyword.toLowerCase().trim();

    const isKeywordMatch =
      matchType === 'exact'    ? text === kw :
      matchType === 'contains' ? text.includes(kw) : false;

    const continuationEdge = workflow.edges.find(e => 
      e.sourceHandle === incomingText.trim() 
    );

    if (!isKeywordMatch && !continuationEdge) continue;

    if (isKeywordMatch) {
      await executeFromNode(
        workflow, triggerNode.id, incomingText, fromNumber, userId, contactId
      );
    } else {
      await executeFromNode(
        workflow, continuationEdge.source, incomingText, fromNumber, userId, contactId
      );
    }
    break;
  }
};

const executeFromNode = async (workflow, startNodeId, incomingText, fromNumber, userId, contactId) => {
  const nodeMap = Object.fromEntries(workflow.nodes.map(n => [n.id, n]));
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

    // ── Handle delay node ──
    if (nextNode.type === 'delay') {
      await sleep(nextNode.data.delayMinutes * 60 * 1000);
      currentId = nextNode.id;
      continue;
    }

   // workflowExecutor.js - Replace the message node handling section

if (nextNode.type === 'message') {
  const msgData = nextNode.data.message;
  if (!msgData) { 
    console.log('⚠️ No message data in node:', nextNode.id);
    currentId = nextNode.id; 
    continue; 
  }

  let metaMessageId = null;
  
  // 1. Send via Meta API (separate try-catch)
  try {
    const result = await sendMessage(userId, fromNumber, msgData);
    metaMessageId = result?.metaMessageId || null;
    console.log('✅ Message sent successfully, wamid:', metaMessageId);
  } catch (sendErr) {
    console.error('🔥 Meta API Send Error:', sendErr.message);
    // Continue to save attempt even if send fails (for audit trail)
  }

  // 2. Build message record
  let messageRecord = {
    userId,
    contactId,
    from: 'bot',
    type: msgData.type === 'text' ? 'text' : 'interactive',
    metaMessageId,
    status: metaMessageId ? 'sent' : 'failed',
    isReadByAdmin: true,
    timestamp: new Date(),
  };

  // 3. Add type-specific fields
  if (msgData.type === 'text') {
    messageRecord.text = msgData.text;
  } 
  else if (msgData.type === 'button') {
    messageRecord.text = msgData.buttonBody || 'Button Message';
    messageRecord.metadata = {
      type: 'button',
      header: msgData.buttonHeader || null,
      footer: msgData.buttonFooter || null,
      buttons: msgData.buttons,
    };
  } 
  else if (msgData.type === 'list') {
    messageRecord.text = msgData.listBody || 'List Message';
    messageRecord.metadata = {
      type: 'list',
      header: msgData.listHeader || null,
      footer: msgData.listFooter || null,
      buttonText: msgData.listButtonText || 'View options',
      sections: msgData.sections,
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

  // 4. Save to DB (separate try-catch with detailed logging)
  try {
    console.log('💾 Attempting to save message:', JSON.stringify(messageRecord, null, 2));
    const savedMessage = await Message.create(messageRecord);
    console.log('✅ Message saved to DB:', savedMessage._id);
  } catch (dbErr) {
    console.error('🔥 DATABASE SAVE ERROR:', {
      error: dbErr.message,
      name: dbErr.name,
      code: dbErr.code,
      validationErrors: dbErr.errors,
      messageRecord: JSON.stringify(messageRecord, null, 2)
    });
  }

  currentId = nextNode.id;

  // Stop loop if interactive message
  if (msgData.type === 'button' || msgData.type === 'list') {
    break;
  }
  continue;
}

    currentId = nextNode.id;
  }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));