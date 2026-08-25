// Merges location rows that are one office written several ways.
//
// WHAT THIS IS FOR
// normalizeBranches canonicalises branch, department and programme. It leaves
// physical_location alone on purpose: "Reception", "BM's Office" and "Kitchen"
// are genuinely different rooms, and a script that guessed at them would
// destroy real detail. But within a single branch and programme there are also
// rows like this:
//
//     Machakos / Tala:  "Tala Office" | "TALA" | "Tala" | (none)
//     Mombasa / Kilifi: "Kilifi Office" | "KILIFI" | (none)
//     Kariobangi / Kitengela: "Kitengela Office" | "Kitengala Office" | (none)
//
// Those are one place. The difference is spelling, case, and whether somebody
// typed "Office" on the end.
//
// WHY IT IS A LIST AND NOT A RULE
// No inference. Every merge below is written out by hand, because the cases
// this cannot be told apart from are the ones that matter: "Kabarnet Office"
// and "Koibatek Office" both sit under branch Kabarnet, and they are two
// different offices, not two spellings. A rule clever enough to merge
// "TALA" into "Tala Office" would merge those too.
//
// Edit MERGES. Anything not listed is left exactly as it is.
//
//   node scripts/normalizePlaces.js            dry run
//   node scripts/normalizePlaces.js --apply    writes

require('dotenv').config();
const pool = require('../src/db/pool');

// Each entry: the location ids that are the same place, and which one survives.
// `keep` is the row with the fullest name, so the merged register reads
// "Tala Office" rather than "TALA".
//
// REVIEW BEFORE RUNNING. These ids came from one look at one database on
// 20 August 2026. Ids are not stable across restores — the script re-checks
// that each id still holds the branch/programme/place it expects, and refuses
// to merge anything that has moved.
const MERGES = [
  // --- programme offices, one name each ------------------------------------
  { keep: 26,  drop: [117, 808, 1010], expect: { branch: 'Machakos',   programme: 'Tala' } },
  { keep: 55,  drop: [121, 1035],      expect: { branch: 'Mombasa',    programme: 'Kilifi' } },
  { keep: 64,  drop: [811, 253],       expect: { branch: 'Kariobangi', programme: 'Kitengela' } },
  { keep: 401, drop: [995],            expect: { branch: 'Kapsabet',   programme: 'Kaptumo' } },
  { keep: 814, drop: [850, 1046],      expect: { branch: 'Machakos',   programme: 'Kalawa' } },
  { keep: 849, drop: [495],            expect: { branch: 'Mombasa',    programme: 'Mwatate' } },
  { keep: 23,  drop: [1039],           expect: { branch: 'Nairobi',    programme: 'Thika' } },
  { keep: 504, drop: [1029],           expect: { branch: 'Kakamega',   programme: 'Matete' } },

  // --- branch offices ------------------------------------------------------
  { keep: 49,  drop: [962, 985],       expect: { branch: 'Kabarnet' } },   // "Kabanet Office"
  { keep: 322, drop: [63, 1014],       expect: { branch: 'Kapenguria' } }, // "Kapenguaria Office"
  { keep: 67,  drop: [85, 1016],       expect: { branch: 'Kapsowar' } },   // "Kapsawar"
  { keep: 48,  drop: [92],             expect: { branch: 'Nyandarua South' } },

  // NOT MERGED, deliberately. Someone at VisionFund has to say where these
  // assets actually are, and it is not recoverable from the data:
  //
  //   479  "Voioffice"       filed under branch Eldoret West. Voi is its own
  //                          branch, so this is a wrong branch, not a spelling.
  //   192  "Koibatek Office" filed under branch Kabarnet, same problem.
  //   413  "Reception"       Kapsabet/Kaptumo. A reception is a real room, so
  //                          this may be correct as it stands.
  //   648  "JACKLINE JERE,IAH"  a person, not a place. See the note at the
  //                          bottom of this file.
  //
  //   The credit officer's room, at Kabarnet and at Koibatek. Kabarnet alone
  //   has "CO's Office", "CO Office", "COs' Office", "C.O's Office" and
  //   "C.O's Offic e". Whether the apostrophe falls before or after the s is
  //   the difference between one officer's room and a room shared by several,
  //   so this needs somebody who knows the building. Koibatek additionally
  //   has one marked "Not In Use", which must not become the survivor —
  //   an earlier version of this list made exactly that mistake.
];

