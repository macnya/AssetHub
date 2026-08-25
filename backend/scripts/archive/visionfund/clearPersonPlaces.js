// Clears physical_location values that are actually people's names.
//
// The register's PHYSICAL LOCATION column recorded who held an asset, not
// where it lived. linkAssetHolders already moved that information to
// assignment.employee_id, where it belongs — but the name was left sitting in
// the location row, so "Bomet" exists thirty times over, once per person.
//
// Clearing it loses nothing: the person is recorded correctly on the
// assignment. What's left is one location row per real place.
//
// Matching is the same two-stage approach linkAssetHolders used, because the
// register writes "Reuben Mwaura" where HR writes "REUBEN MWAURA MAINGI".
//
// Four buckets, in descending order of certainty:
//
//   redundant  the place just repeats the branch ("Bomet" under Bomet)
//   exact      the place is exactly an employee's name
//   fuzzy      the place is probably an employee, spelled differently
//   nameLike   name-shaped, but that person is not in the employee table —
//              which covers the 213 staff who never imported for want of an
//              email address, so there are a lot of these
//
//   node scripts/clearPersonPlaces.js                   dry run
//   node scripts/clearPersonPlaces.js --apply           redundant + exact
//   node scripts/clearPersonPlaces.js --apply --fuzzy   ...and probable ones
//   node scripts/clearPersonPlaces.js --apply --names   ...and name-shaped ones

require('dotenv').config();
const pool = require('../src/db/pool');

const normalise = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const tokens = (v) => new Set(normalise(v).split(' ').filter((t) => t.length > 1));

// Words that mean the value is a place, whatever else it looks like. "Bomet
// Office" is two capitalised words and is not a person.
const PLACE_WORDS = /office|branch|room|store|archive|desk|reception|centre|center|floor|hq|counter|strong ?room|server|boardroom|registry|kitchen|washroom|banking hall/i;

// Real place names have the same disease as the branches did, one level down:
// "Archive", "ARCHIVE" and "Admin Office " are three rows for two places.
//
// Role and office abbreviations must survive: BM is the Branch Manager, CO the
// Credit Officer, COO the Chief Operating Officer, FM the Finance Manager,
// EARO the East Africa Regional Office. An explicit list rather than a length
// rule, because "WEST" is four capitals and is not an acronym.
const PLACE_ACRONYMS = new Set([
  'BM', 'CO', 'COO', 'CEO', 'CFO', 'FM', 'RM', 'GM', 'MD', 'PA',
  'HR', 'ICT', 'IT', 'HQ', 'ATM', 'EARO', 'AP',
]);

