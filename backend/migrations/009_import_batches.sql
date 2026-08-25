-- A record of every bulk import.
--
-- WHY THIS EXISTS
-- Every data problem in this register came from an import that reported success
-- while doing something unexpected: 168 assets sharing the code "N/A", engine
-- numbers in the condition column, and every price silently empty because a
-- column heading carried a leading space.
--
-- None of those were noticed at the time, because nothing recorded what an
-- import had actually done. This does: who uploaded what, when, in which mode,
-- and exactly how many rows were added, changed and skipped.
--
-- It also makes an import reversible in principle — you can see what a batch
-- touched — which is the difference between a mistake and a disaster.

CREATE TABLE IF NOT EXISTS import_batch (
  id                SERIAL PRIMARY KEY,

  filename          TEXT NOT NULL,
  sheet_names       TEXT[],

  -- 'add'    — only rows whose asset code is not already present
  -- 'upsert' — new rows added, existing rows updated where the sheet differs
  -- 'preview'— parsed and reported, nothing written
  mode              TEXT NOT NULL,

  rows_read         INTEGER NOT NULL DEFAULT 0,
  rows_added        INTEGER NOT NULL DEFAULT 0,
  rows_updated      INTEGER NOT NULL DEFAULT 0,
  rows_unchanged    INTEGER NOT NULL DEFAULT 0,
  rows_rejected     INTEGER NOT NULL DEFAULT 0,

  -- What could not be read and why, kept so somebody can fix the spreadsheet
  -- rather than guess. Capped in the application to a sensible number of rows.
  rejections        JSONB,

  -- Which asset codes this batch created, so its effect can be traced — and,
  -- if it went wrong, undone.
  created_codes     TEXT[],

  imported_by       INTEGER REFERENCES it_staff(id),
  imported_at       TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT import_mode_valid CHECK (mode IN ('add', 'upsert', 'preview'))
);

CREATE INDEX IF NOT EXISTS idx_import_batch_at ON import_batch (imported_at DESC);

-- Which import an asset came from. Null for everything that predates this.
ALTER TABLE asset ADD COLUMN IF NOT EXISTS import_batch_id INTEGER REFERENCES import_batch(id);

CREATE INDEX IF NOT EXISTS idx_asset_import_batch
  ON asset (import_batch_id) WHERE import_batch_id IS NOT NULL;

-- Supabase enables RLS on new tables by default, and an empty policy set denies
-- everything silently — which has caught this project twice.
ALTER TABLE import_batch DISABLE ROW LEVEL SECURITY;