import express from 'express';
import multer from 'multer';
import { listTemplates, createTemplate, deleteTemplate, syncTemplates } from '../controllers/templateController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB max

router.get   ('/',        protect, listTemplates);
router.post  ('/sync',    protect, syncTemplates);
router.post  ('/',        protect, upload.single('headerImage'), createTemplate);
router.delete('/:name',   protect, deleteTemplate);

export default router;
