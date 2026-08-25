const express = require('express');
const router = express.Router();
const { createLostAssetRecord, getAllLostAssets } = require('../controllers/lostAssetController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);
router.get('/', getAllLostAssets);
router.post('/', requireRole(ROLES.ADMIN), createLostAssetRecord);

module.exports = router;