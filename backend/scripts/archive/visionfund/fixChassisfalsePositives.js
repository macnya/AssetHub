// Corrects an over-eager match in repairMotorVehicleData.js.
//
// That script treated any uppercase alphanumeric description as a chassis
// number and replaced it with "Motor Cycle". But model names like
// "TVS HLX 125CC 4-GEAR REF -LOCAL" fit the same shape, so 29 legitimate
// descriptions were moved into chassis_number.
//
// Nothing was lost — the original text is still in chassis_number, so this
// simply puts it back. The discriminator is whitespace: a real VIN or chassis
// number is a single unbroken token ("MD625AF75J1F07682"), whereas a model
// name is several words.
//
// Dry run (default):  node scripts/fixChassisFalsePositives.js
// Apply:              node scripts/fixChassisFalsePositives.js --apply

require('dotenv').config();
const pool = require('../src/db/pool');

// A genuine chassis/VIN: one token, no separators, at least 10 characters.
function isRealChassis(value) {
  return /^[A-Z0-9]{10,}$/.test(String(value).trim());
}

async function main() {
  const apply = process.argv.includes('--apply');

  const { rows } = await pool.query(
    `SELECT id, asset_code, description, chassis_number
     FROM asset
     WHERE chassis_number IS NOT NULL
     ORDER BY asset_code`
  );

  const keep = rows.filter((r) => isRealChassis(r.chassis_number));
  const restore = rows.filter((r) => !isRealChassis(r.chassis_number));

  console.log(`Rows with a chassis_number: ${rows.length}`);
  console.log(`  genuine chassis, leave alone: ${keep.length}`);
  console.log(`  actually a description, restore: ${restore.length}\n`);

  if (keep.length > 0) {
    console.log('Keeping as chassis:');
    keep.forEach((r) => console.log(`  ${r.asset_code}: ${r.chassis_number}`));
    console.log('');
  }

  if (restore.length === 0) {
    console.log('Nothing to restore.');
    return;
  }

  console.log('Restoring description:');
  restore.forEach((r) =>
    console.log(`  ${r.asset_code}: "${r.description}" -> "${r.chassis_number}"`)
  );

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write the changes.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of restore) {
      await client.query(
        `UPDATE asset SET description = $1, chassis_number = NULL WHERE id = $2`,
        [r.chassis_number, r.id]
      );
    }
    await client.query('COMMIT');
    console.log(`\nRestored ${restore.length} descriptions.`);
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