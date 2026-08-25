const express = require('express');
const router = express.Router();

const {
  getSummary, getDisposals, getLosses, getRecoverable, getExport,
} = require('../controllers/financeController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);

// Finance, Admin and Auditor. A Branch Administrator is deliberately excluded:
// branch-level value is visible on their own pages, and a reporting view keyed
// to reconciliation is not their job.
const canSee = requireRole(ROLES.FINANCE, ROLES.ADMIN, ROLES.AUDITOR);

router.get('/summary', canSee, getSummary);
router.get('/disposals', canSee, getDisposals);
router.get('/losses', canSee, getLosses);
router.get('/recoverable', canSee, getRecoverable);
router.get('/export', canSee, getExport);

module.exports = router;