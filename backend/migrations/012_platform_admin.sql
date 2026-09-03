-- The operator's view: which organisations exist, how big they are, and
-- nothing else.
--
-- THE DESIGN CONSTRAINT
-- A platform admin must be able to see that an organisation has 2,311 assets
-- without being able to see one of them. Row-level security already stops
-- app_user reading across organisations, and that must stay true — so the
-- counts come from functions that run with the definer's rights and whose
-- RETURN TYPE contains only numbers and dates.
--
-- That is the safety property worth having. Not "we remembered not to select
-- the data", but "there is no argument that could make it return a row".

BEGIN;
-- CREATE OR REPLACE cannot change a function's return type, so an earlier
-- version with different columns blocks the new one and takes the whole
-- migration down with it. Dropping first makes this file safe to re-run,
-- which matters because it will be — on the next database, and the one after.
DROP FUNCTION IF EXISTS organisation_overview();
DROP FUNCTION IF EXISTS asset_status_drift(INT);
DROP FUNCTION IF EXISTS asset_status_reconcile(INT);
-- ---------------------------------------------------------------------------
-- Who the operator is
-- ---------------------------------------------------------------------------
--
-- Deliberately not a role on it_staff. An it_staff row belongs to exactly one
-- organisation; a platform admin belongs to none. Adding "and can also see
-- everything" to a tenant role is how a support tool becomes a back door, and
-- it makes "was I acting as a customer or as the operator?" unanswerable.
CREATE TABLE IF NOT EXISTS platform_admin (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMP
);

-- Supabase enables RLS on every new table through an event trigger. This one
-- holds no tenant data and is only ever read by the platform login, which runs
-- before any organisation is known.
ALTER TABLE platform_admin ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_admin_readable ON platform_admin;
CREATE POLICY platform_admin_readable ON platform_admin FOR SELECT USING (true);
GRANT SELECT ON platform_admin TO app_user;
GRANT UPDATE (last_seen_at) ON platform_admin TO app_user;

-- ---------------------------------------------------------------------------
-- What the operator can see
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION organisation_overview()
RETURNS TABLE (
  id            INT,
  code          TEXT,
  name          TEXT,
  status        TEXT,
  created_at    TIMESTAMP,
  staff         BIGINT,
  assets        BIGINT,
  employees     BIGINT,
  locations     BIGINT,
  last_activity TIMESTAMP
)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Without a fixed search_path a SECURITY DEFINER function can be pointed at
-- tables of the caller's choosing.
SET search_path = public
AS $$
  SELECT o.id, o.code, o.name, o.status, o.created_at,
         (SELECT count(*) FROM it_staff s WHERE s.org_id = o.id),
         (SELECT count(*) FROM asset    a WHERE a.org_id = o.id),
         (SELECT count(*) FROM employee e WHERE e.org_id = o.id),
         (SELECT count(*) FROM location l WHERE l.org_id = o.id),
         (SELECT max(sl.timestamp) FROM scan_log sl WHERE sl.org_id = o.id)
  FROM organisation o
  ORDER BY o.id;
$$;

REVOKE ALL ON FUNCTION organisation_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION organisation_overview() TO app_user;

-- ---------------------------------------------------------------------------
-- Recomputing what has drifted
-- ---------------------------------------------------------------------------
--
-- asset.status is derived: an asset is Disposed if there is a disposal record,
-- Lost if there is a loss report, Assigned if somebody currently holds it, and
-- In Stock otherwise. Nothing enforces that. The status column is written by
-- whichever code path last touched the asset, and a path that fails halfway,
-- or a row edited directly, leaves it saying something the records disagree
-- with.
--
-- The dashboard counts are computed live from status, so a drifted status is a
-- wrong number on a screen with no clue as to why.
--
-- This works out what each asset's status should be and reports the
-- disagreements. Returns counts only, so an operator sees that 14 assets are
-- wrong without seeing which — the same constraint as the overview.
CREATE OR REPLACE FUNCTION asset_status_drift(p_org_id INT)
RETURNS TABLE (
  recorded TEXT,
  derived  TEXT,
  n        BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH derived AS (
    SELECT a.id,
           a.status AS recorded,
           CASE
             WHEN EXISTS (SELECT 1 FROM disposal_record d WHERE d.asset_id = a.id)
               THEN 'Disposed'
             WHEN EXISTS (SELECT 1 FROM lost_asset_record r WHERE r.asset_id = a.id)
               THEN 'Lost'
             WHEN EXISTS (SELECT 1 FROM assignment ag
                          WHERE ag.asset_id = a.id
                            AND ag.returned_date IS NULL
                            AND ag.employee_id IS NOT NULL)
               THEN 'Assigned'
             ELSE 'In Stock'
           END AS derived
    FROM asset a
    WHERE a.org_id = p_org_id
  )
  SELECT recorded, derived, count(*)
  FROM derived
  WHERE recorded IS DISTINCT FROM derived
  GROUP BY recorded, derived
  ORDER BY count(*) DESC;
$$;

REVOKE ALL ON FUNCTION asset_status_drift(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION asset_status_drift(INT) TO app_user;

-- The same calculation, written down. Separate from the read above so that
-- looking is never accidentally the same action as changing: an operator has
-- to see the drift and then decide.
CREATE OR REPLACE FUNCTION asset_status_reconcile(p_org_id INT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed BIGINT;
BEGIN
  WITH derived AS (
    SELECT a.id,
           CASE
             WHEN EXISTS (SELECT 1 FROM disposal_record d WHERE d.asset_id = a.id)
               THEN 'Disposed'
             WHEN EXISTS (SELECT 1 FROM lost_asset_record r WHERE r.asset_id = a.id)
               THEN 'Lost'
             WHEN EXISTS (SELECT 1 FROM assignment ag
                          WHERE ag.asset_id = a.id
                            AND ag.returned_date IS NULL
                            AND ag.employee_id IS NOT NULL)
               THEN 'Assigned'
             ELSE 'In Stock'
           END AS should_be
    FROM asset a
    WHERE a.org_id = p_org_id
  )
  UPDATE asset a
  SET status = d.should_be
  FROM derived d
  WHERE a.id = d.id AND a.status IS DISTINCT FROM d.should_be;

  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION asset_status_reconcile(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION asset_status_reconcile(INT) TO app_user;

COMMIT;
