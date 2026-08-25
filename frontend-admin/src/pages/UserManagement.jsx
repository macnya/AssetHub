import { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchUsers, updateUserRole, deleteUser, resetUserPassword, fetchAssetFilters } from '../api';
import { ALL_ROLES, ROLE_NOTE, ROLES, canonicalRole } from '../roles';

export default function UserManagement({ currentUserId, onCreateNew }) {
  const [users, setUsers] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);   // { kind, text }
  const [filters, setFilters] = useState({ q: '', role: '', branch: '' });

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await fetchUsers());
    } catch (err) {
      console.error(err);
      setNotice({ kind: 'error', text: 'Could not load staff accounts.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadUsers();
    fetchAssetFilters().then((o) => setBranches(o.branches || [])).catch(() => {});
  }, [loadUsers]);

  // Counts come from the unfiltered list, so the number beside each role stays
  // put while you click between them.
  const roleCounts = useMemo(() => {
    const counts = {};
    users.forEach((u) => {
      const r = canonicalRole(u.role);
      counts[r] = (counts[r] || 0) + 1;
    });
    return counts;
  }, [users]);

  const scopedCount = useMemo(
    () => users.filter((u) => canonicalRole(u.role) === ROLES.BRANCH_ADMIN).length,
    [users]
  );

  // Filtering happens here rather than server-side: the staff list is a few
  // dozen rows, so a round trip per keystroke would cost more than it saves.
  const visible = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return users.filter((u) => {
      const role = canonicalRole(u.role);
      const scoped = role === ROLES.BRANCH_ADMIN;

      if (filters.role && role !== filters.role) return false;

      if (filters.branch === '__unscoped') {
        if (scoped) return false;
      } else if (filters.branch === '__none') {
        if (!(scoped && !u.branch)) return false;
      } else if (filters.branch && u.branch !== filters.branch) {
        return false;
      }

      if (q && !`${u.name} ${u.email}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [users, filters]);

  const activeFilters = Object.values(filters).filter(Boolean).length;

  // Role and branch are saved together. Promoting someone to Branch
  // Administrator without a branch would leave them able to sign in and see
  // nothing, so the backend refuses it and this asks for one first.
  const handleRoleChange = async (user, newRole) => {
    setNotice(null);

    let branch = user.branch || null;
    if (newRole === ROLES.BRANCH_ADMIN) {
      const chosen = prompt(
        `Which branch is ${user.name} responsible for?\n\n` +
        `Type it exactly as it appears below:\n\n${branches.join('\n')}`,
        branch || ''
      );
      if (chosen === null) return;                       // cancelled
      branch = chosen.trim();
      if (!branches.includes(branch)) {
        setNotice({
          kind: 'error',
          text: `"${branch}" is not a branch in the register. A Branch Administrator's view is an exact match, so it has to be one of the listed names.`,
        });
        return;
      }
    }

    try {
      await updateUserRole(user.id, newRole, branch);
      setNotice({
        kind: 'ok',
        text: newRole === ROLES.BRANCH_ADMIN
          ? `${user.name} now administers ${branch} only.`
          : `${user.name} is now ${newRole}.`,
      });
      loadUsers();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'Failed to update role.' });
    }
  };

  const handleReset = async (id, name) => {
    const temp = prompt(
      `Temporary password for ${name} (at least 8 characters).\n\n` +
      `They will be asked to choose their own the next time they sign in, and ` +
      `this will end any session they currently have open.`
    );
    if (temp === null) return;
    if (temp.trim().length < 8) {
      setNotice({ kind: 'error', text: 'That password is too short — 8 characters minimum.' });
      return;
    }

    setNotice(null);
    try {
      await resetUserPassword(id, temp.trim());
      setNotice({
        kind: 'ok',
        text: `Temporary password set for ${name}. Give it to them directly, not over a group chat.`,
      });
      loadUsers();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'Failed to reset this password.' });
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Delete the account for ${name}? This cannot be undone.`)) return;
    setNotice(null);
    try {
      await deleteUser(id);
      setNotice({ kind: 'ok', text: `${name}'s account was deleted.` });
      loadUsers();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'Failed to delete this account.' });
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Staff accounts</h1>
          <p className="page-sub">
            {loading
              ? 'Loading…'
              : activeFilters > 0
                ? `${visible.length} of ${users.length} accounts`
                : `${users.length} account${users.length === 1 ? '' : 's'} with access to the register`}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={onCreateNew}>New staff account</button>
        </div>
      </div>

      {notice && (
        <div className={notice.kind === 'ok' ? 'notice notice-ok' : 'notice notice-error'}>{notice.text}</div>
      )}

      <div className="filters" style={{ marginBottom: '1.25rem' }}>
        <input
          type="search"
          placeholder="Search name or email…"
          value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          style={{ width: 'auto', minWidth: '14rem' }}
        />

        {/* Counts sit in the option labels so you can see the shape of the
            team without clicking through each role in turn. */}
        <select
          value={filters.role}
          onChange={(e) => setFilters((f) => ({ ...f, role: e.target.value }))}
        >
          <option value="">All roles ({users.length})</option>
          {ALL_ROLES.map((r) => (
            <option key={r} value={r}>{r} ({roleCounts[r] || 0})</option>
          ))}
        </select>

        <select
          value={filters.branch}
          onChange={(e) => setFilters((f) => ({ ...f, branch: e.target.value }))}
        >
          <option value="">Sees anywhere</option>
          <option value="__unscoped">All branches ({users.length - scopedCount})</option>
          <option value="__none">No branch set</option>
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        {activeFilters > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setFilters({ q: '', role: '', branch: '' })}
          >
            Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {loading ? (
        <p className="empty">Loading staff accounts…</p>
      ) : visible.length === 0 ? (
        <div className="card">
          <p className="empty">
            {users.length === 0 ? 'No staff accounts yet.' : 'No accounts match these filters.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Sees</th>
                <th>Password</th>
                <th aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((u) => {
                const isSelf = u.id === currentUserId;
                const role = canonicalRole(u.role);
                const scoped = role === ROLES.BRANCH_ADMIN;
                return (
                  <tr key={u.id}>
                    <td data-label="Name">
                      {u.name}
                      {isSelf && <span className="badge badge-neutral" style={{ marginLeft: '0.5rem' }}>you</span>}
                    </td>
                    <td data-label="Email">{u.email}</td>

                    <td data-label="Role">
                      <select
                        value={ALL_ROLES.includes(role) ? role : ROLES.OFFICER}
                        onChange={(e) => handleRoleChange(u, e.target.value)}
                        title={ROLE_NOTE[role]}
                      >
                        {ALL_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>

                    {/* Which slice of the register this account can see. A
                        scoped account with no branch sees nothing, so that
                        state is called out rather than left blank. */}
                    <td data-label="Sees">
                      {!scoped ? (
                        <span className="cell-sub">All branches</span>
                      ) : u.branch ? (
                        <span className="badge badge-deep">{u.branch}</span>
                      ) : (
                        <span className="badge badge-bad">No branch set</span>
                      )}
                    </td>

                    <td data-label="Password">
                      {u.must_change_password ? (
                        <span className="badge badge-warn">Temporary</span>
                      ) : u.password_changed_at ? (
                        <span className="cell-sub">
                          set {new Date(u.password_changed_at).toLocaleDateString()}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>

                    <td data-label="">
                      <div className="page-actions">
                        <button className="btn btn-secondary btn-sm" onClick={() => handleReset(u.id, u.name)}>
                          Reset password
                        </button>
                        {/* Deleting your own account would lock you out mid-session. */}
                        {!isSelf && (
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(u.id, u.name)}>
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
