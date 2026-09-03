-- Phase 1 of multi-tenancy: give every row an owner.
--
-- WHAT THIS DOES
-- Creates the organisation table, makes the existing data organisation 1, and
-- adds org_id to all sixteen tenant tables.
--
-- WHAT IT DOES NOT DO
-- Nothing is isolated yet. Isolation is 011_row_level_security.sql, which is a
-- separate file so that this one can be run, checked, and lived with for a day
-- before anything starts refusing queries.
--
-- SAFE TO RUN TWICE. Every statement checks first.
--
--   psql "$DATABASE_URL" -f migrations/010_organisations.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- The organisation itself
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organisation (
  id                SERIAL PRIMARY KEY,

  -- What somebody types next to their email at sign-in. Lowercase and
  -- unique; the login form folds case before looking it up.
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,

  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('trial', 'active', 'suspended', 'closed')),

  -- Everything below is an assumption the single-tenant system made in code.
  -- A register in Nairobi and one in Kampala disagree about all of it.
  currency_code     TEXT NOT NULL DEFAULT 'KES',
  locale            TEXT NOT NULL DEFAULT 'en-KE',
  timezone          TEXT NOT NULL DEFAULT 'Africa/Nairobi',

  logo_url          TEXT,
  primary_colour    TEXT NOT NULL DEFAULT '#0D7C74',

  -- The condition vocabulary was a frozen array in
  -- src/constants/assetConditions.js. Its own comment records what happens
  -- when two parts of the system disagree about it: the mobile picker offered
  -- "Fair", verification did not accept it, and assets ended up in a state
  -- nothing could overwrite. Per-organisation now, so it must be read from
  -- here and never hardcoded again.
  asset_conditions  TEXT[] NOT NULL DEFAULT ARRAY['Good', 'Good with issues', 'Faulty'],

  -- Custody and clearance messages cite "HR Manual 9.3a" and "8.10.1". Those
  -- numbers belong to one organisation's policy document.
  policy_labels     JSONB NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE organisation IS
  'One row per customer. Everything else in this schema belongs to exactly one of these.';

-- The existing register becomes organisation 1. Explicit id, because every
-- backfill below depends on it being 1.
INSERT INTO organisation (id, code, name, status)
VALUES (1, 'visionfund', 'VisionFund Kenya', 'active')
ON CONFLICT (id) DO NOTHING;

-- SERIAL started at 1, so the next insert would collide with the row above.
SELECT setval('organisation_id_seq', GREATEST((SELECT MAX(id) FROM organisation), 1));

-- ---------------------------------------------------------------------------
-- org_id on every tenant table
-- ---------------------------------------------------------------------------
--
-- Written as a loop rather than sixteen copies, so a table cannot be missed by
-- a slip of the eye — and so the list itself is readable as the answer to
-- "which tables hold customer data?".
--
-- The DEFAULT is what keeps the application code unchanged: 232 INSERT
-- statements across seventeen controllers never name org_id, and with this
-- default they do not have to.
--
-- current_setting(..., true) returns NULL rather than raising when the setting
-- is absent. Combined with NOT NULL that means an INSERT with no organisation
-- context fails loudly instead of quietly writing to the wrong tenant.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'asset', 'asset_category', 'asset_verification', 'assignment',
    'bot_query_log', 'custody_request', 'disposal_record', 'employee',
    'exit_clearance', 'exit_clearance_item', 'import_batch', 'it_staff',
    'knowledge_base', 'location', 'lost_asset_record', 'scan_log'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'org_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN org_id INT', t);
      EXECUTE format('UPDATE public.%I SET org_id = 1 WHERE org_id IS NULL', t);
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN org_id SET NOT NULL', t);
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN org_id '
        'SET DEFAULT current_setting(''app.org_id'', true)::int', t);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I '
        'FOREIGN KEY (org_id) REFERENCES organisation(id)', t, t || '_org_fk');
      EXECUTE format('CREATE INDEX %I ON public.%I (org_id)', 'idx_' || t || '_org', t);
      RAISE NOTICE 'org_id added to %', t;
    ELSE
      RAISE NOTICE 'org_id already on %, left alone', t;
    END IF;

  END LOOP;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- What to check before going further
-- ---------------------------------------------------------------------------
--
-- Sixteen rows, every count equal to the table's total:
--
--   SELECT c.relname AS table_name, a.attnotnull AS org_id_not_null
--   FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
--   WHERE a.attname = 'org_id' AND c.relkind = 'r'
--   ORDER BY 1;
--
-- Then the unique constraints, which 011 cannot decide for you. Anything
-- unique across the whole table has to become unique per organisation, or the
-- second customer cannot have an asset called EQP/001:
--
--   SELECT conrelid::regclass AS table_name, conname,
--          pg_get_constraintdef(oid) AS definition
--   FROM pg_constraint
--   WHERE contype = 'u' AND connamespace = 'public'::regnamespace
--   ORDER BY 1;
--
--   SELECT tablename, indexname, indexdef
--   FROM pg_indexes
--   WHERE schemaname = 'public' AND indexdef LIKE '%UNIQUE%'
--   ORDER BY 1;
--
-- Read both lists. Every one that does not already start with org_id is a
-- collision waiting for the second tenant.
