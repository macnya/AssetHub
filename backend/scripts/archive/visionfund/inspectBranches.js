// Diagnostic only. Writes nothing.
//
// The location table has branch, department and physical_location columns, but
// the import put everything into branch. So "MOMBASA - MARAFA" is a branch and
// a department in one string, "Finance" is a department with no branch at all,
// and "TALA" and "Tala" are the same place twice.
//
// This classifies every distinct value so the cleanup can be decided from the
// real data rather than from a sample.
//
//   node scripts/inspectBranches.js

require('dotenv').config();
const pool = require('../src/db/pool');

// Words that name a function rather than a place. A value that is only this
// is a department sitting in the branch column.
const DEPARTMENT_WORDS = [
  'ict', 'it', 'hr', 'human resource', 'finance', 'admin', 'administration',
  'audit', 'operations', 'ops', 'credit', 'legal', 'procurement', 'marketing',
  'supervisor', 'manager', 'office', 'archive', 'store', 'server room',
  'reception', 'boardroom', 'registry',
];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function looksLikeDepartment(value) {
  const v = norm(value);
  return DEPARTMENT_WORDS.some((w) => v === w || v === `${w} office` || v === `${w} dept`);
}

// Two capitalised words, neither a known place word — probably a person.
function looksLikePerson(value) {
  const parts = String(value || '').trim().split(/\s+/);
  if (parts.length !== 2) return false;
  if (DEPARTMENT_WORDS.some((w) => norm(value).includes(w))) return false;
  if (/branch|office|region|hq|head/i.test(value)) return false;
  return parts.every((p) => /^[A-Z][a-z]{2,}$/.test(p));
}

async function main() {
  const { rows } = await pool.query(
    `SELECT
        l.id, l.branch, l.department, l.physical_location,
        COUNT(DISTINCT ag.asset_id) FILTER (WHERE ag.returned_date IS NULL)::int AS live_assets,
        COUNT(ag.id)::int AS all_assignments
     FROM location l
     LEFT JOIN assignment ag ON ag.location_id = l.id
     GROUP BY l.id, l.branch, l.department, l.physical_location
     ORDER BY l.branch NULLS LAST, l.department NULLS LAST`
  );

  console.log(`Location rows: ${rows.length}\n`);

  // ---- distinct branch values, with usage ----
  const byBranch = new Map();
  rows.forEach((r) => {
    const key = r.branch || '(null)';
    const e = byBranch.get(key) || { rows: 0, live: 0 };
    e.rows += 1;
    e.live += r.live_assets;
    byBranch.set(key, e);
  });

  console.log(`Distinct branch values: ${byBranch.size}\n`);

  // ---- case and spacing duplicates ----
  const byNorm = new Map();
  [...byBranch.keys()].forEach((b) => {
    const k = norm(b);
    byNorm.set(k, [...(byNorm.get(k) || []), b]);
  });
  const dupes = [...byNorm.entries()].filter(([, v]) => v.length > 1);

  console.log(`--- Same place, spelled differently (${dupes.length}) ---`);
  dupes.forEach(([, variants]) => {
    const parts = variants.map((v) => `"${v}" (${byBranch.get(v).live} assets)`);
    console.log(`  ${parts.join('  ==  ')}`);
  });
  if (!dupes.length) console.log('  none');

  // ---- branch strings carrying a department ----
  const compound = [...byBranch.keys()].filter((b) => / - | – |\//.test(b));
  console.log(`\n--- Branch and department in one string (${compound.length}) ---`);
  compound.forEach((b) => {
    const [left, ...rest] = b.split(/ - | – |\//);
    console.log(`  "${b}"  ->  branch "${left.trim()}" + department "${rest.join(' - ').trim()}"  (${byBranch.get(b).live} assets)`);
  });
  if (!compound.length) console.log('  none');

  // ---- departments sitting in the branch column ----
  const asDept = [...byBranch.keys()].filter(looksLikeDepartment);
  console.log(`\n--- Department, not a branch (${asDept.length}) ---`);
  asDept.forEach((b) => console.log(`  "${b}"  (${byBranch.get(b).live} assets)`));
  if (!asDept.length) console.log('  none');

  // ---- people in the branch column ----
  const asPerson = [...byBranch.keys()].filter(looksLikePerson);
  console.log(`\n--- Looks like a person's name (${asPerson.length}) ---`);
  asPerson.forEach((b) => console.log(`  "${b}"  (${byBranch.get(b).live} assets)`));
  if (!asPerson.length) console.log('  none');

  // ---- head office variants ----
  const heads = [...byBranch.keys()].filter((b) => /head\s*office|^hq$|headquarters/i.test(b));
  console.log(`\n--- Head office variants (${heads.length}) ---`);
  heads.forEach((b) => console.log(`  "${b}"  (${byBranch.get(b).live} assets)`));

  // ---- unused rows ----
  const unused = rows.filter((r) => r.all_assignments === 0);
  console.log(`\n--- Location rows nothing points at: ${unused.length} ---`);
  unused.slice(0, 15).forEach((r) =>
    console.log(`  id ${r.id}: branch="${r.branch}" dept="${r.department}" place="${r.physical_location}"`)
  );
  if (unused.length > 15) console.log(`  ...and ${unused.length - 15} more`);

  // ---- everything else, for eyeballing ----
  const flagged = new Set([...dupes.flatMap(([, v]) => v), ...compound, ...asDept, ...asPerson, ...heads]);
  const clean = [...byBranch.keys()].filter((b) => !flagged.has(b)).sort();
  console.log(`\n--- Look like real branches (${clean.length}) ---`);
  console.log('  ' + clean.join(', '));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());