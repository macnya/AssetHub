// Re-points existing assignments whose "location" is actually a person.
//
// importAssets.js used to write the PHYSICAL LOCATION column straight into
// location.physical_location and never set assignment.employee_id. In this
// register that column usually holds a staff member's name, so roughly 879 of
// 2,076 assets are recorded as living at a place named after a person, and the
// system cannot answer "what does this employee hold?".
//
// This finds those assignments, matches the name against the employee table,
// and moves the person from the location into employee_id. The location is
// rewritten to just the branch and department, which is what it should have
// been.
//
// Exact matches are safe. Fuzzy matches (two or more shared name tokens) catch
// spelling differences like "ABROSE KALAPATA" vs "AMROSE KALAPATA" but need a
// human eye, so they are reported separately and skipped unless you ask.
//
//   node scripts/linkAssetHolders.js                    dry run, everything
//   node scripts/linkAssetHolders.js --apply            writes EXACT matches only
//   node scripts/linkAssetHolders.js --apply --fuzzy    writes fuzzy ones too

require('dotenv').config();
const pool = require('../src/db/pool');

function normalise(value) {
  return String(value).trim().toUpperCase().replace(/\s+/g, ' ');
}

function tokens(value) {
  return new Set(normalise(value).split(' ').filter((t) => t.length > 1));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const includeFuzzy = process.argv.includes('--fuzzy');

  const { rows: employees } = await pool.query('SELECT id, name FROM employee WHERE name IS NOT NULL');
  const exactMap = new Map();
  employees.forEach((e) => exactMap.set(normalise(e.name), e));
  console.log(`Employees available for matching: ${employees.length}`);

  // Open assignments that have no person attached but whose location carries
  // a physical_location string.
  const { rows: candidates } = await pool.query(
    `SELECT ag.id AS assignment_id, a.asset_code, a.description,
            l.id AS location_id, l.branch, l.department, l.physical_location
     FROM assignment ag
     JOIN asset a ON a.id = ag.asset_id
     JOIN location l ON l.id = ag.location_id
     WHERE ag.returned_date IS NULL
       AND ag.employee_id IS NULL
       AND l.physical_location IS NOT NULL
       AND l.physical_location <> ''
     ORDER BY a.asset_code`
  );

  console.log(`Open assignments with no employee and a physical_location: ${candidates.length}\n`);

  const exact = [];
  const fuzzy = [];
  const noMatch = [];

  for (const c of candidates) {
    const key = normalise(c.physical_location);
    const hit = exactMap.get(key);
    if (hit) {
      exact.push({ ...c, employee: hit, how: 'exact' });
      continue;
    }

    const ct = tokens(c.physical_location);
    if (ct.size < 2) {
      noMatch.push(c);
      continue;
    }

    const scored = employees
      .map((e) => {
        const shared = [...ct].filter((t) => tokens(e.name).has(t)).length;
        return { e, shared };
      })
      .filter((x) => x.shared >= 2)
      .sort((a, b) => b.shared - a.shared);

    // Only propose a fuzzy match when exactly one employee is the best fit —
    // two equally good candidates means we cannot tell them apart.
    if (scored.length > 0 && (scored.length === 1 || scored[0].shared > scored[1].shared)) {
      fuzzy.push({ ...c, employee: scored[0].e, how: 'fuzzy' });
    } else {
      noMatch.push(c);
    }
  }

  console.log(`  exact name match:  ${exact.length}`);
  console.log(`  fuzzy name match:  ${fuzzy.length}`);
  console.log(`  no match (likely a real place): ${noMatch.length}\n`);

  const show = (label, list, limit) => {
    if (list.length === 0) return;
    console.log(`--- ${label} ---`);
    list.slice(0, limit).forEach((x) =>
      console.log(`  ${x.asset_code.padEnd(12)} "${x.physical_location}" -> ${x.employee.name}`)
    );
    if (list.length > limit) console.log(`  ...and ${list.length - limit} more`);
    console.log('');
  };

  show('EXACT matches (safe)', exact, 15);
  show('FUZZY matches (review these carefully)', fuzzy, 40);

  if (noMatch.length > 0) {
    console.log('--- No match: left untouched, presumed to be real places ---');
    noMatch.slice(0, 15).forEach((x) => console.log(`  ${x.asset_code.padEnd(12)} "${x.physical_location}"`));
    if (noMatch.length > 15) console.log(`  ...and ${noMatch.length - 15} more`);
    console.log('');
  }

  const toApply = includeFuzzy ? [...exact, ...fuzzy] : exact;

  if (!apply) {
    console.log(`Dry run only. --apply would update ${exact.length} exact matches.`);
    console.log(`Add --fuzzy to include the ${fuzzy.length} fuzzy ones as well.`);
    return;
  }

  const client = await pool.connect();
  const locationCache = new Map();
  try {
    await client.query('BEGIN');

    for (const x of toApply) {
      // The assignment should point at a location describing the PLACE only.
      const key = `${x.branch}||${x.department}`;
      let cleanLocationId = locationCache.get(key);

      if (!cleanLocationId) {
        const existing = await client.query(
          `SELECT id FROM location
           WHERE branch IS NOT DISTINCT FROM $1
             AND department IS NOT DISTINCT FROM $2
             AND (physical_location IS NULL OR physical_location = '')
           LIMIT 1`,
          [x.branch, x.department]
        );
        if (existing.rows.length > 0) {
          cleanLocationId = existing.rows[0].id;
        } else {
          const created = await client.query(
            `INSERT INTO location (branch, department, physical_location)
             VALUES ($1, $2, NULL) RETURNING id`,
            [x.branch, x.department]
          );
          cleanLocationId = created.rows[0].id;
        }
        locationCache.set(key, cleanLocationId);
      }

      await client.query(
        `UPDATE assignment SET employee_id = $1, location_id = $2 WHERE id = $3`,
        [x.employee.id, cleanLocationId, x.assignment_id]
      );
    }

    await client.query('COMMIT');
    console.log(`\nLinked ${toApply.length} assignments to employees.`);
    console.log('Pseudo-location rows are now unused; list them with:');
    console.log("  SELECT * FROM location WHERE id NOT IN (SELECT location_id FROM assignment WHERE location_id IS NOT NULL);");
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