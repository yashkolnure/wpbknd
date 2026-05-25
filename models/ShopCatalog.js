import mongoose from 'mongoose';

const shopCatalogSchema = new mongoose.Schema({
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  catalogId:       { type: String, required: true },
  name:            { type: String, default: '' },
  isActive:        { type: Boolean, default: true },
  ownedByPlatform: { type: Boolean, default: false }, // true = created via platform SYSTEM_USER_TOKEN
}, { timestamps: true });

export default mongoose.model('ShopCatalog', shopCatalogSchema);
