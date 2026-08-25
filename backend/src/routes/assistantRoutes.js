const express = require('express');
const router = express.Router();
const { ask } = require('../controllers/assistantController');
const { verifyToken } = require('../middleware/authMiddleware');
const { loginLimiter } = require('../middleware/rateLimiter');

// Every authenticated role may ask. The endpoint answers within whatever the
// caller's own role and branch already permit, so an Auditor gets read-only
// facts and a Branch Administrator gets their own branch — the same as the panel.
//
// Rate limited because each call costs a model request, and a runaway client
// would spend money as well as load the database.
router.post('/', verifyToken, loginLimiter, ask);

module.exports = router;