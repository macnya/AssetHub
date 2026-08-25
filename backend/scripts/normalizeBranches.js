// Collapses 94 branch spellings into the ~30 places that actually exist.
//
// WHAT WENT WRONG
// The importer wrote whatever the spreadsheet said into location.branch, and
// the spreadsheet said "Head Office", "Head office", "HEAD OFFICE",
// "Headoffice", "HEADOFFICE" and "HO" for the same building. It also put
// departments there (Finance, ICT, HR OFFICE), sub-offices ("Kabarnet Branch -
// Bartabwa Office"), and a stray "all".
//
// WHY IT MATTERS NOW
// A Branch Administrator's view is an exact string match on location.branch.
// Until these are merged, an administrator set to "Eldoret" sees 65 assets and
// misses the 8 filed under "ELDORET", "Eldoret " and "ELDORET ".
//
// WHAT THIS DOES
// Rewrites each location row to a canonical (branch, department, programme,
// physical_location), merges rows that then become identical, re-points every
// foreign key at the survivor, and deletes the emptied duplicates.
//
// Requires:  ALTER TABLE location ADD COLUMN IF NOT EXISTS programme TEXT;
//
//   node scripts/normalizeBranches.js            dry run
//   node scripts/normalizeBranches.js --apply    writes

require('dotenv').config();
const pool = require('../src/db/pool');

// Anything not listed here is title-cased and kept as its own branch. These
// are the cases where that isn't enough — merges, renames, and strings that
// were never a branch at all.
//
// REVIEW THIS TABLE. Some entries are judgement calls, marked (?).
const CANONICAL = {
  // --- one place, many spellings -----------------------------------------
  'ho':                     { branch: 'Head Office' },
  'headoffice':             { branch: 'Head Office' },
  'head office':            { branch: 'Head Office' },

  'kapswoar':               { branch: 'Kapsowar' },
  'kapsawar':               { branch: 'Kapsowar' },
  'kapsowar branch':        { branch: 'Kapsowar' },
  'kabarnet branch':        { branch: 'Kabarnet' },
  'nyahururu branch':       { branch: 'Nyahururu' },
  'ilaramatak':             { branch: 'Ilara Matak' },
  'ilara matak':            { branch: 'Ilara Matak' },

  // --- departments that ended up in the branch column ---------------------
  // These sit at Head Office. If Finance or ICT actually operate from
  // somewhere else, change the branch here.
  'finance':                { branch: 'Head Office', department: 'Finance' },
  'hr office':              { branch: 'Head Office', department: 'Human Resources' },
  'ict':                    { branch: 'Head Office', department: 'ICT' },
  "ceo's office":           { branch: 'Head Office', department: "CEO's Office" },
  'call center':            { branch: 'Head Office', department: 'Call Centre' },   // (?) may be its own site

  // --- sub-offices: a department of their parent branch -------------------
  'bartabwa':               { branch: 'Kabarnet',  department: 'Bartabwa Office' },
  'tunyo':                  { branch: 'Kapsowar',  department: 'Tunyo Office' },

  // --- programmes ---------------------------------------------------------
  // A programme is a World Vision Area Programme operating from a branch.
  // These two are confirmed; add the rest once the authoritative list exists.
  'south rift':             { branch: 'Rift Valley', programme: 'South Rift' },
  // Marafa was briefly mapped to Kitale on a misremembering. The data has it
  // under Mombasa, which also fits — Marafa is in Kilifi county.
  'marafa':                 { branch: 'Mombasa',     programme: 'Marafa' },

  // --- junk ---------------------------------------------------------------
  // "all" is not a place. It's left exactly as it is rather than guessed at:
  // location.branch is NOT NULL, and inventing a branch for an asset would be
  // the same mistake that produced this mess. Handle it by hand afterwards.
  'all':                    { skip: true },
};

