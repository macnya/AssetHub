-- Custody changes wait for approval.
--
-- WHY A SEPARATE TABLE RATHER THAN A FLAG ON assignment
-- An earlier attempt put approval_status on assignment itself. That was wrong:
-- every query in the system finds current custody with `returned_date IS NULL`,
-- and a pending row has no return date — so an unapproved assignment would
-- immediately show as the live custody on the dashboard, the asset list, the
-- scanner and the assistant. Correcting that meant adding a filter to roughly
-- twenty queries, and missing one would present an unapproved claim as fact.
--
-- Here nothing enters the register until it is approved. Not one existing query
-- changes, and a pending request is visibly a request rather than a quiet
-- alteration of the record.

DROP TABLE IF EXISTS custody_request;

CREATE TABLE custody_request (
  id                  SERIAL PRIMARY KEY,
  asset_id            INTEGER NOT NULL REFERENCES asset(id),

  -- 'assign' moves an asset to a person or place; 'return' sends it back to
  -- storage. Both are custody changes and both need the same approval.
  kind                TEXT NOT NULL,

  -- Where it is going. Null on a return.
  to_employee_id      INTEGER REFERENCES employee(id),
  to_location_id      INTEGER REFERENCES location(id),

  -- Where it was when the request was made, kept so the approver can see the
  -- move without reconstructing it, and so the record stands even if custody
  -- changes again before approval.
  from_employee_id    INTEGER REFERENCES employee(id),
  from_location_id    INTEGER REFERENCES location(id),

  -- HR 9.3b makes an employee liable for damage through negligence to property
  -- entrusted to them. Without the condition at the moment of handover nobody
  -- can show whether damage happened on their watch — which protects the
  -- employee as much as the organisation.
  condition_at_handover TEXT,
  notes               TEXT,

  -- The requesting officer's position, captured where they stood. Approval
  -- never overwrites it.
  latitude            NUMERIC(10,7),
  longitude           NUMERIC(10,7),

  status              TEXT NOT NULL DEFAULT 'pending',
  requested_by        INTEGER NOT NULL REFERENCES it_staff(id),
  requested_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  reviewed_by         INTEGER REFERENCES it_staff(id),
  reviewed_at         TIMESTAMP,
  rejection_reason    TEXT,

  -- What the request produced once approved, so the two can be traced to each
  -- other afterwards.
  assignment_id       INTEGER REFERENCES assignment(id),
  verification_id     INTEGER REFERENCES asset_verification(id),

  CONSTRAINT custody_kind_valid   CHECK (kind IN ('assign', 'return')),
  CONSTRAINT custody_status_valid CHECK (status IN ('pending', 'approved', 'rejected')),

  -- Four eyes, enforced by the database rather than only by the endpoint.
  CONSTRAINT custody_not_self_approved
    CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by),

  -- An assignment must name a destination; a return must not.
  CONSTRAINT custody_destination_matches_kind CHECK (
    (kind = 'assign' AND (to_employee_id IS NOT NULL OR to_location_id IS NOT NULL))
    OR (kind = 'return' AND to_employee_id IS NULL AND to_location_id IS NULL)
  )
);

CREATE INDEX idx_custody_request_pending
  ON custody_request (status) WHERE status = 'pending';

CREATE INDEX idx_custody_request_asset ON custody_request (asset_id);

-- One request at a time per asset. Two people requesting different destinations
-- for the same laptop, both approved, is a race nobody would notice until the
-- laptop was in the wrong place.
CREATE UNIQUE INDEX idx_one_open_request_per_asset
  ON custody_request (asset_id) WHERE status = 'pending';

-- Supabase enables RLS on new tables by default, and an empty policy set denies
-- everything silently — which has caught this project twice.
ALTER TABLE custody_request DISABLE ROW LEVEL SECURITY;