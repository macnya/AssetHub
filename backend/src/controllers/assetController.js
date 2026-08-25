const pool = require('../db/pool');
const {
  ASSET_CONDITIONS,
  DEFAULT_CONDITION,
  isValidCondition,
} = require('../constants/assetConditions');
const { branchScopeFor } = require('../utils/scope');
const { ROLES, isAdminRole } = require('../middleware/authMiddleware');
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// The joins are shared between the page query and the count query so the
// reported total can never drift from the rows actually returned.
const ASSET_JOINS = `
  FROM asset a
  LEFT JOIN asset_category ac ON a.asset_category_id = ac.id
  LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
  LEFT JOIN employee e ON ag.employee_id = e.id
  LEFT JOIN location l ON ag.location_id = l.id
`;

// `assigned` and `sort` are new. Assignment state can't be read off
// asset.status alone — an asset can be In Stock with a stale open assignment —
// so it's derived from whether a live assignment row exists.
function buildAssetFilter({ search, category, status, branch, assigned, includePending }, scopeBranch) {
  const clauses = [];
  const params = [];
  // A pending asset is a claim, not yet a register entry. The approval queue is
  // where it belongs until somebody has checked it.
  if (includePending !== 'yes') {
    clauses.push(`a.approval_status = 'approved'`);
  }
  // Applied first and not user-supplied: a Branch Administrator cannot widen
  // their own view by passing ?branch= for somewhere else.
  if (scopeBranch) {
    params.push(scopeBranch);
    clauses.push(`l.branch = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(a.asset_code ILIKE $${params.length} OR a.description ILIKE $${params.length})`);
  }
  if (category) {
    params.push(category);
    clauses.push(`ac.name = $${params.length}`);
  }
  if (status) {
    params.push(status);
    clauses.push(`a.status = $${params.length}`);
  }
  if (branch) {
    params.push(branch);
    clauses.push(`l.branch = $${params.length}`);
  }

  if (assigned === 'yes') {
    clauses.push('ag.id IS NOT NULL');
  } else if (assigned === 'no') {
    clauses.push('ag.id IS NULL');
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

// Whitelisted so the sort key can never reach the query as raw input.
// "newest" uses id rather than a timestamp: the asset table has no created_at,
// and a serial primary key is insertion order.
const SORTS = {
  code: 'a.asset_code ASC',
  newest: 'a.id DESC',
  oldest: 'a.id ASC',
  value: 'a.purchase_price DESC NULLS LAST',
  description: 'a.description ASC',
};

// GET /assets — paginated list.
//
// Returns { data, total, limit, offset } rather than a bare array. The old
// version applied a hard LIMIT 200 with no offset and no count, so against a
// register of several thousand assets the client silently displayed a
// truncated slice with no way to reach the rest.
async function getAllAssets(req, res) {
  const parsedLimit = Number.parseInt(req.query.limit, 10);
  const parsedOffset = Number.parseInt(req.query.offset, 10);

  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  try {
    const { where, params } = buildAssetFilter(req.query, branchScopeFor(req));

    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT a.id)::int AS total ${ASSET_JOINS} ${where}`,
      params
    );

    const pageParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT a.*, ac.name AS category_name,
              ag.employee_id, ag.location_id,
              e.name AS employee_name, l.branch, l.physical_location
       ${ASSET_JOINS}
       ${where}
       ORDER BY ${SORTS[req.query.sort] || SORTS.code}
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams
    );

    res.json({
      data: result.rows,
      total: countResult.rows[0].total,
      limit,
      offset,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch assets' });
  }
}

// GET /assets/categories — list all asset categories (for dropdowns)
async function getAllCategories(req, res) {
  try {
    const result = await pool.query('SELECT id, name FROM asset_category ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
}

// GET /assets/conditions — the canonical condition vocabulary, so the web and
// mobile clients don't have to keep their own copies in sync by hand.
async function getAllConditions(req, res) {
  res.json(ASSET_CONDITIONS);
}

// GET /assets/filters — everything the filter bar needs, in one request
// rather than three.
async function getFilterOptions(req, res) {
  try {
    const scopeBranch = branchScopeFor(req);

    const [categories, branches] = await Promise.all([
      pool.query('SELECT id, name FROM asset_category ORDER BY name'),
      pool.query(
        `SELECT DISTINCT branch FROM location
         WHERE branch IS NOT NULL AND branch <> ''
         ORDER BY branch`
      ),
    ]);

    res.json({
      categories: categories.rows,
      // Offering branches they cannot see would just produce empty results.
      branches: scopeBranch
        ? branches.rows.map((r) => r.branch).filter((b) => b === scopeBranch)
        : branches.rows.map((r) => r.branch),
      statuses: ['In Stock', 'Assigned', 'Disposed', 'Lost'],
      conditions: ASSET_CONDITIONS,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch filter options' });
  }
}

// GET /assets/:asset_code — lookup a single asset by its QR/barcode value (used by the scanner)
async function getAssetByCode(req, res) {
  const { asset_code } = req.params;

  try {
    const assetResult = await pool.query(
      `SELECT a.*, ac.name AS category_name
       FROM asset a
       LEFT JOIN asset_category ac ON a.asset_category_id = ac.id
       WHERE a.asset_code = $1`,
      [asset_code]
    );

    if (assetResult.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const asset = assetResult.rows[0];

    const assignmentResult = await pool.query(
      `SELECT ag.*, e.name AS employee_name, e.department AS employee_department,
              e.branch AS employee_branch, l.branch, l.department, l.physical_location
       FROM assignment ag
       LEFT JOIN employee e ON ag.employee_id = e.id
       LEFT JOIN location l ON ag.location_id = l.id
       WHERE ag.asset_id = $1 AND ag.returned_date IS NULL`,
      [asset.id]
    );

    // A scoped role must not read an asset outside their branch, even by
    // typing its code directly. Checked after the assignment lookup because
    // that is where an asset's branch actually lives.
    const scopeBranch = branchScopeFor(req);
    if (scopeBranch) {
      const assignedBranch = assignmentResult.rows[0]?.branch || null;
      if (assignedBranch !== scopeBranch) {
        return res.status(403).json({ error: 'This asset is not at your branch' });
      }
    }

    // Full custody and inspection trail in one list: who handed the asset
    // over, who took it, who returned it to stock, and who physically
    // verified it. scan_log and asset_verification are separate tables, so
    // neither alone answers "what has happened to this asset".
    const timelineResult = await pool.query(
      `SELECT * FROM (
         SELECT
           'scan-' || sl.id::text        AS event_id,
           sl.action::text               AS type,
           sl.timestamp                  AS at,
           s.name                        AS actor,
           fe.name                       AS from_holder,
           te.name                       AS to_holder,
           fl.branch                     AS from_branch,
           tl.branch                     AS to_branch,
           fl.physical_location          AS from_place,
           tl.physical_location          AS to_place,
           NULL::text                    AS condition,
           sl.notes::text                AS remarks,
           sl.latitude, sl.longitude
         FROM scan_log sl
         LEFT JOIN employee fe ON fe.id = sl.from_employee_id
         LEFT JOIN employee te ON te.id = sl.to_employee_id
         LEFT JOIN location fl ON fl.id = sl.from_location_id
         LEFT JOIN location tl ON tl.id = sl.to_location_id
         LEFT JOIN it_staff s  ON s.id  = sl.scanned_by
         WHERE sl.asset_id = $1

         UNION ALL

         SELECT
           'verify-' || v.id::text,
           'Verification',
           v.verified_at,
           s.name,
           NULL, NULL, NULL, NULL, NULL, NULL,
           v.condition::text,
           v.remarks::text,
           v.latitude, v.longitude
         FROM asset_verification v
         JOIN it_staff s ON s.id = v.verified_by
         WHERE v.asset_id = $1
       ) events
       ORDER BY at DESC
       LIMIT 100`,
      [asset.id]
    );

    const timeline = timelineResult.rows.map((e) => ({
      ...e,
      map_url:
        e.latitude != null && e.longitude != null
          ? `https://www.google.com/maps?q=${e.latitude},${e.longitude}`
          : null,
    }));

    // The newest event carrying GPS is, by definition, where the asset was
    // last seen — so this comes free rather than costing a second query.
    const lastSeenEvent = timeline.find((e) => e.latitude != null && e.longitude != null) || null;

    // If nobody holds it now, who held it last? Useful when chasing an asset
    // that reads In Stock but isn't on the shelf.
    const lastHolderResult = await pool.query(
      `SELECT e.name AS employee_name, l.branch, l.physical_location, ag.returned_date
       FROM assignment ag
       LEFT JOIN employee e ON ag.employee_id = e.id
       LEFT JOIN location l ON ag.location_id = l.id
       WHERE ag.asset_id = $1 AND ag.returned_date IS NOT NULL
       ORDER BY ag.returned_date DESC
       LIMIT 1`,
      [asset.id]
    );

    const lastSeen = lastSeenEvent
      ? {
          latitude: lastSeenEvent.latitude,
          longitude: lastSeenEvent.longitude,
          recorded_at: lastSeenEvent.at,
          source: lastSeenEvent.type,
          map_url: lastSeenEvent.map_url,
        }
      : null;

    res.json({
      asset,
      current_assignment: assignmentResult.rows[0] || null,
      last_seen: lastSeen,
      last_holder: assignmentResult.rows.length === 0 ? lastHolderResult.rows[0] || null : null,
      timeline,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch asset' });
  }
}

