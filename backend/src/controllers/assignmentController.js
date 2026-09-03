const pool = require("../db/pool");

// POST /assignments
async function createAssignment(req, res) {
  
  const {
    asset_id,
    employee_id,
    location_id,
    latitude,
    longitude,
  } = req.body;

  const assigned_by = req.user.id;

  if (!asset_id) {
    return res.status(400).json({
      error: "asset_id is required",
    });
  }

  if (!employee_id && !location_id) {
    return res.status(400).json({
      error: "Assign to either an employee or a location.",
    });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const activeAssignment = await client.query(
      `SELECT * FROM assignment
       WHERE asset_id = $1
       AND returned_date IS NULL`,
      [asset_id]
    );

    let fromEmployeeId = null;
    let fromLocationId = null;

    if (activeAssignment.rows.length > 0) {
      const prev = activeAssignment.rows[0];

      fromEmployeeId = prev.employee_id;
      fromLocationId = prev.location_id;

      await client.query(
        `UPDATE assignment
         SET returned_date = NOW()
         WHERE id = $1`,
        [prev.id]
      );
    }

    const newAssignment = await client.query(
      `INSERT INTO assignment
        (asset_id, employee_id, location_id, assigned_by)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [
        asset_id,
        employee_id || null,
        location_id || null,
        assigned_by,
      ]
    );

    await client.query(
      `UPDATE asset
       SET status='Assigned'
       WHERE id=$1`,
      [asset_id]
    );

    await client.query(
      `INSERT INTO scan_log
      (
        asset_id,
        scanned_by,
        action,
        from_location_id,
        to_location_id,
        from_employee_id,
        to_employee_id,
        latitude,
        longitude
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        asset_id,
        assigned_by,
        "Transfer",
        fromLocationId,
        location_id || null,
        fromEmployeeId,
        employee_id || null,
        latitude ?? null,
        longitude ?? null,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json(newAssignment.rows[0]);

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("Create Assignment Error:", err);

    return res.status(500).json({
      error: "Failed to create assignment",
    });

  } finally {
    client.release();
  }
}

// PATCH /assignments/:id/return
async function returnAssignment(req, res) {
  const { id } = req.params;
  const { latitude, longitude } = req.body;
  const scanned_by = req.user.id;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const assignmentResult = await client.query(
      `SELECT * FROM assignment
       WHERE id=$1
       AND returned_date IS NULL`,
      [id]
    );

    if (assignmentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Active assignment not found",
      });
    }

    const assignment = assignmentResult.rows[0];

    await client.query(
      `UPDATE assignment
       SET returned_date = NOW()
       WHERE id=$1`,
      [id]
    );

    await client.query(
      `UPDATE asset
       SET status='In Stock'
       WHERE id=$1`,
      [assignment.asset_id]
    );

    await client.query(
      `INSERT INTO scan_log
      (
        asset_id,
        scanned_by,
        action,
        from_location_id,
        from_employee_id,
        latitude,
        longitude
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7)`,
      [
        assignment.asset_id,
        scanned_by,
        "Check-In",
        assignment.location_id,
        assignment.employee_id,
        latitude ?? null,
        longitude ?? null,
      ]
    );

    await client.query("COMMIT");

    res.json({
      message: "Asset checked in successfully",
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("Return Assignment Error:", err);

    res.status(500).json({
      error: "Failed to return assignment",
    });

  } finally {
    client.release();
  }
}

// GET /assignments/history/:asset_id
async function getAssetHistory(req, res) {
  const { asset_id } = req.params;

  try {
    const result = await db.query(
      `SELECT
          sl.*,
          fe.name AS from_employee_name,
          te.name AS to_employee_name,
          fl.branch AS from_branch,
          tl.branch AS to_branch,
          s.name AS scanned_by_name
       FROM scan_log sl
       LEFT JOIN employee fe ON sl.from_employee_id = fe.id
       LEFT JOIN employee te ON sl.to_employee_id = te.id
       LEFT JOIN location fl ON sl.from_location_id = fl.id
       LEFT JOIN location tl ON sl.to_location_id = tl.id
       LEFT JOIN it_staff s ON sl.scanned_by = s.id
       WHERE sl.asset_id = $1
       ORDER BY sl.timestamp DESC`,
      [asset_id]
    );

    res.json(result.rows);

  } catch (err) {
    console.error("History Error:", err);

    res.status(500).json({
      error: "Failed to fetch asset history",
    });
  }
}

module.exports = {
  createAssignment,
  returnAssignment,
  getAssetHistory,
};