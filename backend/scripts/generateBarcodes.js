require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bwipjs = require('bwip-js');
const pool = require('../src/db/pool');

const OUTPUT_DIR = path.join(__dirname, '../barcodes');

async function run() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const result = await pool.query('SELECT asset_code, description FROM asset ORDER BY asset_code');
  const assets = result.rows;

  console.log(`Generating barcodes for ${assets.length} assets...`);

  let count = 0;
  for (const asset of assets) {
    const safeFileName = asset.asset_code.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(OUTPUT_DIR, `${safeFileName}.png`);

    const png = await bwipjs.toBuffer({
      bcid: 'code128',
      text: asset.asset_code,
      scale: 3,
      height: 10,
      includetext: true,
      textxalign: 'center',
      backgroundcolor: 'FFFFFF',
      paddingwidth: 10,
      paddingheight: 10,
    });

    fs.writeFileSync(filePath, png);

    count++;
    if (count % 200 === 0) {
      console.log(`  ...${count} generated so far`);
    }
  }

  console.log(`Done. ${count} barcode images saved to: ${OUTPUT_DIR}`);
  await pool.end();
}

run().catch(err => {
  console.error('Barcode generation failed:', err);
  process.exit(1);
});