// POST /assets — create a new asset.
//
// A Branch Administrator may register equipment that arrives at their branch,
// but it is held as PENDING and stays out of the register until an admin
// approves it. Officers and admins create approved assets directly: an officer
// scanning an unknown barcode in the field is recording something that
// demonstrably exists, which is a different act from adding a record.
async function createAsset(req, res) {
  const {
    asset_code, description, asset_category_id, serial_number,
    date_of_purchase, purchase_price, supplier,
    useful_life_years, remaining_life, monthly_depreciation,
    accumulated_depreciation, nbv, current_end_month_date, condition
  } = req.body;

  if (!asset_code || !description) {
    return res.status(400).json({ error: 'asset_code and description are required' });
  }

  if (condition && !isValidCondition(condition)) {
    return res.status(400).json({
      error: `condition must be one of: ${ASSET_CONDITIONS.join(', ')}`,
    });
  }

  const needsApproval = req.user.role === ROLES.BRANCH_ADMIN;

  try {
    const result = await pool.query(
      `INSERT INTO asset
        (asset_code, description, asset_category_id, serial_number, date_of_purchase,
         purchase_price, supplier, useful_life_years, remaining_life, monthly_depreciation,
         accumulated_depreciation, nbv, current_end_month_date, condition,
         approval_status, created_by, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18)
       RETURNING *`,
      [asset_code, description, asset_category_id, serial_number, date_of_purchase,
       purchase_price, supplier, useful_life_years, remaining_life, monthly_depreciation,
       accumulated_depreciation, nbv, current_end_month_date, condition || DEFAULT_CONDITION,
       needsApproval ? 'pending' : 'approved',
       req.user.id,
       needsApproval ? null : req.user.id,
       needsApproval ? null : new Date()]
    );

    res.status(201).json({
      ...result.rows[0],
      message: needsApproval
        ? 'Recorded. An administrator will review it before it joins the register.'
        : undefined,
    });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'asset_code already exists' });
    }
    res.status(500).json({ error: 'Failed to create asset' });
  }
}
// PATCH /assets/:asset_code — admin correction of asset details.
//
// asset_code is deliberately NOT editable: it's the identity printed on the
// barcode label stuck to the equipment, and changing it here would silently
// orphan that label. status is also excluded — it's derived from assignment,
// disposal and loss actions, so editing it directly would desync it from the
// assignment table.
const EDITABLE = [
  'description', 'asset_category_id', 'serial_number', 'supplier',
  'purchase_price', 'date_of_purchase', 'condition',
  'chassis_number', 'engine_number', 'nbv',
];

