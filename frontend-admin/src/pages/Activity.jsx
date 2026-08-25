import { useState, useEffect, useCallback } from 'react';
import { fetchActivity, fetchActivityActions } from '../api';

// Who did what, and who let them.
//
// Merged from movements, verifications and custody requests — including the
// approvals and refusals, which is the half a scan log cannot show. "Who
// approved that transfer?" is the question an auditor asks, and it has no
// answer in a list of movements alone.

const PAGE = 100;

// Colour carries the meaning at a glance: something was allowed, something was
// refused, or something is still waiting on a decision.
const TONE = {
  'Verification approved': 'is-approved',
  'Custody approved':      'is-approved',
  'Verification rejected': 'is-rejected',
  'Custody rejected':      'is-rejected',
  'Verification recorded': 'is-recorded',
  'Assignment requested':  'is-recorded',
  'Return requested':      'is-recorded',
  'Transfer':              'is-move',
  'Check-In':              'is-move',
  'Import':                'is-quiet',
};

const EMPTY = { action: '', actor: '', asset: '', from: '', to: '' };

export default function Activity({ scopedTo }) {
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [actions, setActions] = useState([]);
  const [filters, setFilters] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchActivityActions().then(setActions).catch(() => setActions([]));
  }, []);

  const load = useCallback(async (nextOffset = 0, append = false) => {
    setLoading(true);
    setError('');
    try {
      const clean = Object.fromEntries(
        Object.entries(filters).filter(([, v]) => v !== '' && v != null)
      );
      const data = await fetchActivity({ ...clean, limit: PAGE, offset: nextOffset });

      setEvents((prev) => (append ? [...prev, ...data.events] : data.events));
      setTotal(data.total);
      setOffset(nextOffset);
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || 'Could not load the activity trail.');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(0, false);
  }, [load]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const anyFilter = Object.values(filters).some((v) => v !== '');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Activity</h1>
          <p className="page-sub">
            {scopedTo ? `${scopedTo} only · ` : ''}
            Every action recorded, including who approved or refused it
          </p>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <div className="filters" style={{ marginBottom: '1rem' }}>
        <input
          type="search" placeholder="Person…"
          value={filters.actor} onChange={set('actor')}
        />
        <input
          type="search" placeholder="Asset code…"
          value={filters.asset} onChange={set('asset')}
        />
        <select value={filters.action} onChange={set('action')}>
          <option value="">Every action</option>
          {actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <input type="date" value={filters.from} onChange={set('from')} title="From" />
        <input type="date" value={filters.to} onChange={set('to')} title="To" />
        {anyFilter && (
          <button className="btn btn-ghost btn-sm" onClick={() => setFilters(EMPTY)}>Clear</button>
        )}
      </div>

      <div className="list-foot" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
        <span className="list-count">
          {loading && events.length === 0
            ? 'Loading…'
            : `Showing ${events.length.toLocaleString()} of ${total.toLocaleString()}`}
        </span>
      </div>

      {events.length === 0 && !loading ? (
        <div className="card">
          <p className="empty">
            {anyFilter ? 'Nothing matches those filters.' : 'Nothing recorded yet.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Asset</th>
                <th>Detail</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.event_id}>
                  <td data-label="When">
                    {e.at ? new Date(e.at).toLocaleDateString() : '—'}
                    <div className="cell-sub">
                      {e.at ? new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </div>
                  </td>

                  <td data-label="Action">
                    <span className={`activity-tag ${TONE[e.action] || 'is-quiet'}`}>{e.action}</span>
                    {e.branch && <div className="cell-sub">{e.branch}</div>}
                  </td>

                  <td data-label="Asset">
                    <span className="code">{e.asset_code}</span>
                    <div className="cell-sub">{e.description}</div>
                  </td>

                  <td data-label="Detail">
                    {e.detail || <span className="muted">—</span>}
                    {/* A rejection reason matters more than the rejection: it
                        is what tells the officer what to correct. */}
                    {e.notes && <div className="cell-sub">{e.notes}</div>}
                    {e.gps_link && (
                      <div className="cell-sub">
                        <a href={e.gps_link} target="_blank" rel="noopener noreferrer">View position</a>
                      </div>
                    )}
                  </td>

                  <td data-label="By">
                    {e.actor || <span className="muted">unknown</span>}
                    {e.actor_role && <div className="cell-sub">{e.actor_role}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {events.length < total && (
        <div className="list-foot">
          <button
            className="btn btn-secondary"
            onClick={() => load(offset + PAGE, true)}
            disabled={loading}
          >
            {loading ? 'Loading…' : `Load next ${Math.min(PAGE, total - events.length)}`}
          </button>
        </div>
      )}
    </div>
  );
}