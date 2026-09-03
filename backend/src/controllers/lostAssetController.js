const { db } = require('../db/context');

// POST /lost-assets â€” report an asset as lost
async function createLostAssetRecord(req, res) {
  const { asset_id, notes } = req.body;
  const reported_by = req.user.id;

  if (!asset_id) {
    return res.status(400).json({ error: 'asset_id is required' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const assetResult = await client.query('SELECT * FROM asset WHERE id = $1', [asset_id]);
    if (assetResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Asset not found' });
    }

    // Capture last known assignment before closing it
    const activeAssignment = await client.query(
      `SELECT * FROM assignment WHERE asset_id = $1 AND returned_date IS NULL`,
      [asset_id]
    );
    const lastEmployeeId = activeAssignment.rows[0]?.employee_id || null;
    const lastLocationId = activeAssignment.rows[0]?.location_id || null;

    const lostResult = await client.query(
      `INSERT INTO lost_asset_record (asset_id, last_known_employee_id, last_known_location_id, reported_by, notes)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [asset_id, lastEmployeeId, lastLocationId, reported_by, notes || null]
    );

    await client.query(
      `UPDATE assignment SET returned_date = now() WHERE asset_id = $1 AND returned_date IS NULL`,
      [asset_id]
    );

    await client.query(`UPDATE asset SET status = 'Lost' WHERE id = $1`, [asset_id]);

    await client.query(
      `INSERT INTO scan_log (asset_id, scanned_by, action, from_employee_id, from_location_id, notes)
       VALUES ($1, $2, 'Reported Lost', $3, $4, $5)`,
      [asset_id, reported_by, lastEmployeeId, lastLocationId, notes || 'Asset reported lost']
    );

    await client.query('COMMIT');
    res.status(201).json(lostResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to report lost asset' });
  } finally {
    client.release();
  }
}

async function getAllLostAssets(req, res) {
  try {
    const result = await db.query(`
      SELECT lr.*, a.asset_code, a.description,
        e.name AS last_known_employee_name, l.branch AS last_known_branch,
        s.name AS reported_by_name
      FROM lost_asset_record lr
      JOIN asset a ON lr.asset_id = a.id
      LEFT JOIN employee e ON lr.last_known_employee_id = e.id
      LEFT JOIN location l ON lr.last_known_location_id = l.id
      LEFT JOIN it_staff s ON lr.reported_by = s.id
      ORDER BY lr.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch lost asset records' });
  }
}

module.exports = { createLostAssetRecord, getAllLostAssets };