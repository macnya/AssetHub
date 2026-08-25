// Repairs asset rows where the source spreadsheet put the wrong data in the
// DESCRIPTION and CURRENT STATUS columns.
//
// What went wrong: importAssets.js correctly maps the sheet's CURRENT STATUS
// column into asset.condition. But in the Motor Vehicles sheet, 96 of 122 rows
// have an engine number (or a location) in that column instead of a condition,
// and 8 of those also have a chassis number where the description should be.
// The importer copied it faithfully. The spreadsheet is the thing that's wrong.
//
// Nothing here is deleted — the engine and chassis numbers are moved into
// their own columns, which requires these to exist first:
//
//   ALTER TABLE asset ADD COLUMN IF NOT EXISTS chassis_number TEXT;
//   ALTER TABLE asset ADD COLUMN IF NOT EXISTS engine_number  TEXT;
//
// Dry run (default):  node scripts/repairMotorVehicleData.js
// Apply:              node scripts/repairMotorVehicleData.js --apply

require('dotenv').config();
const pool = require('../src/db/pool');
const { ASSET_CONDITIONS } = require('../src/constants/assetConditions');

// Values that carry no condition information at all. Cleared to NULL rather
// than guessed at, because claiming "Good" for an asset nobody has inspected
// is how a register stops being trustworthy.
const MEANINGLESS = ['HEAD OFFICE', 'Domicile location'];

// Free text that does describe a condition, mapped by hand.
const FREE_TEXT = {
  'Faulty Door': 'Good with issues', // switch cabinet: door damaged, unit works
};

// Replacement description for rows whose description is a chassis number.
// Matches the correctly-entered motorcycles in the same sheet.
const MOTORCYCLE_DESCRIPTION = 'Motor Cycle';

// Engine numbers come from the condition column and may contain a separator
// (some rows hold two numbers joined by a slash), so spaces are tolerated here.
function looksLikeEngineNumber(value) {
  const s = String(value).trim();
  return /^[A-Z0-9][A-Z0-9\-\/ ]{6,}$/.test(s) && /\d/.test(s);
}

// A chassis/VIN is a single unbroken token. Model names like
// "TVS HLX 125CC 4-GEAR REF -LOCAL" contain spaces and must not match —
// an earlier version of this script used one loose pattern for both and
// wiped 29 legitimate descriptions as a result.
function looksLikeChassis(value) {
  return /^[A-Z0-9]{10,}$/.test(String(value).trim());
}

function canonicalise(value) {
  const s = String(value).trim();
  return ASSET_CONDITIONS.find((c) => c.toLowerCase() === s.toLowerCase()) || null;
}

async function main() {
  const apply = process.argv.includes('--apply');

  const columnCheck = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'asset' AND column_name IN ('chassis_number','engine_number')`
  );
  if (columnCheck.rows.length < 2) {
    console.error(
      'Missing columns. Run this first:\n' +
      '  ALTER TABLE asset ADD COLUMN IF NOT EXISTS chassis_number TEXT;\n' +
      '  ALTER TABLE asset ADD COLUMN IF NOT EXISTS engine_number  TEXT;'
    );
    process.exitCode = 1;
    return;
  }

  const { rows } = await pool.query(
    `SELECT a.id, a.asset_code, a.description, a.serial_number, a.condition,
            a.chassis_number, a.engine_number, ac.name AS category
     FROM asset a
     LEFT JOIN asset_category ac ON ac.id = a.asset_category_id
     WHERE a.condition IS NOT NULL
       AND NOT (a.condition = ANY($1::text[]))
     ORDER BY a.asset_code`,
    [ASSET_CONDITIONS]
  );

  const plan = [];
  const unhandled = [];

  for (const r of rows) {
    const raw = String(r.condition).trim();
    const change = { id: r.id, asset_code: r.asset_code, sets: {}, why: '' };

    if (canonicalise(raw)) {
      change.sets.condition = canonicalise(raw);
      change.why = `case variant "${raw}"`;
    } else if (FREE_TEXT[raw]) {
      change.sets.condition = FREE_TEXT[raw];
      change.why = `free text "${raw}"`;
    } else if (MEANINGLESS.includes(raw)) {
      change.sets.condition = null;
      change.why = `"${raw}" is not a condition — never recorded`;
    } else if (looksLikeEngineNumber(raw)) {
      change.sets.engine_number = raw;
      change.sets.condition = null;
      change.why = `engine number "${raw}" moved out of condition`;
    } else {
      unhandled.push(r);
      continue;
    }

    // Only motor vehicles get the description repair — a chassis-looking
    // description could be legitimate elsewhere in the register.
    if (r.category === 'Motor Vehicles' && r.description && looksLikeChassis(r.description)) {
      change.sets.chassis_number = String(r.description).trim();
      change.sets.description = MOTORCYCLE_DESCRIPTION;
      change.why += `; chassis "${r.description}" moved out of description`;
    }

    plan.push(change);
  }

  console.log(`Non-canonical condition rows found: ${rows.length}`);
  console.log(`  will repair: ${plan.length}`);
  console.log(`  unhandled:   ${unhandled.length}\n`);

  const counts = plan.reduce((acc, c) => {
    const k = c.sets.engine_number ? 'engine number moved'
            : c.sets.condition === null ? 'cleared to NULL'
            : 'condition normalised';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k.padEnd(22)} ${v}`));
  const chassisCount = plan.filter((c) => c.sets.chassis_number).length;
  console.log(`  ${'chassis moved'.padEnd(22)} ${chassisCount}\n`);

  plan.forEach((c) => console.log(`  ${c.asset_code}: ${c.why}`));

  if (unhandled.length > 0) {
    console.log('\nNOT touched — no rule matches these, decide by hand:');
    unhandled.forEach((r) => console.log(`  ${r.asset_code}: "${r.condition}"`));
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write the changes.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const c of plan) {
      const cols = Object.keys(c.sets);
      const assignments = cols.map((col, i) => `${col} = $${i + 1}`).join(', ');
      const values = cols.map((col) => c.sets[col]);
      await client.query(
        `UPDATE asset SET ${assignments} WHERE id = $${cols.length + 1}`,
        [...values, c.id]
      );
    }

    await client.query('COMMIT');
    console.log(`\nApplied ${plan.length} row updates.`);
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