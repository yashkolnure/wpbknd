import Workflow from '../models/Workflow.js';
import { sendMessage } from './messageSender.js';
import Message from "../models/Message.js";

export const executeWorkflow = async (userId, incomingText, fromNumber, contactId) => {
  const workflows = await Workflow.find({ userId, isActive: true });

  for (const workflow of workflows) {
    const triggerNode = workflow.nodes.find(n => n.type === 'trigger');
    if (!triggerNode) continue;

    const { keyword, matchType } = triggerNode.data;
    const text = incomingText.toLowerCase().trim();
    const kw   = keyword.toLowerCase().trim();

    const matched =
      matchType === 'exact'    ? text === kw :
      matchType === 'contains' ? text.includes(kw) : false;

    if (!matched) continue;

    // Execute starting from trigger, passing the incoming text
    // so branch nodes can match button/row IDs
    await executeFromNode(workflow, triggerNode.id, incomingText, fromNumber, userId, contactId);
    console.log('Workflow executed:', workflow.name , 'for user:', userId, 'with incoming text:', incomingText);
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
      if (!nextEdge) break; 
    }

    const nextNode = nodeMap[nextEdge.target];
    if (!nextNode) break;

    if (nextNode.type === 'message') {
      const msgData = nextNode.data.message;
      
      // 1. Send the actual message via WhatsApp API
      await sendMessage(userId, fromNumber, msgData);
      
      // 2. LOG THE OUTGOING BOT MESSAGE TO DB
      // We determine what text to show in the dashboard based on message type
      let loggedText = "";
      let metadata = null;

      if (msgData.type === 'text') {
        loggedText = msgData.text;
      } else if (msgData.type === 'button') {
        loggedText = msgData.buttonBody; // Main body of the button msg
        metadata = {
          header: msgData.buttonHeader,
          buttons: msgData.buttons,
          footer: msgData.buttonFooter
        };
      } else if (msgData.type === 'list') {
        loggedText = msgData.listBody;
        metadata = {
          title: msgData.listTitle,
          sections: msgData.sections
        };
      }
console.log('Logging bot message to DB for user:', userId, 'Contact:', contactId, 'Text:', loggedText, 'Metadata:', metadata);
      try {
        await Message.create({
          userId,
          contactId,
          from: 'bot', // This is key for the UI layout
          type: msgData.type === 'text' ? 'text' : 'interactive',
          text: loggedText,
          metadata: metadata,
          timestamp: new Date()
        });
      } catch (dbErr) {
        console.error('Error logging bot message:', dbErr.message);
      }

      console.log('Sent message and logged to DB for user:', userId);
    }

    if (nextNode.type === 'delay') {
      await sleep(nextNode.data.delayMinutes * 60 * 1000);
    }

    currentId = nextNode.id;

    // After sending a branching node (button/list), stop and wait
    const msgType = nextNode.data?.message?.type;
    if (msgType === 'button' || msgType === 'list') break;
  }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));