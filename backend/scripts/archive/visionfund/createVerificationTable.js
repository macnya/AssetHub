// Run once: node scripts/createVerificationTable.js
require('dotenv').config();
const pool = require('../src/db/pool');

async function run() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS asset_verification (
        id SERIAL PRIMARY KEY,
        asset_id INTEGER NOT NULL REFERENCES asset(id),
        verified_by INTEGER NOT NULL REFERENCES it_staff(id),
        condition VARCHAR(30) NOT NULL CHECK (condition IN ('Good', 'Good with issues', 'Faulty')),
        remarks TEXT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        verified_at TIMESTAMP NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_asset_verification_asset_id ON asset_verification(asset_id);
    `);
    console.log('asset_verification table ready.');
  } catch (err) {
    console.error('Failed to create table:', err);
  } finally {
    await pool.end();
  }
}

run();