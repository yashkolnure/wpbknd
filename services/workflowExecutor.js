import Workflow from '../models/Workflow.js';
import { sendMessage } from './messageSender.js';
import Message from "../models/Message.js";

export const executeWorkflow = async (userId, incomingText, fromNumber, contactId) => {
  const workflows = await Workflow.find({ userId, isActive: true });

  for (const workflow of workflows) {
    const triggerNode = workflow.nodes.find(n => n.type === 'trigger');
    
    // 1. If there's no trigger node or no keyword, skip this workflow
    if (!triggerNode || !triggerNode.data?.keyword) continue;

    const { keyword, matchType } = triggerNode.data;
    const text = (incomingText || "").toLowerCase().trim();

    // ─── FIX START: Split comma-separated keywords ───
    const keywordsArray = keyword.split(',').map(k => k.toLowerCase().trim());

    // Check if ANY keyword in the list matches the incoming text
    const isKeywordMatch = keywordsArray.some(kw => {
      if (matchType === 'exact') {
        return text === kw;
      } else if (matchType === 'contains') {
        // "contains" logic: Does the customer's message contain one of our keywords?
        return text.includes(kw);
      }
      return false;
    });
    // ─── FIX END ───

    const continuationEdge = workflow.edges.find(e => 
      e.sourceHandle === incomingText.trim() 
    );

    if (!isKeywordMatch && !continuationEdge) continue;

    // Trigger the execution
    if (isKeywordMatch) {
      await executeFromNode(
        workflow, triggerNode.id, incomingText, fromNumber, userId, contactId
      );
    } else {
      await executeFromNode(
        workflow, continuationEdge.source, incomingText, fromNumber, userId, contactId
      );
    }
    
    // IMPORTANT: Stop looking for other workflows once one has matched
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

    // ── Handle message node ──
    if (nextNode.type === 'message') {
      const msgData = nextNode.data.message; // Declared ONCE here
      if (!msgData) { currentId = nextNode.id; continue; }

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
          metaMessageId,
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
      if (msgData.type === 'button' || msgData.type === 'list') {
        break;
      }
      continue;
    }

    currentId = nextNode.id;
  }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));