import express from 'express';
import LeadForm from '../models/LeadForm.js';
import Lead from '../models/Lead.js';

const router = express.Router();

// ─── ADMIN: GET CONFIG ───
router.get('/config', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ message: "userId is required" });
  console.log("Fetching config for userId:", userId);

  try {
    const config = await LeadForm.findOne({ userId });
    res.json(config || { formTitle: "Lead Capture Form", fields: [], btnLabel: "Submit", slug: "" });
  } catch (err) {
    res.status(500).json({ message: "Server Error" });
  }
});

// ─── ADMIN: SAVE CONFIG ───
router.post('/config', async (req, res) => {
  const { fields, formTitle, btnLabel, slug, userId } = req.body;
  
  if (!userId) return res.status(400).json({ message: "userId is required" });

  const reserved = ["login", "dashboard", "api", "admin", "upgrade", "settings", "home"];
  if (slug && reserved.includes(slug.toLowerCase())) {
    return res.status(400).json({ message: "That URL name is reserved." });
  }

  try {
    const config = await LeadForm.findOneAndUpdate(
      { userId },
      { fields, formTitle, btnLabel, slug: slug?.toLowerCase().trim() },
      { upsert: true, new: true }
    );
    res.json(config);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "This URL is already taken by another user." });
    }
    res.status(500).json({ message: "Error saving form." });
  }
});

// ─── ADMIN: GET COLLECTED LEADS ───
router.get('/', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ message: "userId is required" });

  try {
    const leads = await Lead.find({ userId }).sort({ createdAt: -1 });
    res.json(leads);
  } catch (err) {
    res.status(500).json({ message: "Error fetching leads" });
  }
});

// ─── PUBLIC: FETCH FORM BY SLUG ───
router.get('/public/slug/:slug', async (req, res) => {
  try {
    const config = await LeadForm.findOne({ slug: req.params.slug.toLowerCase() });
    if (!config) return res.status(404).json({ message: "Form not found" });
    res.json(config);
  } catch (err) {
    res.status(500).json({ message: "Server Error" });
  }
});

// ─── PUBLIC: SUBMIT DATA ───
router.post('/submit/:userId', async (req, res) => {
  try {
    const newLead = new Lead({
      userId: req.params.userId,
      data: req.body, 
      sourceUrl: req.headers.referer || 'Direct'
    });
    await newLead.save();
    res.json({ success: true, message: "Submitted successfully!" });
  } catch (err) {
    res.status(500).json({ message: "Submission failed" });
  }
});

export default router;