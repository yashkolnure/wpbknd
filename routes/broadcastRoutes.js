import express from 'express';
import { createCampaign, getCampaigns, getContactTags, getActive24Count } from '../controllers/broadcastController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get('/tags',       protect, getContactTags);
router.get('/active24',   protect, getActive24Count);
router.get('/',           protect, getCampaigns);
router.post('/',          protect, createCampaign);

export default router;
