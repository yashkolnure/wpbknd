import Workflow from '../models/Workflow.js';
import { sendMessage } from './messageSender.js';
import Message from "../models/Message.js";
import Contact from '../models/Contact.js';

export const executeWorkflow = async (userId, incomingText, fromNumber, contactId) => {
  // 1. Fetch the contact to check for an active session (Current State)
  const contact = await Contact.findById(contactId);
  
  let workflow;
  let startNodeId;
  const cleanInput = (incomingText || "").trim();

  // ─── 2. SESSION RESUME LOGIC (For Variable Replies) ───
  if (contact?.activeWorkflowId && contact?.currentNodeId) {
    workflow = await Workflow.findOne({ _id: contact.activeWorkflowId, isActive: true });
    
    if (workflow) {
      const currentNode = workflow.nodes.find(n => n.id === contact.currentNodeId);
      const outgoingEdges = workflow.edges.filter(e => e.source === contact.currentNodeId);

      if (outgoingEdges.length > 0) {
        // Logic: Try to match a specific button/handle first
        const match = outgoingEdges.find(e => e.sourceHandle === cleanInput);
        
        if (match) {
          startNodeId = match.target;
        } else {
          // VARIABLE REPLY FIX:
          // If the last thing we sent was a standard message (not a button/list),
          // we assume ANY reply is the "answer" and move to the next node.
          const msgType = currentNode.data?.message?.type;
          if (msgType !== 'button' && msgType !== 'list') {
            startNodeId = outgoingEdges[0].target;
          }
        }
      }
    }
  }

  // ─── 3. KEYWORD TRIGGER LOGIC (Fallback if no active session) ───
  if (!startNodeId) {
    const workflows = await Workflow.find({ userId, isActive: true });

    for (const wf of workflows) {
      const triggerNode = wf.nodes.find(n => n.type === 'trigger');
      if (!triggerNode || !triggerNode.data?.keyword) continue;

      const { keyword, matchType } = triggerNode.data;
      const text = cleanInput.toLowerCase();
      const keywordsArray = keyword.split(',').map(k => k.toLowerCase().trim());

      const isKeywordMatch = keywordsArray.some(kw => {
        return matchType === 'exact' ? text === kw : text.includes(kw);
      });

      if (isKeywordMatch) {
        workflow = wf;
        startNodeId = triggerNode.id;
        break; 
      }
    }
  }

  // ─── 4. TRIGGER EXECUTION ───
  if (workflow && startNodeId) {
    await executeFromNode(
      workflow, 
      startNodeId, 
      incomingText, 
      fromNumber, 
      userId, 
      contactId
    );
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