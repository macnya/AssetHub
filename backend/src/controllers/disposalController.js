const pool = require('../db/pool');

// POST /disposals — record a disposal and update the asset's status
async function createDisposal(req, res) {
  const {
    asset_id, sales_proceeds, disposal_month, notes
  } = req.body;
  const disposed_by = req.user.id;

  if (!asset_id) {
    return res.status(400).json({ error: 'asset_id is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const assetResult = await client.query('SELECT * FROM asset WHERE id = $1', [asset_id]);
    if (assetResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Asset not found' });
    }
    const asset = assetResult.rows[0];

    const baseGrossValue = asset.purchase_price;
    const accumulatedDepreciation = asset.accumulated_depreciation;
    const nbvAtDisposal = asset.nbv;
    const gainOrLoss = sales_proceeds != null && nbvAtDisposal != null
      ? sales_proceeds - nbvAtDisposal
      : null;

    const disposalResult = await client.query(
      `INSERT INTO disposal_record
        (asset_id, base_gross_value, accumulated_depreciation, nbv_at_disposal, sales_proceeds, gain_or_loss, disposal_month, disposed_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [asset_id, baseGrossValue, accumulatedDepreciation, nbvAtDisposal, sales_proceeds || null, gainOrLoss, disposal_month || null, disposed_by, notes || null]
    );

    // Close out any active assignment
    await client.query(
      `UPDATE assignment SET returned_date = now() WHERE asset_id = $1 AND returned_date IS NULL`,
      [asset_id]
    );

    await client.query(`UPDATE asset SET status = 'Disposed' WHERE id = $1`, [asset_id]);

    await client.query(
      `INSERT INTO scan_log (asset_id, scanned_by, action, notes)
       VALUES ($1, $2, 'Disposed', $3)`,
      [asset_id, disposed_by, notes || 'Asset disposed']
    );

    await client.query('COMMIT');
    res.status(201).json(disposalResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to record disposal' });
  } finally {
    client.release();
  }
}

async function getAllDisposals(req, res) {
  try {
    const result = await pool.query(`
      SELECT dr.*, a.asset_code, a.description, s.name AS disposed_by_name
      FROM disposal_record dr
      JOIN asset a ON dr.asset_id = a.id
      LEFT JOIN it_staff s ON dr.disposed_by = s.id
      ORDER BY dr.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch disposal records' });
  }
}

module.exports = { createDisposal, getAllDisposals };