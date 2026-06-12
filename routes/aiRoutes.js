import express from 'express';
import { protect } from '../middleware/auth.js';
import { getAIProviders, getAIConfig, saveAIConfig, testAIConfig, deleteAIConfig } from '../controllers/aiController.js';

const router = express.Router();

router.get('/providers', getAIProviders); // unauthenticated build probe
router.get('/config',    protect, getAIConfig);
router.put('/config',    protect, saveAIConfig);
router.delete('/config', protect, deleteAIConfig);
router.post('/test',     protect, testAIConfig);

export default router;
