import Workflow from '../models/Workflow.js';
import { buildMetaPayload } from '../services/messageBuilder.js';

// POST /api/workflows
export const createWorkflow = async (req, res) => {
  try {
    const { name, nodes, edges } = req.body;

    if (!name)            return res.status(400).json({ message: 'Workflow name is required' });
    if (!nodes?.length)   return res.status(400).json({ message: 'At least one node is required' });

    const trigger = nodes.find(n => n.type === 'trigger');
    if (!trigger)         return res.status(400).json({ message: 'A trigger node is required' });
    if (!trigger.data?.keyword) return res.status(400).json({ message: 'Trigger keyword is required' });

    const workflow = await Workflow.create({
      userId: req.user._id,
      name,
      nodes,
      edges: edges || [],
    });

    res.status(201).json(workflow);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/workflows
export const getWorkflows = async (req, res) => {
  try {
    const workflows = await Workflow.find({ userId: req.user._id })
      .sort('-createdAt')
      .select('name isActive nodes createdAt updatedAt');

    res.json(workflows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/workflows/:id
export const getWorkflow = async (req, res) => {
  try {
    const workflow = await Workflow.findOne({
      _id:    req.params.id,
      userId: req.user._id,
    });

    if (!workflow) return res.status(404).json({ message: 'Workflow not found' });

    res.json(workflow);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/workflows/:id
export const deleteWorkflow = async (req, res) => {
  try {
    const workflow = await Workflow.findOneAndDelete({
      _id:    req.params.id,
      userId: req.user._id,
    });

    if (!workflow) return res.status(404).json({ message: 'Workflow not found' });

    res.json({ message: 'Workflow deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/workflows/:id/toggle
export const toggleWorkflow = async (req, res) => {
  try {
    const workflow = await Workflow.findOne({
      _id:    req.params.id,
      userId: req.user._id,
    });

    if (!workflow) return res.status(404).json({ message: 'Workflow not found' });

    workflow.isActive = !workflow.isActive;
    await workflow.save();

    res.json({ isActive: workflow.isActive });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const updateWorkflow = async (req, res) => {
  try {
    const { name, nodes, edges } = req.body;
    const workflow = await Workflow.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { name, nodes, edges: edges || [] },
      { new: true }
    );
    if (!workflow) return res.status(404).json({ message: 'Workflow not found' });
    res.json(workflow);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/workflows/:id/simulate
export const simulateWorkflow = async (req, res) => {
  try {
    const { incomingText, branchPath = [] } = req.body;

    if (!incomingText?.trim()) {
      return res.status(400).json({ message: 'incomingText is required' });
    }

    const workflow = await Workflow.findOne({
      _id:    req.params.id,
      userId: req.user._id,
    });
    if (!workflow) return res.status(404).json({ message: 'Workflow not found' });

    const triggerNode = workflow.nodes.find(n => n.type === 'trigger');
    if (!triggerNode)  return res.status(400).json({ message: 'No trigger node found' });

    const { keyword, matchType } = triggerNode.data;
    const text = incomingText.toLowerCase().trim();
    const kw   = keyword.toLowerCase().trim();

    const matched =
      matchType === 'exact'    ? text === kw :
      matchType === 'contains' ? text.includes(kw) : false;

    if (!matched) {
      return res.json({
        matched: false,
        message: `Keyword "${keyword}" (${matchType}) did not match "${incomingText}"`,
        steps:   [],
      });
    }

    const nodeMap   = Object.fromEntries(workflow.nodes.map(n => [n.id, n]));
    const steps     = [];
    let currentId   = triggerNode.id;
    let branchIndex = 0;

    while (true) {
      const outgoingEdges = workflow.edges.filter(e => e.source === currentId);
      if (!outgoingEdges.length) break;

      let nextEdge;

      if (outgoingEdges.length === 1) {
        // Single path — just follow it regardless of sourceHandle
        nextEdge = outgoingEdges[0];
      } else {
        // Multiple paths — need user to pick
        const selectedHandle = branchPath[branchIndex];

        if (!selectedHandle) {
          // Not picked yet — ask frontend to show choices
          // Look up human-readable labels from the current node
          const currentNode  = nodeMap[currentId];
          const branches     = outgoingEdges.map(e => {
            const label = resolveBranchLabel(currentNode, e.sourceHandle);
            return { handle: e.sourceHandle, label };
          });

          steps.push({ type: 'branch_choice', nodeId: currentId, branches });
          break;
        }

        nextEdge = outgoingEdges.find(e => e.sourceHandle === selectedHandle);
        if (!nextEdge) break;
        branchIndex++;
      }

      const nextNode = nodeMap[nextEdge.target];
      if (!nextNode) break;

      if (nextNode.type === 'message') {
        let payload = null;
        try { payload = buildMetaPayload('PREVIEW', nextNode.data.message); } catch {}

        steps.push({
          nodeId:  nextNode.id,
          type:    nextNode.data.message?.type || 'message',
          payload,
        });

        // If this node has multiple outgoing edges, ask for branch choice next
        const nextOutgoing = workflow.edges.filter(e => e.source === nextNode.id);
        if (nextOutgoing.length > 1) {
          const selectedHandle = branchPath[branchIndex];
          if (!selectedHandle) {
            const branches = nextOutgoing.map(e => {
              const label = resolveBranchLabel(nextNode, e.sourceHandle);
              return { handle: e.sourceHandle, label };
            });
            steps.push({ type: 'branch_choice', nodeId: nextNode.id, branches });
            currentId = nextNode.id;
            break;
          }
          // User already picked — continue loop from this node
          currentId = nextNode.id;
          continue;
        }
      }

      if (nextNode.type === 'delay') {
        steps.push({
          nodeId:       nextNode.id,
          type:         'delay',
          delayMinutes: nextNode.data.delayMinutes,
        });
      }

      currentId = nextNode.id;
    }

    res.json({ matched: true, keyword, matchType, stepCount: steps.length, steps });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Helper — look up the human-readable label for a sourceHandle
const resolveBranchLabel = (node, handle) => {
  if (!node || !handle) return handle;

  const msg = node.data?.message;
  if (!msg) return handle;

  // Button message — match handle to button id
  if (msg.type === 'button' && msg.buttons?.length) {
    const btn = msg.buttons.find(b => b.id === handle);
    if (btn) return btn.title;
  }

  // List message — match handle to row id across all sections
  if (msg.type === 'list' && msg.sections?.length) {
    for (const section of msg.sections) {
      const row = section.rows?.find(r => r.id === handle);
      if (row) return row.title;
    }
  }

  return handle; // fallback to raw handle if not found
};