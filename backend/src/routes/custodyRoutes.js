const express = require('express');
const router = express.Router();

const {
  requestChange, getPending, approve, reject, getForAsset,
} = require('../controllers/custodyController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);

// Anyone who works with assets in the field may request a change. Nothing they
// request takes effect until it is approved, so the gate that matters is on
// approval rather than on asking.
router.post('/request',
  requireRole(ROLES.ADMIN, ROLES.OFFICER, ROLES.BRANCH_ADMIN), requestChange);

router.get('/pending', requireRole(ROLES.ADMIN), getPending);
router.get('/asset/:asset_id', getForAsset);

// Approving is an Admin act, and the endpoint additionally refuses a
// self-approval. A CHECK constraint on the table enforces the same rule.
router.post('/:id/approve', requireRole(ROLES.ADMIN), approve);
router.post('/:id/reject', requireRole(ROLES.ADMIN), reject);

module.exports = router;