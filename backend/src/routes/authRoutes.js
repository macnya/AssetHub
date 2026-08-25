const express = require('express');
const router = express.Router();

const {
  register,
  login,
  getUsers,
  updateUserRole,
  deleteUser,
  refreshToken,
  issueServiceToken,
  changePassword,
  resetUserPassword,
} = require('../controllers/authController');

const {
  verifyToken,
  requireAdmin,
} = require('../middleware/authMiddleware');

const { loginLimiter, perIpLoginLimiter, changePasswordLimiter } = require('../middleware/rateLimiter');

// Public route
router.post('/login', loginLimiter, login);

// Any authenticated user can refresh their own token before it expires
router.post('/refresh', verifyToken, refreshToken);

// Any authenticated user can change their OWN password. Not admin-gated on
// purpose: an officer forced to change a temporary password is not an admin,
// and the endpoint verifies their current password rather than their role.
//
// verifyToken runs BEFORE the limiter so the limiter can key on who they are
// rather than which office they're sitting in.
router.post('/change-password', verifyToken, changePasswordLimiter, changePassword);


// Admin protected routes
router.post('/register', verifyToken, requireAdmin, register);

router.get('/users', verifyToken, requireAdmin, getUsers);
router.put('/users/:id/role', verifyToken, requireAdmin, updateUserRole);
router.delete('/users/:id', verifyToken, requireAdmin, deleteUser);

// Sets a temporary password and forces a change on next sign-in.
router.post('/users/:id/reset-password', verifyToken, requireAdmin, resetUserPassword);

// Not behind verifyToken — this is how a service gets a token in the first
// place. Rate limited on IP, because the shared secret is the only thing
// standing in front of it.
router.post('/service-token', perIpLoginLimiter, issueServiceToken);


module.exports = router;