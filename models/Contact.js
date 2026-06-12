import mongoose from 'mongoose';
const { Schema } = mongoose;
const contactSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  phone:         { type: String, required: true },
  name:          { type: String, default: '' },
  lastMessage:   { type: String, default: '' },
  lastActive:    { type: Date, default: Date.now },
  messageCount:  { type: Number, default: 1 },
  workflows:     [{ type: String }], // workflow names triggered
  tags:          [{ type: String }],
  activeWorkflowId: { type: Schema.Types.ObjectId, ref: 'Workflow', default: null },
  currentNodeId:    { type: String, default: null },
  // Collect-input session state
  awaitingInput:    { type: Boolean, default: false },
  awaitingInputVar: { type: String, default: null },       // variable name to store answer into
  awaitingInputType:{ type: String, default: 'text' },     // text | phone | email | number
  awaitingRetryMsg: { type: String, default: null },       // message on invalid input
  variables:        { type: Map, of: String, default: {} },// stored {{variables}} for this contact
  notes:            { type: String, default: '' },
  optedOut:         { type: Boolean, default: false },
}, { timestamps: true });

// One contact per phone per user
contactSchema.index({ userId: 1, phone: 1 }, { unique: true });

export default mongoose.model('Contact', contactSchema);