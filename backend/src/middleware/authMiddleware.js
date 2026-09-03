const jwt = require('jsonwebtoken');
const { db, runInOrgContext } = require('../db/context');

// Names have changed twice. "Branch Manager" became "Branch Administrator" —
// the role administers one branch's assets, as opposed to IT Admin who
// administers the whole register. "IT Officer" became "Administration
// Officer", since the people doing the scanning are administration staff
// rather than IT.
const ROLES = {
  ADMIN: 'Admin',
  OFFICER: 'Administration Officer',
  BRANCH_ADMIN: 'Branch Administrator',
  AUDITOR: 'Auditor',
  // Read-only like an Auditor, but the financial fields are the point: value,
  // depreciation, disposals, and what a leaver owes.
  FINANCE: 'Finance',
};

const LEGACY_ROLES = {
  'IT Admin': ROLES.ADMIN,
  'Branch Manager': ROLES.BRANCH_ADMIN,
  'IT Officer': ROLES.OFFICER,
};

// While must_change_password is set, these are the only paths that work.
// change-password is the way out; refresh is allowed so the session does not
// expire underneath somebody in the middle of setting a new one.
const CHANGE_PASSWORD_ONLY = ['/auth/change-password', '/auth/refresh'];

function canonicalRole(role) {
  return LEGACY_ROLES[role] || role;
}

function isAdminRole(role) {
  return canonicalRole(role) === ROLES.ADMIN;
}

// JWTs are stateless: once issued they stay valid for their full 8 hours no
// matter what happens to the account. That makes "reset this person's password
// because their account is compromised" only half work — whoever holds their
// current token keeps access until it expires.
//
// So after verifying the signature we look the account up. That gives us three
// things the token cannot: whether it was issued before the password changed,
// the CURRENT role, and the branch a scoped role is limited to. Reading role
// from the database rather than the token also means a demotion takes effect
// immediately instead of at the next sign-in.
//
// The cost is one indexed lookup per authenticated request — nothing next to
// the queries the request itself will run.
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

   let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // A platform token carries more authority than any tenant account and must
  // not be usable as one. Both tokens are signed with the same secret, so
  // without this check an operator token would satisfy verifyToken and act as
  // whichever staff id it happened to carry. platformAuth.js makes the
  // opposite check; both directions have to hold or the separation is only on
  // paper.
  if (decoded.aud === 'assethub-platform') {
    return res.status(403).json({ error: 'Not a staff token' });
  }

  // Tokens issued before organisations existed carry no org_id. There is no
  // safe guess to make, so they are refused and the person signs in again.
  if (!decoded.org_id) {
    return res.status(401).json({ error: 'Please sign in again.' });
  }
  // Everything from here runs inside one organisation's context, on one
  // connection, including the account lookup below and every query the route
  // will make. The lookup is itself filtered by that context, so an org_id
  // forged into a token finds no account rather than reaching another
  // organisation's data.
  runInOrgContext(decoded.org_id, async () => {
    const result = await db.query(
      'SELECT id, email, role, branch, org_id, password_changed_at, must_change_password FROM it_staff WHERE id = $1',
      [decoded.id]
    );
    const account = result.rows[0];

    if (!account) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }

    // jwt `iat` is in seconds; Date gives milliseconds. The one-second grace
    // covers a token issued in the same second as the change — without it,
    // changing your own password would invalidate the token you just used.
    if (account.password_changed_at) {
      const changedAt = Math.floor(new Date(account.password_changed_at).getTime() / 1000);
      if (decoded.iat && decoded.iat < changedAt - 1) {
        return res.status(401).json({ error: 'Password was changed. Please sign in again.' });
      }
    }

    // A temporary password gets you far enough to replace it and no further.
    //
    // login returns must_change_password and the admin panel redirects on it,
    // but nothing server-side enforced it: anyone who ignored the redirect, or
    // used the API directly, kept full access indefinitely on a password an
    // administrator had chosen for them and still knows.
    if (account.must_change_password
        && !CHANGE_PASSWORD_ONLY.includes(req.originalUrl.split('?')[0])) {
      return res.status(403).json({
        error: 'You must change your password before continuing',
        must_change_password: true,
      });
    }

    req.user = {
      id: account.id,
      email: account.email,
      role: canonicalRole(account.role),
      branch: account.branch || null,
      org_id: account.org_id,
    };

    // The promise settles when the response does, which is what holds the
    // connection and its transaction open for the whole request rather than
    // closing the moment next() returns. 'close' as well as 'finish' because
    // a client that hangs up mid-response fires only the former, and without
    // it the connection would be held until the pool timed it out.
    return new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    });
  }).catch((err) => {
    console.error('Auth check failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not verify your session' });
    }
  });
}

function requireAdmin(req, res, next) {
  if (!req.user || !isAdminRole(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// General-purpose role gate: requireRole(ROLES.ADMIN, ROLES.OFFICER)
function requireRole(...allowedRoles) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const mine = canonicalRole(req.user.role);
    if (!allowedRoles.map(canonicalRole).includes(mine)) {
      return res.status(403).json({
        error: `Access denied. Requires one of: ${allowedRoles.join(', ')}`,
      });
    }
    next();
  };
}

module.exports = { verifyToken, requireAdmin, requireRole, ROLES, canonicalRole, isAdminRole };