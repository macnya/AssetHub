// Clears conditions that the old importer invented.
//
// importAssets.js used to do: row[c.status] || 'Good'
// Where the spreadsheet cell was empty, it wrote 'Good' regardless. Around 122
// assets therefore claim a condition nobody ever recorded. Because the import
// uses ON CONFLICT DO NOTHING, re-running it will never correct them.
//
// This compares the live database against the cleaned spreadsheet and clears
// the condition wherever the sheet is blank. NULL means "not yet inspected",
// which is the truth, and it becomes the work queue for field verification.
//
// Dry run (default):  node scripts/reconcileBlankConditions.js
// Apply:              node scripts/reconcileBlankConditions.js --apply

require('dotenv').config();
const path = require('path');
const xlsx = require('xlsx');
const pool = require('../src/db/pool');

const FILE_PATH = path.join(__dirname, '../data/fixed-asset-register.xlsx');

// Sheet name -> the column header holding the condition.
const SHEETS = {
  'Equipments': 'CURRENT STATUS',
  'Plant & Machinery': 'CURRENT STATUS',
  'Furniture & Fittings': 'CURRENT STATUS',
  'Computer & Peripherals': 'CURRENT STATUS',
  'Motor Vehicles': 'CURRENT STATUS',
  'Tablets': 'STATUS',
  'Non- Capitalized': 'STATUS',
};

async function main() {
  const apply = process.argv.includes('--apply');
  const workbook = xlsx.readFile(FILE_PATH, { cellDates: true });

  // Every asset code whose condition cell is blank in the cleaned sheet.
  const blankInSheet = new Set();
  let sheetRows = 0;

  for (const [sheetName, statusCol] of Object.entries(SHEETS)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      console.warn(`Sheet not found: ${sheetName} — skipping`);
      continue;
    }
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });
    for (const row of rows) {
      const code = row['ASSET CODE'];
      if (!code || typeof code !== 'string' || !code.trim()) continue;
      sheetRows += 1;
      const v = row[statusCol];
      if (v === null || v === undefined || String(v).trim() === '') {
        blankInSheet.add(code.trim());
      }
    }
  }

  console.log(`Asset rows read from spreadsheet: ${sheetRows}`);
  console.log(`Blank condition in spreadsheet:   ${blankInSheet.size}\n`);

  if (blankInSheet.size === 0) {
    console.log('Nothing to reconcile.');
    return;
  }

  // Of those, which currently hold a value in the database?
  const codes = [...blankInSheet];
  const { rows } = await pool.query(
    `SELECT asset_code, condition
     FROM asset
     WHERE asset_code = ANY($1::text[])
       AND condition IS NOT NULL
     ORDER BY asset_code`,
    [codes]
  );

  const byValue = rows.reduce((acc, r) => {
    acc[r.condition] = (acc[r.condition] || 0) + 1;
    return acc;
  }, {});

  console.log(`Assets in the database with a condition the spreadsheet does not have: ${rows.length}`);
  Object.entries(byValue).forEach(([v, n]) => console.log(`  "${v}" x ${n}`));
  console.log('');
  rows.slice(0, 25).forEach((r) => console.log(`  ${r.asset_code}: "${r.condition}" -> NULL`));
  if (rows.length > 25) console.log(`  ...and ${rows.length - 25} more`);

  if (rows.length === 0) {
    console.log('\nNothing to clear — already consistent.');
    return;
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write the changes.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE asset SET condition = NULL WHERE asset_code = ANY($1::text[]) AND condition IS NOT NULL`,
      [rows.map((r) => r.asset_code)]
    );
    await client.query('COMMIT');
    console.log(`\nCleared ${result.rowCount} invented conditions.`);
    console.log('These are now your field verification work queue:');
    console.log('  SELECT asset_code, description FROM asset WHERE condition IS NULL;');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nRolled back — nothing was written.');
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