// Every table with a foreign key pointing at location, read from the catalog
// rather than listed by hand. scan_log references location TWICE, from and to,
// which is exactly what a hand-written list misses.
async function findReferencingColumns(client) {
  const { rows } = await client.query(
    `SELECT tc.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND ccu.table_name = 'location'
       AND tc.table_name <> 'location'`
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

async function main() {
  const apply = process.argv.includes('--apply');

  const ids = MERGES.flatMap((m) => [m.keep, ...m.drop]);
  const { rows } = await pool.query(
    `SELECT l.id, l.branch, l.department, l.programme, l.physical_location,
            COUNT(ag.id) FILTER (WHERE ag.returned_date IS NULL)::int AS open_assignments
     FROM location l
     LEFT JOIN assignment ag ON ag.location_id = l.id
     WHERE l.id = ANY($1::int[])
     GROUP BY l.id`,
    [ids]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const plan = [];
  const refused = [];

  for (const m of MERGES) {
    const keep = byId.get(m.keep);
    if (!keep) { refused.push(`keep id ${m.keep} no longer exists`); continue; }

    // Refuse anything that has moved since this list was written. An id that
    // now holds a different branch is a restored or re-seeded database, and
    // merging on stale ids would move assets somewhere arbitrary.
    const mismatched = [m.keep, ...m.drop].filter((id) => {
      const r = byId.get(id);
      if (!r) return true;
      if (m.expect.branch && r.branch !== m.expect.branch) return true;
      if (m.expect.programme !== undefined && (r.programme || null) !== (m.expect.programme || null)) return true;
      return false;
    });
    if (mismatched.length) {
      refused.push(`ids ${mismatched.join(', ')} are not where this list expects them`);
      continue;
    }

    const drop = m.drop.map((id) => byId.get(id));
    plan.push({ keep, drop, moving: drop.reduce((s, d) => s + d.open_assignments, 0) });
  }

  console.log(`Merges listed:   ${MERGES.length}`);
  console.log(`Ready to run:    ${plan.length}`);
  if (refused.length) {
    console.log(`Refused:         ${refused.length}`);
    refused.forEach((r) => console.log(`    ${r}`));
  }
  console.log('');

  for (const p of plan) {
    const label = (r) =>
      `${r.id} "${r.physical_location || '(none)'}" (${r.open_assignments})`;
    console.log(`${p.keep.branch}${p.keep.programme ? ' / ' + p.keep.programme : ''}`);
    console.log(`    keep  ${label(p.keep)}`);
    p.drop.forEach((d) => console.log(`    drop  ${label(d)}`));
  }

  const totalMoving = plan.reduce((s, p) => s + p.moving, 0);
  const totalDropping = plan.reduce((s, p) => s + p.drop.length, 0);
  console.log(`\n${totalDropping} rows would be removed, moving ${totalMoving} open assignments.`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write these changes.');
    console.log('Check the "keep" names above read the way the register should read.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const refs = await findReferencingColumns(client);
    console.log('\nTables referencing location:');
    refs.forEach((r) => console.log(`  ${r.table}.${r.column}`));

    let repointed = 0, deleted = 0;

    for (const p of plan) {
      const dropIds = p.drop.map((d) => d.id);

      // Re-point EVERY reference before deleting, not just assignments. A
      // delete that skipped scan_log would fail on the foreign key, and the
      // whole transaction with it.
      for (const ref of refs) {
        const r = await client.query(
          `UPDATE ${ref.table} SET ${ref.column} = $1 WHERE ${ref.column} = ANY($2::int[])`,
          [p.keep.id, dropIds]
        );
        repointed += r.rowCount;
      }

      const d = await client.query('DELETE FROM location WHERE id = ANY($1::int[])', [dropIds]);
      deleted += d.rowCount;
    }

    await client.query('COMMIT');

    console.log(`\nRe-pointed ${repointed} references.`);
    console.log(`Deleted ${deleted} duplicate rows.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nNothing was written.');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }

  await pool.end();
}

// STILL OUTSTANDING, and bigger than this script.
//
// Roughly twenty location rows hold a person's name in physical_location:
// "Grace Kimeu", "Elias Kiplagat", "Josphat Kipkosgei", "JACKLINE JERE,IAH".
// Their ids sit in a distinct high range (4523-5217), so some other process
// created them.
//
// assignment.employee_id exists for this. An asset held by a person but
// recorded as being at a place named after them shows as unassigned: it is
// missing from what that person holds, HR 9.3b cannot be enforced against
// them, and exit clearance will not find it when they leave.
//
// Fixing it means matching those names to employee rows and rewriting the
// assignments to point at the employee instead of the location, which needs
// somebody to confirm each match. It is not a merge and does not belong here.

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
