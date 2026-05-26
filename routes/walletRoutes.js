import express from 'express';
import { getWallet, createRechargeOrder, verifyRecharge } from '../controllers/walletController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get ('/',                  protect, getWallet);
router.post('/recharge/create-order', protect, createRechargeOrder);
router.post('/recharge/verify',   protect, verifyRecharge);

export default router;
