// Read-only. Classifies every non-canonical condition value so we can decide
// what each group actually is before touching the data.
require('dotenv').config();
const pool = require('../src/db/pool');
const { ASSET_CONDITIONS } = require('../src/constants/assetConditions');

const CANONICAL_LOWER = ASSET_CONDITIONS.map((c) => c.toLowerCase());

async function main() {
  const { rows } = await pool.query(
    `SELECT id, asset_code, description, serial_number, condition, status
     FROM asset
     WHERE condition IS NOT NULL
       AND NOT (condition = ANY($1::text[]))
     ORDER BY asset_code`,
    [ASSET_CONDITIONS]
  );

  const caseVariants = [];
  const serialInWrongColumn = [];
  const other = [];

  for (const r of rows) {
    const value = String(r.condition).trim();

    if (CANONICAL_LOWER.includes(value.toLowerCase())) {
      caseVariants.push(r);
    } else if (/^[A-Z0-9][A-Z0-9\-\/ ]{6,}$/.test(value) && /\d/.test(value)) {
      // Long uppercase alphanumeric strings — VINs, engine numbers, chassis numbers.
      serialInWrongColumn.push(r);
    } else {
      other.push(r);
    }
  }

  console.log(`Non-canonical condition rows: ${rows.length}\n`);

  console.log(`A. Case variants only (safe to normalise): ${caseVariants.length}`);
  console.log(`B. Looks like a serial/chassis number:     ${serialInWrongColumn.length}`);
  console.log(`C. Everything else:                        ${other.length}\n`);

  // The critical question for group B.
  const noSerial = serialInWrongColumn.filter((r) => !r.serial_number);
  const sameAsSerial = serialInWrongColumn.filter(
    (r) => r.serial_number && r.serial_number.trim() === String(r.condition).trim()
  );
  const differentSerial = serialInWrongColumn.filter(
    (r) => r.serial_number && r.serial_number.trim() !== String(r.condition).trim()
  );

  console.log('For group B — where else does that value exist?');
  console.log(`  serial_number is EMPTY  (condition is the only copy): ${noSerial.length}`);
  console.log(`  serial_number is IDENTICAL (condition is a duplicate): ${sameAsSerial.length}`);
  console.log(`  serial_number is DIFFERENT (needs a human):            ${differentSerial.length}\n`);

  const sample = (label, list) => {
    if (list.length === 0) return;
    console.log(`--- ${label} (first 5) ---`);
    list.slice(0, 5).forEach((r) => {
      console.log(`  ${r.asset_code}`);
      console.log(`    description:   ${r.description}`);
      console.log(`    serial_number: ${r.serial_number ?? '(empty)'}`);
      console.log(`    condition:     ${r.condition}`);
      console.log(`    status:        ${r.status}`);
    });
    console.log('');
  };

  sample('B: condition is the only copy', noSerial);
  sample('B: condition duplicates serial_number', sameAsSerial);
  sample('B: serial_number disagrees', differentSerial);
  sample('C: everything else', other);

  if (other.length > 0) {
    console.log('--- Full list of group C values ---');
    other.forEach((r) => console.log(`  ${r.asset_code}: "${r.condition}"`));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());