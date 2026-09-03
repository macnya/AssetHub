const { db } = require('../db/context');
const { ASSET_CONDITIONS, isValidCondition } = require('../constants/assetConditions');
const { branchScopeFor } = require('../utils/scope');

// POST /assets/:asset_code/verify â€” record a physical inspection.
//
// The verification is written as PENDING. asset.condition is deliberately NOT
// updated here: what an officer observed is a claim until an admin who is not
// the officer has checked it. The register reflects approved observations only.
//
// The GPS recorded is the verifier's, captured where they stood. Approval never
// touches it, so the map continues to show where the asset actually was rather
// than where the approving admin was sitting.
async function verifyAsset(req, res) {
  const { asset_code } = req.params;
  const { condition, remarks, latitude, longitude } = req.body;

  if (!condition || !isValidCondition(condition)) {
    return res.status(400).json({
      error: `condition is required and must be one of: ${ASSET_CONDITIONS.join(', ')}`,
    });
  }

  try {
    const assetResult = await db.query(
      `SELECT a.id, l.branch
       FROM asset a
       LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
       LEFT JOIN location l ON l.id = ag.location_id
       WHERE a.asset_code = $1`,
      [asset_code]
    );
    if (assetResult.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    const asset = assetResult.rows[0];

    // A scoped role cannot verify an asset outside their own branch, even by
    // typing the code directly.
    const scopeBranch = branchScopeFor(req);
    if (scopeBranch && asset.branch !== scopeBranch) {
      return res.status(403).json({ error: 'This asset is not at your branch' });
    }

    const result = await db.query(
      `INSERT INTO asset_verification
         (asset_id, verified_by, condition, remarks, latitude, longitude, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [asset.id, req.user.id, condition, remarks || null, latitude ?? null, longitude ?? null]
    );

    res.status(201).json({
      ...result.rows[0],
      message: 'Recorded. An administrator will review it before the register is updated.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record verification' });
  }
}

// GET /verifications â€” report of verifications, with assignment, branch and GPS.
//
// ?status=pending narrows to the approval queue; the default shows everything
// so the report remains a complete record.
async function getVerificationReport(req, res) {
  const { branch, condition, from, to, status } = req.query;

  try {
    let query = `
      SELECT
        v.id, v.condition, v.remarks, v.latitude, v.longitude, v.verified_at,
        v.status, v.approved_at, v.rejection_reason,
        a.asset_code, a.description,
        s.name AS verified_by_name,
        s.role AS verified_by_role,
        ap.name AS approved_by_name,
        v.edited_at,
        ed.name AS edited_by_name,
        e.name AS assigned_to,
        l.branch, l.physical_location
      FROM asset_verification v
      JOIN asset a ON a.id = v.asset_id
      JOIN it_staff s ON s.id = v.verified_by
      LEFT JOIN it_staff ap ON ap.id = v.approved_by
      LEFT JOIN it_staff ed ON ed.id = v.edited_by
      LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
      LEFT JOIN employee e ON e.id = ag.employee_id
      LEFT JOIN location l ON l.id = ag.location_id
      WHERE 1=1
    `;
    const params = [];

    // Not user-supplied, so a scoped role can't widen their view with ?branch=
    const scopeBranch = branchScopeFor(req);
    if (scopeBranch) {
      params.push(scopeBranch);
      query += ` AND l.branch = $${params.length}`;
    }

    if (status) {
      params.push(status);
      query += ` AND v.status = $${params.length}`;
    }
    if (branch) {
      params.push(branch);
      query += ` AND l.branch = $${params.length}`;
    }
    if (condition) {
      params.push(condition);
      query += ` AND v.condition = $${params.length}`;
    }
    if (from) {
      params.push(from);
      query += ` AND v.verified_at >= $${params.length}`;
    }
    if (to) {
      // A date with no time component ("2026-08-06") compared with <= would
      // stop at midnight and exclude everything verified during that day, so
      // treat a bare date as "up to the end of that day".
      const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(to).trim());
      params.push(to);
      query += isDateOnly
        ? ` AND v.verified_at < (($${params.length})::date + INTERVAL '1 day')`
        : ` AND v.verified_at <= $${params.length}`;
    }

    query += ` ORDER BY v.verified_at DESC LIMIT 1000`;

    const result = await db.query(query, params);

    const rows = result.rows.map((r) => ({
      ...r,
      gps_link:
        r.latitude != null && r.longitude != null
          ? `https://www.google.com/maps?q=${r.latitude},${r.longitude}`
          : null,
    }));

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch verification report' });
  }
}

