const xlsx = require('xlsx');
const pool = require('../db/pool');
const { ASSET_CONDITIONS, isValidCondition } = require('../constants/assetConditions');

// Bulk import from a spreadsheet, with a preview before anything is written.
//
// WHY PREVIEW FIRST
// A bad import is the one action that can damage 2,311 records at once, and
// every data problem in this register came from an import that reported success
// while doing something unexpected. So this parses the file, compares it with
// what is already there, and reports exactly what it would do — added, changed,
// unchanged, rejected — before a single row is written.
//
// The file is never stored. It is parsed in memory, the diff is returned, and
// the browser sends the rows back when the person confirms. That avoids holding
// uploads on a small instance and avoids a half-applied import if the process
// restarts between the two steps.

// Column headings are trimmed before use. This workbook pads the headings of
// its numeric columns — ' PURCHASE PRICE ', ' NBV ' — while text columns are
// clean, and that single space emptied every financial field in the register
// and understated it by a factor of sixty-six.
function normaliseHeaders(row) {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [String(k).trim().toUpperCase(), v])
  );
}

// Accepts the several spellings a column has appeared under across eight sheets.
const FIELDS = {
  asset_code:   ['ASSET CODE', 'ASSETCODE', 'CODE'],
  description:  ['DESCRIPTION', 'ASSET DESCRIPTION', 'ITEM'],
  serial:       ['SERIAL NO.', 'SERIAL NO', 'SERIAL NUMBER', 'TABLET IMEI'],
  purchaseDate: ['DATE OF PURCHASE', 'PURCHASE DATE'],
  price:        ['PURCHASE PRICE', 'COST', 'PURCHASE COST'],
  supplier:     ['SUPPLIER', 'VENDOR'],
  branch:       ['BRANCH'],
  department:   ['LOCATION', 'DEPARTMENT'],
  // 'NAM E OF USER' is a typo in the Plant & Machinery and Intangibles sheet
  // headers. Trimming and upper-casing does not repair an interior space, so
  // those two sheets silently lost their holder column until it was listed.
  physLoc:      ['PHYSICAL LOCATION', 'CURRENT USER', 'NAME OF USER', 'NAM E OF USER'],
  status:       ['CURRENT STATUS', 'STATUS'],
  nbv:          ['NBV', 'NET BOOK VALUE'],
  accDep:       ['ACCUMULATED DEPRECIATION'],
  chassis:      ['CHASSIS NO', 'CHASSIS NO.', 'CHASSIS NUMBER'],
  engine:       ['ENGINE NO', 'ENGINE NO.', 'ENGINE NUMBER'],
  // The depreciation columns exist on every sheet and on the asset table, but
  // were never mapped, so the register could not answer what anything is worth
  // now. Empty in the current workbook; mapped so they arrive when they are
  // filled in rather than needing another code change.
  usefulLife:   ['NO. OF YEARS', 'NO OF YEARS', 'USEFUL LIFE', 'USEFUL LIFE YEARS'],
  remainingLife:['REMAINING LIFE'],
  monthlyDep:   ['MONTHLY DEPRECIATION'],
  endMonth:     ['CURRENT END MONTH DATE'],
};

