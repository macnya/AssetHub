const express = require('express');
const router = express.Router();
const { createDisposal, getAllDisposals } = require('../controllers/disposalController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);
router.get('/', getAllDisposals);
router.post('/', requireRole(ROLES.ADMIN), createDisposal);

module.exports = router;