require('dotenv').config();
const path = require('path');
const xlsx = require('xlsx');
const pool = require('../src/db/pool');

const FILE_PATH = path.join(__dirname, '../data/fixed-asset-register.xlsx');
const IMPORTER_EMAIL = 'testadmin@visionfund.com';

function toDateString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  return null;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return isNaN(n) ? null : n;
}

async function run() {
  const workbook = xlsx.readFile(FILE_PATH, { cellDates: true });

  const categoryResult = await pool.query('SELECT id, name FROM asset_category');
  const categoryMap = {};
  categoryResult.rows.forEach(row => { categoryMap[row.name] = row.id; });
  const intangiblesCategoryId = categoryMap['Intangibles'];

  const staffResult = await pool.query('SELECT id FROM it_staff WHERE email = $1', [IMPORTER_EMAIL]);
  if (staffResult.rows.length === 0) {
    console.error(`No it_staff found with email ${IMPORTER_EMAIL}`);
    process.exit(1);
  }
  const importerId = staffResult.rows[0].id;

  const locationCache = new Map();
  async function getOrCreateLocation(branch, physLoc) {
    const key = `${branch}||${physLoc}`;
    if (locationCache.has(key)) return locationCache.get(key);

    const existing = await pool.query(
      `SELECT id FROM location WHERE branch = $1 AND physical_location IS NOT DISTINCT FROM $2`,
      [branch, physLoc]
    );

    let locationId;
    if (existing.rows.length > 0) {
      locationId = existing.rows[0].id;
    } else {
      const inserted = await pool.query(
        `INSERT INTO location (branch, physical_location) VALUES ($1, $2) RETURNING id`,
        [branch, physLoc]
      );
      locationId = inserted.rows[0].id;
    }
    locationCache.set(key, locationId);
    return locationId;
  }

  const sheet = workbook.Sheets['Intangibles'];
  if (!sheet) {
    console.error('Sheet "Intangibles" not found.');
    process.exit(1);
  }

  const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });
  console.log(`Processing Intangibles (${rows.length} rows)`);

  let imported = 0, skipped = 0;
  for (const row of rows) {
    const assetCode = row['ASSET CODE'];
    const description = row['DESCRIPTION'];

    if (!assetCode || typeof assetCode !== 'string' || !assetCode.trim()) { skipped++; continue; }
    if (!description || typeof description !== 'string' || !description.trim()) { skipped++; continue; }

    try {
      const existing = await pool.query('SELECT id FROM asset WHERE asset_code = $1', [assetCode.trim()]);
      if (existing.rows.length > 0) {
        skipped++;
        continue; // already imported somehow — don't duplicate
      }

      const assetResult = await pool.query(
        `INSERT INTO asset
          (asset_code, description, asset_category_id, serial_number, date_of_purchase,
           purchase_price, supplier, useful_life_years, remaining_life, monthly_depreciation,
           accumulated_depreciation, nbv, current_end_month_date, condition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          assetCode.trim(),
          description.trim(),
          intangiblesCategoryId,
          row['SERIAL NO.'] || null,
          toDateString(row['DATE OF PURCHASE']),
          toNumber(row['PURCHASE PRICE']),
          row['SUPPLIER'] || null,
          toNumber(row['No. OF YEARS']),
          toNumber(row['REMAINING LIFE']),
          toNumber(row['Monthly Depreciation']),
          toNumber(row['Accumulated Depreciation']),
          toNumber(row['NBV']),
          toDateString(row['CURRENT END MONTH DATE']),
          row['CURRENT STATUS'] || 'Good',
        ]
      );

      const assetId = assetResult.rows[0].id;
      const branch = row['LOCATION'] || null;
      const physLoc = row['PHYSICAL LOCATION'] || row['NAM E OF USER'] || null;

      if (branch) {
        const locationId = await getOrCreateLocation(branch, physLoc);
        await pool.query(
          `INSERT INTO assignment (asset_id, location_id, assigned_by) VALUES ($1, $2, $3)`,
          [assetId, locationId, importerId]
        );
        await pool.query(
          `INSERT INTO scan_log (asset_id, scanned_by, action, to_location_id, notes)
           VALUES ($1, $2, 'Import', $3, 'Imported from Intangibles sheet')`,
          [assetId, importerId, locationId]
        );
      }

      imported++;
    } catch (err) {
      console.error(`  Error on ${assetCode}:`, err.message);
      skipped++;
    }
  }

  console.log(`\nDone. Intangibles: ${imported} imported, ${skipped} skipped`);
  await pool.end();
}

run().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});