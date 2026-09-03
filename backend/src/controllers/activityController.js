const { db } = require('../db/context');
const { branchScopeFor } = require('../utils/scope');

// GET /activity â€” one trail of everything anybody has done.
//
// WHY MERGED RATHER THAN A SCAN LOG
// scan_log answers "what happened to assets". Accountability needs "who did
// what" â€” and that includes the approvals and refusals, which live in
// asset_verification and custody_request rather than in the scan log. An
// auditor asking "who approved that transfer?" gets no answer from movements
// alone.
//
// Five sources, one shape, ordered by time. UNION ALL rather than five separate
// requests so the page can paginate a single ordered list; a client merging
// five paginated feeds would have to over-fetch each one to be sure it had the
// next row.

const SOURCES = `
  -- Movements: transfers, check-ins, imports, and verification scans.
  SELECT
    'scan_' || sl.id                         AS event_id,
    sl.action                                AS action,
    sl.timestamp                             AS at,
    s.name                                   AS actor,
    s.role                                   AS actor_role,
    a.asset_code, a.description,
    COALESCE(tl.branch, fl.branch)           AS branch,
    NULLIF(CONCAT_WS(' â†’ ',
      NULLIF(COALESCE(fe.name, fl.physical_location, fl.branch), ''),
      NULLIF(COALESCE(te.name, tl.physical_location, tl.branch), '')), '')  AS detail,
    sl.notes                                 AS notes,
    NULL::text                               AS outcome,
    sl.latitude, sl.longitude
  FROM scan_log sl
  JOIN asset a ON a.id = sl.asset_id
  LEFT JOIN it_staff s ON s.id = sl.scanned_by
  LEFT JOIN location fl ON fl.id = sl.from_location_id
  LEFT JOIN location tl ON tl.id = sl.to_location_id
  LEFT JOIN employee fe ON fe.id = sl.from_employee_id
  LEFT JOIN employee te ON te.id = sl.to_employee_id

  UNION ALL

  -- Verifications, as recorded. The approval is a separate event below,
  -- because they are two acts by two people.
  SELECT
    'verify_' || v.id,
    'Verification recorded',
    v.verified_at,
    s.name, s.role,
    a.asset_code, a.description,
    l.branch,
    v.condition,
    v.remarks,
    v.status,
    v.latitude, v.longitude
  FROM asset_verification v
  JOIN asset a ON a.id = v.asset_id
  LEFT JOIN it_staff s ON s.id = v.verified_by
  LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
  LEFT JOIN location l ON l.id = ag.location_id

  UNION ALL

  -- Who approved or rejected a verification, and when. This is the half of the
  -- record that a scan log cannot show.
  SELECT
    'verifyreview_' || v.id,
    CASE WHEN v.status = 'approved' THEN 'Verification approved'
         ELSE 'Verification rejected' END,
    v.approved_at,
    s.name, s.role,
    a.asset_code, a.description,
    l.branch,
    'recorded by ' || COALESCE(vb.name, 'unknown'),
    v.rejection_reason,
    v.status,
    NULL::numeric, NULL::numeric
  FROM asset_verification v
  JOIN asset a ON a.id = v.asset_id
  LEFT JOIN it_staff s ON s.id = v.approved_by
  LEFT JOIN it_staff vb ON vb.id = v.verified_by
  LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
  LEFT JOIN location l ON l.id = ag.location_id
  WHERE v.approved_at IS NOT NULL

  UNION ALL

  -- Custody requests, as asked for.
  SELECT
    'custody_' || r.id,
    CASE WHEN r.kind = 'assign' THEN 'Assignment requested'
         ELSE 'Return requested' END,
    r.requested_at,
    s.name, s.role,
    a.asset_code, a.description,
    COALESCE(tl.branch, fl.branch),
    NULLIF(CONCAT_WS(' â†’ ',
      NULLIF(COALESCE(fe.name, fl.physical_location, fl.branch), ''),
      NULLIF(COALESCE(te.name, tl.physical_location, tl.branch, 'storage'), '')), ''),
    r.notes,
    r.status,
    r.latitude, r.longitude
  FROM custody_request r
  JOIN asset a ON a.id = r.asset_id
  LEFT JOIN it_staff s ON s.id = r.requested_by
  LEFT JOIN location fl ON fl.id = r.from_location_id
  LEFT JOIN location tl ON tl.id = r.to_location_id
  LEFT JOIN employee fe ON fe.id = r.from_employee_id
  LEFT JOIN employee te ON te.id = r.to_employee_id

  UNION ALL

  -- And who let them through, or did not.
  SELECT
    'custodyreview_' || r.id,
    CASE WHEN r.status = 'approved' THEN 'Custody approved'
         ELSE 'Custody rejected' END,
    r.reviewed_at,
    s.name, s.role,
    a.asset_code, a.description,
    COALESCE(tl.branch, fl.branch),
    'requested by ' || COALESCE(rb.name, 'unknown'),
    r.rejection_reason,
    r.status,
    NULL::numeric, NULL::numeric
  FROM custody_request r
  JOIN asset a ON a.id = r.asset_id
  LEFT JOIN it_staff s ON s.id = r.reviewed_by
  LEFT JOIN it_staff rb ON rb.id = r.requested_by
  LEFT JOIN location fl ON fl.id = r.from_location_id
  LEFT JOIN location tl ON tl.id = r.to_location_id
  WHERE r.reviewed_at IS NOT NULL
`;

