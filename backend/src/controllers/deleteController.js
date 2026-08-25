const pool = require('../db/pool');

// Deleting assets from the register.
//
// TWO DIFFERENT THINGS ARE CALLED "DELETE"
//
// Removing a mistake — a row typed twice, an import that brought in junk.
// Nothing has ever happened to it, so removing it loses nothing and is right.
//
// Removing a real asset — it has verifications, custody history, perhaps a
// disposal record. Deleting it destroys the audit trail. The register is an
// audit document; Finance may have reported on this asset and an auditor may
// have signed it off. What is wanted there is "Mark as disposed" or "Report as
// lost", which keep the record and say what became of the thing.
//
// So this deletes only assets with no history, and refuses the rest with an
// explanation rather than cascading through their records silently.

// Everything that would be destroyed along with an asset. Discovered from the
// catalog rather than listed by hand: a hand-written list already missed
// scan_log once on this project, and the delete failed on a foreign key nobody
// remembered existed.
async function findReferencingTables(client) {
  const { rows } = await client.query(
    `SELECT tc.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND ccu.table_name = 'asset'
       AND tc.table_name <> 'asset'`
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

// What history does this asset carry? Counted per table, so the refusal can say
// what stands in the way rather than just refusing.
async function historyFor(client, assetId, refs) {
  const counts = {};
  for (const ref of refs) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${ref.table} WHERE ${ref.column} = $1`,
      [assetId]
    );
    if (rows[0].n > 0) counts[ref.table] = rows[0].n;
  }
  return counts;
}

// A count of assignments alone is not history: the import created one for every
// asset that had a location, so every asset has at least one. What matters is
// whether anybody has DONE anything — verified it, moved it, disposed of it.
const IMPORT_ONLY = new Set(['assignment', 'scan_log']);

function isJustImported(counts) {
  const meaningful = Object.keys(counts).filter((t) => !IMPORT_ONLY.has(t));
  if (meaningful.length) return false;
  // One assignment and one scan_log entry is exactly what the import left.
  return (counts.assignment || 0) <= 1 && (counts.scan_log || 0) <= 1;
}

// GET /assets/:asset_code/deletable — can this be removed, and if not, why not?
//
// Asked before the button is shown, so nobody is offered an action that will be
// refused.
async function checkDeletable(req, res) {
  const { asset_code } = req.params;
  const client = await pool.connect();

  try {
    const { rows } = await client.query(
      'SELECT id, asset_code, description FROM asset WHERE asset_code = $1',
      [asset_code]
    );
    if (!rows.length) return res.status(404).json({ error: 'Asset not found' });

    const refs = await findReferencingTables(client);
    const counts = await historyFor(client, rows[0].id, refs);
    const clean = isJustImported(counts);

    res.json({
      asset_code: rows[0].asset_code,
      description: rows[0].description,
      deletable: clean,
      history: counts,
      reason: clean ? null
        : 'This asset has history. Use "Mark as disposed" or "Report as lost" instead, ' +
          'which keep the record and say what became of it.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check that asset' });
  } finally {
    client.release();
  }
}

// DELETE /assets/:asset_code
async function deleteAsset(req, res) {
  const { asset_code } = req.params;
  const { reason } = req.body;

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A reason is required. Deleting a register entry should be explicable.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT id, asset_code, description FROM asset WHERE asset_code = $1',
      [asset_code]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Asset not found' });
    }

    const asset = rows[0];
    const refs = await findReferencingTables(client);
    const counts = await historyFor(client, asset.id, refs);

    if (!isJustImported(counts)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This asset has history and cannot be deleted.',
        history: counts,
        suggestion: 'Use "Mark as disposed" or "Report as lost" instead. Those keep the record.',
      });
    }

    // Record what is about to disappear, so the deletion itself leaves a trace.
    // A register that can lose a row without saying so is not an audit document.
    await client.query(
      `INSERT INTO bot_query_log
         (platform_user_id, username, staff_id, query, intent, response, refused)
       VALUES ($1, $2, $3, $4, 'asset_deleted', $5, false)`,
      [
        `web:${req.user.id}`, req.user.email, req.user.id,
        `Deleted ${asset.asset_code}`,
        JSON.stringify({ asset_code: asset.asset_code, description: asset.description, reason: String(reason).trim() }),
      ]
    ).catch(() => {});

    // The import's own rows go with it; there is nothing else by definition.
    for (const ref of refs) {
      await client.query(`DELETE FROM ${ref.table} WHERE ${ref.column} = $1`, [asset.id]);
    }
    await client.query('DELETE FROM asset WHERE id = $1', [asset.id]);

    await client.query('COMMIT');

    res.json({ deleted: asset.asset_code, message: `${asset.asset_code} removed from the register.` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not delete that asset' });
  } finally {
    client.release();
  }
}

// POST /assets/delete-batch — remove several at once.
//
// Deliberately not "delete everything". A whole-register wipe has no legitimate
// use that a restore from backup does not serve better, and offering it as a
// button invites the accident it enables.
async function deleteBatch(req, res) {
  const { asset_codes, reason, batch_id } = req.body;

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A reason is required' });
  }

  let codes = Array.isArray(asset_codes) ? asset_codes : [];

  // Removing an import that went wrong is the main honest use of bulk delete,
  // so a batch can be named instead of listing its codes.
  if (batch_id) {
    const { rows } = await pool.query(
      'SELECT created_codes FROM import_batch WHERE id = $1', [batch_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Import batch not found' });
    codes = rows[0].created_codes || [];
  }

  if (!codes.length) return res.status(400).json({ error: 'Nothing to delete' });
  if (codes.length > 5000) return res.status(400).json({ error: 'Too many at once' });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const refs = await findReferencingTables(client);
    const deleted = [];
    const refused = [];

    for (const code of codes) {
      const { rows } = await client.query(
        'SELECT id, asset_code FROM asset WHERE asset_code = $1', [code]
      );
      if (!rows.length) { refused.push({ code, reason: 'Not in the register' }); continue; }

      const counts = await historyFor(client, rows[0].id, refs);
      if (!isJustImported(counts)) {
        refused.push({ code, reason: 'Has history', history: counts });
        continue;
      }

      for (const ref of refs) {
        await client.query(`DELETE FROM ${ref.table} WHERE ${ref.column} = $1`, [rows[0].id]);
      }
      await client.query('DELETE FROM asset WHERE id = $1', [rows[0].id]);
      deleted.push(code);
    }

    await client.query(
      `INSERT INTO bot_query_log
         (platform_user_id, username, staff_id, query, intent, response, refused)
       VALUES ($1, $2, $3, $4, 'assets_deleted', $5, false)`,
      [
        `web:${req.user.id}`, req.user.email, req.user.id,
        `Deleted ${deleted.length} assets`,
        JSON.stringify({ deleted, refused: refused.length, reason: String(reason).trim(), batch_id: batch_id || null }),
      ]
    ).catch(() => {});

    await client.query('COMMIT');

    res.json({
      deleted: deleted.length,
      refused: refused.length,
      deleted_codes: deleted,
      // Named rather than counted: "12 could not be deleted" is not actionable.
      refusals: refused.slice(0, 100),
      message: refused.length
        ? `${deleted.length} removed. ${refused.length} kept because they have history.`
        : `${deleted.length} removed.`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'The deletion failed and nothing was removed.' });
  } finally {
    client.release();
  }
}

module.exports = { checkDeletable, deleteAsset, deleteBatch };