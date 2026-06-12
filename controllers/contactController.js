import Contact from '../models/Contact.js';

// Build a query from shared filter params (used by getContacts + exportContacts)
function buildContactQuery(userId, { search, tags, filter } = {}) {
  const query = { userId };
  if (search) {
    query.$or = [
      { phone: { $regex: search, $options: 'i' } },
      { name:  { $regex: search, $options: 'i' } },
    ];
  }
  if (tags) {
    const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
    if (tagList.length) query.tags = { $all: tagList };
  }
  if (filter === 'active') {
    query.lastActive = { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
  } else if (filter === 'opted_out') {
    query.optedOut = true;
  }
  return query;
}

// GET /api/contacts
export const getContacts = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, tags, filter } = req.query;
    const query = buildContactQuery(req.user._id, { search, tags, filter });

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

// GET /api/contacts/export
export const exportContacts = async (req, res) => {
  try {
    const { search, tags, filter } = req.query;
    const query = buildContactQuery(req.user._id, { search, tags, filter });
    const contacts = await Contact.find(query).sort('-lastActive');
    const rows = ['Name,Phone,Tags,Messages,Last Active,Created'];
    for (const c of contacts) {
      rows.push([
        `"${(c.name || '').replace(/"/g, '""')}"`,
        c.phone,
        `"${(c.tags || []).join(';')}"`,
        c.messageCount,
        c.lastActive ? new Date(c.lastActive).toLocaleDateString() : '',
        new Date(c.createdAt).toLocaleDateString(),
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.send(rows.join('\n'));
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