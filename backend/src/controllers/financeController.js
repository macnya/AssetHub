const { db } = require('../db/context');
const { branchScopeFor } = require('../utils/scope');

// Financial reporting over the register.
//
// WHAT FINANCE ACTUALLY NEEDS
// Not the operational view â€” who scanned what, which labels are printed â€” but
// the numbers that reconcile to the ledger: what the organisation owns, what it
// is worth, what has been written off, and what a leaver owes.
//
// Read-only by construction. There is no write path in this file, and the
// Finance role has no endpoint anywhere that changes the register. That is
// deliberate: Finance carries the consequence of a disposal, so it should not
// also be the hand that records one.
//
// Every query respects branch scope, so the same endpoints serve a Branch
// Administrator looking at their own branch.

// GET /finance/summary â€” the headline reconciliation figures.
async function getSummary(req, res) {
  const scope = branchScopeFor(req);

  try {
    const [byCategory, byStatus, byBranch, unpriced] = await Promise.all([
      db.query(
        `SELECT COALESCE(ac.name, 'Uncategorised') AS category,
                COUNT(DISTINCT a.id)::int AS assets,
                COUNT(a.purchase_price)::int AS priced,
                COALESCE(SUM(a.purchase_price), 0)::numeric AS cost,
                COALESCE(SUM(a.nbv), 0)::numeric AS nbv,
                COALESCE(SUM(a.accumulated_depreciation), 0)::numeric AS accumulated_depreciation
         FROM asset a
         LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
         LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
         LEFT JOIN location l ON l.id = ag.location_id
         WHERE a.approval_status = 'approved'
           AND ($1::text IS NULL OR l.branch = $1)
         GROUP BY ac.name
         ORDER BY cost DESC NULLS LAST`,
        [scope]
      ),

      db.query(
        `SELECT a.status,
                COUNT(DISTINCT a.id)::int AS assets,
                COALESCE(SUM(a.purchase_price), 0)::numeric AS cost,
                COALESCE(SUM(a.nbv), 0)::numeric AS nbv
         FROM asset a
         LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
         LEFT JOIN location l ON l.id = ag.location_id
         WHERE a.approval_status = 'approved'
           AND ($1::text IS NULL OR l.branch = $1)
         GROUP BY a.status
         ORDER BY cost DESC NULLS LAST`,
        [scope]
      ),

      db.query(
        `SELECT l.branch,
                COUNT(DISTINCT a.id)::int AS assets,
                COALESCE(SUM(a.purchase_price), 0)::numeric AS cost,
                COALESCE(SUM(a.nbv), 0)::numeric AS nbv
         FROM asset a
         JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
         JOIN location l ON l.id = ag.location_id
         WHERE a.approval_status = 'approved'
           AND ($1::text IS NULL OR l.branch = $1)
         GROUP BY l.branch
         ORDER BY cost DESC NULLS LAST`,
        [scope]
      ),

      // Assets with no recorded cost. Finance should see this rather than have
      // a total quietly understate itself â€” the register already did that once,
      // by a factor of sixty-six.
      db.query(
        `SELECT COUNT(*)::int AS n
         FROM asset a
         LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
         LEFT JOIN location l ON l.id = ag.location_id
         WHERE a.approval_status = 'approved'
           AND a.purchase_price IS NULL
           AND ($1::text IS NULL OR l.branch = $1)`,
        [scope]
      ),
    ]);

    res.json({
      by_category: byCategory.rows,
      by_status: byStatus.rows,
      by_branch: byBranch.rows,
      assets_without_a_cost: unpriced.rows[0].n,
      scoped_to: scope || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch the financial summary' });
  }
}

// GET /finance/disposals â€” what left the register, and what it realised.
//
// The disposal record already carries proceeds and gain or loss, which is the
// figure that reaches the accounts. Nothing here recalculates it.
async function getDisposals(req, res) {
  const { from, to } = req.query;
  const scope = branchScopeFor(req);

  try {
    const params = [scope];
    let dateClause = '';

    if (from) { params.push(from); dateClause += ` AND d.disposal_month >= $${params.length}`; }
    if (to) {
      // disposal_month is a date, so a bare date compared with <= would still
      // stop at midnight on that day.
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(to).trim());
      params.push(to);
      dateClause += dateOnly
        ? ` AND d.disposal_month < (($${params.length})::date + INTERVAL '1 day')`
        : ` AND d.disposal_month <= $${params.length}`;
    }

        const { rows } = await db.query(
      `SELECT a.asset_code, a.description,
              ac.name AS category,
              d.disposal_month, d.base_gross_value, d.accumulated_depreciation,
              d.nbv_at_disposal, d.sales_proceeds, d.gain_or_loss, d.notes,
              s.name AS recorded_by, l.branch
       FROM disposal_record d
       JOIN asset a ON a.id = d.asset_id
       LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
       LEFT JOIN it_staff s ON s.id = d.disposed_by
       -- The last place this asset was, not the current one.
       --
       -- A plain LEFT JOIN on assignment produced a row per assignment the
       -- asset ever had, and the totals below are summed in JS from these
       -- rows, so proceeds and gain were multiplied by however many times it
       -- had changed hands. Adding returned_date IS NULL fixes the count but
       -- empties the branch: 166 of 175 disposals have no open assignment,
       -- because closing it is part of disposing of the asset. LATERAL takes
       -- exactly one row â€” the open assignment if there is one, otherwise the
       -- most recently returned â€” so each disposal is counted once AND keeps
       -- the branch a scoped user filters on.
       LEFT JOIN LATERAL (
         SELECT lo.branch
         FROM assignment ag
         JOIN location lo ON lo.id = ag.location_id
         WHERE ag.asset_id = a.id
         ORDER BY ag.returned_date DESC NULLS FIRST, ag.assigned_date DESC, ag.id DESC
         LIMIT 1
       ) l ON TRUE
       WHERE ($1::text IS NULL OR l.branch = $1)${dateClause}
       ORDER BY d.disposal_month DESC NULLS LAST
       LIMIT 500`,
      params
    );

    const sum = (k) => rows.reduce((s2, r) => s2 + Number(r[k] || 0), 0);

    res.json({
      disposals: rows,
      count: rows.length,
      total_gross: sum('base_gross_value'),
      total_nbv: sum('nbv_at_disposal'),
      total_proceeds: sum('sales_proceeds'),
      total_gain_or_loss: sum('gain_or_loss'),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch disposals' });
  }
}

// GET /finance/losses â€” written off, and what it cost.
//
// The loss record keeps the last known holder and location on the record
// itself, rather than relying on the assignment still being open â€” which it
// will not be once the asset is written off.
async function getLosses(req, res) {
  const scope = branchScopeFor(req);

  try {
    const { rows } = await db.query(
      `SELECT a.asset_code, a.description, a.purchase_price, a.nbv,
              ac.name AS category, lo.reported_date, lo.notes,
              s.name AS reported_by,
              e.name AS last_held_by,
              l.branch
       FROM lost_asset_record lo
       JOIN asset a ON a.id = lo.asset_id
       LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
       LEFT JOIN it_staff s ON s.id = lo.reported_by
       LEFT JOIN employee e ON e.id = lo.last_known_employee_id
       LEFT JOIN location l ON l.id = lo.last_known_location_id
       WHERE ($1::text IS NULL OR l.branch = $1)
       ORDER BY lo.reported_date DESC NULLS LAST
       LIMIT 500`,
      [scope]
    );

    res.json({
      losses: rows,
      count: rows.length,
      total_cost: rows.reduce((s2, r) => s2 + Number(r.purchase_price || 0), 0),
      total_nbv: rows.reduce((s2, r) => s2 + Number(r.nbv || 0), 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch losses' });
  }
}

// GET /finance/recoverable â€” what leavers owe.
//
// This is the figure HR Manual 8.10.2 requires on a clearance form, and the one
// Finance deducts from final dues. It exists here so Finance can see it without
// opening each clearance in turn.
async function getRecoverable(req, res) {
  const scope = branchScopeFor(req);

  try {
    const [owed, unresolved] = await Promise.all([
      db.query(
        `SELECT e.name AS employee, e.branch, e.last_working_day,
                c.id AS clearance_id, c.status AS clearance_status, c.deadline,
                COUNT(i.id)::int AS items,
                COALESCE(SUM(i.value_at_exit), 0)::numeric AS amount
         FROM exit_clearance_item i
         JOIN exit_clearance c ON c.id = i.clearance_id
         JOIN employee e ON e.id = c.employee_id
         WHERE i.outcome = 'owed'
           AND ($1::text IS NULL OR e.branch = $1)
         GROUP BY e.id, e.name, e.branch, e.last_working_day, c.id
         ORDER BY amount DESC`,
        [scope]
      ),

      // Still outstanding on an open clearance: not yet a debt, but it may
      // become one, and Finance should not be surprised by it.
      db.query(
        `SELECT e.name AS employee, c.deadline,
                COUNT(i.id)::int AS items,
                COALESCE(SUM(i.value_at_exit), 0)::numeric AS amount
         FROM exit_clearance_item i
         JOIN exit_clearance c ON c.id = i.clearance_id
         JOIN employee e ON e.id = c.employee_id
         WHERE i.outcome = 'outstanding'
           AND c.status = 'open'
           AND ($1::text IS NULL OR e.branch = $1)
         GROUP BY e.id, e.name, c.deadline
         ORDER BY amount DESC`,
        [scope]
      ),
    ]);

    res.json({
      owed: owed.rows,
      total_owed: owed.rows.reduce((s, r) => s + Number(r.amount || 0), 0),
      unresolved: unresolved.rows,
      total_unresolved: unresolved.rows.reduce((s, r) => s + Number(r.amount || 0), 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch recoverable amounts' });
  }
}

// GET /finance/export â€” the register as rows, for a spreadsheet.
//
// Returned as JSON and turned into CSV in the browser. Finance will want this
// in Excel, and generating it client-side avoids holding a large file in memory
// on a small instance.
async function getExport(req, res) {
  const scope = branchScopeFor(req);

  try {
    const { rows } = await db.query(
      `SELECT a.asset_code, a.description, ac.name AS category,
              a.serial_number, a.date_of_purchase, a.supplier,
              a.purchase_price, a.accumulated_depreciation, a.nbv,
              a.status, a.condition,
              e.name AS held_by, l.region, l.branch, l.department,
              l.programme, l.physical_location,
              (SELECT MAX(v.verified_at) FROM asset_verification v
               WHERE v.asset_id = a.id AND v.status = 'approved') AS last_verified
       FROM asset a
       LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
       LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
       LEFT JOIN employee e ON e.id = ag.employee_id
       LEFT JOIN location l ON l.id = ag.location_id
       WHERE a.approval_status = 'approved'
         AND ($1::text IS NULL OR l.branch = $1)
       ORDER BY ac.name, a.asset_code`,
      [scope]
    );

    res.json({ rows, count: rows.length, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build the export' });
  }
}

module.exports = { getSummary, getDisposals, getLosses, getRecoverable, getExport };