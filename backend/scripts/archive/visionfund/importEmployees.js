// Run once: node scripts/importEmployees.js
//
// Reads backend/data/employees-export.xlsx (the "Manage Users" export) and
// upserts employees into the `employee` table by email.
//
// Rules applied:
//  - Skips rows with status DELETED (account no longer exists).
//  - Skips rows where the Email column isn't a real email address (~206 rows
//    in the source file just have a system username there instead, e.g.
//    "ABOITT" — mostly old INACTIVE accounts with no email on file).
//  - Rows with status ACTIVE or INACTIVE but a real email ARE imported —
//    INACTIVE just means they don't currently log into the loan system,
//    it doesn't mean they're not a real member of staff who might hold assets.
//  - Safe to re-run: matches on email and updates name/branch rather than
//    creating duplicates.
//
// Review before running: a skipped-rows report is written to
// backend/data/skipped-employees.csv so you can see who was left out and why.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const pool = require('../src/db/pool');

const FILE_PATH = path.join(__dirname, '../data/employees-export.xlsx');
const SKIPPED_REPORT_PATH = path.join(__dirname, '../data/skipped-employees.csv');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function ensureEmailUnique() {
  // Needed so the upsert (ON CONFLICT) below can match existing employees by email.
  try {
    await pool.query(`ALTER TABLE employee ADD CONSTRAINT employee_email_unique UNIQUE (email)`);
    console.log('Added unique constraint on employee.email');
  } catch (err) {
    if (err.code === '42710' /* already exists */ || err.code === '23505') {
      console.log('Unique constraint on employee.email already present, or duplicate emails exist — continuing.');
    } else {
      console.log('Note: could not add unique constraint on employee.email (' + err.message + '). Continuing without it — re-running this script may create duplicates.');
    }
  }
}

async function run() {
  const workbook = xlsx.readFile(FILE_PATH);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  // Header row is row 5 in this export (rows 1-4 are title/generated-by info)
  const rows = xlsx.utils.sheet_to_json(sheet, { range: 4, defval: null });

  await ensureEmailUnique();

  let imported = 0;
  let updated = 0;
  const skipped = [];

  for (const row of rows) {
    const branch = row['Branch'];
    const name = row['UserName'];
    const email = row['Email'];
    const status = row['Status'];

    if (status === 'DELETED') {
      skipped.push({ branch, name, email, status, reason: 'Account deleted' });
      continue;
    }
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      skipped.push({ branch, name, email, status, reason: 'No valid email on file' });
      continue;
    }
    if (!name) {
      skipped.push({ branch, name, email, status, reason: 'No name on file' });
      continue;
    }

    const cleanEmail = String(email).trim().toLowerCase();

    try {
      const result = await pool.query(
        `INSERT INTO employee (name, department, branch, email)
         VALUES ($1, NULL, $2, $3)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, branch = EXCLUDED.branch
         RETURNING (xmax = 0) AS inserted`,
        [name, branch || null, cleanEmail]
      );
      if (result.rows[0].inserted) imported += 1;
      else updated += 1;
    } catch (err) {
      skipped.push({ branch, name, email, status, reason: 'DB error: ' + err.message });
    }
  }

  // Write skipped-rows report
  const csvLines = ['Branch,Name,Email,Status,Reason'];
  for (const s of skipped) {
    csvLines.push([s.branch, s.name, s.email, s.status, s.reason].map((v) => `"${v ?? ''}"`).join(','));
  }
  fs.writeFileSync(SKIPPED_REPORT_PATH, csvLines.join('\n'));

  console.log(`Imported (new): ${imported}`);
  console.log(`Updated (existing): ${updated}`);
  console.log(`Skipped: ${skipped.length} — see ${SKIPPED_REPORT_PATH}`);

  await pool.end();
}

run().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});