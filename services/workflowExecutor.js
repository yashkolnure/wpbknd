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
 
nextEdge = outgoingEdges.find(e => 
  e.sourceHandle === incomingText.trim()
);

      if (!nextEdge) {
        if (outgoingEdges.length === 1) {
          nextEdge = outgoingEdges[0];
        } else {
          break;
        }
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
      const msgData = nextNode.data.message;
      if (!msgData) { currentId = nextNode.id; continue; }

      try {
        // Send via Meta API
        const result       = await sendMessage(userId, fromNumber, msgData);
        const metaMessageId = result?.metaMessageId || null;

        let metadata   = null;
let loggedText = '';

// 2. Assign the HUMAN-READABLE text to loggedText
if (nextNode.data.type === 'text') {
    loggedText = nextNode.data.text;
} else if (nextNode.data.type === 'button') {
    // For buttons, we log the Body text so the admin can see what was asked
    loggedText = nextNode.data.buttonBody || 'Button Message';
} else if (nextNode.data.type === 'list') {
    loggedText = nextNode.data.listBody || 'List Message';
} else if (nextNode.data.type === 'media') {
    loggedText = nextNode.data.mediaCaption || 'Media Message';
}

// 3. Now your existing Save logic will work perfectly
await Message.create({
  userId,
  contactId,
  from: 'bot',
  type: msgData.type === 'text' ? 'text' : 'interactive',
  text: loggedText, // ✅ Now this contains "Welcome!" instead of "button-uuid..."
  metadata,
  metaMessageId,
  status: 'sent',
  isReadByAdmin: true,
  timestamp: new Date(),
});
      } catch (err) {
        console.error('🔥 Send error:', err.message);
      }

      currentId = nextNode.id;

      // Stop after button/list — wait for user's next reply
      if (msgData.type === 'button' || msgData.type === 'list') {
        break;
      }

      continue;
    }

    // Unknown node type — just move forward
    currentId = nextNode.id;
  }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));