async function updateAsset(req, res) {
  const { asset_code } = req.params;
  const updates = {};

  for (const field of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      updates[field] = req.body[field] === '' ? null : req.body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No editable fields supplied' });
  }

  if (updates.description !== undefined && !String(updates.description || '').trim()) {
    return res.status(400).json({ error: 'description cannot be empty' });
  }

  if (updates.condition && !isValidCondition(updates.condition)) {
    return res.status(400).json({
      error: `condition must be one of: ${ASSET_CONDITIONS.join(', ')}`,
    });
  }

  try {
    const cols = Object.keys(updates);
    const assignments = cols.map((col, i) => `${col} = $${i + 1}`).join(', ');
    const values = cols.map((col) => updates[col]);

    const result = await pool.query(
      `UPDATE asset SET ${assignments} WHERE asset_code = $${cols.length + 1} RETURNING *`,
      [...values, asset_code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update asset' });
  }
}
// GET /assets/pending — the approval queue.
//
// Excludes the caller's own submissions: they cannot approve those, and a queue
// containing work you are forbidden to action is just noise.
async function getPendingAssets(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, ac.name AS category_name, s.name AS created_by_name, s.branch AS created_by_branch
       FROM asset a
       LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
       LEFT JOIN it_staff s ON s.id = a.created_by
       WHERE a.approval_status = 'pending'
         AND (a.created_by IS NULL OR a.created_by <> $1)
       ORDER BY a.id DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch pending assets' });
  }
}

// POST /assets/:asset_code/approve  and  /reject
//
// Four eyes. A CHECK constraint on the table enforces the same rule, so this
// check failing open would still not permit a self-approval.
async function reviewAsset(req, res) {
  const { asset_code } = req.params;
  const approving = req.path.endsWith('/approve');
  const { reason } = req.body;

  if (!approving && !String(reason || '').trim()) {
    return res.status(400).json({ error: 'A reason is required so the branch knows what to correct' });
  }

  try {
    const existing = await pool.query(
      'SELECT id, approval_status, created_by FROM asset WHERE asset_code = $1',
      [asset_code]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const a = existing.rows[0];
    if (a.approval_status !== 'pending') {
      return res.status(409).json({ error: `This asset is already ${a.approval_status}` });
    }
    if (a.created_by === req.user.id) {
      return res.status(403).json({
        error: 'You cannot approve an asset you added. Another administrator must review it.',
      });
    }

    const { rows } = await pool.query(
      `UPDATE asset
       SET approval_status = $1, approved_by = $2, approved_at = NOW(), rejection_reason = $3
       WHERE asset_code = $4
       RETURNING *`,
      [approving ? 'approved' : 'rejected', req.user.id,
       approving ? null : String(reason).trim(), asset_code]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to review this asset' });
  }
}
module.exports = {
  getAllAssets,
  getFilterOptions,
  updateAsset,
  getAssetByCode,
  createAsset,
  getAllCategories,
  getAllConditions,
  getPendingAssets,
  reviewAsset,
};