const express = require('express');
const router = express.Router();

const { getActivity, getActions } = require('../controllers/activityController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);

// Admin and Auditor. Accountability is what an Auditor is for, so they see the
// same trail an administrator does — including who approved whose work.
//
// A Branch Administrator is deliberately excluded: a trail of who did what,
// scoped to one branch, is a supervision tool rather than an audit one, and
// that is a decision for the organisation rather than a default.
const canSee = requireRole(ROLES.ADMIN, ROLES.AUDITOR);

router.get('/', canSee, getActivity);
router.get('/actions', canSee, getActions);

module.exports = router;