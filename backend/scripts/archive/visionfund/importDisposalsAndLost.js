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

async function getOrCreateAsset(row, categoryName, categoryMap) {
  const assetCode = row['ASSET CODE'];
  const description = row['DESCRIPTION'];

  // Skip junk: real rows always have a description; headers/notes/names don't
  if (!assetCode || typeof assetCode !== 'string' || !assetCode.trim()) return null;
  if (!description || typeof description !== 'string' || !description.trim()) return null;

  const existing = await pool.query('SELECT id FROM asset WHERE asset_code = $1', [assetCode.trim()]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  // Not found — create it from this row's own data
  const categoryId = categoryMap[categoryName] || null;
  const inserted = await pool.query(
    `INSERT INTO asset
      (asset_code, description, asset_category_id, serial_number, date_of_purchase, purchase_price, supplier, condition)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      assetCode.trim(),
      description.trim(),
      categoryId,
      row['SERIAL NO.'] || null,
      toDateString(row['DATE OF PURCHASE']),
      toNumber(row[' PURCHASE PRICE '] ?? row['PURCHASE PRICE']),
      row['SUPPLIER'] || null,
      'Good',
    ]
  );
  console.log(`  Created missing asset record: ${assetCode}`);
  return inserted.rows[0].id;
}

async function run() {
  const workbook = xlsx.readFile(FILE_PATH, { cellDates: true });

  const staffResult = await pool.query('SELECT id FROM it_staff WHERE email = $1', [IMPORTER_EMAIL]);
  if (staffResult.rows.length === 0) {
    console.error(`No it_staff found with email ${IMPORTER_EMAIL}`);
    process.exit(1);
  }
  const importerId = staffResult.rows[0].id;

  const categoryResult = await pool.query('SELECT id, name FROM asset_category');
  const categoryMap = {};
  categoryResult.rows.forEach(row => { categoryMap[row.name] = row.id; });

  // ---------- DISPOSAL FY2025 ----------
  const disposalSheet = workbook.Sheets['Disposal FY2025'];
  if (disposalSheet) {
    const rows = xlsx.utils.sheet_to_json(disposalSheet, { defval: null });
    console.log(`\nProcessing Disposal FY2025 (${rows.length} rows)`);

    let imported = 0, skipped = 0;
    for (const row of rows) {
      const assetId = await getOrCreateAsset(row, 'Equipment', categoryMap);
      if (!assetId) { skipped++; continue; }

      try {
        await pool.query(
          `INSERT INTO disposal_record
            (asset_id, base_gross_value, accumulated_depreciation, nbv_at_disposal, sales_proceeds, gain_or_loss, disposal_month, disposed_by, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            assetId,
            toNumber(row[' Base Gross Value ']),
            toNumber(row[' Acc. Dep ']),
            toNumber(row[' NBV ']),
            toNumber(row[' Sales Proceeds ']),
            toNumber(row[' Gain/ (Loss) ']),
            toDateString(row['Disposal Month']),
            importerId,
            'Imported from Disposal FY2025 sheet',
          ]
        );

        await pool.query(`UPDATE asset SET status = 'Disposed' WHERE id = $1`, [assetId]);
        await pool.query(
          `INSERT INTO scan_log (asset_id, scanned_by, action, notes) VALUES ($1,$2,'Disposed','Historical import - Disposal FY2025')`,
          [assetId, importerId]
        );

        imported++;
      } catch (err) {
        console.error(`  Error on row:`, err.message);
        skipped++;
      }
    }
    console.log(`  Disposal FY2025: ${imported} imported, ${skipped} skipped`);
  }

  // ---------- LOST ASSETS ----------
  const lostSheet = workbook.Sheets['Lost Assets'];
  if (lostSheet) {
    const rows = xlsx.utils.sheet_to_json(lostSheet, { defval: null });
    console.log(`\nProcessing Lost Assets (${rows.length} rows)`);

    let imported = 0, skipped = 0;
    for (const row of rows) {
      const assetId = await getOrCreateAsset(row, 'Equipment', categoryMap);
      if (!assetId) { skipped++; continue; }

      try {
        await pool.query(
          `INSERT INTO lost_asset_record (asset_id, reported_by, notes)
           VALUES ($1,$2,$3)`,
          [assetId, importerId, 'Imported from Lost Assets sheet']
        );

        await pool.query(`UPDATE asset SET status = 'Lost' WHERE id = $1`, [assetId]);
        await pool.query(
          `INSERT INTO scan_log (asset_id, scanned_by, action, notes) VALUES ($1,$2,'Reported Lost','Historical import - Lost Assets')`,
          [assetId, importerId]
        );

        imported++;
      } catch (err) {
        console.error(`  Error on row:`, err.message);
        skipped++;
      }
    }
    console.log(`  Lost Assets: ${imported} imported, ${skipped} skipped`);
  }

  console.log('\nDone.');
  await pool.end();
}

run().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});