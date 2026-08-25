// Adds staff who were confirmed as current but have no email on file.
//
// importEmployees.js keys on email and skips anyone whose Email column holds a
// system username instead of an address — 213 people in the Manage Users
// export. Most are leavers, but these were confirmed as still employed and
// between them they hold assets worth around KES 1.75M, including a camera
// worth KES 665,840.
//
// They are inserted with email NULL. Postgres allows multiple NULLs under a
// UNIQUE constraint, so this does not clash with employee_email_unique — but
// it also means ON CONFLICT cannot protect us, so this script matches on name
// itself before inserting and is safe to re-run.
//
// After running, link their assets:
//   node scripts/linkAssetHolders.js
//   node scripts/linkAssetHolders.js --apply
//   node scripts/linkAssetHolders.js --apply --fuzzy
//
// Dry run (default):  node scripts/addConfirmedStaff.js
// Apply:              node scripts/addConfirmedStaff.js --apply

require('dotenv').config();
const pool = require('../src/db/pool');

// Confirmed still at VF Kenya as of the December 2025 staff list review.
// Grace Syombua Kimeu and Marion Wafula are deliberately NOT here — they moved
// to Vision Fund International and their assets need recovering, not linking.
const CONFIRMED_STAFF = [
  { name: 'PATRICIA NGONYO KURIA',   branch: 'VFK PRODUCTION' },
  { name: 'LEAH WAGITHI MWATI',      branch: 'VFK PRODUCTION' },
  { name: 'FRANCIS MWANIA MUTUKU',   branch: 'KITENGELA' },
  { name: 'JOYCE NYIHA WANYOIKE',    branch: 'VFK PRODUCTION' },
  { name: 'PERIS WANGARE',           branch: 'NYAHURURU' },
  { name: 'MIRIAM CHEPTOO',          branch: null },
  { name: 'STANLEY MUENDO PETER',    branch: 'VFK PRODUCTION' },
  { name: 'LEONARD TANUI KIPLETING', branch: 'ELDAMA RAVINE' },
  { name: 'RIZIKI MZINGA MWEMA',     branch: 'VOI' },
  { name: 'RHODA KENDI',             branch: 'MERU' },
];

function normalise(value) {
  return String(value).trim().toUpperCase().replace(/\s+/g, ' ');
}

async function main() {
  const apply = process.argv.includes('--apply');

  const { rows: existing } = await pool.query('SELECT id, name, branch FROM employee');
  const byName = new Map();
  existing.forEach((e) => { if (e.name) byName.set(normalise(e.name), e); });

  const toInsert = [];
  const alreadyThere = [];

  for (const s of CONFIRMED_STAFF) {
    const hit = byName.get(normalise(s.name));
    (hit ? alreadyThere : toInsert).push(hit ? { ...s, existing: hit } : s);
  }

  console.log(`Employees currently in the table: ${existing.length}`);
  console.log(`Confirmed staff to add:           ${toInsert.length}`);
  console.log(`Already present, skipping:        ${alreadyThere.length}\n`);

  alreadyThere.forEach((s) =>
    console.log(`  already there: ${s.name} (id ${s.existing.id})`)
  );
  toInsert.forEach((s) => console.log(`  will insert:   ${s.name}  [${s.branch || 'no branch'}]`));

  if (toInsert.length === 0) {
    console.log('\nNothing to do.');
    return;
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to insert these.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of toInsert) {
      await client.query(
        `INSERT INTO employee (name, department, branch, email) VALUES ($1, NULL, $2, NULL)`,
        [s.name, s.branch]
      );
    }
    await client.query('COMMIT');
    console.log(`\nInserted ${toInsert.length} employees.`);
    console.log('Now run: node scripts/linkAssetHolders.js');
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