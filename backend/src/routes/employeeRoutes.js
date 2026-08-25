const express = require('express');
const router = express.Router();
const { getAllEmployees, createEmployee } = require('../controllers/employeeController');
const { verifyToken, requireRole, ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);
router.get('/', getAllEmployees);
router.post('/', requireRole(ROLES.ADMIN), createEmployee);

module.exports = router;