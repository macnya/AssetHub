    -- NULLIF, because RESET leaves a custom setting as an empty string rather
    -- than removing it, and ''::int throws. Through a pooler a connection that
    -- served an earlier request arrives in exactly that state. Without this
    -- the policy fails with a type error instead of quietly returning nothing.
-- Phase 1, part two: make the separation real.
-- 010 gave every row an owner. This makes the database enforce it.
--
-- WHY THE DATABASE AND NOT THE APPLICATION
-- The alternative is adding "AND org_id = $n" to 232 queries across seventeen
-- controllers. Miss one and it returns every organisation's rows, silently,
-- with no error and nothing in a log. With a policy in place, the same mistake
-- returns nothing at all: a visible bug instead of a breach.
--
-- BEFORE RUNNING THIS
-- Fix the unique constraints. A constraint that is unique across the whole
-- table stops the second organisation having an asset called EQP/001, and no
-- policy will help — see the queries at the foot of 010.
--
-- AFTER RUNNING THIS
-- Every query needs app.org_id set on its connection, or it sees nothing.
-- src/db/context.js does that once per request. Scripts under scripts/ do not
-- have it and will need updating one at a time.
--
--   psql "$DATABASE_URL" -f migrations/011_row_level_security.sql

BEGIN;

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

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- FORCE makes the policy apply to the table's owner as well. Without it,
    -- whichever role created the tables reads everything and the protection is
    -- only as good as the connection string in use that day.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON public.%I', t);

    -- USING filters what a query can see. WITH CHECK stops a write placing a
    -- row into another organisation. Both are needed: without WITH CHECK you
    -- could not read someone else's data but could still write into it.
    --
    -- The `true` argument to current_setting means "return NULL if unset"
    -- rather than raising. NULL compares as false, so a connection with no
    -- organisation context sees an empty database. Fail closed.
    EXECUTE format(
      'CREATE POLICY org_isolation ON public.%I '
      'USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::int) '
      'WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::int)', t);

    RAISE NOTICE 'isolation on %', t;

  END LOOP;
END $$;

-- The organisation table itself is deliberately NOT protected this way.
-- Sign-in has to look up an organisation by its code before it knows which
-- organisation the caller belongs to — the lookup necessarily comes first.
-- It holds no customer data: a code, a name, and display settings.
GRANT SELECT ON organisation TO app_user;
GRANT USAGE, SELECT ON SEQUENCE organisation_id_seq TO app_user;

COMMIT;

-- ---------------------------------------------------------------------------
-- Prove it, before trusting it
-- ---------------------------------------------------------------------------
--
-- Run these as app_user, not as postgres. The postgres role on Supabase has
-- BYPASSRLS, so every check below passes for it whether the policies work or
-- not — which is the single easiest way to convince yourself of something
-- untrue.
--
--   SET app.org_id = 1;
--   SELECT count(*) FROM asset;          -- the real number
--
--   SET app.org_id = 2;
--   SELECT count(*) FROM asset;          -- 0
--
--   RESET app.org_id;
--   SELECT count(*) FROM asset;          -- 0, and this is the important one
--
-- Then try to write across the boundary. It must fail:
--
--   SET app.org_id = 1;
--   INSERT INTO asset_category (name, org_id) VALUES ('x', 2);
--   -- ERROR: new row violates row-level security policy
--
-- If the third query returns rows instead of 0, the connection is not using
-- app_user. Check with:  SELECT current_user;
