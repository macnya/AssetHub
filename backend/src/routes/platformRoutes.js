const express = require('express');
const router = express.Router();

const { verifyPlatformToken } = require('../middleware/platformAuth');
const {
  login, listOrganisations, setStatus, statusDrift, reconcile,
} = require('../controllers/platformController');

const { perIpLoginLimiter } = require('../middleware/rateLimiter');

// The only route without a token, and the one worth rate limiting hardest:
// a platform account is the most valuable credential on the service.
router.post('/login', perIpLoginLimiter, login);

router.use(verifyPlatformToken);

router.get('/organisations', listOrganisations);
router.patch('/organisations/:id/status', setStatus);
router.get('/organisations/:id/drift', statusDrift);
router.post('/organisations/:id/reconcile', reconcile);

module.exports = router;
