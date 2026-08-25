const express = require('express');
const router = express.Router();

const {
  getVerificationReport,
  updateVerification,
  approveVerification,
  rejectVerification,
  getPendingCount,
} = require('../controllers/verificationController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', getVerificationReport);

// Drives the badge in the navigation, so every authenticated user may call it —
// it returns their own reviewable count, which is zero for non-admins.
router.get('/pending/count', getPendingCount);

// Approving is an Admin action, and the endpoint additionally refuses a
// self-approval. A CHECK constraint on the table enforces the same rule, so
// this failing open would still not permit one.
router.post('/:id/approve', requireRole(ROLES.ADMIN), approveVerification);
router.post('/:id/reject', requireRole(ROLES.ADMIN), rejectVerification);

router.patch('/:id', requireRole(ROLES.ADMIN), updateVerification);

module.exports = router;