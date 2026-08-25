// Collapses department spellings the same way normalizeBranches did for
// branches, one level down.
//
// Head Office alone has Administration, Administartion, Admin and Adm for one
// department, plus Communication/Communications and CEO/CEO's. A department
// filter is only as useful as the number of distinct values behind it.
//
// Run AFTER clearPersonPlaces, so the rows have settled and the merges here
// are between real departments rather than person-rows that are about to
// disappear anyway.
//
//   node scripts/normalizeDepartments.js            dry run
//   node scripts/normalizeDepartments.js --apply    writes

require('dotenv').config();
const pool = require('../src/db/pool');

// Left side is lower-cased and whitespace-collapsed before lookup.
// Anything not listed is title-cased and kept as-is.
const CANONICAL = {
  'admin':            'Administration',
  'adm':              'Administration',
  'administartion':   'Administration',   // typo in the source
  'administration':   'Administration',

  'communication':    'Communications',
  'communications':   'Communications',

  'ceo':              "CEO's Office",
  "ceo's":            "CEO's Office",
  "ceo's office":     "CEO's Office",

  'ict':              'ICT',
  'it':               'ICT',

  'p & c':            'People & Culture',
  'p&c':              'People & Culture',
  'hr':               'People & Culture',      // (?) same function — split if not
  'human resources':  'People & Culture',

  'dru':              'DRU',                   // (?) expand if it stands for something

  'call centre':      'Call Centre',
  'call center':      'Call Centre',

  'adiministration':  'Administration',   // second typo variant

  'operation':        'Operations',
  'operations':       'Operations',
  'ops':              'Operations',
};

const key = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const ACRONYMS = new Set(['ICT', 'IT', 'HR', 'CEO', 'DRU', 'P&C', 'HQ']);

function titleCase(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').split(' ').map((w) => {
    const bare = w.toUpperCase().replace(/['’]S$/, '').replace(/[^A-Z&]/g, '');
    if (ACRONYMS.has(bare)) return w.toUpperCase().replace(/'S$/, "'s");
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function canonicalise(dept) {
  const d = String(dept || '').trim();
  if (!d) return null;
  return CANONICAL[key(d)] || titleCase(d);
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

  const { rows } = await pool.query(
    `SELECT l.id, l.branch, l.department, l.programme, l.physical_location,
            COUNT(ag.id)::int AS refs
     FROM location l
     LEFT JOIN assignment ag ON ag.location_id = l.id
     GROUP BY l.id, l.branch, l.department, l.programme, l.physical_location`
  );

  const before = new Set(rows.map((r) => (r.department || '').trim()).filter(Boolean));

  const groups = new Map();
  const changed = [];
  rows.forEach((r) => {
    const dept = canonicalise(r.department);
    if (dept !== (r.department || null)) changed.push({ from: r.department, to: dept });
    const k = `${r.branch}||${dept}||${r.programme}||${r.physical_location}`;
    const g = groups.get(k) || { branch: r.branch, department: dept, programme: r.programme, physical_location: r.physical_location, members: [] };
    g.members.push(r);
    groups.set(k, g);
  });

  const after = new Set([...groups.values()].map((g) => g.department).filter(Boolean));
  const merges = [...groups.values()].filter((g) => g.members.length > 1);

  console.log(`Location rows:          ${rows.length}`);
  console.log(`Distinct departments:   ${before.size}  ->  ${after.size}`);
  console.log(`Rows after merging:     ${groups.size}`);
  console.log(`Rows with no department: ${rows.filter((r) => !r.department).length}\n`);

  console.log('--- Departments after cleanup ---');
  console.log('  ' + [...after].sort().join(', ') + '\n');

  const renames = new Map();
  changed.forEach((c) => renames.set(`${c.from} -> ${c.to}`, (renames.get(`${c.from} -> ${c.to}`) || 0) + 1));
  if (renames.size) {
    console.log('--- Renames ---');
    [...renames.entries()].sort((a, b) => b[1] - a[1]).forEach(([label, n]) =>
      console.log(`  ${label}  (${n} rows)`)
    );
    console.log('');
  }

  if (merges.length) {
    console.log(`--- Merges (${merges.length}) ---`);
    merges.slice(0, 12).forEach((g) => {
      const from = [...new Set(g.members.map((m) => `"${m.department}"`))].join(', ');
      console.log(`  ${g.branch}: ${from} -> "${g.department}" @ "${g.physical_location || '-'}"  (${g.members.length} rows)`);
    });
    if (merges.length > 12) console.log(`  ...and ${merges.length - 12} more`);
    console.log('');
  }

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to write these changes.');
    console.log('Check the department list — anything unfamiliar needs a CANONICAL entry.');
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

      await client.query(`UPDATE location SET department = $1 WHERE id = $2`, [g.department, keep.id]);
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