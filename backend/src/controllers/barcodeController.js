const bwipjs = require('bwip-js');
const { db } = require('../db/context');

async function getAssetBarcode(req, res) {
  const { asset_code } = req.params;

  try {
    const result = await db.query('SELECT id FROM asset WHERE asset_code = $1', [asset_code]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const png = await bwipjs.toBuffer({
  bcid: 'code128',
  text: asset_code,
  scale: 3,
  height: 10,
  includetext: true,
  textxalign: 'center',
  backgroundcolor: 'FFFFFF',  // white background, no transparency
  paddingwidth: 10,
  paddingheight: 10,
});

    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate barcode' });
  }
}

module.exports = { getAssetBarcode };