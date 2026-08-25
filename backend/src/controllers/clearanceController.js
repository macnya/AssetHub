const pool = require('../db/pool');
const { branchScopeFor } = require('../utils/scope');

// Exit clearance, implementing HR Manual 8.10.1 and 8.10.2.
//
// The policy is already mandatory and already documented. What it lacked was
// the data: somebody in P&C has to state what a leaver owed and what it was
// worth, and there was no reliable way to answer either question.

// 8.10.2: "This should be within 3 months after an employee exits."
const DEADLINE_MONTHS = 3;

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// GET /clearances — the queue, newest first.
async function listClearances(req, res) {
  const { status } = req.query;
  const scopeBranch = branchScopeFor(req);

  try {
    const params = [];
    const clauses = [];

    if (status) {
      params.push(status);
      clauses.push(`c.status = $${params.length}`);
    }
    if (scopeBranch) {
      params.push(scopeBranch);
      clauses.push(`e.branch = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT
          c.id, c.last_working_day, c.deadline, c.status, c.reason,
          c.involves_fraud, c.opened_at, c.completed_at, c.notes,
          e.id AS employee_id, e.name AS employee_name, e.branch, e.department,
          o.name AS opened_by_name,
          cb.name AS completed_by_name,
          COUNT(i.id)::int AS total_items,
          COUNT(i.id) FILTER (WHERE i.outcome = 'outstanding')::int AS outstanding,
          COUNT(i.id) FILTER (WHERE i.outcome = 'returned')::int AS returned,
          COUNT(i.id) FILTER (WHERE i.outcome = 'written_off')::int AS written_off,
          COUNT(i.id) FILTER (WHERE i.outcome = 'owed')::int AS owed,
          -- What Finance deducts: only items the leaver still owes. An asset
          -- returned or written off is not a debt.
          COALESCE(SUM(i.value_at_exit) FILTER (WHERE i.outcome = 'owed'), 0)::numeric AS amount_owed,
          COALESCE(SUM(i.value_at_exit) FILTER (WHERE i.outcome = 'outstanding'), 0)::numeric AS value_unresolved
       FROM exit_clearance c
       JOIN employee e ON e.id = c.employee_id
       LEFT JOIN it_staff o ON o.id = c.opened_by
       LEFT JOIN it_staff cb ON cb.id = c.completed_by
       LEFT JOIN exit_clearance_item i ON i.clearance_id = c.id
       ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
       GROUP BY c.id, e.id, o.name, cb.name
       ORDER BY c.status = 'open' DESC, c.deadline ASC`,
      params
    );

    const today = new Date().toISOString().slice(0, 10);

    res.json(rows.map((r) => ({
      ...r,
      // A clearance involving fraud waits for the investigation, so its
      // deadline is not treated as overdue (8.10.2).
      overdue: r.status === 'open' && !r.involves_fraud && r.deadline < today,
      days_left: r.status === 'open'
        ? Math.ceil((new Date(r.deadline) - new Date(today)) / 86400000)
        : null,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch clearances' });
  }
}

// GET /clearances/:id — one clearance with its items.
async function getClearance(req, res) {
  const { id } = req.params;

  try {
    const header = await pool.query(
      `SELECT c.*, e.name AS employee_name, e.branch, e.department, e.email,
              o.name AS opened_by_name, cb.name AS completed_by_name
       FROM exit_clearance c
       JOIN employee e ON e.id = c.employee_id
       LEFT JOIN it_staff o ON o.id = c.opened_by
       LEFT JOIN it_staff cb ON cb.id = c.completed_by
       WHERE c.id = $1`,
      [id]
    );
    if (!header.rows.length) return res.status(404).json({ error: 'Clearance not found' });

    const items = await pool.query(
      `SELECT i.id, i.asset_id, i.value_at_exit, i.outcome, i.notes, i.resolved_at,
              a.asset_code, a.description, a.condition, a.serial_number,
              ac.name AS category,
              r.name AS resolved_by_name
       FROM exit_clearance_item i
       JOIN asset a ON a.id = i.asset_id
       LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
       LEFT JOIN it_staff r ON r.id = i.resolved_by
       WHERE i.clearance_id = $1
       ORDER BY i.outcome = 'outstanding' DESC, a.asset_code`,
      [id]
    );

    res.json({ ...header.rows[0], items: items.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch clearance' });
  }
}

// GET /clearances/holdings/:employee_id — what a member of staff holds now.
//
// Used before opening a clearance, so P&C can see what they are committing to
// chase. Also answers the everyday question "what does this person have?".
async function getEmployeeHoldings(req, res) {
  const { employee_id } = req.params;
  const scopeBranch = branchScopeFor(req);

  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.asset_code, a.description, a.condition, a.purchase_price,
              ac.name AS category, l.branch, l.physical_location,
              ag.assigned_date
       FROM assignment ag
       JOIN asset a ON a.id = ag.asset_id
       LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
       LEFT JOIN location l ON l.id = ag.location_id
       WHERE ag.employee_id = $1
         AND ag.returned_date IS NULL
         AND a.approval_status = 'approved'
         AND ($2::text IS NULL OR l.branch = $2)
       ORDER BY a.purchase_price DESC NULLS LAST`,
      [employee_id, scopeBranch]
    );

    res.json({
      items: rows,
      count: rows.length,
      total_value: rows.reduce((s, r) => s + Number(r.purchase_price || 0), 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
}

// POST /clearances — open a clearance for a leaver.
//
// Snapshots everything they hold at this moment, with the value of each. The
// list is deliberately frozen: 8.10.1 makes assets due back on the last working
// day, and a live query would drop an asset that was quietly reassigned
// afterwards, letting the process be sidestepped by moving things around.
async function openClearance(req, res) {
  const { employee_id, last_working_day, reason, involves_fraud, notes } = req.body;

  if (!employee_id || !last_working_day) {
    return res.status(400).json({ error: 'employee_id and last_working_day are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const emp = await client.query('SELECT id, name FROM employee WHERE id = $1', [employee_id]);
    if (!emp.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    const open = await client.query(
      `SELECT id FROM exit_clearance WHERE employee_id = $1 AND status = 'open'`,
      [employee_id]
    );
    if (open.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This employee already has an open clearance',
        clearance_id: open.rows[0].id,
      });
    }

    const clearance = await client.query(
      `INSERT INTO exit_clearance
         (employee_id, last_working_day, deadline, reason, involves_fraud, notes, opened_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [employee_id, last_working_day, addMonths(last_working_day, DEADLINE_MONTHS),
       reason || null, involves_fraud === true, notes || null, req.user.id]
    );

    // Snapshot. purchase_price is copied rather than referenced so a later
    // correction cannot change what Finance was told to deduct (8.10.2).
    const items = await client.query(
      `INSERT INTO exit_clearance_item (clearance_id, asset_id, value_at_exit)
       SELECT $1, a.id, a.purchase_price
       FROM assignment ag
       JOIN asset a ON a.id = ag.asset_id
       WHERE ag.employee_id = $2
         AND ag.returned_date IS NULL
         AND a.approval_status = 'approved'
       RETURNING id`,
      [clearance.rows[0].id, employee_id]
    );

    // 'exiting' rather than 'exited': they have not finished clearing, and the
    // distinction is what makes the outstanding list meaningful.
    await client.query(
      `UPDATE employee
       SET employment_status = 'exiting', last_working_day = $1, exit_reason = $2
       WHERE id = $3`,
      [last_working_day, reason || null, employee_id]
    );

    await client.query('COMMIT');

    res.status(201).json({
      ...clearance.rows[0],
      employee_name: emp.rows[0].name,
      items_snapshotted: items.rowCount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to open clearance' });
  } finally {
    client.release();
  }
}

// PATCH /clearances/:id/items/:item_id — record what happened to one asset.
//
// 'returned' closes the assignment, so the register reflects reality rather
// than leaving the asset against someone who no longer works here. That single
// omission is why Grace Kimeu still holds seven assets in the register.
async function resolveItem(req, res) {
  const { id, item_id } = req.params;
  const { outcome, notes } = req.body;

  const valid = ['outstanding', 'returned', 'written_off', 'owed'];
  if (!valid.includes(outcome)) {
    return res.status(400).json({ error: `outcome must be one of: ${valid.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const item = await client.query(
      `SELECT i.id, i.asset_id, c.employee_id, c.status
       FROM exit_clearance_item i
       JOIN exit_clearance c ON c.id = i.clearance_id
       WHERE i.id = $1 AND i.clearance_id = $2`,
      [item_id, id]
    );
    if (!item.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item not found on this clearance' });
    }
    if (item.rows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This clearance is no longer open' });
    }

    await client.query(
      `UPDATE exit_clearance_item
       SET outcome = $1, notes = $2, resolved_by = $3, resolved_at = NOW()
       WHERE id = $4`,
      [outcome, notes || null, req.user.id, item_id]
    );

    if (outcome === 'returned') {
      await client.query(
        `UPDATE assignment SET returned_date = NOW()
         WHERE asset_id = $1 AND employee_id = $2 AND returned_date IS NULL`,
        [item.rows[0].asset_id, item.rows[0].employee_id]
      );
      await client.query(`UPDATE asset SET status = 'In Stock' WHERE id = $1`, [item.rows[0].asset_id]);
    }

    // Written off: the assignment closes too, but the asset is recorded as lost
    // rather than back in stock. Somebody should still account for it.
    if (outcome === 'written_off') {
      await client.query(
        `UPDATE assignment SET returned_date = NOW()
         WHERE asset_id = $1 AND employee_id = $2 AND returned_date IS NULL`,
        [item.rows[0].asset_id, item.rows[0].employee_id]
      );
      await client.query(`UPDATE asset SET status = 'Lost' WHERE id = $1`, [item.rows[0].asset_id]);
      await client.query(
        `INSERT INTO lost_asset_record (asset_id, notes)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [item.rows[0].asset_id, `Not returned at exit clearance. ${notes || ''}`.trim()]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to update this item' });
  } finally {
    client.release();
  }
}

// POST /clearances/:id/complete
//
// Refuses while anything is unresolved. 8.10.1 requires every asset accounted
// for; a clearance signed off with items still outstanding would defeat the
// point of having the process.
async function completeClearance(req, res) {
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const outstanding = await client.query(
      `SELECT COUNT(*)::int AS n FROM exit_clearance_item
       WHERE clearance_id = $1 AND outcome = 'outstanding'`,
      [id]
    );
    if (outstanding.rows[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `${outstanding.rows[0].n} asset${outstanding.rows[0].n === 1 ? '' : 's'} still unresolved. ` +
               `Mark each as returned, written off, or owed before completing.`,
      });
    }

    const clearance = await client.query(
      `UPDATE exit_clearance
       SET status = 'complete', completed_by = $1, completed_at = NOW()
       WHERE id = $2 AND status = 'open'
       RETURNING *`,
      [req.user.id, id]
    );
    if (!clearance.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This clearance is not open' });
    }

    await client.query(
      `UPDATE employee SET employment_status = 'exited' WHERE id = $1`,
      [clearance.rows[0].employee_id]
    );

    const owed = await client.query(
      `SELECT COALESCE(SUM(value_at_exit), 0)::numeric AS amount
       FROM exit_clearance_item WHERE clearance_id = $1 AND outcome = 'owed'`,
      [id]
    );

    await client.query('COMMIT');

    res.json({
      ...clearance.rows[0],
      // The figure 8.10.2 requires on the clearance form, for Finance to
      // deduct from final dues.
      amount_owed: owed.rows[0].amount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to complete this clearance' });
  } finally {
    client.release();
  }
}

module.exports = {
  listClearances, getClearance, getEmployeeHoldings,
  openClearance, resolveItem, completeClearance,
};