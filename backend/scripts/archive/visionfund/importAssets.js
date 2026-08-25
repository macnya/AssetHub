require('dotenv').config();
const path = require('path');
const xlsx = require('xlsx');
const pool = require('../src/db/pool');
const { ASSET_CONDITIONS } = require('../src/constants/assetConditions');

const FILE_PATH = path.join(__dirname, '../data/fixed-asset-register.xlsx');
const IMPORTER_EMAIL = 'anifa.sumba@visionfundkenya.co.ke'; // must match the it_staff account you registered

// Column mapping per sheet — accounts for naming differences across sheets
const sheetConfigs = [
  {
    sheetName: 'Equipments',
    category: 'Equipment',
    cols: { code: 'ASSET CODE', desc: 'DESCRIPTION', serial: 'SERIAL NO.', purchaseDate: 'DATE OF PURCHASE', price: 'PURCHASE PRICE', supplier: 'SUPPLIER', dept: 'LOCATION', branch: 'BRANCH', physLoc: 'PHYSICAL LOCATION', status: 'CURRENT STATUS', endDate: 'CURRENT END MONTH DATE', years: 'No. OF YEARS', remLife: 'REMAINING LIFE', monthlyDep: 'Monthly Depreciation', accDep: 'Accumulated Depreciation', nbv: 'NBV' },
  },
  {
    sheetName: 'Plant & Machinery',
    category: 'Plant & Machinery',
    cols: { code: 'ASSET CODE', desc: 'DESCRIPTION', serial: 'SERIAL NO', purchaseDate: 'DATE OF PURCHASE', price: 'PURCHASE PRICE', supplier: 'SUPPLIER', dept: 'LOCATION', branch: 'BRANCH', physLoc: 'NAM E OF USER', status: 'CURRENT STATUS', endDate: 'CURRENT END MONTH DATE', years: 'No. OF YEARS', remLife: 'REMAINING LIFE', monthlyDep: 'Monthly Depreciation', accDep: 'Accumulated Depreciation', nbv: 'NBV' },
  },
  {
    sheetName: 'Furniture & Fittings',
    category: 'Furniture & Fittings',
    cols: { code: 'ASSET CODE', desc: 'DESCRIPTION', serial: 'SERIAL NO.', purchaseDate: 'DATE OF PURCHASE', price: 'PURCHASE PRICE', supplier: 'SUPPLIER', dept: 'LOCATION', branch: 'BRANCH', physLoc: 'PHYSICAL LOCATION', status: 'CURRENT STATUS', endDate: 'CURRENT END MONTH DATE', years: 'No. OF YEARS', remLife: 'REMAINING LIFE', monthlyDep: 'Monthly Depreciation', accDep: 'Accumulated Depreciation', nbv: 'NBV' },
  },
  {
    sheetName: 'Computer & Peripherals',
    category: 'Computer & Peripherals',
    cols: { code: 'ASSET CODE', desc: 'DESCRIPTION', serial: 'SERIAL NO.', purchaseDate: 'DATE OF PURCHASE', price: 'PURCHASE PRICE', supplier: 'SUPPLIER', dept: 'LOCATION', branch: 'BRANCH', physLoc: 'PHYSICAL LOCATION', status: 'CURRENT STATUS', endDate: 'CURRENT END MONTH DATE', years: 'No. OF YEARS', remLife: 'REMAINING LIFE', monthlyDep: 'Monthly Depreciation', accDep: 'Accumulated Depreciation', nbv: 'NBV' },
  },
  {
    sheetName: 'Motor Vehicles',
    category: 'Motor Vehicles',
    cols: { code: 'ASSET CODE', desc: 'DESCRIPTION', serial: 'SERIAL NO.', purchaseDate: 'DATE OF PURCHASE', price: 'PURCHASE PRICE', supplier: 'SUPPLIER', dept: 'LOCATION', branch: 'BRANCH', physLoc: 'PHYSICAL LOCATION', status: 'CURRENT STATUS', endDate: 'CURRENT END MONTH DATE', years: 'No. OF YEARS', remLife: 'REMAINING LIFE', monthlyDep: 'Monthly Depreciation', accDep: 'Accumulated Depreciation', nbv: 'NBV', chassis: 'CHASSIS NO', engine: 'ENGINE NO' },
  },
  {
    sheetName: 'Tablets',
    category: 'Tablets',
    cols: { code: 'ASSET CODE', desc: 'DESCRIPTION', serial: 'TABLET Imei', purchaseDate: 'DATE OF PURCHASE', price: 'PURCHASE PRICE', supplier: 'SUPPLIER', dept: 'Department', branch: 'BRANCH', physLoc: 'Current User', status: 'STATUS', endDate: null, years: null, remLife: null, monthlyDep: null, accDep: null, nbv: null },
  },
  {
    sheetName: 'Non- Capitalized',
    category: 'Non-Capitalized',
    cols: { code: 'ASSET CODE', desc: 'DESCRIPTION', serial: 'SERIAL NO.', purchaseDate: 'DATE OF PURCHASE', price: 'PURCHASE PRICE', supplier: 'SUPPLIER', dept: 'Department', branch: 'BRANCH', physLoc: 'PHYSICAL LOCATION', status: 'STATUS', endDate: 'CURRENT END MONTH DATE', years: 'No. OF YEARS', remLife: 'REMAINING LIFE', monthlyDep: null, accDep: null, nbv: null },
  },
];