// "Kabarnet Branch - Bartabwa Office" is a branch and a department jammed
// together with a dash. So is "Nyahururu Branch-Mweiga Office", with no spaces
// — which an earlier version missed.
//
// Splitting on every dash would break a genuinely hyphenated place name, so a
// bare dash only counts when one side says Branch or Office.
function splitCompound(value) {
  const v = String(value);

  const spaced = v.split(/\s+[-–]\s+/);
  if (spaced.length >= 2) {
    return { left: spaced[0].trim(), right: spaced.slice(1).join(' - ').trim() };
  }

  if (/branch\s*[-–]/i.test(v) || /[-–][^-–]*office/i.test(v)) {
    const tight = v.split(/\s*[-–]\s*/);
    if (tight.length >= 2 && tight[0].trim() && tight[1].trim()) {
      return { left: tight[0].trim(), right: tight.slice(1).join(' - ').trim() };
    }
  }

  return null;
}

const key = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Acronyms that should stay upper case. An explicit list, because the obvious
// shortcut — "short and all-caps means acronym" — turned VOI into VOI and left
// it sitting next to Voi as a separate branch.
const ACRONYMS = new Set(['ICT', 'IT', 'HR', 'CEO', 'HQ', 'AP', 'P&C', 'WASH']);

function titleCase(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').split(' ').map((w) => {
    // Drop a possessive before matching, so CEO'S is recognised as CEO.
    const bare = w.toUpperCase().replace(/['’]S$/, '').replace(/[^A-Z&]/g, '');
    if (ACRONYMS.has(bare)) {
      // Keep any trailing possessive: CEO'S -> CEO's
      return w.toUpperCase().replace(/'S$/, "'s");
    }
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function canonicalise(rawBranch, rawDept, rawProgramme) {
  let branch = String(rawBranch || '').trim();
  let department = String(rawDept || '').trim();
  let programme = String(rawProgramme || '').trim();

  // A compound branch string carries a department. Take it.
  const split = splitCompound(branch);
  if (split) {
    branch = split.left;
    if (!department || key(department) === key(rawBranch)) department = split.right;
  }

  // The importer copied branch into department for many rows. That's noise.
  if (key(department) === key(branch)) department = '';

  const mapped = CANONICAL[key(branch)];
  if (mapped?.skip) return null;          // caller leaves the row untouched
  if (mapped) {
    if (mapped.department && !department) department = mapped.department;
    if (mapped.programme && !programme) programme = mapped.programme;
    branch = mapped.branch;
  } else {
    branch = titleCase(branch);
  }

  if (department) {
    const mappedDept = CANONICAL[key(department)];
    department = mappedDept?.department || titleCase(department);
  }

  return {
    branch: branch || null,
    department: department || null,
    programme: programme ? titleCase(programme) : null,
  };
}

// Every table with a foreign key pointing at location. Discovered from the
// catalog rather than listed by hand: an earlier version re-pointed only
// assignment.location_id and the delete then failed on
// scan_log_to_location_id_fkey. scan_log references location TWICE, from and
// to, which is exactly the sort of thing a hand-written list misses.
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

  const { rows } = await pool.query(
    `SELECT l.id, l.branch, l.department, l.programme, l.physical_location,
            COUNT(ag.id)::int AS refs
     FROM location l
     LEFT JOIN assignment ag ON ag.location_id = l.id
     GROUP BY l.id, l.branch, l.department, l.programme, l.physical_location`
  );

  // Group by what each row SHOULD be. Rows landing on the same triple are the
  // same place written differently, and get merged into one.
  const groups = new Map();
  const skipped = [];
  rows.forEach((r) => {
    const c = canonicalise(r.branch, r.department, r.programme);
    if (!c || !c.branch) { skipped.push(r); return; }
    const place = (r.physical_location || '').trim() || null;
    const k = `${c.branch}||${c.department}||${c.programme}||${place}`;
    const g = groups.get(k) || { ...c, physical_location: place, members: [] };
    g.members.push(r);
    groups.set(k, g);
  });

  const merges = [...groups.values()].filter((g) => g.members.length > 1);
  const orphans = rows.filter((r) => r.refs === 0);
  const branchesBefore = new Set(rows.map((r) => (r.branch || '').trim()).filter(Boolean));
  const branchesAfter = new Set([...groups.values()].map((g) => g.branch).filter(Boolean));

  console.log(`Location rows:        ${rows.length}`);
  console.log(`Distinct branches:    ${branchesBefore.size}  ->  ${branchesAfter.size}`);
  console.log(`Rows after merging:   ${groups.size}`);
  console.log(`Rows nothing points at (deleted): ${orphans.length}`);
  if (skipped.length) {
    console.log(`Left untouched (no sensible branch): ${skipped.length}`);
    skipped.slice(0, 5).forEach((r) => console.log(`    id ${r.id}: branch="${r.branch}" place="${r.physical_location}"`));
  }
  console.log('');

  const programmes = new Set([...groups.values()].map((g) => g.programme).filter(Boolean));
  if (programmes.size) {
    console.log('--- Programmes ---');
    console.log('  ' + [...programmes].sort().join(', ') + '\n');
  }

  console.log('--- Branches after cleanup ---');
  console.log('  ' + [...branchesAfter].sort().join(', ') + '\n');

  console.log('--- Merges (showing the 15 largest) ---');
  merges
    .sort((a, b) => b.members.length - a.members.length)
    .slice(0, 15)
    .forEach((g) => {
      const from = [...new Set(g.members.map((m) => `"${m.branch}"`))].join(', ');
      const refs = g.members.reduce((s, m) => s + m.refs, 0);
      console.log(`  ${from}\n      -> branch="${g.branch}" dept="${g.department || '-'}" prog="${g.programme || '-'}" place="${g.physical_location || '-'}"  (${g.members.length} rows, ${refs} assignments)`);
    });
  if (merges.length > 15) console.log(`  ...and ${merges.length - 15} more merges`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write these changes.');
    console.log('Read the branch list above first — a name you do not recognise means');
    console.log('the CANONICAL table needs an entry before this runs.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const refs = await findReferencingColumns(client);
    console.log('\nTables referencing location:');
    refs.forEach((r) => console.log(`  ${r.table}.${r.column}`));

    let updated = 0, repointed = 0, deleted = 0;

    for (const g of groups.values()) {
      // Keep the row with the most assignments; it's the one most likely to be
      // referenced elsewhere and the least disruptive to keep.
      const sorted = [...g.members].sort((a, b) => b.refs - a.refs);
      const keep = sorted[0];
      const drop = sorted.slice(1);

      await client.query(
        `UPDATE location SET branch = $1, department = $2, programme = $3, physical_location = $4 WHERE id = $5`,
        [g.branch, g.department, g.programme, g.physical_location, keep.id]
      );
      updated += 1;

      if (drop.length) {
        const ids = drop.map((d) => d.id);

        // Re-point EVERY reference before deleting, not just assignments.
        for (const ref of refs) {
          const r = await client.query(
            `UPDATE ${ref.table} SET ${ref.column} = $1 WHERE ${ref.column} = ANY($2::int[])`,
            [keep.id, ids]
          );
          repointed += r.rowCount;
        }

        const d = await client.query(`DELETE FROM location WHERE id = ANY($1::int[])`, [ids]);
        deleted += d.rowCount;
      }
    }

    // Anything still unreferenced after the merge is dead weight — but
    // "unreferenced" has to mean by ANY table, not just assignment.
    const notIn = refs
      .map((r) => `id NOT IN (SELECT ${r.column} FROM ${r.table} WHERE ${r.column} IS NOT NULL)`)
      .join(' AND ');
    const skipIds = skipped.map((r) => r.id);
    const cleaned = await client.query(
      `DELETE FROM location WHERE ${notIn} AND NOT (id = ANY($1::int[]))`,
      [skipIds]
    );

    await client.query('COMMIT');

    console.log(`\nRewrote ${updated} rows.`);
    console.log(`Re-pointed ${repointed} assignments.`);
    console.log(`Deleted ${deleted} duplicate rows and ${cleaned.rowCount} unreferenced ones.`);
    console.log('\nBranch Administrator accounts now need checking — the branch they are');
    console.log('set to may have been renamed. Staff accounts shows any with no match.');
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