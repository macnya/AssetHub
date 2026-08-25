const express = require('express');
const router = express.Router();

const {
  listClearances, getClearance, getEmployeeHoldings,
  openClearance, resolveItem, completeClearance,
} = require('../controllers/clearanceController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);

// Branch Administrators and Auditors can see clearances; the controller scopes
// a Branch Administrator to their own branch.
router.get('/', listClearances);
router.get('/holdings/:employee_id', getEmployeeHoldings);
router.get('/:id', getClearance);

// Opening and closing a clearance is a P&C and Admin act. 8.10.1 requires the
// handover to be with a P&C representative, so this is not a field action.
router.post('/', requireRole(ROLES.ADMIN), openClearance);
router.post('/:id/complete', requireRole(ROLES.ADMIN), completeClearance);

// Recording what happened to each item can be done by an officer receiving
// equipment back, as well as by an admin.
router.patch('/:id/items/:item_id', requireRole(ROLES.ADMIN, ROLES.OFFICER), resolveItem);

module.exports = router;