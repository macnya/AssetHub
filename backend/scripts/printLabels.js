// Builds a print-ready PDF of asset labels, laid out on A4 sheets.
//
// The PNGs in ../barcodes are one file per asset, which is fine for viewing a
// single label on screen and useless for printing 170 of them. This lays them
// out 24 to a page at a fixed physical size, so a sheet comes out of the
// printer ready to cut or peel.
//
// Grid matches Avery L7159 / 5871 (63.5 x 33.9 mm, 3 across, 8 down), which is
// the most widely stocked address-label sheet. It also prints fine on plain
// paper if you're cutting and taping.
//
//   node scripts/printLabels.js                      every asset
//   node scripts/printLabels.js --prefix NC          the 170 new ones
//   node scripts/printLabels.js --branch Eldoret     one branch
//   node scripts/printLabels.js --unverified         never physically checked
//   node scripts/printLabels.js --codes KDT001,KDT002
//   node scripts/printLabels.js --prefix NC --skip 5 start 5 slots in, to
//                                                   reuse a part-used sheet
//
// PRINT AT 100%. Any "fit to page" or "shrink to fit" setting rescales the
// bars and a scanner may not read them.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const pool = require('../src/db/pool');

const MM = 2.83465;                    // points per millimetre

const LABEL_W = 63.5 * MM;
const LABEL_H = 33.9 * MM;
const COLS = 3;
const ROWS = 8;
const PER_PAGE = COLS * ROWS;

const PAGE_W = 595.28;                 // A4 portrait, in points
const PAGE_H = 841.89;

// The grid is centred rather than pinned to a vendor's margins, so it prints
// sensibly on plain paper too. Run one test page against your label stock
// before committing a box to it.
const MARGIN_X = (PAGE_W - COLS * LABEL_W) / 2;
const MARGIN_Y = (PAGE_H - ROWS * LABEL_H) / 2;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes(`--${name}`);

async function fetchAssets() {
  const clauses = [];
  const params = [];

  const prefix = arg('prefix');
  if (prefix) {
    params.push(`${prefix}%`);
    clauses.push(`a.asset_code LIKE $${params.length}`);
  }

  const codes = arg('codes');
  if (codes) {
    params.push(codes.split(',').map((c) => c.trim()).filter(Boolean));
    clauses.push(`a.asset_code = ANY($${params.length}::text[])`);
  }

  const branch = arg('branch');
  if (branch) {
    params.push(branch);
    clauses.push(`l.branch = $${params.length}`);
  }

  if (has('unverified')) {
    clauses.push('a.condition IS NULL');
  }

  // Disposed and lost assets don't need labels printing.
  clauses.push(`a.status NOT IN ('Disposed', 'Lost')`);

  const { rows } = await pool.query(
    `SELECT DISTINCT a.asset_code, a.description, l.branch
     FROM asset a
     LEFT JOIN assignment ag ON ag.asset_id = a.id AND ag.returned_date IS NULL
     LEFT JOIN location l ON l.id = ag.location_id
     ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
     ORDER BY a.asset_code`,
    params
  );
  return rows;
}

function drawLabel(doc, asset, barcode, col, row) {
  const x = MARGIN_X + col * LABEL_W;
  const y = MARGIN_Y + row * LABEL_H;

  // A hairline cut guide. Invisible on peel-off stock, useful on plain paper.
  doc.save()
     .rect(x, y, LABEL_W, LABEL_H)
     .lineWidth(0.25)
     .strokeColor('#dddddd')
     .stroke()
     .restore();

  const padX = 4 * MM;
  const padY = 3 * MM;
  const innerW = LABEL_W - padX * 2;

  // Barcode fills most of the label. Bar width is what a scanner reads, so it
  // gets the space; the text underneath is for humans.
  const bcH = 16 * MM;
  doc.image(barcode, x + padX, y + padY, { width: innerW, height: bcH });

  doc.fontSize(9).font('Courier-Bold').fillColor('#000000')
     .text(asset.asset_code, x + padX, y + padY + bcH + 1.2 * MM, {
       width: innerW, align: 'center', lineBreak: false,
     });

  // Description helps whoever is walking round with the sheet work out which
  // label goes on which thing.
  const desc = (asset.description || '').slice(0, 34);
  doc.fontSize(6).font('Helvetica').fillColor('#555555')
     .text(desc, x + padX, y + padY + bcH + 5 * MM, {
       width: innerW, align: 'center', lineBreak: false,
     });
}

async function main() {
  const assets = await fetchAssets();

  if (assets.length === 0) {
    console.log('No assets matched those filters — nothing to print.');
    return;
  }

  const skip = Math.max(0, parseInt(arg('skip') || '0', 10));
  const pages = Math.ceil((assets.length + skip) / PER_PAGE);

  console.log(`Assets: ${assets.length}`);
  if (skip) console.log(`Skipping the first ${skip} label position(s) on page 1.`);
  console.log(`Pages:  ${pages} (${PER_PAGE} labels per A4 sheet)`);

  const outPath = path.join(__dirname, '../barcodes/labels.pdf');
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  doc.pipe(fs.createWriteStream(outPath));

  let slot = skip;
  for (let i = 0; i < assets.length; i++) {
    if (slot > 0 && slot % PER_PAGE === 0) doc.addPage();

    const asset = assets[i];

    // Generated at scale 4 and scaled down by the PDF: the extra resolution
    // survives printing, where a low-res barcode goes fuzzy at the edges and
    // scanners start refusing it.
    const barcode = await bwipjs.toBuffer({
      bcid: 'code128',
      text: asset.asset_code,
      scale: 4,
      height: 12,
      includetext: false,        // the code is drawn as PDF text below instead
      backgroundcolor: 'FFFFFF',
      paddingwidth: 2,
      paddingheight: 2,
    });

    const pos = slot % PER_PAGE;
    drawLabel(doc, asset, barcode, pos % COLS, Math.floor(pos / COLS));
    slot++;

    if ((i + 1) % 50 === 0) console.log(`  ...${i + 1} laid out`);
  }

  doc.end();
  console.log(`\nWritten to: ${outPath}`);
  console.log('\nPrint at 100% / "Actual size". Any fit-to-page setting rescales');
  console.log('the bars and a scanner may not read them. Print ONE page first and');
  console.log('check it scans with the app before running the whole batch.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());