// GET /verifications/pending/count â€” for the badge in the navigation.
// Cheap enough to call on every page load; there is a partial index on status.
async function getPendingCount(req, res) {
  try {
    const [verifications, assets, custodyRequests] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS n FROM asset_verification
         WHERE status = 'pending' AND verified_by <> $1`,
        [req.user.id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS n FROM asset
         WHERE approval_status = 'pending'
           AND (created_by IS NULL OR created_by <> $1)`,
        [req.user.id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS n FROM custody_request
         WHERE status = 'pending' AND requested_by <> $1`,
        [req.user.id]
      ),
    ]);

    // Excludes the caller's own submissions, since they cannot approve those.
    // A badge counting work you are not allowed to do is just noise.
    res.json({
      verifications: verifications.rows[0].n,
      assets: assets.rows[0].n,
      custody: custodyRequests.rows[0].n,
      total: verifications.rows[0].n + assets.rows[0].n + custodyRequests.rows[0].n,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to count pending approvals' });
  }
}

// POST /verifications/:id/approve
//
// Four eyes. The database also refuses a self-approval via a CHECK constraint,
// so this check failing open would not be enough to bypass it.
async function approveVerification(req, res) {
  const { id } = req.params;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT v.id, v.asset_id, v.condition, v.status, v.verified_by, s.name AS verified_by_name
       FROM asset_verification v
       JOIN it_staff s ON s.id = v.verified_by
       WHERE v.id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Verification not found' });
    }

    const v = existing.rows[0];

    if (v.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This verification is already ${v.status}` });
    }

    if (v.verified_by === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'You cannot approve your own verification. Another administrator must review it.',
      });
    }

    const updated = await client.query(
      `UPDATE asset_verification
       SET status = 'approved', approved_by = $1, approved_at = NOW(), rejection_reason = NULL
       WHERE id = $2
       RETURNING *`,
      [req.user.id, id]
    );

    // asset.condition mirrors the most recent APPROVED verification. Approving
    // an older one out of order must not overwrite a newer approved result.
    const latest = await client.query(
      `SELECT id FROM asset_verification
       WHERE asset_id = $1 AND status = 'approved'
       ORDER BY verified_at DESC, id DESC
       LIMIT 1`,
      [v.asset_id]
    );
    const isLatest = latest.rows.length > 0 && String(latest.rows[0].id) === String(id);

    if (isLatest) {
      await client.query('UPDATE asset SET condition = $1 WHERE id = $2', [v.condition, v.asset_id]);
    }

    await client.query('COMMIT');

    res.json({
      ...updated.rows[0],
      applied_to_asset: isLatest,
      verified_by_name: v.verified_by_name,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to approve this verification' });
  } finally {
    client.release();
  }
}

// POST /verifications/:id/reject
//
// A rejection is kept rather than deleted. Somebody stood in front of that
// asset and recorded what they saw; that it was rejected, and why, is part of
// the record.
async function rejectVerification(req, res) {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A reason is required so the officer knows what to correct' });
  }

  try {
    const existing = await db.query(
      'SELECT status, verified_by FROM asset_verification WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Verification not found' });
    }
    if (existing.rows[0].status !== 'pending') {
      return res.status(409).json({ error: `This verification is already ${existing.rows[0].status}` });
    }
    if (existing.rows[0].verified_by === req.user.id) {
      return res.status(403).json({ error: 'You cannot review your own verification' });
    }

    const updated = await db.query(
      `UPDATE asset_verification
       SET status = 'rejected', approved_by = $1, approved_at = NOW(), rejection_reason = $2
       WHERE id = $3
       RETURNING *`,
      [req.user.id, String(reason).trim(), id]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reject this verification' });
  }
}

// GET /assets/:asset_code/verifications â€” verification history for one asset
async function getVerificationsForAsset(req, res) {
  const { asset_code } = req.params;
  try {
    const result = await db.query(
      `SELECT v.*, s.name AS verified_by_name, ap.name AS approved_by_name
       FROM asset_verification v
       JOIN asset a ON a.id = v.asset_id
       JOIN it_staff s ON s.id = v.verified_by
       LEFT JOIN it_staff ap ON ap.id = v.approved_by
       WHERE a.asset_code = $1
       ORDER BY v.verified_at DESC`,
      [asset_code]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch verification history' });
  }
}

// PATCH /verifications/:id â€” correct a condition or remarks entered by mistake.
//
// Admin only. The correction is RECORDED rather than applied silently: an asset
// register is an audit document, and "why did this go from Faulty to Good in
// March?" needs an answer better than "someone changed it".
async function updateVerification(req, res) {
  const { id } = req.params;
  const { condition, remarks } = req.body;

  if (!condition || !isValidCondition(condition)) {
    return res.status(400).json({
      error: `condition is required and must be one of: ${ASSET_CONDITIONS.join(', ')}`,
    });
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, asset_id, condition, status FROM asset_verification WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Verification not found' });
    }
    const { asset_id, status } = existing.rows[0];

    const updated = await client.query(
      `UPDATE asset_verification
       SET condition = $1, remarks = $2, edited_by = $3, edited_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [condition, remarks || null, req.user.id, id]
    );

    // asset.condition mirrors the most recent APPROVED verification. Correcting
    // an older record, or one still pending, must not overwrite the asset's
    // current state.
    const latest = await client.query(
      `SELECT id FROM asset_verification
       WHERE asset_id = $1 AND status = 'approved'
       ORDER BY verified_at DESC, id DESC
       LIMIT 1`,
      [asset_id]
    );
    const isLatest =
      status === 'approved' && latest.rows.length > 0 && String(latest.rows[0].id) === String(id);

    if (isLatest) {
      await client.query('UPDATE asset SET condition = $1 WHERE id = $2', [condition, asset_id]);
    }

    await client.query('COMMIT');

    res.json({ ...updated.rows[0], applied_to_asset: isLatest });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to update verification' });
  } finally {
    client.release();
  }
}

module.exports = {
  verifyAsset,
  getVerificationReport,
  getVerificationsForAsset,
  updateVerification,
  approveVerification,
  rejectVerification,
  getPendingCount,
};