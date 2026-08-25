// One-off cleanup for the condition vocabulary mismatch.
//
// The mobile "Add New Asset" screen used to offer Good / Fair / Faulty while
// verification only ever accepted Good / Good with issues / Faulty. Any asset
// created through the app with "Fair" therefore sits outside the canonical
// list: it can't be produced by a verification, and it never matches the
// condition filter on the verification report.
//
// Run a dry run first to see what would change:
//   node scripts/normalizeAssetConditions.js
// Then apply:
//   node scripts/normalizeAssetConditions.js --apply

require('dotenv').config();
const pool = require('../src/db/pool');
const { ASSET_CONDITIONS } = require('../src/constants/assetConditions');

// "Fair" sat between Good and Faulty, which is exactly what
// "Good with issues" means in the canonical list.
const MAPPING = {
  Fair: 'Good with issues',
};

async function main() {
  const apply = process.argv.includes('--apply');

  const { rows } = await pool.query(
    `SELECT condition, COUNT(*)::int AS count
     FROM asset
     WHERE condition IS NOT NULL
     GROUP BY condition
     ORDER BY count DESC`
  );

  const offenders = rows.filter((r) => !ASSET_CONDITIONS.includes(r.condition));

  console.log('Current condition values in the asset table:');
  rows.forEach((r) => {
    const flag = ASSET_CONDITIONS.includes(r.condition) ? 'ok' : 'NON-CANONICAL';
    console.log(`  ${String(r.condition).padEnd(20)} ${String(r.count).padStart(6)}  ${flag}`);
  });

  if (offenders.length === 0) {
    console.log('\nNothing to do — every value is already in the canonical list.');
    return;
  }

  console.log('');
  for (const row of offenders) {
    const target = MAPPING[row.condition];

    if (!target) {
      console.log(
        `No mapping defined for "${row.condition}" (${row.count} rows). ` +
        `Add it to MAPPING in this script and re-run.`
      );
      continue;
    }

    if (!apply) {
      console.log(`Would remap "${row.condition}" -> "${target}" (${row.count} rows)`);
      continue;
    }

    const result = await pool.query(
      'UPDATE asset SET condition = $1 WHERE condition = $2',
      [target, row.condition]
    );
    console.log(`Remapped "${row.condition}" -> "${target}" (${result.rowCount} rows)`);
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write the changes.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());