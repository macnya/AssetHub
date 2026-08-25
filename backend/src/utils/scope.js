const { ROLES, isAdminRole } = require('../middleware/authMiddleware');

// A Branch Administrator sees only their own branch. Everyone else sees
// everything, so this returns null and callers add no clause.
//
// An asset's branch is not a column on `asset` — it comes from the location of
// its current open assignment. So an asset sitting in stock with no assignment
// has no branch, and is therefore invisible to a Branch Administrator. That is
// the honest reading of "assets at my branch", but it does mean unassigned
// stock is only visible to IT Admin and IT Officer.
function branchScopeFor(req) {
  if (!req.user) return null;
  if (isAdminRole(req.user.role)) return null;
  if (req.user.role !== ROLES.BRANCH_ADMIN) return null;

  // A Branch Administrator with no branch set sees nothing rather than
  // everything. Failing closed is the right default for a scoped role.
  return req.user.branch || '\u0000none';
}

module.exports = { branchScopeFor };