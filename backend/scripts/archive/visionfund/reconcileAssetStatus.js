// Rebuilds asset.status from the records that actually determine it.
//
// THE PROBLEM
// The dashboard reports 21 assets assigned. The custody records show over
// 1,142. asset.status was imported from the spreadsheet and never updated when
// linkAssetHolders reconstructed custody, so the two disagree — and a register
// that contradicts itself is worse than one that admits a gap.
//
// THE RULE
// Status is derived, not stored independently:
//
//   Disposed   a disposal record exists          (wins over everything)
//   Lost       a loss record exists              (wins over assignment)
//   Assigned   an open assignment naming a PERSON
//   In Stock   none of the above
//
// Disposal and loss beat assignment deliberately: an asset written off while
// still shown against a member of staff is disposed, and the open assignment is
// itself a loose end worth reporting.
//
// The person/place distinction matters. 778 open assignments name an employee;
// 1,347 name only a location. An asset in the Head Office archive HAS an
// assignment — that is where it lives, not somebody holding it. An earlier
// version treated both as Assigned and left 10 assets in stock out of 2,311,
// which was wrong enough to notice.
//
//   node scripts/reconcileAssetStatus.js            dry run
//   node scripts/reconcileAssetStatus.js --apply    writes

require('dotenv').config();
const pool = require('../src/db/pool');

async function main() {
  const apply = process.argv.includes('--apply');

  const { rows } = await pool.query(
    `SELECT
        a.id,
        a.asset_code,
        a.description,
        a.status AS current_status,
        CASE
          WHEN d.asset_id IS NOT NULL THEN 'Disposed'
          WHEN lo.asset_id IS NOT NULL THEN 'Lost'
          WHEN ag.employee_id IS NOT NULL THEN 'Assigned'
          ELSE 'In Stock'
        END AS derived_status,
        e.name AS holder,
        l.branch
     FROM asset a
     LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
     LEFT JOIN employee e ON e.id = ag.employee_id
     LEFT JOIN location l ON l.id = ag.location_id
     LEFT JOIN (SELECT DISTINCT asset_id FROM disposal_record) d ON d.asset_id = a.id
     LEFT JOIN (SELECT DISTINCT asset_id FROM lost_asset_record) lo ON lo.asset_id = a.id
     ORDER BY a.asset_code`
  );

  const wrong = rows.filter((r) => r.current_status !== r.derived_status);

  // Summarise the shape of the disagreement rather than printing 2,000 rows.
  const shifts = new Map();
  wrong.forEach((r) => {
    const k = `${r.current_status || '(none)'}  ->  ${r.derived_status}`;
    shifts.set(k, (shifts.get(k) || 0) + 1);
  });

  const tally = (key) => {
    const m = new Map();
    rows.forEach((r) => m.set(r[key], (m.get(r[key]) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  console.log(`Assets: ${rows.length}`);
  console.log(`Status disagrees with the records: ${wrong.length}\n`);

  console.log('--- Recorded status ---');
  tally('current_status').forEach(([s, n]) => console.log(`  ${String(s || '(none)').padEnd(12)} ${n}`));

  console.log('\n--- Status the records imply ---');
  tally('derived_status').forEach(([s, n]) => console.log(`  ${String(s).padEnd(12)} ${n}`));

  console.log('\n--- Corrections ---');
  [...shifts.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}  (${n})`));

  // An asset written off while still assigned is a loose end in its own right.
  const disposedButHeld = rows.filter(
    (r) => (r.derived_status === 'Disposed' || r.derived_status === 'Lost') && r.holder
  );
  if (disposedButHeld.length) {
    console.log(`\n--- Written off but still shown against someone (${disposedButHeld.length}) ---`);
    console.log('    The assignment was never closed. Worth chasing separately.');
    disposedButHeld.slice(0, 10).forEach((r) =>
      console.log(`  ${r.asset_code.padEnd(12)} ${r.derived_status.padEnd(9)} ${r.holder} @ ${r.branch || '-'}`)
    );
    if (disposedButHeld.length > 10) console.log(`  ...and ${disposedButHeld.length - 10} more`);
  }

  if (!apply) {
    console.log(`\nDry run only. --apply would correct ${wrong.length} assets.`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Grouped by target status so this is four statements rather than 2,000.
    let updated = 0;
    for (const status of ['Disposed', 'Lost', 'Assigned', 'In Stock']) {
      const ids = wrong.filter((r) => r.derived_status === status).map((r) => r.id);
      if (!ids.length) continue;
      const r = await client.query(
        `UPDATE asset SET status = $1 WHERE id = ANY($2::int[])`,
        [status, ids]
      );
      updated += r.rowCount;
      console.log(`  ${status}: ${r.rowCount}`);
    }

    await client.query('COMMIT');
    console.log(`\nCorrected ${updated} assets.`);
    console.log('The dashboard and the custody records now agree.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nRolled back — nothing was written.');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());