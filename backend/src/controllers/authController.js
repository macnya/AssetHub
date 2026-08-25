const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { ROLES } = require('../middleware/authMiddleware');
const crypto = require('crypto');

// One place, so the create form, the self-service change and the admin reset
// can't disagree. Raised from 6: an admin-issued starter password gets typed
// by someone else and lives in a chat message until it's changed.
const MIN_PASSWORD_LENGTH = 8;

// Register a new IT staff member (use this once to create your first admin, then restrict/remove access later)
async function register(req, res) {
  const { name, email, password, role, branch } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }

  // A Branch Administrator with no branch would see nothing at all — the scope
  // fails closed. Better to refuse the account than create a broken one.
  if (role === ROLES.BRANCH_ADMIN && !branch) {
    return res.status(400).json({
      error: 'A Branch Administrator must be given a branch',
    });
  }

  try {
    const existing = await pool.query('SELECT id FROM it_staff WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    // must_change_password starts true: whoever the admin creates this for
    // did not choose this password, and it has almost certainly been sent to
    // them over WhatsApp or read out loud.
    const result = await pool.query(
      `INSERT INTO it_staff (name, email, password_hash, role, branch, must_change_password, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW())
       RETURNING id, name, email, role, branch, must_change_password`,
      [name, email.trim().toLowerCase(), password_hash, role || ROLES.OFFICER, branch || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during registration' });
  }
}

// Log in an existing IT staff member
async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await pool.query('SELECT * FROM it_staff WHERE LOWER(email) = LOWER($1)', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      // The client uses must_change_password to route straight to the change
      // screen. The flag is advisory for the UI only — the endpoints below are
      // what actually enforce anything.
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        branch: user.branch || null,
        must_change_password: user.must_change_password === true,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
}

// GET /auth/users
async function getUsers(req, res) {
  try {
    const result = await pool.query(
      `SELECT
          id,
          name,
          email,
          role,
          branch,
          created_at,
          must_change_password,
          password_changed_at
       FROM it_staff
       ORDER BY created_at DESC`
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to fetch users"
    });
  }
}

// PUT /auth/users/:id/role — change a user's role
async function updateUserRole(req, res) {
  const { id } = req.params;
  const { role, branch } = req.body;

  const validRoles = Object.values(ROLES);

  if (!role || !validRoles.includes(role)) {
    return res.status(400).json({
      error: `role is required and must be one of: ${validRoles.join(', ')}`,
    });
  }

  try {
    // Branch only means something for a Branch Administrator. Clearing it for
    // every other role stops a stale value sitting on an account and quietly
    // taking effect if they're moved back later.
    const nextBranch = role === ROLES.BRANCH_ADMIN ? (branch || null) : null;

    if (role === ROLES.BRANCH_ADMIN && !nextBranch) {
      return res.status(400).json({ error: 'A Branch Administrator must be given a branch' });
    }

    const result = await pool.query(
      `UPDATE it_staff
       SET role = $1, branch = $2
       WHERE id = $3
       RETURNING id, name, email, role, branch, created_at`,
      [role, nextBranch, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update user role' });
  }
}

// DELETE /auth/users/:id — delete a user (cannot delete yourself)
async function deleteUser(req, res) {
  const { id } = req.params;

  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  try {
    const result = await pool.query(
      `DELETE FROM it_staff WHERE id = $1 RETURNING id, name, email, role`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User deleted', user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
}

// POST /auth/refresh — issue a fresh 8h token, as long as the current one hasn't expired yet.
// req.user is populated by verifyToken, which already rejects expired/invalid tokens before this runs.
async function refreshToken(req, res) {
  try {
    // Re-check the user still exists and hasn't been deleted/disabled since the original token was issued
    const result = await pool.query(
      'SELECT id, name, email, role, branch, must_change_password FROM it_staff WHERE id = $1',
      [req.user.id]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during token refresh' });
  }
}

// POST /auth/change-password — the account holder changes their own password.
//
// Requires the CURRENT password even though the caller already holds a valid
// token. Without that, anyone who got hold of a token — a shared laptop, a
// phone left unlocked — could change the password and lock the real owner out.
async function changePassword(req, res) {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password are both required' });
  }

  if (new_password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }

  if (current_password === new_password) {
    return res.status(400).json({ error: 'The new password must be different from the current one' });
  }

  try {
    const result = await pool.query('SELECT password_hash FROM it_staff WHERE id = $1', [req.user.id]);
    const row = result.rows[0];
    if (!row) return res.status(401).json({ error: 'Account no longer exists' });

    const ok = await bcrypt.compare(current_password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Your current password is not correct' });

    const password_hash = await bcrypt.hash(new_password, 10);

    await pool.query(
      `UPDATE it_staff
       SET password_hash = $1, must_change_password = false, password_changed_at = NOW()
       WHERE id = $2`,
      [password_hash, req.user.id]
    );

    res.json({ message: 'Password changed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to change password' });
  }
}

// POST /auth/users/:id/reset-password — admin sets a temporary password.
//
// Deliberately forces a change on next sign-in. A reset that leaves the
// admin's chosen password in place just replaces one shared secret with
// another, and the admin would know the staff member's password indefinitely.
async function resetUserPassword(req, res) {
  const { id } = req.params;
  const { new_password } = req.body;

  if (!new_password || new_password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `A temporary password of at least ${MIN_PASSWORD_LENGTH} characters is required`,
    });
  }

  try {
    const password_hash = await bcrypt.hash(new_password, 10);

    const result = await pool.query(
      `UPDATE it_staff
       SET password_hash = $1, must_change_password = true, password_changed_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, role`,
      [password_hash, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: 'Temporary password set. They will be asked to choose a new one when they sign in.',
      user: result.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reset this password' });
  }
}

// POST /auth/service-token — mint a short-lived token for a trusted service.
//
// WHY THIS EXISTS
// The Slack bot acts on behalf of a member of staff, but has no password for
// them, so it cannot sign in the normal way. Without this it would have to
// query the database itself — which is exactly the duplication that let the
// bot's answers drift from the panel's.
//
// WHY IT IS NARROW
// A shared secret that can mint a token for any user is a powerful thing, so
// this is deliberately constrained:
//
//   - It only ever issues tokens for accounts that already exist.
//   - Tokens last five minutes, not eight hours. Long enough to answer a
//     question, not long enough to be worth stealing.
//   - Every issuance is logged with the email it was issued for, so "who asked
//     what as whom" is answerable.
//   - The secret must be at least 32 characters, or the endpoint refuses to
//     work at all rather than accepting a weak one.
//
// The token carries no more authority than the user's own: verifyToken reads
// role and branch from the database on every request, so a Branch
// Administrator's service token is scoped exactly as their own session is.
async function issueServiceToken(req, res) {
  const secret = process.env.BOT_SERVICE_SECRET;
  const { service_secret, email } = req.body;

  // Refusing on a weak secret rather than accepting it: a 6-character shared
  // secret protecting token issuance is worse than no feature.
  if (!secret || secret.length < 32) {
    console.error('BOT_SERVICE_SECRET is missing or shorter than 32 characters.');
    return res.status(503).json({ error: 'Service tokens are not configured on this server' });
  }

  if (!service_secret || !email) {
    return res.status(400).json({ error: 'service_secret and email are required' });
  }

  // Constant-time comparison, so a wrong secret cannot be discovered a
  // character at a time by measuring how long the check takes.
  const a = Buffer.from(String(service_secret));
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn(`Service token refused: bad secret, requested for ${email}`);
    return res.status(401).json({ error: 'Not authorised' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, email, role, branch FROM it_staff WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'No staff account with that email' });
    }

    const user = rows[0];

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, via: 'service' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );

    console.log(`Service token issued for ${user.email} (${user.role})`);

    res.json({ token, role: user.role, branch: user.branch });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not issue a service token' });
  }
}

module.exports = {
  issueServiceToken, register, login, getUsers, updateUserRole, deleteUser, refreshToken,
  changePassword, resetUserPassword,
};