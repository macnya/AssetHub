// Sorts the department column into the four things it's actually holding.
//
// A query of (branch, department) pairs showed department carrying:
//
//   real departments   Finance, ICT, Operations, People & Culture
//   programmes         Angurai and Matete under Kakamega, Kaptumo under
//                      Kapsabet, Changamwe under Mombasa — World Vision Area
//                      Programmes operating from a branch
//   sub-offices        Bartabwa Office, Lokis Office, Mondi Office
//   regions            Mombasa under Bamba — the branch's parent
//   job titles         Supervisor, Tunyo Supervisor
//   noise              the department repeating its own branch
//
// Requires:  ALTER TABLE location ADD COLUMN IF NOT EXISTS region TEXT;
//
//   node scripts/routeDepartments.js            dry run
//   node scripts/routeDepartments.js --apply    writes

require('dotenv').config();
const pool = require('../src/db/pool');

// The real departments. Anything here stays in the department column.
const DEPARTMENTS = new Set([
  'administration', 'adiministration', 'administartion', 'admin', 'adm',
  'audit', "ceo's office", 'ceo', "ceo's", 'call centre', 'call center',
  'communications', 'communication', 'compliance', 'dru', 'finance', 'ict',
  'impact', 'insurance', 'operations', 'operation', 'ops',
  'people & culture', 'p & c', 'hr',
]);

// Everything else, routed explicitly. Keyed "branch|department", lower case.
//
// REVIEW THIS. The uncertain ones are marked (?) — mostly values that are
// themselves branch names appearing under a different branch, which could be a
// programme sharing a name or could be a region. Only Bamba's is clear-cut.
const ROUTE = {
  // --- regions: the branch's parent ---------------------------------------
  'bamba|mombasa':                { region: 'Mombasa' },
  'kitale|mombasa':               { region: 'Mombasa' },      // (?) 600km apart — likely a filing error
  'ilara matak|narok':            { region: 'Narok' },        // (?)
  'nyandarua south|nyandarua':    { region: 'Nyandarua' },    // (?)
  'kabarnet|koibatek':            { region: 'Koibatek' },     // (?)

  // --- programmes ----------------------------------------------------------
  'kakamega|angurai':             { programme: 'Angurai' },
  'kakamega|matete':              { programme: 'Matete' },
  'kapsabet|kaptumo':             { programme: 'Kaptumo' },
  'machakos|kalawa':              { programme: 'Kalawa' },
  'machakos|tala':                { programme: 'Tala' },
  'meru|isiolo':                  { programme: 'Isiolo' },
  'mombasa|changamwe':            { programme: 'Changamwe' },
  'mombasa|kilifi':               { programme: 'Kilifi' },
  'mombasa|marafa':               { programme: 'Marafa' },
  'mombasa|mwatate':              { programme: 'Mwatate' },
  'mombasa|voi':                  { programme: 'Voi' },
  'nairobi|thika':                { programme: 'Thika' },
  'naivasha|nyandarua south':     { programme: 'Nyandarua South' },
  'nakuru|wema':                  { programme: 'Wema' },
  'nyahururu|kiawara':            { programme: 'Kiawara' },
  'nyahururu|mweiga':             { programme: 'Mweiga' },
  'kariobangi|kitengela':         { programme: 'Kitengela' },
  'migori|migori(kegonga)':       { programme: 'Kegonga' },
  'head office|c. hub':           { programme: 'C. Hub' },    // (?) what is this
  'head office|chu':              { programme: 'CHU' },       // (?) what is this

  // --- sub-offices: a satellite of the branch ------------------------------
  'kabarnet|bartabwa office':     { programme: 'Bartabwa' },
  'kabarnet|lokis office':        { programme: 'Lokis' },
  'kabarnet|mondi office':        { programme: 'Mondi' },
  'kapsowar|tunyo office':        { programme: 'Tunyo' },
  'nyahururu|mweiga office':      { programme: 'Mweiga' },

  // --- job titles, not places. The assignment already records who holds it --
  'kapsowar|tunyo supervisor':    { programme: 'Tunyo' },
  'bamba|supervisor':             { clear: true },
  'mombasa|supervisor':           { clear: true },

  // --- department just repeats its branch ----------------------------------
  'kabarnet|kabarnet':            { clear: true },
  'kapsowar|kapsowar':            { clear: true },
};

const key = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function findReferencingColumns(client) {
  const { rows } = await client.query(
    `SELECT tc.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
     JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'location'
       AND tc.table_name <> 'location'`
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

async function main() {
  const apply = process.argv.includes('--apply');

  const { rows } = await pool.query(
    `SELECT l.id, l.branch, l.department, l.region, l.programme, l.physical_location,
            COUNT(ag.id)::int AS refs
     FROM location l
     LEFT JOIN assignment ag ON ag.location_id = l.id
     GROUP BY l.id, l.branch, l.department, l.region, l.programme, l.physical_location`
  );

  const groups = new Map();
  const moves = [];
  const unrouted = new Set();

  rows.forEach((r) => {
    let department = r.department;
    let region = r.region;
    let programme = r.programme;

    if (department) {
      const d = key(department);
      if (DEPARTMENTS.has(d)) {
        // stays put
      } else {
        const route = ROUTE[`${key(r.branch)}|${d}`];
        if (route) {
          if (route.region) region = region || route.region;
          if (route.programme) programme = programme || route.programme;
          department = null;
          moves.push({ branch: r.branch, from: r.department, region: route.region, programme: route.programme, cleared: !!route.clear });
        } else {
          unrouted.add(`${r.branch} | ${r.department}`);
        }
      }
    }

    const k = `${r.branch}||${department}||${region}||${programme}||${r.physical_location}`;
    const g = groups.get(k) || { branch: r.branch, department, region, programme, physical_location: r.physical_location, members: [] };
    g.members.push(r);
    groups.set(k, g);
  });

  const regions = new Set([...groups.values()].map((g) => g.region).filter(Boolean));
  const programmes = new Set([...groups.values()].map((g) => g.programme).filter(Boolean));
  const departments = new Set([...groups.values()].map((g) => g.department).filter(Boolean));

  console.log(`Location rows: ${rows.length}  ->  ${groups.size} after merging\n`);
  console.log(`--- Regions (${regions.size}) ---\n  ${[...regions].sort().join(', ') || '(none)'}\n`);
  console.log(`--- Programmes (${programmes.size}) ---\n  ${[...programmes].sort().join(', ') || '(none)'}\n`);
  console.log(`--- Departments (${departments.size}) ---\n  ${[...departments].sort().join(', ') || '(none)'}\n`);

  if (unrouted.size) {
    console.log(`--- NOT ROUTED — add these to ROUTE before applying (${unrouted.size}) ---`);
    [...unrouted].sort().forEach((u) => console.log(`  ${u}`));
    console.log('');
  }

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to write these changes.');
    if (unrouted.size) console.log('Everything above is left alone until it has a ROUTE entry.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const refs = await findReferencingColumns(client);

    let updated = 0, repointed = 0, deleted = 0;

    for (const g of groups.values()) {
      const sorted = [...g.members].sort((a, b) => b.refs - a.refs);
      const keep = sorted[0];
      const drop = sorted.slice(1);

      await client.query(
        `UPDATE location SET department = $1, region = $2, programme = $3 WHERE id = $4`,
        [g.department, g.region, g.programme, keep.id]
      );
      updated += 1;

      if (drop.length) {
        const ids = drop.map((d) => d.id);
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

    await client.query('COMMIT');
    console.log(`\nRewrote ${updated} rows, re-pointed ${repointed} references, deleted ${deleted} duplicates.`);
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