function tidyPlace(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').split(' ').map((w) => {
    // A short all-caps word carrying a possessive is somebody's job title:
    // BM's, RO's, LCO's, BA's. Rather than keep extending the list one run at
    // a time, recognise the shape — and normalise RO'S to RO's so the two
    // spellings merge.
    const possessive = w.match(/^([A-Z]{2,4})['’][Ss]$/);
    if (possessive) return `${possessive[1]}'s`;

    // Strip a possessive and a plural before matching, so COs' and COO's are
    // both recognised. The original casing is then kept as-is.
    const bare = w.toUpperCase()
      .replace(/['’]S$/, '')     // COO'S -> COO
      .replace(/[^A-Z]/g, '')    // C.O -> CO
      .replace(/S$/, '');        // COS -> CO
    if (PLACE_ACRONYMS.has(bare) || PLACE_ACRONYMS.has(w.toUpperCase().replace(/[^A-Z]/g, ''))) {
      return w;                  // leave abbreviations exactly as written
    }
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

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
  const includeFuzzy = process.argv.includes('--fuzzy');

  const { rows: employees } = await pool.query(
    'SELECT id, name FROM employee WHERE name IS NOT NULL'
  );
  const exactNames = new Set(employees.map((e) => normalise(e.name)));

  const { rows: locations } = await pool.query(
    `SELECT l.id, l.branch, l.department, l.programme, l.physical_location,
            COUNT(ag.id)::int AS refs
     FROM location l
     LEFT JOIN assignment ag ON ag.location_id = l.id
     WHERE l.physical_location IS NOT NULL AND l.physical_location <> ''
     GROUP BY l.id, l.branch, l.department, l.programme, l.physical_location
     ORDER BY l.branch, l.physical_location`
  );

  const redundant = [];
  const exact = [];
  const fuzzy = [];
  const nameLike = [];
  const kept = [];

  // Two or three capitalised words, no digits — the shape of a Kenyan name.
  // Deliberately not applied to anything containing a place word, or to a
  // value that simply repeats its own branch.
  const NAME_SHAPED = /^[A-Za-z][A-Za-z'’-]+( [A-Za-z][A-Za-z'’-]+){1,2}$/;

  for (const l of locations) {
    const place = l.physical_location;

    // "Bomet" filed under branch Bomet says nothing the branch doesn't.
    if (normalise(place) === normalise(l.branch)) { redundant.push(l); continue; }

    if (PLACE_WORDS.test(place)) {
      const tidy = tidyPlace(place);
      kept.push({ ...l, tidy, needsTidy: tidy !== place });
      continue;
    }

    if (exactNames.has(normalise(place))) { exact.push({ ...l, how: 'exact' }); continue; }

    const pt = tokens(place);
    if (pt.size < 2) { kept.push(l); continue; }

    const scored = employees
      .map((e) => ({ e, shared: [...pt].filter((t) => tokens(e.name).has(t)).length }))
      .filter((x) => x.shared >= 2)
      .sort((a, b) => b.shared - a.shared);

    // Only when one employee is a strictly better fit than every other — a tie
    // means we cannot tell two people apart, so leave it alone.
    if (scored.length && (scored.length === 1 || scored[0].shared > scored[1].shared)) {
      fuzzy.push({ ...l, matched: scored[0].e.name });
    } else if (NAME_SHAPED.test(place.trim())) {
      nameLike.push(l);
    } else {
      kept.push(l);
    }
  }

  console.log(`Location rows with a physical_location: ${locations.length}`);
  console.log(`  just repeats the branch:      ${redundant.length}`);
  console.log(`  exactly an employee name:     ${exact.length}`);
  console.log(`  probably an employee name:    ${fuzzy.length}`);
  console.log(`  name-shaped, not an employee: ${nameLike.length}`);
  console.log(`  look like real places:        ${kept.length}\n`);

  const show = (label, list, limit) => {
    if (!list.length) return;
    console.log(`--- ${label} ---`);
    list.slice(0, limit).forEach((l) =>
      console.log(`  ${String(l.branch).padEnd(16)} "${l.physical_location}"${l.matched ? `  ~ ${l.matched}` : ''}  (${l.refs} assignments)`)
    );
    if (list.length > limit) console.log(`  ...and ${list.length - limit} more`);
    console.log('');
  };

  show('Repeats the branch — safe to clear', redundant, 10);
  show('Exact employee matches — safe to clear', exact, 10);
  show('Probable employee matches — read these', fuzzy, 25);
  show('Name-shaped but not in the employee table — read these', nameLike, 30);
  const toTidy = kept.filter((l) => l.needsTidy);
  show('Kept as real places', kept, 25);
  if (toTidy.length) {
    console.log(`--- Place names to tidy (${toTidy.length}) ---`);
    toTidy.slice(0, 12).forEach((l) => console.log(`  "${l.physical_location}"  ->  "${l.tidy}"`));
    if (toTidy.length > 12) console.log(`  ...and ${toTidy.length - 12} more`);
    console.log('');
  }

  const includeNames = process.argv.includes('--names');
  const toClear = [
    ...redundant,
    ...exact,
    ...(includeFuzzy || includeNames ? fuzzy : []),
    ...(includeNames ? nameLike : []),
  ];

  if (!apply) {
    console.log(`Dry run only. --apply would clear ${redundant.length + exact.length} rows.`);
    console.log(`  --fuzzy adds ${fuzzy.length} probable employee matches.`);
    console.log(`  --names adds those plus ${nameLike.length} name-shaped values.`);
    console.log('\nRead the name-shaped list before using --names: anything there that is');
    console.log('actually a place would lose its name.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const refs = await findReferencingColumns(client);

    // Clearing the name makes rows identical, so they then have to be merged
    // the same way normalizeBranches does — otherwise thirty Bomet rows just
    // become thirty blank Bomet rows.
    await client.query(
      `UPDATE location SET physical_location = NULL WHERE id = ANY($1::int[])`,
      [toClear.map((l) => l.id)]
    );

    // Tidy the genuine place names in the same pass, so ARCHIVE and Archive
    // merge below rather than surviving as two rows.
    for (const l of toTidy) {
      await client.query(`UPDATE location SET physical_location = $1 WHERE id = $2`, [l.tidy, l.id]);
    }

    const { rows: after } = await client.query(
      `SELECT l.id, l.branch, l.department, l.programme, l.physical_location,
              COUNT(ag.id)::int AS refs
       FROM location l
       LEFT JOIN assignment ag ON ag.location_id = l.id
       GROUP BY l.id, l.branch, l.department, l.programme, l.physical_location`
    );

    const groups = new Map();
    after.forEach((r) => {
      const k = `${r.branch}||${r.department}||${r.programme}||${r.physical_location}`;
      groups.set(k, [...(groups.get(k) || []), r]);
    });

    let merged = 0, repointed = 0;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const sorted = [...members].sort((a, b) => b.refs - a.refs);
      const keep = sorted[0];
      const ids = sorted.slice(1).map((m) => m.id);

      for (const ref of refs) {
        const r = await client.query(
          `UPDATE ${ref.table} SET ${ref.column} = $1 WHERE ${ref.column} = ANY($2::int[])`,
          [keep.id, ids]
        );
        repointed += r.rowCount;
      }
      const d = await client.query(`DELETE FROM location WHERE id = ANY($1::int[])`, [ids]);
      merged += d.rowCount;
    }

    await client.query('COMMIT');

    console.log(`\nCleared ${toClear.length} person-names from physical_location.`);
    console.log(`Tidied ${toTidy.length} real place names.`);
    console.log(`Merged ${merged} rows that became duplicates, re-pointing ${repointed} references.`);

    const { rows: final } = await pool.query('SELECT COUNT(*)::int AS n FROM location');
    console.log(`Location rows now: ${final[0].n}`);
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