import express from 'express';
import { createBulkCampaign, getBulkCampaigns } from '../controllers/bulkController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get ('/', protect, getBulkCampaigns);
router.post('/', protect, createBulkCampaign);

export default router;