function pick(row, field) {
  for (const name of FIELDS[field]) {
    if (row[name] !== undefined && row[name] !== null && row[name] !== '') return row[name];
  }
  return null;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  // "1,234.50" and "KES 1,234" both give NaN through Number() alone, and the
  // value is then silently lost.
  // A cell holding only spaces strips to '', and Number('') is 0 — so a blank
  // read as a recorded zero. One such cell is already in the Accumulated
  // Depreciation column of the Equipments sheet.
  if (typeof value === 'string' && !/\d/.test(value)) return null;

  // A minus sign only counts at the front. Without the second replace,
  // "VFK-Elnino 2" strips to "-2" and a label becomes a negative number.
  const cleaned = typeof value === 'string'
    ? value.replace(/[^0-9.-]/g, '').replace(/(?!^)-/g, '')
    : value;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// A useful life is a small number of years. The Non-Capitalized sheet has 15
// rows where No. OF YEARS holds values like 358928132569567 — device
// identifiers pasted into the wrong column — and one of them overflowed the
// column and stopped the entire import. An implausible value is dropped and
// flagged, rather than 2,116 good rows failing because of 15 bad cells.
function toYears(value) {
  const n = toNumber(value);
  if (n === null) return null;
  return n >= 0 && n <= 100 ? n : null;
}

// Dates are read as calendar dates, not instants.
//
// The original import called .toISOString() on a date parsed in local time.
// Kenya is UTC+3, so midnight on the 1st became 21:00 on the 30th, and every
// purchase date in the register is one day early. A spreadsheet date has no
// timezone — it is the day written in the cell — so the local parts are read
// directly rather than converted.
function toDate(value) {
  if (!value) return null;
  // A bare number is not a date. cellDates hands back a real Date for anything
  // Excel formats as one, so a number means the cell holds something else —
  // and new Date(717664454) would quietly read as 9 January 1970.
  if (typeof value === 'number') return null;

  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return null;

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Sheets that are not asset registers. This workbook carries cleanup notes, a
// summary, disposal and loss listings, and copies of three sheets somebody
// duplicated in Excel and left in — reading them all produced 1,095 rejections
// and buried the rows that mattered.
const SKIP_SHEET = /^(data cleanup|nc codes|summary|disposal|lost assets|sheet\d*)/i;
const DUPLICATE_SHEET = /\(\d+\)\s*$/;

// Parses the workbook into rows, and says plainly what it could not read.
function parseWorkbook(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });

  const rows = [];
  const rejections = [];
  const skippedSheets = [];
  const readSheets = [];
  const seenCodes = new Map();
  const seenSerials = new Map();

  for (const sheetName of wb.SheetNames) {
    const name = sheetName.trim();

    if (SKIP_SHEET.test(name) || DUPLICATE_SHEET.test(name)) {
      skippedSheets.push(sheetName);
      continue;
    }
    readSheets.push(sheetName);

    const raw = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });

    raw.forEach((rawRow, i) => {
      const rowNumber = i + 2;                // +1 for the header, +1 for 1-based
      const row = normaliseHeaders(rawRow);
      const code = pick(row, 'asset_code');

      if (!code || !String(code).trim()) return;      // a blank line, not an error

      const assetCode = String(code).trim();

      // Not an asset code. "N/A" gave 168 assets the same code; the balance and
      // variance rows are spreadsheet arithmetic that the original import
      // brought in as sixteen pieces of equipment.
      if (/^(n\/?a|none|nil|-{1,}|tbd)$/i.test(assetCode)
          || /^(balance|system balance|variance|total|grand total|sub[- ]?total)/i.test(assetCode)) {
        rejections.push({ sheet: sheetName, row: rowNumber, code: assetCode,
                          reason: 'Not an asset — a total or balance row' });
        return;
      }

      const description = pick(row, 'description');
      if (!description || !String(description).trim()) {
        rejections.push({ sheet: sheetName, row: rowNumber, code: assetCode,
                          reason: 'No description' });
        return;
      }

      // A code appearing twice in one upload is a mistake in the spreadsheet,
      // not something to resolve silently by taking the last one.
      // The message names the sheet the first copy was on. Codes repeat ACROSS
      // sheets here — 54 of the Tablets rows also appear under Non-Capitalized —
      // and "duplicate of row 442 in this file" read as nonsense while you were
      // looking at a different tab.
      if (seenCodes.has(assetCode)) {
        rejections.push({ sheet: sheetName, row: rowNumber, code: assetCode,
                          reason: `Already read from ${seenCodes.get(assetCode)}` });
        return;
      }
      seenCodes.set(assetCode, `${sheetName} row ${rowNumber}`);

      const serial = pick(row, 'serial');
      const condition = pick(row, 'status');

      const parsed = {
        sheet: sheetName,
        row: rowNumber,
        asset_code: assetCode,
        description: String(description).trim(),
        serial_number: serial ? String(serial).trim() : null,
        date_of_purchase: toDate(pick(row, 'purchaseDate')),
        purchase_price: toNumber(pick(row, 'price')),
        supplier: pick(row, 'supplier'),
        nbv: toNumber(pick(row, 'nbv')),
        accumulated_depreciation: toNumber(pick(row, 'accDep')),
        useful_life_years: toYears(pick(row, 'usefulLife')),        remaining_life: toNumber(pick(row, 'remainingLife')),
        monthly_depreciation: toNumber(pick(row, 'monthlyDep')),
        current_end_month_date: toDate(pick(row, 'endMonth')),
        chassis_number: pick(row, 'chassis'),
        engine_number: pick(row, 'engine'),
        branch: pick(row, 'branch'),
        department: pick(row, 'department'),
        physical_location: pick(row, 'physLoc'),
        // An unrecognised condition is stored as null rather than accepted.
        // Engine numbers in this column are how ~100 assets ended up with a
        // chassis code as their condition.
        condition: condition && isValidCondition(String(condition).trim())
          ? String(condition).trim()
          : null,
        condition_raw: condition ? String(condition).trim() : null,
      };

            // A serial appearing twice is worth flagging but not refusing — two
      // identical monitors legitimately share a blank serial.
      if (parsed.serial_number && !/^n\/?a$/i.test(parsed.serial_number)) {
        if (seenSerials.has(parsed.serial_number)) {
          parsed.warning = `Serial also on ${seenSerials.get(parsed.serial_number)}`;
        } else {
          seenSerials.set(parsed.serial_number, assetCode);
        }
      }

      // A cell was present but too implausible to keep. 15 rows on the
      // Non-Capitalized sheet carry device identifiers in these two columns —
      // 358928132569567 years of useful life — and one of them overflowed the
      // column and stopped the whole import before this was caught here.
      if (pick(row, 'usefulLife') != null && parsed.useful_life_years === null) {
        parsed.warning = 'Useful life is not a plausible number of years — ignored';
      } else if (pick(row, 'endMonth') != null && parsed.current_end_month_date === null) {
        parsed.warning = 'End month date is not a date — ignored';
      }

      rows.push(parsed);
    });
  }

  return { rows, rejections, sheetNames: readSheets, skippedSheets };
}

