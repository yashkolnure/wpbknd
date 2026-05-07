import express from 'express';
import {
  getContacts,
  getContact,
  updateContact,
  deleteContact,
  getContactStats,
} from '../controllers/contactController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get   ('/stats',  protect, getContactStats);
router.get   ('/',       protect, getContacts);
router.get   ('/:id',    protect, getContact);
router.patch ('/:id',    protect, updateContact);
router.delete('/:id',    protect, deleteContact);

export default router;