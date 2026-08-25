// Removes spreadsheet structure rows that were imported as if they were assets.
//
// The importer only skips a row when the ASSET CODE cell is empty. Section
// headings and subtotal labels ("2025 Additions", "Balance as at Close of
// 31st December 2025", "System Balance", "Variance", "FY2017") are non-empty
// strings, so they passed the check and became assets with the description
// "Unnamed asset". They inflate dashboard counts and get barcodes printed.
//
// Child tables are discovered from the catalog rather than hardcoded — an
// earlier version listed three and missed disposal_record and
// lost_asset_record, which fails on a foreign key partway through.
//
// Dry run (default):  node scripts/removeStructureRows.js
// Apply:              node scripts/removeStructureRows.js --apply

require('dotenv').config();
const pool = require('../src/db/pool');

// Anchored patterns only — deliberately narrow so a real asset can never match.
const JUNK_PATTERNS = [
  /^FY\d{4}$/i,
  /^20\d{2} Additions$/i,
  /^Balance as at\b.*/i,
  /^System Balance$/i,
  /^Variance$/i,
  /^Totals?$/i,
  /^New Seats$/i,
];

function isStructureRow(code) {
  const s = String(code).trim();
  return JUNK_PATTERNS.some((p) => p.test(s));
}

// Every table with a foreign key pointing at asset.
async function findChildTables() {
  const { rows } = await pool.query(
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

async function main() {
  const apply = process.argv.includes('--apply');

  const children = await findChildTables();
  console.log('Tables referencing asset:');
  children.forEach((c) => console.log(`  ${c.table}.${c.column}`));
  console.log('');

  const { rows } = await pool.query(
    `SELECT id, asset_code, description FROM asset ORDER BY asset_code`
  );
  const junk = rows.filter((r) => isStructureRow(r.asset_code));

  console.log(`Assets in database: ${rows.length}`);
  console.log(`Structure rows to remove: ${junk.length}\n`);

  if (junk.length === 0) {
    console.log('Nothing to remove.');
    return;
  }

  const ids = junk.map((r) => r.id);

  // Count what each row drags with it, so nothing is deleted blind.
  const counts = {};
  for (const c of children) {
    const { rows: n } = await pool.query(
      `SELECT ${c.column} AS asset_id, COUNT(*)::int AS n
       FROM ${c.table} WHERE ${c.column} = ANY($1::int[]) GROUP BY 1`,
      [ids]
    );
    n.forEach((x) => {
      counts[x.asset_id] = counts[x.asset_id] || {};
      counts[x.asset_id][c.table] = x.n;
    });
  }

  for (const r of junk) {
    const refs = counts[r.id] || {};
    const detail = Object.entries(refs).map(([t, n]) => `${t}=${n}`).join(' ') || 'no references';
    console.log(`  ${r.asset_code}  (${r.description})  ${detail}`);
    if (refs.asset_verification) {
      console.log('     ^ has a verification record — someone physically scanned this. Check before deleting.');
    }
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to delete these.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of children) {
      const res = await client.query(
        `DELETE FROM ${c.table} WHERE ${c.column} = ANY($1::int[])`,
        [ids]
      );
      if (res.rowCount > 0) console.log(`  deleted ${res.rowCount} from ${c.table}`);
    }
    const d = await client.query('DELETE FROM asset WHERE id = ANY($1::int[])', [ids]);
    await client.query('COMMIT');
    console.log(`\nDeleted ${d.rowCount} structure rows.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nRolled back — nothing was deleted.');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());