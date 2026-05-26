import mongoose from "mongoose";

const blogSchema = new mongoose.Schema(
  {
    title:           { type: String, required: true, trim: true },
    slug:            { type: String, required: true, unique: true, lowercase: true, trim: true },
    content:         { type: String, required: true },
    excerpt:         { type: String, trim: true },
    thumbnail:       { type: String },
    author:          { type: String, default: "WPLeads Team" },
    category:        { type: String, default: "General", trim: true },
    tags:            [{ type: String }],
    status:          { type: String, enum: ["draft", "published"], default: "draft" },
    featured:        { type: Boolean, default: false },
    readingTime:     { type: Number, default: 1 },
    views:           { type: Number, default: 0 },
    publishedAt:     { type: Date },
    // SEO
    metaTitle:       { type: String },
    metaDescription: { type: String },
    metaKeywords:    { type: String },
  },
  { timestamps: true }
);

blogSchema.index({ status: 1, publishedAt: -1 });
blogSchema.index({ category: 1, status: 1 });
blogSchema.index({ featured: 1, status: 1 });

export default mongoose.model("Blog", blogSchema);
