import express from 'express';
import {
  createWorkflow,
  getWorkflows,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  toggleWorkflow,
  simulateWorkflow,
} from '../controllers/workflowController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.post  ('/',             protect, createWorkflow);
router.get   ('/',             protect, getWorkflows);
router.get   ('/:id',          protect, getWorkflow);
router.put   ('/:id',          protect, updateWorkflow);
router.delete('/:id',          protect, deleteWorkflow);
router.patch ('/:id/toggle',   protect, toggleWorkflow);
router.post  ('/:id/simulate', protect, simulateWorkflow);

export default router;