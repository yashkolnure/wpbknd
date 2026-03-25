import Contact from '../models/Contact.js';

// GET /api/contacts
export const getContacts = async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const query = { userId: req.user._id };

    if (search) {
      query.$or = [
        { phone: { $regex: search, $options: 'i' } },
        { name:  { $regex: search, $options: 'i' } },
      ];
    }

    const total    = await Contact.countDocuments(query);
    const contacts = await Contact.find(query)
      .sort('-lastActive')
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.json({ contacts, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/contacts/:id
export const getContact = async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, userId: req.user._id });
    if (!contact) return res.status(404).json({ message: 'Contact not found' });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/contacts/:id
export const updateContact = async (req, res) => {
  try {
    const { name, notes, tags } = req.body;
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { name, notes, tags } },
      { new: true }
    );
    if (!contact) return res.status(404).json({ message: 'Contact not found' });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/contacts/:id
export const deleteContact = async (req, res) => {
  try {
    await Contact.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ message: 'Contact deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/contacts/stats
export const getContactStats = async (req, res) => {
  try {
    const userId = req.user._id;
    const total  = await Contact.countDocuments({ userId });
    const today  = new Date(); today.setHours(0, 0, 0, 0);
    const newToday = await Contact.countDocuments({ userId, createdAt: { $gte: today } });
    const activeThisWeek = await Contact.countDocuments({
      userId,
      lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    });
    res.json({ total, newToday, activeThisWeek });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};