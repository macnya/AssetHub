// Authentication for the operator, kept apart from the tenants'.
//
// A tenant token says "this person is staff of organisation 4". A platform
// token says "this person runs the service". They are not the same authority
// and must not be interchangeable, so the tokens carry a marker and each
// middleware refuses the other's.
//
// Without that, a tenant Admin who worked out the token format could reach the
// operator endpoints, and the separation would be decorative.

const jwt = require('jsonwebtoken');
const { db } = require('../db/context');

// Marker claim. verifyToken rejects a token carrying it, and this rejects one
// without it.
const PLATFORM_AUDIENCE = 'assethub-platform';

async function verifyPlatformToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  let decoded;
  try {
    decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (decoded.aud !== PLATFORM_AUDIENCE) {
    return res.status(403).json({ error: 'Not a platform token' });
  }

  try {
    // Re-read on every request, so removing an operator takes effect at once
    // rather than whenever their token happens to expire.
    const { rows } = await db.unscoped.query(
      'SELECT id, email, name FROM platform_admin WHERE id = $1', [decoded.id]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }

    req.platformAdmin = rows[0];

    // Best effort; a failed heartbeat should not fail the request.
    db.unscoped
      .query('UPDATE platform_admin SET last_seen_at = now() WHERE id = $1', [rows[0].id])
      .catch(() => {});

    next();
  } catch (err) {
    console.error('Platform auth failed:', err);
    res.status(500).json({ error: 'Could not verify your session' });
  }
}

module.exports = { verifyPlatformToken, PLATFORM_AUDIENCE };
