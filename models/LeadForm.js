import mongoose from 'mongoose';

const LeadFormSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  slug: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  formTitle: { type: String, default: "Lead Capture Form" },
  btnLabel: { type: String, default: "Submit" },
  fields: [{
    id: String,
    type: { type: String },
    label: String,
    placeholder: String,
    required: { type: Boolean, default: false },
    width: { type: String, default: "full" },
    options: String,
  }]
}, { timestamps: true });

export default mongoose.model('LeadForm', LeadFormSchema);