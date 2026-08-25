const express = require('express');
const router = express.Router();
const { getAllLocations, createLocation, getBranchTree } = require('../controllers/locationController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);
router.get('/', getAllLocations);

// The structure with asset counts. Scoped like everything else, so a Branch
// Administrator sees only their own branch here too.
router.get('/branches', getBranchTree);

router.post('/', requireRole(ROLES.ADMIN), createLocation);

module.exports = router;