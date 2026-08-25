-- Three changes: assignments need approval, a Finance role, and condition
-- recorded at handover.

-- ------------------------------------------------- assignments need approval
-- Custody moving is a change to the register, and the same reasoning applies as
-- to verifications: it should be confirmed by someone other than the person who
-- recorded it. HR Manual 9.3a already requires permission from the head of
-- department or branch manager before equipment moves — this is that permission,
-- recorded.
ALTER TABLE assignment
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS requested_by INTEGER REFERENCES it_staff(id),
  ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES it_staff(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

ALTER TABLE assignment DROP CONSTRAINT IF EXISTS assignment_approval_valid;
ALTER TABLE assignment ADD CONSTRAINT assignment_approval_valid
  CHECK (approval_status IN ('pending', 'approved', 'rejected'));

-- Four eyes, enforced by the database rather than only by the endpoint.
ALTER TABLE assignment DROP CONSTRAINT IF EXISTS assignment_not_self_approved;
ALTER TABLE assignment ADD CONSTRAINT assignment_not_self_approved
  CHECK (approved_by IS NULL OR requested_by IS NULL OR approved_by <> requested_by);

CREATE INDEX IF NOT EXISTS idx_assignment_pending
  ON assignment (approval_status) WHERE approval_status = 'pending';

-- A return to storage is also a custody change, so it carries the same fields.
ALTER TABLE assignment
  ADD COLUMN IF NOT EXISTS return_approval_status TEXT,
  ADD COLUMN IF NOT EXISTS return_requested_by INTEGER REFERENCES it_staff(id),
  ADD COLUMN IF NOT EXISTS return_approved_by INTEGER REFERENCES it_staff(id);

ALTER TABLE assignment DROP CONSTRAINT IF EXISTS assignment_return_approval_valid;
ALTER TABLE assignment ADD CONSTRAINT assignment_return_approval_valid
  CHECK (return_approval_status IS NULL
         OR return_approval_status IN ('pending', 'approved', 'rejected'));

-- --------------------------------------------- condition recorded at handover
-- HR 9.3b makes an employee liable for damage through negligence to property
-- entrusted to them. Without the condition at the moment of handover, nobody
-- can show whether damage happened on their watch — which is as much a
-- protection for the employee as for the organisation.
ALTER TABLE assignment
  ADD COLUMN IF NOT EXISTS condition_at_handover TEXT,
  ADD COLUMN IF NOT EXISTS verification_id INTEGER REFERENCES asset_verification(id);

-- ------------------------------------------------------------ finance access
-- Finance needs the register's numbers — value, depreciation, disposals, what
-- a leaver owes — without the ability to change custody or approve anything.
-- Read-only, but wider than an Auditor's remit in the financial fields it
-- surfaces.
--
-- The role is a plain string in it_staff.role, so nothing schema-side is
-- needed beyond documenting it here:
--
--   Admin                   everything
--   Administration Officer  field operations
--   Branch Administrator    own branch, subject to approval
--   Auditor                 read-only, all branches
--   Finance                 read-only, financial reporting        <- new
--
-- Existing accounts are untouched.

COMMENT ON COLUMN it_staff.role IS
  'Admin | Administration Officer | Branch Administrator | Auditor | Finance';