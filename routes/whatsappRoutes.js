import express from 'express';
import { connect, getStatus, disconnect, addPhoneNumber, requestOtp, verifyOtp, registerPhoneNumber, getOnboardingProgress, saveOnboardingProgress, clearOnboardingProgress, embeddedConnect } from '../controllers/whatsappController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.post  ('/connect',           protect, connect);
router.post  ('/embedded-connect',  protect, embeddedConnect);
router.get   ('/status',     protect, getStatus);
router.delete('/disconnect', protect, disconnect);


router.get   ('/onboarding',         protect, getOnboardingProgress);
router.put   ('/onboarding',         protect, saveOnboardingProgress);
router.delete('/onboarding',         protect, clearOnboardingProgress);

router.post('/numbers/add',         protect, addPhoneNumber);
router.post('/numbers/request-otp', protect, requestOtp);
router.post('/numbers/verify-otp',  protect, verifyOtp);
router.post('/numbers/register',    protect, registerPhoneNumber);

router.get('/webhook-info', protect, (req, res) => {
  res.json({
    webhookUrl:   `${process.env.BASE_URL}/api/webhook`,
    verifyToken:  process.env.WEBHOOK_VERIFY_TOKEN,
  });
});

export default router;