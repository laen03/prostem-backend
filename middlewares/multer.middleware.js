const multer = require('multer');
const path = require('path');
const fs = require('fs');

function ensurePath(...segments) {
  const uploadPath = path.join(__dirname, '..', 'uploads', ...segments);
  if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
  }
  return uploadPath;
}

// Profile pictures (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
});

// Base disk storage configuration
const baseDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, ensurePath());
  },
  filename: (req, file, cb) => {
    const uniqueSuffix =
      Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

// Documents (PDF, Word, PowerPoint)
const fileUpload = multer({
  storage: baseDiskStorage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.ppt', '.pptx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) {
      return cb(new Error('Only PDF, Word, and PowerPoint files are allowed'));
    }
    cb(null, true);
  },
});

// Payment receipts (images and PDF)
const paymentUpload = multer({
  storage: baseDiskStorage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) {
      return cb(
        new Error('Only JPG, JPEG, PNG, and PDF files are allowed')
      );
    }
    cb(null, true);
  },
});

// ZIP files
const zipUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, ensurePath('temp'));
    },
    filename: baseDiskStorage.filename,
  }),
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') {
      return cb(new Error('Only ZIP files are allowed'));
    }
    cb(null, true);
  },
});

// News images (JPEG, PNG, GIF)
const newsImageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, ensurePath('temp'));
    },
    filename: baseDiskStorage.filename,
  }),
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

module.exports = {
  upload,
  fileUpload,
  paymentUpload,
  zipUpload,
  newsImageUpload,
};