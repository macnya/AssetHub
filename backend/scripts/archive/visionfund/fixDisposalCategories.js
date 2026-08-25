require('dotenv').config();
const pool = require('../src/db/pool');

// Keyword → category name mapping, checked in order (first match wins)
const keywordRules = [
  { keywords: ['chair', 'desk', 'table', 'cabinet', 'shelf', 'sofa', 'furniture'], category: 'Furniture & Fittings' },
  { keywords: ['vehicle', 'car', 'truck', 'motorcycle', 'motorbike', 'van'], category: 'Motor Vehicles' },
  { keywords: ['laptop', 'desktop', 'monitor', 'printer', 'scanner', 'computer', 'keyboard', 'mouse', 'server', 'ups', 'projector'], category: 'Computer & Peripherals' },
  { keywords: ['tablet', 'ipad'], category: 'Tablets' },
  { keywords: ['generator', 'machine', 'compressor', 'pump'], category: 'Plant & Machinery' },
];

async function run() {
  const categoryResult = await pool.query('SELECT id, name FROM asset_category');
  const categoryMap = {};
  categoryResult.rows.forEach(row => { categoryMap[row.name] = row.id; });

  const equipmentCategoryId = categoryMap['Equipment'];

  // Only touch assets currently sitting on the "Equipment" placeholder AND in Disposed/Lost status
  // (this scopes the fix to exactly the assets our historical import created)
  const result = await pool.query(
    `SELECT id, asset_code, description FROM asset
     WHERE asset_category_id = $1 AND status IN ('Disposed', 'Lost')`,
    [equipmentCategoryId]
  );

  console.log(`Found ${result.rows.length} assets to review...`);

  let updated = 0, unchanged = 0;
  for (const asset of result.rows) {
    const desc = (asset.description || '').toLowerCase();
    let matchedCategory = null;

    for (const rule of keywordRules) {
      if (rule.keywords.some(kw => desc.includes(kw))) {
        matchedCategory = rule.category;
        break;
      }
    }

    if (matchedCategory && categoryMap[matchedCategory]) {
      await pool.query('UPDATE asset SET asset_category_id = $1 WHERE id = $2', [categoryMap[matchedCategory], asset.id]);
      console.log(`  ${asset.asset_code}: "${asset.description}" → ${matchedCategory}`);
      updated++;
    } else {
      unchanged++;
    }
  }

  console.log(`\nDone. ${updated} recategorized, ${unchanged} left as Equipment (no keyword match).`);
  await pool.end();
}

run().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});