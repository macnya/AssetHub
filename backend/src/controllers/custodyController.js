const pool = require('../db/pool');
const { branchScopeFor } = require('../utils/scope');
const { ASSET_CONDITIONS, isValidCondition } = require('../constants/assetConditions');

// Custody changes, held for approval.
//
// Assigning an asset or returning it to storage does not alter the register
// directly. A request is recorded, and only when a second person approves it
// does the assignment change, the status move, and the scan log gain an entry.
//
// HR Manual 9.3a already requires permission from the head of department or
// branch manager before equipment moves. This is that permission, recorded
// rather than assumed.
//
// Nothing here writes to `assignment` until approval, so no existing query
// needs to learn about pending states — the register simply does not show a
// change that has not happened yet.

// POST /custody/request — ask to assign an asset, or return it to storage.
async function requestChange(req, res) {
  const {
    asset_id, kind,
    employee_id, location_id,
    condition, notes, latitude, longitude,
  } = req.body;

  if (!asset_id || !kind) {
    return res.status(400).json({ error: 'asset_id and kind are required' });
  }
  if (!['assign', 'return'].includes(kind)) {
    return res.status(400).json({ error: "kind must be 'assign' or 'return'" });
  }
  if (kind === 'assign' && !employee_id && !location_id) {
    return res.status(400).json({ error: 'Assign to either an employee or a location.' });
  }

  // The condition at handover is what makes HR 9.3b enforceable later, so it is
  // required rather than optional when equipment changes hands.
  if (kind === 'assign' && employee_id) {
    if (!condition || !isValidCondition(condition)) {
      return res.status(400).json({
        error: `A condition is required when issuing equipment to a person: ${ASSET_CONDITIONS.join(', ')}`,
      });
    }
  } else if (condition && !isValidCondition(condition)) {
    return res.status(400).json({
      error: `condition must be one of: ${ASSET_CONDITIONS.join(', ')}`,
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Where the asset is now, so the approver can see the move without
    // reconstructing it — and so the record stands even if custody changes
    // again before the request is reviewed.
    const current = await client.query(
      `SELECT ag.employee_id, ag.location_id, l.branch
       FROM assignment ag
       LEFT JOIN location l ON l.id = ag.location_id
       WHERE ag.asset_id = $1 AND ag.returned_date IS NULL
       LIMIT 1`,
      [asset_id]
    );
    const from = current.rows[0] || {};

    // A scoped role cannot move an asset that is not at their branch, even by
    // sending an asset_id directly.
    const scope = branchScopeFor(req);
    if (scope && from.branch && from.branch !== scope) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This asset is not at your branch' });
    }

    if (kind === 'return' && !current.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This asset is already in storage' });
    }

    const open = await client.query(
      `SELECT id, kind, requested_at FROM custody_request
       WHERE asset_id = $1 AND status = 'pending'`,
      [asset_id]
    );
    if (open.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'There is already a custody request waiting for approval on this asset',
        request_id: open.rows[0].id,
      });
    }

    const { rows } = await client.query(
      `INSERT INTO custody_request
         (asset_id, kind, to_employee_id, to_location_id,
          from_employee_id, from_location_id,
          condition_at_handover, notes, latitude, longitude, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        asset_id, kind,
        kind === 'assign' ? (employee_id || null) : null,
        kind === 'assign' ? (location_id || null) : null,
        from.employee_id || null,
        from.location_id || null,
        condition || null,
        notes || null,
        latitude ?? null,
        longitude ?? null,
        req.user.id,
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      ...rows[0],
      message: kind === 'assign'
        ? 'Recorded. An administrator will approve it before the register changes.'
        : 'Recorded. An administrator will approve the return before the register changes.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to record that request' });
  } finally {
    client.release();
  }
}

// GET /custody/pending — the approval queue.
//
// Excludes the caller's own requests: they cannot approve those, and a queue
// containing work you are forbidden to action is just noise.
async function getPending(req, res) {
  const scope = branchScopeFor(req);

  try {
    const { rows } = await pool.query(
      `SELECT r.*,
              a.asset_code, a.description, a.condition AS current_condition,
              ac.name AS category,
              te.name AS to_employee, tl.branch AS to_branch,
              tl.physical_location AS to_place,
              fe.name AS from_employee, fl.branch AS from_branch,
              fl.physical_location AS from_place,
              s.name AS requested_by_name, s.role AS requested_by_role
       FROM custody_request r
       JOIN asset a ON a.id = r.asset_id
       LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
       LEFT JOIN employee te ON te.id = r.to_employee_id
       LEFT JOIN location tl ON tl.id = r.to_location_id
       LEFT JOIN employee fe ON fe.id = r.from_employee_id
       LEFT JOIN location fl ON fl.id = r.from_location_id
       JOIN it_staff s ON s.id = r.requested_by
       WHERE r.status = 'pending'
         AND r.requested_by <> $1
         AND ($2::text IS NULL OR fl.branch = $2 OR tl.branch = $2)
       ORDER BY r.requested_at`,
      [req.user.id, scope]
    );

    res.json(rows.map((r) => ({
      ...r,
      gps_link: r.latitude != null && r.longitude != null
        ? `https://www.google.com/maps?q=${r.latitude},${r.longitude}`
        : null,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch custody requests' });
  }
}

