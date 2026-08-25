require('dotenv').config();
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const pool = require('../src/db/pool');

const OUTPUT_PATH = path.join(__dirname, '../barcodes/asset-labels.pdf');

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 20;
const COLS = 2;
const ROWS = 10;
const LABEL_WIDTH = (PAGE_WIDTH - MARGIN * 2) / COLS;
const LABEL_HEIGHT = (PAGE_HEIGHT - MARGIN * 2) / ROWS;
const BARCODE_WIDTH = LABEL_WIDTH - 20;
const BARCODE_HEIGHT = 40;

async function run() {
  const result = await pool.query(
    'SELECT asset_code, description FROM asset ORDER BY asset_code'
  );
  const assets = result.rows;

  console.log(`Building barcode label sheet for ${assets.length} assets...`);

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
  const stream = fs.createWriteStream(OUTPUT_PATH);
  doc.pipe(stream);

  let col = 0;
  let row = 0;

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];

    if (row >= ROWS) {
      doc.addPage();
      row = 0;
      col = 0;
    }

    const x = MARGIN + col * LABEL_WIDTH;
    const y = MARGIN + row * LABEL_HEIGHT;

    const barcodeBuffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: asset.asset_code,
      scale: 2,
      height: 8,
      includetext: false,
      backgroundcolor: 'FFFFFF',
      paddingwidth: 6,
      paddingheight: 6,
    });

    doc.rect(x, y, LABEL_WIDTH, LABEL_HEIGHT).stroke('#cccccc');

    const barcodeX = x + (LABEL_WIDTH - BARCODE_WIDTH) / 2;
    doc.image(barcodeBuffer, barcodeX, y + 8, { width: BARCODE_WIDTH, height: BARCODE_HEIGHT });

    doc.fontSize(8).font('Helvetica-Bold').text(
      asset.asset_code,
      x + 2,
      y + BARCODE_HEIGHT + 12,
      { width: LABEL_WIDTH - 4, align: 'center' }
    );

    const shortDesc = asset.description.length > 35
      ? asset.description.slice(0, 35) + '...'
      : asset.description;
    doc.fontSize(6).font('Helvetica').text(
      shortDesc,
      x + 2,
      y + BARCODE_HEIGHT + 24,
      { width: LABEL_WIDTH - 4, align: 'center' }
    );

    col++;
    if (col >= COLS) {
      col = 0;
      row++;
    }

    if ((i + 1) % 500 === 0) {
      console.log(`  ...${i + 1} labels placed`);
    }
  }

  doc.end();

  stream.on('finish', async () => {
    console.log(`Done. Label sheet saved to: ${OUTPUT_PATH}`);
    await pool.end();
  });
}

run().catch(err => {
  console.error('Label sheet generation failed:', err);
  process.exit(1);
});