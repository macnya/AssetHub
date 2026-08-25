// Fills in the financial fields the original import dropped.
//
// WHAT WENT WRONG
// Two faults, one on top of the other.
//
// First, Excel pads the header of numeric columns in this workbook:
// ' PURCHASE PRICE ', ' NBV ', ' No. OF YEARS ' all carry a leading and
// trailing space, while every text column is clean. So row['PURCHASE PRICE']
// was always undefined, toNumber turned undefined into null, and the insert
// accepted it. Every financial field imported as empty and nothing complained.
//
// Second, importAssets.js inserts with ON CONFLICT (asset_code) DO NOTHING, so
// once the assets existed no later run could have corrected them anyway. It
// counted those skips as "duplicates", which read like success.
//
// The result: 154 of 2,311 assets have a purchase price, and the register
// cannot state what anything is worth. That matters beyond tidiness — HR Manual
// 8.10.2 requires "the exact value of the asset owed" on a clearance form, and
// Finance deducts against it.
//
// This reads the same spreadsheet and UPDATES rather than inserting. It only
// ever fills a blank: an existing value is left alone, because somebody may
// have corrected it in the panel since.
//
//   node scripts/backfillAssetValues.js            dry run
//   node scripts/backfillAssetValues.js --apply    writes
//   node scripts/backfillAssetValues.js --apply --overwrite   replace existing too

require('dotenv').config();
const path = require('path');
const xlsx = require('xlsx');
const pool = require('../src/db/pool');

const FILE_PATH = path.join(__dirname, '../data/fixed-asset-register.xlsx');

// Sheet -> the financial columns on it. Deliberately a subset of what
// importAssets maps: this script touches money and dates only, so it cannot
// disturb the branch, department and custody work already done.
const SHEETS = {
  'Equipments':             { price: 'PURCHASE PRICE', date: 'DATE OF PURCHASE', nbv: 'NBV', years: null, supplier: 'SUPPLIER' },
  'Plant & Machinery':      { price: 'PURCHASE PRICE', date: 'DATE OF PURCHASE', nbv: 'NBV', years: null, supplier: 'SUPPLIER' },
  'Furniture & Fittings':   { price: 'PURCHASE PRICE', date: 'DATE OF PURCHASE', nbv: 'NBV', years: null, supplier: 'SUPPLIER' },
  'Computer & Peripherals': { price: 'PURCHASE PRICE', date: 'DATE OF PURCHASE', nbv: 'NBV', years: null, supplier: 'SUPPLIER' },
  'Motor Vehicles':         { price: 'PURCHASE PRICE', date: 'DATE OF PURCHASE', nbv: 'NBV', years: null, supplier: 'SUPPLIER' },
  'Intangibles':            { price: 'PURCHASE PRICE', date: 'DATE OF PURCHASE', nbv: 'NBV', years: null, supplier: 'SUPPLIER' },
  'Non- Capitalized':       { price: 'PURCHASE PRICE', date: 'DATE OF PURCHASE', nbv: 'NBV', years: null, supplier: 'SUPPLIER' },
  'Tablets':                { price: 'PURCHASE PRICE', date: 'DATE OF PURCHASE', nbv: null,  years: null, supplier: 'SUPPLIER' },
};

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const cleaned = typeof value === 'string'
    ? value.replace(/[^0-9.-]/g, '')
    : value;
  const n = Number(cleaned);
  // Zero is a value, not a gap. Treating it as missing is why NBV came back
  // null for every fully-depreciated asset — the register could not tell
  // "written down to nothing" from "never recorded".
  return Number.isFinite(n) ? n : null;
}