async function getActivity(req, res) {
  const { action, actor, asset, branch, from, to, limit = 100, offset = 0 } = req.query;
  const scope = branchScopeFor(req);

  try {
    const params = [];
    const clauses = [];

    // Applied outside the union so it filters the merged result once, rather
    // than being repeated five times.
    const add = (sql, value) => { params.push(value); clauses.push(sql.replace('$?', `$${params.length}`)); };

    if (scope) add('branch = $?', scope);
    if (branch) add('branch = $?', branch);
    if (actor) add('actor ILIKE $?', `%${actor}%`);
    if (asset) add('asset_code ILIKE $?', `%${asset}%`);
    if (action) add('action = $?', action);
    if (from) add('at >= $?', from);
    if (to) {
      // A bare date compared with <= stops at midnight and excludes that day.
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(to).trim());
      params.push(to);
      clauses.push(dateOnly
        ? `at < (($${params.length})::date + INTERVAL '1 day')`
        : `at <= $${params.length}`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    params.push(Math.min(Number(limit) || 100, 500));
    const limitParam = `$${params.length}`;
    params.push(Number(offset) || 0);
    const offsetParam = `$${params.length}`;

    const { rows } = await db.query(
      `SELECT * FROM (${SOURCES}) AS trail
       ${where}
       ORDER BY at DESC NULLS LAST
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params
    );

    // A separate count so the page can say "showing 100 of 4,812" rather than
    // leaving the reader guessing whether there is more.
    const countParams = params.slice(0, params.length - 2);
    const { rows: counted } = await db.query(
      `SELECT COUNT(*)::int AS n FROM (${SOURCES}) AS trail ${where}`,
      countParams
    );

    res.json({
      events: rows.map((r) => ({
        ...r,
        gps_link: r.latitude != null && r.longitude != null
          ? `https://www.google.com/maps?q=${r.latitude},${r.longitude}`
          : null,
      })),
      total: counted[0].n,
      offset: Number(offset) || 0,
      scoped_to: scope || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch the activity trail' });
  }
}

// GET /activity/actions â€” the distinct action types, for the filter dropdown.
// Read from the data rather than hardcoded, so a new kind of event appears in
// the filter without anyone remembering to add it.
async function getActions(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT action FROM (${SOURCES}) AS trail
       WHERE action IS NOT NULL ORDER BY action`
    );
    res.json(rows.map((r) => r.action));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch action types' });
  }
}

module.exports = { getActivity, getActions };