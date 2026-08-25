import { useState, useEffect, useCallback } from 'react';
import api, { updateVerification, fetchAssetFilters } from '../api';
import { isAdmin } from '../roles';

const CONDITION_BADGE = {
  'Good':             'badge-good',
  'Good with issues': 'badge-warn',
  'Faulty':           'badge-bad',
};

// Corrections are admin-only, matching the requireRole guard on
// PATCH /verifications/:id. Accounts created before the role rename still
// carry 'Admin', which the backend also accepts.
function currentUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}

export default function VerificationReport() {
  const [rows, setRows] = useState([]);
  const [options, setOptions] = useState({ branches: [], conditions: [] });

  const [branchInput, setBranchInput] = useState('');
  const [filters, setFilters] = useState({ branch: '', condition: '' });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);   // { kind, text }

  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ condition: '', remarks: '' });
  const [saving, setSaving] = useState(false);

  const admin = isAdmin(currentUser());

  useEffect(() => {
    fetchAssetFilters().then(setOptions).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (filters.branch) params.branch = filters.branch;
      if (filters.condition) params.condition = filters.condition;
      const res = await api.get('/verifications', { params });
      setRows(res.data);
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || 'Could not load the verification report.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const applyBranch = (e) => {
    e.preventDefault();
    setFilters((f) => ({ ...f, branch: branchInput.trim() }));
  };

  const startEdit = (row) => {
    setEditingId(row.id);
    setDraft({ condition: row.condition, remarks: row.remarks || '' });
    setNotice(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft({ condition: '', remarks: '' });
  };

  const saveEdit = async (row) => {
    setSaving(true);
    setNotice(null);
    try {
      const updated = await updateVerification(row.id, draft);

      // Patch the row in place rather than refetching, so the admin doesn't
      // lose their filters or scroll position.
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id
            ? { ...r, condition: updated.condition, remarks: updated.remarks, edited_at: updated.edited_at, edited_by_name: 'You' }
            : r
        )
      );

      setNotice({
        kind: 'ok',
        text: updated.applied_to_asset
          ? `${row.asset_code} corrected. This is the asset's most recent verification, so its current condition was updated too.`
          : `${row.asset_code} corrected. This is an older verification, so the asset's current condition was left as it is.`,
      });
      cancelEdit();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'Could not save the correction.' });
    } finally {
      setSaving(false);
    }
  };

  // Any field can contain a quote (descriptions and remarks routinely do),
  // so escape all of them rather than just remarks.
  const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

  const exportCsv = () => {
    const header = ['Asset Code', 'Description', 'Condition', 'Remarks', 'Assigned To', 'Branch',
                    'Verified By', 'Verified At', 'Corrected By', 'Corrected At', 'GPS Link'];
    const lines = rows.map((r) => [
      r.asset_code, r.description, r.condition, r.remarks, r.assigned_to, r.branch,
      r.verified_by_name,
      r.verified_at ? new Date(r.verified_at).toLocaleString() : '',
      r.edited_by_name,
      r.edited_at ? new Date(r.edited_at).toLocaleString() : '',
      r.gps_link,
    ].map(csvCell).join(','));

    const csv = [header.map(csvCell).join(','), ...lines].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `asset-verifications-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const activeFilters = Object.values(filters).filter(Boolean).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Verifications</h1>
          <p className="page-sub">
            {loading ? 'Loading…' : `${rows.length} physical inspection${rows.length === 1 ? '' : 's'} recorded`}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={exportCsv} disabled={rows.length === 0}>
            Export CSV
          </button>
        </div>
      </div>

      <form className="toolbar-search" onSubmit={applyBranch} style={{ marginBottom: '0.75rem' }}>
        <input
          type="search"
          placeholder="Filter by branch…"
          value={branchInput}
          onChange={(e) => setBranchInput(e.target.value)}
          list="branch-options"
        />
        <datalist id="branch-options">
          {options.branches.map((b) => <option key={b} value={b} />)}
        </datalist>
        <button type="submit" className="btn btn-primary">Filter</button>
      </form>

      <div className="filters" style={{ marginBottom: '1.25rem' }}>
        <select
          value={filters.condition}
          onChange={(e) => setFilters((f) => ({ ...f, condition: e.target.value }))}
        >
          <option value="">All conditions</option>
          {options.conditions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        {activeFilters > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { setBranchInput(''); setFilters({ branch: '', condition: '' }); }}
          >
            Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {error && <div className="notice notice-error">{error}</div>}
      {notice && (
        <div className={notice.kind === 'ok' ? 'notice notice-ok' : 'notice notice-error'}>{notice.text}</div>
      )}

      {loading ? (
        <p className="empty">Loading verifications…</p>
      ) : rows.length === 0 ? (
        <div className="card">
          <p className="empty">
            {activeFilters > 0
              ? 'No verifications match these filters.'
              : 'No verifications recorded yet. Officers create these by verifying assets in the mobile app.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Condition</th>
                <th>Remarks</th>
                <th>Assigned to</th>
                <th>Branch</th>
                <th>Verified</th>
                <th>Location</th>
                {admin && <th aria-label="Actions"></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const editing = editingId === r.id;
                return (
                  <tr key={r.id}>
                    <td data-label="Asset"><span className="code">{r.asset_code}</span></td>

                    <td data-label="Condition">
                      {editing ? (
                        <select
                          value={draft.condition}
                          onChange={(e) => setDraft((d) => ({ ...d, condition: e.target.value }))}
                        >
                          {options.conditions.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        <span className={`badge ${CONDITION_BADGE[r.condition] || 'badge-neutral'}`}>
                          {r.condition}
                        </span>
                      )}
                    </td>

                    <td data-label="Remarks">
                      {editing ? (
                        <input
                          value={draft.remarks}
                          onChange={(e) => setDraft((d) => ({ ...d, remarks: e.target.value }))}
                          placeholder="Remarks (optional)"
                        />
                      ) : (
                        r.remarks || <span className="muted">—</span>
                      )}
                    </td>

                    <td data-label="Assigned to">{r.assigned_to || '—'}</td>
                    <td data-label="Branch">{r.branch || '—'}</td>

                    <td data-label="Verified">
                      {new Date(r.verified_at).toLocaleDateString()}
                      <div className="cell-sub">by {r.verified_by_name}</div>
                      {r.edited_at && (
                        <div className="cell-corrected">
                          corrected by {r.edited_by_name || 'an admin'} on{' '}
                          {new Date(r.edited_at).toLocaleDateString()}
                        </div>
                      )}
                    </td>

                    <td data-label="Location">
                      {r.gps_link ? (
                        <a href={r.gps_link} target="_blank" rel="noopener noreferrer">View map</a>
                      ) : (
                        <span className="muted">No GPS</span>
                      )}
                    </td>

                    {admin && (
                      <td data-label="">
                        {editing ? (
                          <div className="page-actions">
                            <button className="btn btn-primary btn-sm" onClick={() => saveEdit(r)} disabled={saving}>
                              {saving ? '…' : 'Save'}
                            </button>
                            <button className="btn btn-secondary btn-sm" onClick={cancelEdit} disabled={saving}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button className="btn btn-secondary btn-sm" onClick={() => startEdit(r)}>Correct</button>
                        )}
                      </td>
                    )}
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