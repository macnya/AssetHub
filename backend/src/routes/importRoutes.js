const express = require('express');
const multer = require('multer');
const router = express.Router();

const { preview, apply, getBatches } = require('../controllers/importController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

// In memory, not on disk. The file is parsed and discarded within the request,
// so there is nothing to clean up and nothing left behind on a shared instance.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx, .xls and .csv files can be imported'), ok);
  },
});

router.use(verifyToken);

// Import is an Admin act. It can alter thousands of records at once, which is
// more consequential than anything else in the system.
router.post('/preview', requireRole(ROLES.ADMIN), upload.single('file'), preview);
router.post('/apply', requireRole(ROLES.ADMIN), apply);
router.get('/batches', requireRole(ROLES.ADMIN, ROLES.AUDITOR), getBatches);

module.exports = router;