// Fields compared when deciding whether an existing asset would change.
// Deliberately excludes status and condition: those are set by what happens in
// the field, and a spreadsheet should not overwrite an inspection.
const COMPARED = [
  'description', 'serial_number', 'date_of_purchase', 'purchase_price',
  'supplier', 'nbv', 'accumulated_depreciation', 'chassis_number', 'engine_number',
  'useful_life_years', 'remaining_life', 'monthly_depreciation', 'current_end_month_date',
];

// Dates arrive as a JS Date from Postgres and as a string from the sheet, so a
// plain string comparison never matched — which reported 2,201 of 2,291 assets
// as "changed" when only the format differed, burying whatever had genuinely
// moved.
const asDate = (v) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};

const same = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  if (a instanceof Date || b instanceof Date) {
    const da = asDate(a), db = asDate(b);
    return da != null && da === db;
  }

  if (typeof a === 'number' || typeof b === 'number') {
    // Money is stored to two decimals; a sheet may carry more.
    return Math.abs(Number(a) - Number(b)) < 0.005;
  }

  return String(a).trim() === String(b).trim();
};

// POST /import/preview — parse and compare. Writes nothing.
async function preview(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file was uploaded' });

  try {
    const { rows, rejections, sheetNames, skippedSheets } = parseWorkbook(req.file.buffer);

    if (!rows.length) {
      return res.status(400).json({
        error: 'No usable rows found. Check the sheet has an ASSET CODE and DESCRIPTION column.',
        rejections: rejections.slice(0, 50),
        skipped_sheets: skippedSheets,
      });
    }

    const codes = rows.map((r) => r.asset_code);
    const { rows: existing } = await pool.query(
      `SELECT asset_code, description, serial_number, date_of_purchase,
              purchase_price, supplier, nbv, accumulated_depreciation,
              chassis_number, engine_number,
              useful_life_years, remaining_life, monthly_depreciation,
              current_end_month_date
       FROM asset WHERE asset_code = ANY($1::text[])`,
      [codes]
    );
    const byCode = new Map(existing.map((a) => [a.asset_code, a]));

    const added = [];
    const updated = [];
    const unchanged = [];

    for (const r of rows) {
      const current = byCode.get(r.asset_code);

      if (!current) {
        added.push(r);
        continue;
      }

      // Only fields the sheet actually supplies are compared. A blank cell means
      // "no information", not "set this to empty" — otherwise a partial upload
      // would wipe data it never mentioned.
      const changes = COMPARED
        .filter((f) => r[f] != null && !same(r[f], current[f]))
        .map((f) => ({ field: f, from: current[f], to: r[f] }));

      if (changes.length) updated.push({ ...r, changes });
      else unchanged.push(r);
    }

    res.json({
      filename: req.file.originalname,
      sheets: sheetNames,
      skipped_sheets: skippedSheets,
      rows_read: rows.length,
      summary: {
        added: added.length,
        updated: updated.length,
        unchanged: unchanged.length,
        rejected: rejections.length,
      },
      // Samples rather than everything: a preview is for judgement, and nobody
      // reads 2,000 rows in a browser.
      added: added.slice(0, 50),
      updated: updated.slice(0, 50),
      rejections: rejections.slice(0, 50),
      warnings: rows.filter((r) => r.warning).slice(0, 25),
      // Returned so the browser can send them back on confirm, rather than the
      // server holding an upload between two requests.
      rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not read that file. Is it a valid .xlsx?' });
  }
}
// branch / department / programme / physical_location, all four.
//
// This omitted programme, and location rows differ by it: Mombasa alone has
// five rows — plain, Mwatate, Changamwe, Kilifi and Marafa — that all produced
// the identical key. byKey is a Map, so the last one read from the database
// won, and an import row for plain Mombasa would have been filed under
// whichever programme happened to come back last.
//
// The spreadsheet has no programme column, so a parsed row keys as empty and
// matches only the null-programme row. Which is the correct behaviour: an
// import cannot know which programme an asset belongs to.
const placeKey = (r) =>
  [r.branch, r.department, r.programme, r.physical_location]
    .map((v) => (v == null ? '' : String(v).trim()))
    .join('|');

// Two queries, not two thousand.
//
// The first version of this looked up each place and inserted the missing ones
// one at a time: ~1,900 round trips before a single asset was touched, inside
// a transaction, on an instance that has to reach Supabase over the network.
// The whole register is read in one SELECT and the new places written in one
// INSERT instead.
async function resolveLocations(client, rows) {
  const wanted = new Map();
  const skipped = [];

  for (const r of rows) {
    // location.branch is NOT NULL. The Intangibles sheet has no BRANCH column
    // at all — it carries the branch under LOCATION, alongside a PHYSICAL
    // LOCATION column that actually holds condition text ("In use", "Working").
    // Guessing which of those is the branch is how this register acquired 86
    // spellings for 35 places, so a row with no branch is left unplaced and
    // reported rather than filed somewhere invented.
    if (!r.branch || !String(r.branch).trim()) {
      skipped.push(r.asset_code);
      continue;
    }
    const key = placeKey(r);
    if (!wanted.has(key)) {
      wanted.set(key, {
        branch: String(r.branch).trim(),
        department: r.department ? String(r.department).trim() : null,
        physical_location: r.physical_location ? String(r.physical_location).trim() : null,
      });
    }
  }

  const ids = new Map();

  // Matched in JS on the same key the sheet is keyed by, so null and '' cannot
  // disagree the way SQL's null = null would.
  const { rows: existing } = await client.query(
    'SELECT id, branch, department, physical_location FROM location'
  );
  const byKey = new Map(existing.map((l) => [placeKey(l), l.id]));

  const missing = [];
  for (const [key, place] of wanted) {
    const found = byKey.get(key);
    if (found) ids.set(key, found);
    else missing.push([key, place]);
  }

  if (missing.length) {
    const { rows: made } = await client.query(
      `INSERT INTO location (branch, department, physical_location)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
       RETURNING id, branch, department, physical_location`,
      [
        missing.map(([, p]) => p.branch),
        missing.map(([, p]) => p.department),
        missing.map(([, p]) => p.physical_location),
      ]
    );
    for (const l of made) ids.set(placeKey(l), l.id);
  }

  return { ids, created: missing.length, skipped };
}
// POST /import/apply — write the rows the person has just seen.
async function apply(req, res) {
  const {
    rows, mode = 'upsert', filename = 'upload.xlsx', sheets = [],
    // Set false to write asset records only and leave placement alone. The
    // sheet's branch spellings are not canonical — "Head Office", "HEAD
    // OFFICE" and "HO" are all in there — so creating locations from it grows
    // the branch list until scripts/normalizeBranches.js is run afterwards.
    link_locations = true,
  } = req.body;

  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'No rows to import' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

      const batch = await client.query(
      // sheet_names and rows_read, per migration 009. This read "sheets" and
      // "row_count" — names that have never existed — and was never reached
      // to find out, because the body limit rejected every import first.
      `INSERT INTO import_batch (filename, sheet_names, imported_by, mode, rows_read)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [filename, sheets, req.user.id, mode, rows.length]
    );
    const batchId = batch.rows[0].id;

    let addedCount = 0, updatedCount = 0, unchangedCount = 0;
    const createdCodes = [];

        // Which codes already exist, in one query rather than one per row. preview
    // already reads the register this way; apply was still asking 2,117 times.
        const { rows: known } = await client.query(
      'SELECT id, asset_code, status FROM asset WHERE asset_code = ANY($1::text[])',
      [rows.map((r) => r.asset_code)]
    );
    const idByCode = new Map(known.map((a) => [a.asset_code, a.id]));

    // Disposed and lost assets are not anywhere, and must not be given a
    // location.
    //
    // The register records a holder under the PHYSICAL LOCATION heading, so
    // that column contains staff names as often as places. The first import to
    // write placements read "Grace Kimeu" as somewhere an asset could be, made
    // a location row for her, and opened an assignment against it — on eight
    // assets written off in December 2024 and two recorded as lost. That put
    // live custody of equipment that no longer exists onto named people, who
    // exit clearance would then have chased for it.
    const goneIds = new Set(
      known.filter((a) => ['Disposed', 'Lost'].includes(a.status)).map((a) => a.id)
    );

    // An open assignment is what gives an asset a branch, and an asset that
    // has one is left alone: if somebody has moved the equipment in the field,
    // that record is the true one and a spreadsheet must not overwrite it.
    // Read once into a Set, so the common case costs no query at all.
    const { rows: held } = await client.query(
      `SELECT DISTINCT asset_id FROM assignment
       WHERE returned_date IS NULL AND asset_id = ANY($1::int[])`,
      [[...idByCode.values()]]
    );
    const alreadyPlaced = new Set(held.map((a) => a.asset_id));

    // Only the rows that will actually be placed.
    //
    // These two queries used to run AFTER the location pass, so every distinct
    // place in the file got a location row whether or not anything needed it.
    // The first real import created 924 locations and used 15 of them: 909
    // rows nothing pointed at, which then had to be found and deleted by hand.
    const needsPlacing = rows.filter((r) => {
      const id = idByCode.get(r.asset_code);
      if (id !== undefined && goneIds.has(id)) return false;
      return id === undefined || !alreadyPlaced.has(id);
    });

    const { ids: locationIds, created: locationsCreated, skipped: unplaceable } =
      link_locations === false
        ? { ids: new Map(), created: 0, skipped: [] }
        : await resolveLocations(client, needsPlacing);

    // Collected here and written in one INSERT after the loop.
        const toPlace = [];
    const place = (assetId, r) => {
      // A disposed or lost asset is not anywhere. Checked here as well as in
      // needsPlacing above: that one stops the location row being created,
      // this one stops the assignment. Either alone leaves half the problem.
      if (goneIds.has(assetId)) return;
      if (alreadyPlaced.has(assetId)) return;
      const locationId = locationIds.get(placeKey(r));
      if (!locationId) return;
      alreadyPlaced.add(assetId);          // a code cannot repeat, but be sure
      toPlace.push([assetId, locationId]);
    };

    for (const r of rows) {
      try {
        const existingId = idByCode.get(r.asset_code);

        if (!existingId) {
          const inserted = await client.query(
            `INSERT INTO asset
               (asset_code, description, serial_number, date_of_purchase, purchase_price,
                supplier, nbv, accumulated_depreciation, chassis_number, engine_number,
                useful_life_years, remaining_life, monthly_depreciation,
                current_end_month_date,
                condition, import_batch_id, approval_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'approved')
             RETURNING id`,
            [r.asset_code, r.description, r.serial_number, r.date_of_purchase,
             r.purchase_price, r.supplier, r.nbv, r.accumulated_depreciation,
             r.chassis_number, r.engine_number,
             r.useful_life_years, r.remaining_life, r.monthly_depreciation,
             r.current_end_month_date,
             r.condition, batchId]
          );
          addedCount += 1;
          createdCodes.push(r.asset_code);
          place(inserted.rows[0].id, r);
          continue;
        }

        // An asset already in the register may still have no location — every
        // row imported before this change is in exactly that state.
        place(existingId, r);

        if (mode === 'add') { unchangedCount += 1; continue; }

        // COALESCE on the incoming value, so a blank cell leaves the existing
        // value alone rather than erasing it. The IS DISTINCT FROM guard is
        // what makes "unchanged" mean unchanged: without it every row counts
        // as updated whether or not anything moved.
        const result = await client.query(
          `UPDATE asset SET
             description = COALESCE($2, description),
             serial_number = COALESCE($3, serial_number),
             date_of_purchase = COALESCE($4::date, date_of_purchase),
             purchase_price = COALESCE($5, purchase_price),
             supplier = COALESCE($6, supplier),
             nbv = COALESCE($7, nbv),
             accumulated_depreciation = COALESCE($8, accumulated_depreciation),
             chassis_number = COALESCE($9, chassis_number),
             engine_number = COALESCE($10, engine_number),
             useful_life_years = COALESCE($11, useful_life_years),
             remaining_life = COALESCE($12, remaining_life),
             monthly_depreciation = COALESCE($13, monthly_depreciation),
             current_end_month_date = COALESCE($14::date, current_end_month_date)
           WHERE asset_code = $1
             AND (
               description IS DISTINCT FROM COALESCE($2, description)
               OR serial_number IS DISTINCT FROM COALESCE($3, serial_number)
               OR date_of_purchase IS DISTINCT FROM COALESCE($4::date, date_of_purchase)
               OR purchase_price IS DISTINCT FROM COALESCE($5, purchase_price)
               OR supplier IS DISTINCT FROM COALESCE($6, supplier)
               OR nbv IS DISTINCT FROM COALESCE($7, nbv)
               OR accumulated_depreciation IS DISTINCT FROM COALESCE($8, accumulated_depreciation)
               OR chassis_number IS DISTINCT FROM COALESCE($9, chassis_number)
               OR engine_number IS DISTINCT FROM COALESCE($10, engine_number)
               OR useful_life_years IS DISTINCT FROM COALESCE($11, useful_life_years)
               OR remaining_life IS DISTINCT FROM COALESCE($12, remaining_life)
               OR monthly_depreciation IS DISTINCT FROM COALESCE($13, monthly_depreciation)
               OR current_end_month_date IS DISTINCT FROM COALESCE($14::date, current_end_month_date)
             )`,
          [r.asset_code, r.description, r.serial_number, r.date_of_purchase,
           r.purchase_price, r.supplier, r.nbv, r.accumulated_depreciation,
           r.chassis_number, r.engine_number,
           r.useful_life_years, r.remaining_life, r.monthly_depreciation,
           r.current_end_month_date]
        );

        if (result.rowCount) updatedCount += 1;
        else unchangedCount += 1;
      } catch (err) {
        // Which row, so a failure names itself. The constraint that stopped
        // the first real run gave no clue which of 2,117 rows had caused it.
        err.importRow = `${r.sheet || '?'} row ${r.row || '?'} (${r.asset_code})`;
        throw err;
      }
    }

    if (toPlace.length) {
      await client.query(
        `INSERT INTO assignment (asset_id, location_id, assigned_by)
         SELECT a, l, $3 FROM unnest($1::int[], $2::int[]) AS t(a, l)`,
        [toPlace.map((p) => p[0]), toPlace.map((p) => p[1]), req.user.id]
      );
    }

    await client.query(
      `UPDATE import_batch
       SET rows_added = $1, rows_updated = $2, rows_unchanged = $3, created_codes = $4
       WHERE id = $5`,
      [addedCount, updatedCount, unchangedCount, createdCodes, batchId]
    );

    await client.query('COMMIT');

    res.json({
      batch_id: batchId,
      added: addedCount,
      updated: updatedCount,
      unchanged: unchangedCount,
      // Reported rather than silent: creating locations changes what a Branch
      // Administrator can see, which is too consequential to happen unnoticed.
      locations_created: locationsCreated,
      assets_placed: toPlace.length,
      // Named, not just counted: these are the rows whose sheet gives no
      // branch, so they will not appear under any branch until it is supplied.
      not_placed: unplaceable.length,
      not_placed_codes: unplaceable.slice(0, 100),
      message:
        `${addedCount} added, ${updatedCount} updated, ${unchangedCount} unchanged.` +
        (toPlace.length
          ? ` ${toPlace.length} given a location (${locationsCreated} new place${locationsCreated === 1 ? '' : 's'}).`
          : '') +
        (unplaceable.length
          ? ` ${unplaceable.length} have no branch in the sheet and were left unplaced.`
          : ''),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed at', err.importRow || 'the location pass', err);
    res.status(500).json({
      error: 'The import failed and nothing was written.',
      // Admin-only endpoint, so returning the cause is safe — and saves
      // reading the server log every time a sheet has a surprise in it.
      detail: err.message,
      at: err.importRow || null,
    });
  } finally {
    client.release();
  }
}
// GET /import/batches — what has been imported, and by whom.
async function getBatches(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT b.*, s.name AS imported_by_name
       FROM import_batch b
       LEFT JOIN it_staff s ON s.id = b.imported_by
       WHERE b.mode <> 'preview'
       ORDER BY b.imported_at DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch import history' });
  }
}

module.exports = { preview, apply, getBatches };