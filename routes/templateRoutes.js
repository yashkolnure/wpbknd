import express from 'express';
import { listTemplates, createTemplate, deleteTemplate, syncTemplates } from '../controllers/templateController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get   ('/',        protect, listTemplates);
router.post  ('/sync',    protect, syncTemplates);   // import all from Meta → DB
router.post  ('/',        protect, createTemplate);
router.delete('/:name',   protect, deleteTemplate);

export default router;
