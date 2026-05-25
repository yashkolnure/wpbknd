import mongoose from 'mongoose';

const buttonSchema = new mongoose.Schema({
  id:    { type: String, required: true },   // "btn_uuid"
  title: { type: String, required: true },   // max 20 chars
}, { _id: false });

const rowSchema = new mongoose.Schema({
  id:           { type: String, required: true },
  title:        { type: String, required: true },   // max 24 chars
  description:  { type: String, default: '' },      // max 72 chars
}, { _id: false });

const sectionSchema = new mongoose.Schema({
  title: { type: String, required: true },
  rows:  [rowSchema],
}, { _id: false });

// Product-list section: contains product retailer IDs instead of rows
const productItemSchema = new mongoose.Schema({
  id:         { type: String },
  retailerId: { type: String },
}, { _id: false });

const productSectionSchema = new mongoose.Schema({
  id:       { type: String },
  title:    { type: String, default: '' },
  products: [productItemSchema],
}, { _id: false });

const messageSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['text', 'button', 'list', 'media', 'product', 'product_list'],
    required: true,
  },
  // --- text ---
  text: String,

  // --- button ---
  buttonHeader: String,
  buttonBody:   String,
  buttonFooter: String,
  buttons:      [buttonSchema],   // max 3

  // --- list ---
  listHeader:   String,
  listBody:     String,
  listFooter:   String,
  listButtonText: String,         // text on the "View options" button
  sections:     [sectionSchema],  // max 10 sections, 10 rows each

  // --- media ---
  mediaType:    { type: String, enum: ['image', 'video', 'document'] },
  mediaUrl:     String,
  mediaCaption: String,
  mediaId:      String,
  mediaFilename: String,

  // --- product / product_list ---
  catalogId:          String,
  body:               String,   // body text shown to customer
  productRetailerId:  String,   // single product only
  header:             String,   // product_list header
  footer:             String,   // product_list footer
  productSections:    [productSectionSchema],  // product_list sections
}, { _id: false });

const nodeSchema = new mongoose.Schema({
  id:       { type: String, required: true },
  type:     { type: String, enum: ['trigger', 'message', 'delay'], required: true },
  position: { x: Number, y: Number },
  data: {
    // trigger fields
    keyword:      String,
    matchType:    { type: String, enum: ['exact', 'contains'], default: 'contains' },
    // message fields
    message:      messageSchema,
    // delay fields
    delayMinutes: Number,
  },
}, { _id: false });

// ─── UPDATED EDGE SCHEMA ──────────────────────────────────────────────────
const edgeSchema = new mongoose.Schema({
  id:           String,
  source:       String,
  target:       String,
  // ✅ sourceHandle stores the specific button/list ID from React Flow
  sourceHandle: { type: String, default: null }, 
}, { _id: false });

const workflowSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:     { type: String, required: true },
  isActive: { type: Boolean, default: true },
  nodes:    [nodeSchema],
  edges:    [edgeSchema],
}, { timestamps: true });

export default mongoose.model('Workflow', workflowSchema);