// One place where role names live, so a rename is one edit rather than a hunt
// through thirteen pages.
//
// This file and backend/src/middleware/authMiddleware.js must agree. They were
// briefly inverted here — ADMIN held the old name 'IT Admin' while 'Admin' sat
// in the legacy map — which worked only because the mapping caught it, and
// meant the panel canonicalised a correct account to a name the backend
// treats as legacy.
//
// Names have changed twice. "Branch Manager" became "Branch Administrator",
// since the role administers one branch's assets as opposed to an Admin who
// administers the whole register. "IT Officer" became "Administration
// Officer": the people scanning are Head Office administration staff, and
// there is no longer an IT Officer role at all.

export const ROLES = {
  ADMIN: 'Admin',
  OFFICER: 'Administration Officer',
  BRANCH_ADMIN: 'Branch Administrator',
  AUDITOR: 'Auditor',
  // Read-only like an Auditor, but the financial fields are the point: value,
  // depreciation, disposals, and what a leaver owes.
  FINANCE: 'Finance',
};

// Accounts predating a rename still carry the old value. Both are accepted so
// nobody is locked out between the deploy and the data being updated — and so
// an existing token keeps working until it expires.
const LEGACY = {
  'IT Admin': ROLES.ADMIN,
  'IT Officer': ROLES.OFFICER,
  'Branch Manager': ROLES.BRANCH_ADMIN,
};

export const canonicalRole = (role) => LEGACY[role] || role;

// Order shown in the role dropdown: broadest authority first, read-only last.
// Order shown in the role dropdown: broadest authority first, read-only last.
export const ALL_ROLES = [
  ROLES.ADMIN,
  ROLES.OFFICER,
  ROLES.BRANCH_ADMIN,
  ROLES.FINANCE,
  ROLES.AUDITOR,
];

export const ROLE_NOTE = {
  [ROLES.ADMIN]:
    'Everything, across all branches. Edits the register, manages staff accounts, approves changes, disposes and writes off assets.',
  [ROLES.OFFICER]:
    'Head Office custodian. Scans, assigns and verifies in the field at any branch. Cannot approve their own work.',
  [ROLES.BRANCH_ADMIN]:
    'Manages their own branch only. Verifies and registers equipment there, subject to approval by an administrator.',
  [ROLES.FINANCE]:
    'Read-only. Sees value, depreciation, disposals, custody and what leavers owe — for reporting, not for changing.',
  [ROLES.AUDITOR]:
    'Read-only, across all branches.',
};

const is = (user, ...roles) => roles.includes(canonicalRole(user?.role));

export const isAdmin = (user) => is(user, ROLES.ADMIN);

export const isFinance = (user) => is(user, ROLES.FINANCE);

// Roles that see the register but change nothing in it.
export const isReadOnly = (user) => is(user, ROLES.AUDITOR, ROLES.FINANCE);

export const canCreateAssets = (user) =>
  is(user, ROLES.ADMIN, ROLES.OFFICER, ROLES.BRANCH_ADMIN);

export const canChangeAssets = (user) =>
  is(user, ROLES.ADMIN, ROLES.OFFICER, ROLES.BRANCH_ADMIN);

// Disposing or writing off is not a field action: it removes an asset from the
// register and Finance carries the consequence, so it stays with Admin. Note
// that Finance deliberately cannot do this — their role is to see the numbers,
// not to change what produces them.
export const canDispose = (user) => is(user, ROLES.ADMIN);

export const canManageRecords = (user) => is(user, ROLES.ADMIN, ROLES.OFFICER);

// Four eyes: approving is an Admin act, and the endpoints additionally refuse a
// self-approval regardless of role.
export const canApprove = (user) => is(user, ROLES.ADMIN);