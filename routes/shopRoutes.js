import express from 'express';
import { protect } from '../middleware/auth.js';
import {
  createCatalog,
  getCatalog,
  saveCatalog,
  deleteCatalog,
  getProducts,
  addProduct,
  updateProduct,
  deleteProduct,
  getCommerceSettings,
  updateCommerceSettings,
} from '../controllers/shopController.js';

const router = express.Router();

// Catalog
router.post  ('/catalog/create',       protect, createCatalog);
router.get   ('/catalog',              protect, getCatalog);
router.post  ('/catalog',              protect, saveCatalog);
router.delete('/catalog',              protect, deleteCatalog);

// Products (all scoped to user's catalogId from DB)
router.get   ('/products',             protect, getProducts);
router.post  ('/products',             protect, addProduct);
router.patch ('/products/:productId',  protect, updateProduct);
router.delete('/products/:productId',  protect, deleteProduct);

// Commerce settings (phone-number level — enables Commerce tab in WhatsApp chat)
router.get   ('/commerce-settings',    protect, getCommerceSettings);
router.post  ('/commerce-settings',    protect, updateCommerceSettings);   // Fix #10: new

export default router;