// POST /custody/:id/approve
//
// This is where the register actually changes: the previous assignment closes,
// a new one opens, the status moves and the scan log gains an entry. Doing it
// all here rather than at request time is what makes a rejection cost nothing.
async function approve(req, res) {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const found = await client.query(
      `SELECT * FROM custody_request WHERE id = $1`, [id]
    );
    if (!found.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found' });
    }

    const r = found.rows[0];

    if (r.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This request is already ${r.status}` });
    }
    if (r.requested_by === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'You cannot approve your own request. Another administrator must review it.',
      });
    }

    // Close whatever custody exists now. Read fresh rather than trusting the
    // from_* columns: the asset may have moved since the request was made.
    const active = await client.query(
      `SELECT id, employee_id, location_id FROM assignment
       WHERE asset_id = $1 AND returned_date IS NULL`,
      [r.asset_id]
    );

    for (const prev of active.rows) {
      await client.query(
        `UPDATE assignment SET returned_date = NOW() WHERE id = $1`, [prev.id]
      );
    }

    const from = active.rows[0] || {};
    let assignmentId = null;
    let verificationId = null;

    if (r.kind === 'assign') {
      const created = await client.query(
        `INSERT INTO assignment (asset_id, employee_id, location_id, assigned_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [r.asset_id, r.to_employee_id, r.to_location_id, r.requested_by]
      );
      assignmentId = created.rows[0].id;

      // Assigned to a person is 'Assigned'; parked at a location is stock that
      // happens to have a shelf. That distinction is what the status field is
      // for, and getting it wrong is what made the register claim 21 assigned
      // assets when custody records showed over a thousand.
      await client.query(
        `UPDATE asset SET status = $1 WHERE id = $2`,
        [r.to_employee_id ? 'Assigned' : 'In Stock', r.asset_id]
      );

      // The condition observed at handover becomes a verification in its own
      // right — approved, because the administrator approving the handover is
      // the second pair of eyes the rule asks for.
      if (r.condition_at_handover) {
        const v = await client.query(
          `INSERT INTO asset_verification
             (asset_id, verified_by, condition, remarks, latitude, longitude,
              status, approved_by, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,'approved',$7,NOW())
           RETURNING id`,
          [r.asset_id, r.requested_by, r.condition_at_handover,
           'Recorded at handover', r.latitude, r.longitude, req.user.id]
        );
        verificationId = v.rows[0].id;

        await client.query(
          `UPDATE asset SET condition = $1 WHERE id = $2`,
          [r.condition_at_handover, r.asset_id]
        );
      }
    } else {
      await client.query(
        `UPDATE asset SET status = 'In Stock' WHERE id = $1`, [r.asset_id]
      );
    }

    // The scan log records the officer who made the move and where they stood,
    // not the administrator who approved it from a desk.
    await client.query(
      `INSERT INTO scan_log
         (asset_id, scanned_by, action, from_location_id, to_location_id,
          from_employee_id, to_employee_id, latitude, longitude, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        r.asset_id, r.requested_by,
        r.kind === 'assign' ? 'Transfer' : 'Check-In',
        from.location_id || null, r.to_location_id,
        from.employee_id || null, r.to_employee_id,
        r.latitude, r.longitude,
        `Approved by ${req.user.email}`,
      ]
    );

    const updated = await client.query(
      `UPDATE custody_request
       SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(),
           assignment_id = $2, verification_id = $3
       WHERE id = $4
       RETURNING *`,
      [req.user.id, assignmentId, verificationId, id]
    );

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to approve that request' });
  } finally {
    client.release();
  }
}

// POST /custody/:id/reject
//
// Nothing in the register changes, because nothing changed when the request was
// made. The rejection is kept, with its reason, so the officer knows what to
// correct and the attempt remains on record.
async function reject(req, res) {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A reason is required so the officer knows what to correct' });
  }

  try {
    const found = await pool.query(
      'SELECT status, requested_by FROM custody_request WHERE id = $1', [id]
    );
    if (!found.rows.length) return res.status(404).json({ error: 'Request not found' });
    if (found.rows[0].status !== 'pending') {
      return res.status(409).json({ error: `This request is already ${found.rows[0].status}` });
    }
    if (found.rows[0].requested_by === req.user.id) {
      return res.status(403).json({ error: 'You cannot review your own request' });
    }

    const { rows } = await pool.query(
      `UPDATE custody_request
       SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), rejection_reason = $2
       WHERE id = $3
       RETURNING *`,
      [req.user.id, String(reason).trim(), id]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reject that request' });
  }
}

// GET /custody/asset/:asset_id — request history for one asset, for its timeline.
async function getForAsset(req, res) {
  const { asset_id } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT r.*, s.name AS requested_by_name, rv.name AS reviewed_by_name,
              te.name AS to_employee, tl.branch AS to_branch
       FROM custody_request r
       JOIN it_staff s ON s.id = r.requested_by
       LEFT JOIN it_staff rv ON rv.id = r.reviewed_by
       LEFT JOIN employee te ON te.id = r.to_employee_id
       LEFT JOIN location tl ON tl.id = r.to_location_id
       WHERE r.asset_id = $1
       ORDER BY r.requested_at DESC`,
      [asset_id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch request history' });
  }
}

module.exports = { requestChange, getPending, approve, reject, getForAsset };