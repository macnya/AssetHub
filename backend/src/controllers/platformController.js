// What the operator can do: see which organisations exist, how big they are,
// suspend one, and repair state that has drifted.
//
// What the operator cannot do: read anybody's register. Every query here goes
// through a function whose return type holds only numbers, dates and the
// organisation's own name — see migrations/012_platform_admin.sql. There is no
// argument that could make one of them return a row of somebody's data.

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db } = require('../db/context');
const { PLATFORM_AUDIENCE } = require('../middleware/platformAuth');

// POST /platform/login
async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const { rows } = await db.unscoped.query(
      'SELECT id, name, email, password_hash FROM platform_admin WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    const admin = rows[0];

    // Compare against a dummy hash when there is no such account, so that a
    // wrong email and a wrong password take the same time to fail. Otherwise
    // the difference tells a stranger which addresses are real.
    const hash = admin ? admin.password_hash : '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(password, hash);

    if (!admin || !ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: admin.id, email: admin.email, aud: PLATFORM_AUDIENCE },
      process.env.JWT_SECRET,
      { expiresIn: '4h' }   // shorter than a tenant session: more authority, less time
    );

    res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
}

// GET /platform/organisations
async function listOrganisations(req, res) {
  try {
    const { rows } = await db.unscoped.query('SELECT * FROM organisation_overview()');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not read the organisation list' });
  }
}

// PATCH /platform/organisations/:id/status
//
// Suspending stops sign-in for that organisation. Their data is untouched and
// their admins keep every right they had the moment service resumes — this is
// a billing lever, not a deletion.
async function setStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body;

  const allowed = ['trial', 'active', 'suspended', 'closed'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  try {
    const { rows } = await db.unscoped.query(
      'UPDATE organisation SET status = $1 WHERE id = $2 RETURNING id, code, name, status',
      [status, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No such organisation' });

    // Worth a line in the server log: this is a change one person made to
    // somebody else's ability to work.
    console.log(
      `Platform: ${req.platformAdmin.email} set ${rows[0].code} to ${status}`);

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not change the status' });
  }
}

// GET /platform/organisations/:id/drift
//
// asset.status is derived from disposal records, loss reports and open
// assignments, but stored on the asset. Nothing keeps the two in step, so a
// path that failed halfway or a row edited by hand leaves the column saying
// something the records disagree with — and the dashboard counts, which are
// computed from the column, are then quietly wrong.
//
// This reports the disagreement as counts. It does not fix anything.
async function statusDrift(req, res) {
  try {
    const { rows } = await db.unscoped.query(
      'SELECT * FROM asset_status_drift($1)', [req.params.id]);

    res.json({
      org_id: Number(req.params.id),
      total: rows.reduce((sum, r) => sum + Number(r.n), 0),
      breakdown: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check for drift' });
  }
}

// POST /platform/organisations/:id/reconcile
//
// Separate from the check above, deliberately: looking must never be the same
// action as changing. An operator sees the drift, decides, and then does this.
async function reconcile(req, res) {
  try {
    const { rows } = await db.unscoped.query(
      'SELECT asset_status_reconcile($1) AS changed', [req.params.id]);

    console.log(
      `Platform: ${req.platformAdmin.email} reconciled org ${req.params.id} — ${rows[0].changed} rows`);

    res.json({ org_id: Number(req.params.id), changed: Number(rows[0].changed) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not reconcile' });
  }
}

module.exports = { login, listOrganisations, setStatus, statusDrift, reconcile };
