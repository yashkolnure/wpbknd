import express     from 'express';
import multer      from 'multer';
import path        from 'path';
import fs          from 'fs';
import { fileURLToPath } from 'url';
import { protect } from '../middleware/auth.js';

const router   = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Storage: /uploads/<userId>/<timestamp>-<original> ─────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', req.user._id.toString());
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});

const ALLOWED = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/3gpp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB — WhatsApp's max
  fileFilter: (req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type ${file.mimetype} not allowed`));
  },
});

// POST /api/media/upload
router.post('/upload', protect, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  const BASE_URL  = process.env.API_BASE_URL || `http://localhost:5002`;
  const userId    = req.user._id.toString();
  const publicUrl = `${BASE_URL}/uploads/${userId}/${req.file.filename}`;

  res.json({
    url:      publicUrl,
    filename: req.file.originalname,
    size:     req.file.size,
    type:     req.file.mimetype,
  });
});

export default router;
