const express = require('express');
const router = express.Router();

const { getDashboardStats, getAssetLocations, getSummaryReportPdf } = require('../controllers/dashboardController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

// All authenticated roles can view the dashboard (Admin, Officer, Branch Manager, Auditor)
router.use(verifyToken);
router.get('/stats', getDashboardStats);
router.get('/asset-locations', getAssetLocations);
router.get('/report/pdf', requireRole(ROLES.ADMIN), getSummaryReportPdf);

module.exports = router;