// The sheet's CURRENT STATUS column is supposed to hold a condition, but in
// the Motor Vehicles sheet it frequently held an engine number or a location.
// Importing that verbatim is how ~100 assets ended up with a chassis code as
// their condition. Anything unrecognised is now reported and stored as NULL
// ("not recorded") rather than silently accepted or defaulted to 'Good'.
const rejectedConditions = [];

function normaliseCondition(value, assetCode) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null; // genuinely blank: not recorded, don't claim 'Good'
  }

  const raw = String(value).trim();
  const match = ASSET_CONDITIONS.find((c) => c.toLowerCase() === raw.toLowerCase());
  if (match) return match;

  rejectedConditions.push({ assetCode, value: raw });
  return null;
}

// Dates are read as calendar dates, not instants. See the note in
// backfillAssetValues.js: .toISOString() shifted every purchase date in the
// register back by one day.
function toDateString(value) {
  if (!value) return null;

  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return null;

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  // Money sometimes arrives as "1,234.50" or "KES 1,234", where a bare Number()
  // gives NaN and the value is silently lost.
  const cleaned = typeof value === 'string' ? value.replace(/[^0-9.-]/g, '') : value;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// A number of years is a small number. On the Non-Capitalized sheet that column
// holds phone numbers, IMEIs and a serial ("CODE: 23K1G03CN00W"), none of which
// are years — and 254742876196 overflows NUMERIC(6,2), which aborts the whole
// import. Anything implausible is dropped and reported rather than written.
const rejectedYears = [];

function toYears(value, assetCode) {
  const n = toNumber(value);
  if (n === null) return null;
  if (n < 0 || n > 100) {
    rejectedYears.push({ assetCode, value });
    return null;
  }
  return n;
}

async function run() {
  const workbook = xlsx.readFile(FILE_PATH, { cellDates: true });

  // Get category id lookup
  const categoryResult = await pool.query('SELECT id, name FROM asset_category');
  const categoryMap = {};
  categoryResult.rows.forEach(row => { categoryMap[row.name] = row.id; });

  // Get importer it_staff id
  const staffResult = await pool.query('SELECT id FROM it_staff WHERE email = $1', [IMPORTER_EMAIL]);
  if (staffResult.rows.length === 0) {
    console.error(`No it_staff found with email ${IMPORTER_EMAIL} — update IMPORTER_EMAIL in the script.`);
    process.exit(1);
  }
  const importerId = staffResult.rows[0].id;

  // Cache for location lookups (avoid duplicate rows for the same branch/dept/physLoc combo)
  const locationCache = new Map();

  async function getOrCreateLocation(branch, department, physLoc) {
    const key = `${branch}||${department}||${physLoc}`;
    if (locationCache.has(key)) return locationCache.get(key);

    const existing = await pool.query(
      `SELECT id FROM location WHERE branch = $1 AND department IS NOT DISTINCT FROM $2 AND physical_location IS NOT DISTINCT FROM $3`,
      [branch, department, physLoc]
    );

    let locationId;
    if (existing.rows.length > 0) {
      locationId = existing.rows[0].id;
    } else {
      const inserted = await pool.query(
        `INSERT INTO location (branch, department, physical_location) VALUES ($1, $2, $3) RETURNING id`,
        [branch, department, physLoc]
      );
      locationId = inserted.rows[0].id;
    }

    locationCache.set(key, locationId);
    return locationId;
  }

  let totalImported = 0;
  let totalSkipped = 0;
  let totalUnchanged = 0;

  for (const config of sheetConfigs) {
    const sheet = workbook.Sheets[config.sheetName];
    if (!sheet) {
      console.warn(`Sheet not found: ${config.sheetName} — skipping`);
      continue;
    }

    // Excel pads the header of numeric columns in this workbook:
    // ' PURCHASE PRICE ', ' NBV ', ' No. OF YEARS ' all carry a leading and
    // trailing space, while every text column is clean. Without this trim,
    // row['PURCHASE PRICE'] is undefined, toNumber turns that into null, and
    // the insert accepts it — which is how the register ended up holding 154
    // prices out of 2,311 and reporting a total value of KES 2.5m instead of
    // KES 165m. Nothing complained at any point.
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: null }).map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim(), v]))
    );
    const categoryId = categoryMap[config.category];

    if (!categoryId) {
      console.warn(`Category not found in DB: ${config.category} — skipping sheet`);
      continue;
    }

    console.log(`\nImporting sheet: ${config.sheetName} (${rows.length} rows)`);
    let sheetImported = 0;

    for (const row of rows) {
      const c = config.cols;
      const assetCode = row[c.code];

      // Skip blank/invalid rows
      if (!assetCode || typeof assetCode !== 'string' || !assetCode.trim()) {
        totalSkipped++;
        continue;
      }

      const description = row[c.desc] || 'Unnamed asset';
      const branch = row[c.branch] || null;
      const department = c.dept ? row[c.dept] : null;
      const physLoc = c.physLoc ? row[c.physLoc] : null;

      try {
        // Insert asset (skip if asset_code already exists)
        const assetResult = await pool.query(
          `INSERT INTO asset
            (asset_code, description, asset_category_id, serial_number, date_of_purchase,
             purchase_price, supplier, useful_life_years, remaining_life, monthly_depreciation,
             accumulated_depreciation, nbv, current_end_month_date, condition,
             chassis_number, engine_number)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (asset_code) DO NOTHING
           RETURNING id`,
          [
            assetCode.trim(),
            description,
            categoryId,
            row[c.serial] || null,
            toDateString(row[c.purchaseDate]),
            toNumber(row[c.price]),
            row[c.supplier] || null,
            c.years ? toYears(row[c.years], assetCode) : null,
            c.remLife ? toYears(row[c.remLife], assetCode) : null,
            c.monthlyDep ? toNumber(row[c.monthlyDep]) : null,
            c.accDep ? toNumber(row[c.accDep]) : null,
            c.nbv ? toNumber(row[c.nbv]) : null,
            c.endDate ? toDateString(row[c.endDate]) : null,
            normaliseCondition(row[c.status], assetCode),
            c.chassis ? (row[c.chassis] || null) : null,
            c.engine ? (row[c.engine] || null) : null,
          ]
        );

        if (assetResult.rows.length === 0) {
          // ON CONFLICT DO NOTHING means this row ALREADY EXISTED and nothing
          // was updated. Reported as such rather than as a "duplicate", which
          // read like the importer had done its job — it had not, and that is
          // why missing prices went unnoticed for so long. To correct existing
          // rows, use backfillAssetValues.js.
          totalUnchanged++;
          continue;
        }

        const assetId = assetResult.rows[0].id;

        // Create/reuse location, then record the initial assignment + audit entry
        if (branch) {
          const locationId = await getOrCreateLocation(branch, department, physLoc);

          await pool.query(
            `INSERT INTO assignment (asset_id, location_id, assigned_by) VALUES ($1, $2, $3)`,
            [assetId, locationId, importerId]
          );

          await pool.query(
            `INSERT INTO scan_log (asset_id, scanned_by, action, to_location_id, notes)
             VALUES ($1, $2, $3, $4, $5)`,
            [assetId, importerId, 'Import', locationId, 'Initial bulk import from fixed asset register']
          );
        }

        sheetImported++;
        totalImported++;
      } catch (err) {
        console.error(`Error importing ${assetCode}:`, err.message);
        totalSkipped++;
      }
    }

    console.log(`  → ${sheetImported} imported from ${config.sheetName}`);
  }

  if (rejectedConditions.length > 0) {
    console.log(`\n${rejectedConditions.length} rows had an unusable CURRENT STATUS (stored as NULL):`);
    rejectedConditions.slice(0, 20).forEach((r) => console.log(`  ${r.assetCode}: "${r.value}"`));
    if (rejectedConditions.length > 20) {
      console.log(`  ...and ${rejectedConditions.length - 20} more`);
    }
    console.log('Fix these in the spreadsheet — CURRENT STATUS should only contain:');
    console.log(`  ${ASSET_CONDITIONS.join(', ')}`);
  }

  if (rejectedYears.length > 0) {
    console.log(`\n${rejectedYears.length} rows had an implausible number of years (stored as NULL):`);
    rejectedYears.slice(0, 15).forEach((r) => console.log(`  ${r.assetCode}: "${r.value}"`));
    if (rejectedYears.length > 15) console.log(`  ...and ${rejectedYears.length - 15} more`);
    console.log('On the Non-Capitalized sheet this column holds phone numbers and IMEIs.');
    console.log('Those belong in their own field, not in No. OF YEARS.');
  }

  console.log(`\nDone.`);
  console.log(`  imported (new rows):        ${totalImported}`);
  console.log(`  already present, unchanged: ${totalUnchanged}`);
  console.log(`  skipped (blank or errored): ${totalSkipped}`);
  if (totalUnchanged > 0) {
    console.log(`\nThis script only INSERTS. The ${totalUnchanged} rows above already existed and`);
    console.log('were left exactly as they were — nothing was corrected. Use');
    console.log('backfillAssetValues.js to fill in fields missing on existing rows.');
  }
  await pool.end();
}

run().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});