import express from 'express';
import { connect, getStatus, disconnect } from '../controllers/whatsappController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.post  ('/connect',    protect, connect);
router.get   ('/status',     protect, getStatus);
router.delete('/disconnect', protect, disconnect);


router.get('/webhook-info', protect, (req, res) => {
  res.json({
    webhookUrl:   `${process.env.BASE_URL}/api/webhook`,
    verifyToken:  process.env.WEBHOOK_VERIFY_TOKEN,
  });
});

export default router;