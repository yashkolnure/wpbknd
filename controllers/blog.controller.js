import Blog from "../models/Blog.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const toSlug = (text) =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const calcReadingTime = (html) => {
  const words = html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
};

const ensureUniqueSlug = async (base, excludeId = null) => {
  let slug = base;
  let i = 1;
  while (true) {
    const query = { slug };
    if (excludeId) query._id = { $ne: excludeId };
    const exists = await Blog.findOne(query);
    if (!exists) return slug;
    slug = `${base}-${i++}`;
  }
};

// ─── Public ──────────────────────────────────────────────────────────────────

// GET /api/blogs  — published, paginated, filterable
export const getPublishedBlogs = async (req, res) => {
  try {
    const { page = 1, limit = 9, category, search, featured } = req.query;
    const filter = { status: "published" };

    if (category && category !== "All") filter.category = category;
    if (featured === "true") filter.featured = true;
    if (search) {
      filter.$or = [
        { title:    { $regex: search, $options: "i" } },
        { excerpt:  { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
        { tags:     { $in: [new RegExp(search, "i")] } },
      ];
    }

    const [blogs, total] = await Promise.all([
      Blog.find(filter)
        .sort({ publishedAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select("-content"),          // don't send full content in list
      Blog.countDocuments(filter),
    ]);

    res.json({ blogs, total, pages: Math.ceil(total / limit), page: Number(page) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/blogs/categories  — distinct categories of published blogs
export const getCategories = async (req, res) => {
  try {
    const cats = await Blog.distinct("category", { status: "published" });
    res.json(cats.sort());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/blogs/:slug  — single published blog + increment views
export const getBlogBySlug = async (req, res) => {
  try {
    const blog = await Blog.findOneAndUpdate(
      { slug: req.params.slug, status: "published" },
      { $inc: { views: 1 } },
      { new: true }
    );
    if (!blog) return res.status(404).json({ message: "Blog not found." });
    res.json(blog);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/blogs/:slug/related  — same category, exclude self
export const getRelatedBlogs = async (req, res) => {
  try {
    const blog = await Blog.findOne({ slug: req.params.slug, status: "published" }).select("category tags _id");
    if (!blog) return res.json([]);

    const related = await Blog.find({
      status: "published",
      _id: { $ne: blog._id },
      $or: [
        { category: blog.category },
        { tags: { $in: blog.tags } },
      ],
    })
      .sort({ publishedAt: -1 })
      .limit(3)
      .select("-content");

    res.json(related);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Admin (protect + superAdmin) ────────────────────────────────────────────

// GET /api/admin/blogs
export const adminGetAllBlogs = async (req, res) => {
  try {
    const blogs = await Blog.find().sort({ createdAt: -1 }).select("-content");
    res.json(blogs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/admin/blogs/:id  — full blog for editing
export const adminGetBlog = async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ message: "Not found." });
    res.json(blog);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/admin/blogs
export const createBlog = async (req, res) => {
  try {
    const { title, content } = req.body;
    const baseSlug = req.body.slug ? toSlug(req.body.slug) : toSlug(title);
    const slug = await ensureUniqueSlug(baseSlug);

    const blog = await Blog.create({
      ...req.body,
      slug,
      readingTime: calcReadingTime(content),
      publishedAt: req.body.status === "published" ? new Date() : undefined,
      author: req.body.author || req.user?.name || "WPLeads Team",
    });

    res.status(201).json(blog);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/admin/blogs/:id
export const updateBlog = async (req, res) => {
  try {
    const existing = await Blog.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: "Not found." });

    const baseSlug = req.body.slug ? toSlug(req.body.slug) : toSlug(req.body.title || existing.title);
    const slug = await ensureUniqueSlug(baseSlug, req.params.id);

    // Set publishedAt if switching to published for first time
    const publishedAt =
      req.body.status === "published" && !existing.publishedAt
        ? new Date()
        : existing.publishedAt;

    const updated = await Blog.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        slug,
        publishedAt,
        readingTime: calcReadingTime(req.body.content || existing.content),
      },
      { new: true }
    );

    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/admin/blogs/:id
export const deleteBlog = async (req, res) => {
  try {
    await Blog.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/admin/blogs/:id/toggle-status
export const toggleStatus = async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ message: "Not found." });

    blog.status = blog.status === "published" ? "draft" : "published";
    if (blog.status === "published" && !blog.publishedAt) blog.publishedAt = new Date();
    await blog.save();

    res.json({ status: blog.status });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/admin/blogs/:id/toggle-featured
export const toggleFeatured = async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ message: "Not found." });

    blog.featured = !blog.featured;
    await blog.save();

    res.json({ featured: blog.featured });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
