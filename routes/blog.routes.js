import express from "express";
import { protect } from "../middleware/auth.js";
import { superAdmin } from "../middleware/superAdmin.js";
import {
  getPublishedBlogs,
  getCategories,
  getBlogBySlug,
  getRelatedBlogs,
  adminGetAllBlogs,
  adminGetBlog,
  createBlog,
  updateBlog,
  deleteBlog,
  toggleStatus,
  toggleFeatured,
} from "../controllers/blog.controller.js";

const router = express.Router();

// ── Public ───────────────────────────────────────────
router.get("/",                      getPublishedBlogs);
router.get("/categories",            getCategories);
router.get("/:slug/related",         getRelatedBlogs);
router.get("/:slug",                 getBlogBySlug);

// ── Admin ────────────────────────────────────────────
router.get(   "/admin/all",               protect, superAdmin, adminGetAllBlogs);
router.get(   "/admin/:id",               protect, superAdmin, adminGetBlog);
router.post(  "/admin",                   protect, superAdmin, createBlog);
router.put(   "/admin/:id",               protect, superAdmin, updateBlog);
router.delete("/admin/:id",               protect, superAdmin, deleteBlog);
router.patch( "/admin/:id/toggle-status", protect, superAdmin, toggleStatus);
router.patch( "/admin/:id/toggle-featured", protect, superAdmin, toggleFeatured);

export default router;
