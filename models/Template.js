import mongoose from 'mongoose';

const templateSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name:       { type: String, required: true },           // Meta template name (snake_case)
  metaId:     { type: String },                           // Meta template ID returned on creation
  category:   { type: String },
  language:   { type: String, default: 'en' },
  components: { type: mongoose.Schema.Types.Mixed },      // header/body/footer/buttons
  status:     { type: String, default: 'PENDING' },       // APPROVED | PENDING | REJECTED
}, { timestamps: true });

// One template name per user
templateSchema.index({ userId: 1, name: 1 }, { unique: true });

export default mongoose.model('Template', templateSchema);