// Dates are read as calendar dates, not instants.
//
// .toISOString() on a date parsed in local time shifts it: Kenya is UTC+3, so
// midnight on the 1st became 21:00 on the 30th. That is how every purchase date
// in the register ended up one day early. A spreadsheet date has no timezone —
// it is the day written in the cell — so the local parts are read directly.
function toDateString(value) {
  if (!value) return null;

  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return null;

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
async function main() {
  const apply = process.argv.includes('--apply');
  const overwrite = process.argv.includes('--overwrite');

  const workbook = xlsx.readFile(FILE_PATH, { cellDates: true });

  // Everything the spreadsheet says, keyed by asset code.
  const fromSheet = new Map();
  let sheetRows = 0;

  for (const [sheetName, cols] of Object.entries(SHEETS)) {
    const ws = workbook.Sheets[sheetName];
    if (!ws) { console.log(`  (sheet not found: ${sheetName})`); continue; }

    const raw = xlsx.utils.sheet_to_json(ws, { defval: null });

    // Trim every header key. See the note at the top: a single space around
    // ' PURCHASE PRICE ' is what emptied every financial field in the register.
    const rows = raw.map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim(), v]))
    );

    for (const row of rows) {
      const code = row['ASSET CODE'];
      if (!code || !String(code).trim()) continue;
      sheetRows += 1;
      fromSheet.set(String(code).trim(), {
        sheet: sheetName,
        price: toNumber(row[cols.price]),
        date: toDateString(row[cols.date]),
        nbv: cols.nbv ? toNumber(row[cols.nbv]) : null,
        years: cols.years ? toNumber(row[cols.years]) : null,
        supplier: cols.supplier ? (row[cols.supplier] || null) : null,
      });
    }
  }

  const { rows: assets } = await pool.query(
    `SELECT id, asset_code, purchase_price, date_of_purchase, nbv,
            useful_life_years, supplier
     FROM asset ORDER BY asset_code`
  );

  const updates = [];
  const notInSheet = [];
  const alreadySet = [];
  const noValueInSheet = [];

  for (const a of assets) {
    const src = fromSheet.get(a.asset_code);
    if (!src) { notInSheet.push(a); continue; }

    const set = {};
    // Only fill blanks unless told otherwise: somebody may have corrected a
    // value in the admin panel since, and this must not undo that.
    const wants = (current, incoming) =>
      incoming != null && (overwrite || current == null);

    if (wants(a.purchase_price, src.price)) set.purchase_price = src.price;
    if (wants(a.date_of_purchase, src.date)) set.date_of_purchase = src.date;
    if (wants(a.nbv, src.nbv)) set.nbv = src.nbv;
    if (wants(a.useful_life_years, src.years)) set.useful_life_years = src.years;
    if (wants(a.supplier, src.supplier)) set.supplier = src.supplier;

    if (Object.keys(set).length) updates.push({ asset: a, set, sheet: src.sheet });
    else if (a.purchase_price != null) alreadySet.push(a);
    else noValueInSheet.push(a);
  }

  const withPriceNow = assets.filter((a) => a.purchase_price != null).length;
  const gaining = updates.filter((u) => 'purchase_price' in u.set).length;

  console.log(`Spreadsheet rows read:        ${sheetRows}`);
  console.log(`Assets in the database:       ${assets.length}`);
  console.log(`  with a price now:           ${withPriceNow}`);
  console.log(`  would gain a price:         ${gaining}`);
  console.log(`  price already set:          ${alreadySet.length}`);
  console.log(`  no price in the sheet:      ${noValueInSheet.length}`);
  console.log(`  not in the sheet at all:    ${notInSheet.length}`);
  console.log(`Rows to update:               ${updates.length}\n`);

  const totalValue = updates.reduce((s, u) => s + Number(u.set.purchase_price || 0), 0)
    + assets.reduce((s, a) => s + Number(a.purchase_price || 0), 0);
  console.log(`Register value after this:    KES ${totalValue.toLocaleString('en-KE', { maximumFractionDigits: 2 })}\n`);

  console.log('--- Sample of what would change ---');
  updates.slice(0, 10).forEach((u) =>
    console.log(`  ${u.asset.asset_code.padEnd(12)} ${Object.entries(u.set)
      .map(([k, v]) => `${k}=${v}`).join(', ')}`)
  );
  if (updates.length > 10) console.log(`  ...and ${updates.length - 10} more`);

  if (notInSheet.length) {
    console.log(`\n--- In the database but not the sheet (${notInSheet.length}) ---`);
    console.log('    Mostly the NC codes issued after the spreadsheet was exported.');
    notInSheet.slice(0, 6).forEach((a) => console.log(`  ${a.asset_code}`));
    if (notInSheet.length > 6) console.log(`  ...and ${notInSheet.length - 6} more`);
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write these values.');
    console.log('Existing values are left alone; add --overwrite to replace them too.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let done = 0;
    for (const u of updates) {
      const cols = Object.keys(u.set);
      const assignments = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      await client.query(
        `UPDATE asset SET ${assignments} WHERE id = $${cols.length + 1}`,
        [...cols.map((c) => u.set[c]), u.asset.id]
      );
      done += 1;
      if (done % 500 === 0) console.log(`  ...${done} updated`);
    }

    await client.query('COMMIT');
    console.log(`\nUpdated ${done} assets.`);

    const { rows: after } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(purchase_price)::int AS priced,
              COALESCE(SUM(purchase_price), 0)::numeric AS value
       FROM asset`
    );
    console.log(`Priced: ${after[0].priced} of ${after[0].total}`);
    console.log(`Register value: KES ${Number(after[0].value).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`);
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