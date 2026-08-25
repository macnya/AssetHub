-- Maker-checker approval for verifications and branch-created assets.
--
-- Existing rows default to 'approved'. They are historical records made before
-- the control existed; marking them pending would create a backlog of hundreds
-- of items nobody can meaningfully review.

-- ---------------------------------------------------------------- verifications
ALTER TABLE asset_verification
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES it_staff(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Four eyes, enforced by the database and not only by the endpoint. An
-- approval route can be changed by accident; a constraint cannot.
ALTER TABLE asset_verification
  DROP CONSTRAINT IF EXISTS verification_not_self_approved;
ALTER TABLE asset_verification
  ADD CONSTRAINT verification_not_self_approved
  CHECK (approved_by IS NULL OR approved_by <> verified_by);

ALTER TABLE asset_verification
  DROP CONSTRAINT IF EXISTS verification_status_valid;
ALTER TABLE asset_verification
  ADD CONSTRAINT verification_status_valid
  CHECK (status IN ('pending', 'approved', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_verification_pending
  ON asset_verification (status) WHERE status = 'pending';

-- ---------------------------------------------------------------------- assets
-- A branch administrator can now add an asset that arrives at their branch,
-- but it stays out of the register until an admin approves it.
ALTER TABLE asset
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES it_staff(id),
  ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES it_staff(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

ALTER TABLE asset
  DROP CONSTRAINT IF EXISTS asset_not_self_approved;
ALTER TABLE asset
  ADD CONSTRAINT asset_not_self_approved
  CHECK (approved_by IS NULL OR created_by IS NULL OR approved_by <> created_by);

ALTER TABLE asset
  DROP CONSTRAINT IF EXISTS asset_approval_status_valid;
ALTER TABLE asset
  ADD CONSTRAINT asset_approval_status_valid
  CHECK (approval_status IN ('pending', 'approved', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_asset_pending
  ON asset (approval_status) WHERE approval_status = 'pending';