import * as SQLite from 'expo-sqlite';

const db = SQLite.openDatabaseSync('assethub_offline.db');

// ---- Schema ----
db.execSync(`
  CREATE TABLE IF NOT EXISTS asset_cache (
    asset_code TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS employee_cache (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS location_cache (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_action (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    asset_code TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  );
`);

// Migration for devices that already have the table from an earlier install.
// SQLite has no "ADD COLUMN IF NOT EXISTS", and re-running it throws, so the
// throw is the success signal on second run.
try {
  db.execSync(`ALTER TABLE pending_action ADD COLUMN last_error TEXT`);
} catch {
  // Column already present.
}
try {
  db.execSync(`ALTER TABLE pending_action ADD COLUMN failed_at TEXT`);
} catch {
  // Column already present.
}

// ---- Asset cache (keyed by scanned/searched asset_code) ----
export function cacheAsset(assetCode, data) {
  db.runSync(
    `INSERT OR REPLACE INTO asset_cache (asset_code, data, cached_at) VALUES (?, ?, ?)`,
    [assetCode, JSON.stringify(data), new Date().toISOString()]
  );
}

export function getCachedAsset(assetCode) {
  const row = db.getFirstSync(`SELECT data FROM asset_cache WHERE asset_code = ?`, [assetCode]);
  return row ? JSON.parse(row.data) : null;
}

// ---- Employees / locations cache (used to populate Assign modal offline) ----
export function cacheEmployees(list) {
  db.runSync(`DELETE FROM employee_cache`);
  for (const e of list) {
    db.runSync(`INSERT INTO employee_cache (id, data) VALUES (?, ?)`, [e.id, JSON.stringify(e)]);
  }
}

export function getCachedEmployees() {
  const rows = db.getAllSync(`SELECT data FROM employee_cache`);
  return rows.map((r) => JSON.parse(r.data));
}

export function cacheLocations(list) {
  db.runSync(`DELETE FROM location_cache`);
  for (const l of list) {
    db.runSync(`INSERT INTO location_cache (id, data) VALUES (?, ?)`, [l.id, JSON.stringify(l)]);
  }
}

export function getCachedLocations() {
  const rows = db.getAllSync(`SELECT data FROM location_cache`);
  return rows.map((r) => JSON.parse(r.data));
}

// ---- Pending action queue ----
export function queueAction(type, assetCode, payload) {
  db.runSync(
    `INSERT INTO pending_action (type, asset_code, payload, created_at, status) VALUES (?, ?, ?, ?, 'pending')`,
    [type, assetCode || null, JSON.stringify(payload), new Date().toISOString()]
  );
}

export function getPendingActions() {
  const rows = db.getAllSync(`SELECT * FROM pending_action WHERE status = 'pending' ORDER BY id ASC`);
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function getPendingCountForAsset(assetCode) {
  const row = db.getFirstSync(
    `SELECT COUNT(*) as count FROM pending_action WHERE status = 'pending' AND asset_code = ?`,
    [assetCode]
  );
  return row ? row.count : 0;
}

export function getTotalPendingCount() {
  const row = db.getFirstSync(`SELECT COUNT(*) as count FROM pending_action WHERE status = 'pending'`);
  return row ? row.count : 0;
}

export function markActionSynced(id) {
  db.runSync(`DELETE FROM pending_action WHERE id = ?`, [id]);
}

// A failed action is one the server actively rejected (bad data, missing
// asset, duplicate). It is kept — not deleted — so the officer can see what
// didn't make it and decide what to do, rather than silently losing the work.
export function markActionFailed(id, reason) {
  db.runSync(
    `UPDATE pending_action SET status = 'failed', last_error = ?, failed_at = ? WHERE id = ?`,
    [reason || 'Rejected by the server', new Date().toISOString(), id]
  );
}

export function getFailedActions() {
  const rows = db.getAllSync(`SELECT * FROM pending_action WHERE status = 'failed' ORDER BY id ASC`);
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function getTotalFailedCount() {
  const row = db.getFirstSync(`SELECT COUNT(*) as count FROM pending_action WHERE status = 'failed'`);
  return row ? row.count : 0;
}

// Puts failed actions back in the queue for another attempt.
export function retryFailedActions() {
  const result = db.runSync(
    `UPDATE pending_action SET status = 'pending', last_error = NULL, failed_at = NULL WHERE status = 'failed'`
  );
  return result.changes ?? 0;
}

export function discardFailedAction(id) {
  db.runSync(`DELETE FROM pending_action WHERE id = ? AND status = 'failed'`, [id]);
}

export function discardAllFailedActions() {
  const result = db.runSync(`DELETE FROM pending_action WHERE status = 'failed'`);
  return result.changes ?? 0;
}

export default db;