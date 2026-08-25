import { useState, useEffect, useCallback } from 'react';
import {
  fetchClearances, fetchClearance, fetchEmployeeHoldings,
  openClearance, resolveClearanceItem, completeClearance,
  fetchEmployeesList,
} from '../api';

const money = (v) =>
  v == null || v === '' || Number(v) === 0
    ? '—'
    : `KES ${Number(v).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const OUTCOME = {
  outstanding: { label: 'Outstanding', badge: 'badge-warn' },
  returned:    { label: 'Returned',    badge: 'badge-good' },
  written_off: { label: 'Written off', badge: 'badge-bad' },
  owed:        { label: 'Owed',        badge: 'badge-brand' },
};

export default function Clearances({ canManage, onSelectAsset }) {
  const [clearances, setClearances] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setClearances(await fetchClearances());
    } catch (err) {
      console.error(err);
      setNotice({ kind: 'error', text: 'Could not load clearances.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const openDetail = async (id) => {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id);
    setDetail(null);
    try {
      setDetail(await fetchClearance(id));
    } catch {
      setNotice({ kind: 'error', text: 'Could not load that clearance.' });
    }
  };

  const resolve = async (item, outcome) => {
    let notes = null;
    if (outcome === 'written_off' || outcome === 'owed') {
      notes = prompt(
        outcome === 'written_off'
          ? `Why is ${item.asset_code} being written off?\n\nThis is recorded as a loss against the register.`
          : `Note for ${item.asset_code}.\n\nIts value will be deducted from final dues, so say what was agreed.`
      );
      if (notes === null) return;
    }

    setBusy(item.id);
    setNotice(null);
    try {
      await resolveClearanceItem(openId, item.id, outcome, notes);
      setDetail(await fetchClearance(openId));
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'That did not save.' });
    } finally {
      setBusy(null);
    }
  };

  const complete = async () => {
    if (!window.confirm(
      'Complete this clearance?\n\n' +
      'The amount owed becomes the figure Finance deducts from final dues, ' +
      'and the record can no longer be changed.'
    )) return;

    setBusy('complete');
    setNotice(null);
    try {
      const done = await completeClearance(openId);
      setNotice({
        kind: 'ok',
        text: Number(done.amount_owed) > 0
          ? `Clearance complete. ${money(done.amount_owed)} owed — give this figure to Finance for deduction from final dues.`
          : 'Clearance complete. Nothing owed.',
      });
      setDetail(await fetchClearance(openId));
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'Could not complete this clearance.' });
    } finally {
      setBusy(null);
    }
  };

  const open = clearances.filter((c) => c.status === 'open');
  const overdue = open.filter((c) => c.overdue);
  const totalOwed = clearances.reduce((s, c) => s + Number(c.amount_owed || 0), 0);

  if (loading) return <div className="page"><p className="empty">Loading clearances…</p></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Exit clearance</h1>
          <p className="page-sub">
            {open.length} open{overdue.length > 0 && ` · ${overdue.length} past the three-month deadline`}
            {totalOwed > 0 && ` · ${money(totalOwed)} owed in total`}
          </p>
        </div>
        {canManage && (
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              Start a clearance
            </button>
          </div>
        )}
      </div>

      {notice && (
        <div className={notice.kind === 'ok' ? 'notice notice-ok' : 'notice notice-error'}>{notice.text}</div>
      )}

      {/* The policy this implements, stated plainly. Whoever uses this screen
          should know it is not an IT convention but a mandatory process. */}
      <div className="notice notice-info">
        HR Manual 8.10.1 — all company assets must be returned on or before the last working day.
        8.10.2 — where a leaver does not clear, the value of anything owed is deducted from final
        dues, and the process must be started within three months of their exit.
      </div>

      {overdue.length > 0 && (
        <div className="notice notice-error">
          {overdue.length} clearance{overdue.length === 1 ? ' is' : 's are'} past the three-month
          deadline in 8.10.2. Final dues may already have been paid.
        </div>
      )}

      {creating && (
        <NewClearance
          onCancel={() => setCreating(false)}
          onCreated={async (msg) => {
            setCreating(false);
            setNotice({ kind: 'ok', text: msg });
            await load();
          }}
        />
      )}

      {clearances.length === 0 ? (
        <div className="card">
          <p className="empty">
            No clearances yet. Start one when a member of staff is leaving, and the system will
            list everything they hold.
          </p>
        </div>
      ) : (
        <div className="branch-list">
          {clearances.map((c) => {
            const expanded = openId === c.id;
            return (
              <div key={c.id} className="card branch-card">
                <div className="branch-head">
                  <button className="branch-toggle" onClick={() => openDetail(c.id)} aria-expanded={expanded}>
                    <span className={expanded ? 'branch-caret is-open' : 'branch-caret'}>›</span>
                    <span>
                      <span className="branch-name">{c.employee_name}</span>
                      <div className="cell-sub">
                        {[c.branch, c.department].filter(Boolean).join(' · ') || 'branch not recorded'}
                        {' · last day '}{c.last_working_day}
                      </div>
                    </span>
                  </button>

                  <div className="branch-meta">
                    {c.involves_fraud && <span className="badge badge-bad">fraud case</span>}

                    {c.status === 'open' ? (
                      c.overdue
                        ? <span className="badge badge-bad">overdue</span>
                        : <span className="badge badge-warn">{c.days_left} days left</span>
                    ) : (
                      <span className="badge badge-good">complete</span>
                    )}

                    <span className="branch-count">
                      {c.outstanding > 0 ? `${c.outstanding}/${c.total_items}` : c.total_items}
                    </span>
                  </div>
                </div>

                {expanded && (
                  <div className="branch-body" style={{ gridTemplateColumns: '1fr' }}>
                    {!detail ? (
                      <p className="empty">Loading…</p>
                    ) : (
                      <>
                        <div className="table-wrap" style={{ border: 'none' }}>
                          <table className="table">
                            <thead>
                              <tr>
                                <th>Asset</th>
                                <th>Value at exit</th>
                                <th>Outcome</th>
                                <th aria-label="Actions"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.items.map((i) => (
                                <tr key={i.id}>
                                  <td data-label="Asset">
                                    <button className="link-btn code" onClick={() => onSelectAsset(i.asset_code)}>
                                      {i.asset_code}
                                    </button>
                                    <div className="cell-sub">{i.description}</div>
                                  </td>

                                  {/* Copied when the clearance opened, not read
                                      live: 8.10.2 requires the exact value, and
                                      a later price correction must not change
                                      what Finance was told. */}
                                  <td data-label="Value at exit">{money(i.value_at_exit)}</td>

                                  <td data-label="Outcome">
                                    <span className={`badge ${OUTCOME[i.outcome].badge}`}>
                                      {OUTCOME[i.outcome].label}
                                    </span>
                                    {i.resolved_by_name && (
                                      <div className="cell-sub">by {i.resolved_by_name}</div>
                                    )}
                                    {i.notes && <div className="cell-sub">{i.notes}</div>}
                                  </td>

                                  <td data-label="">
                                    {detail.status === 'open' && i.outcome === 'outstanding' ? (
                                      <div className="page-actions">
                                        <button className="btn btn-primary btn-sm" disabled={busy === i.id}
                                          onClick={() => resolve(i, 'returned')}>Returned</button>
                                        <button className="btn btn-warn btn-sm" disabled={busy === i.id}
                                          onClick={() => resolve(i, 'owed')}>Owed</button>
                                        <button className="btn btn-danger btn-sm" disabled={busy === i.id}
                                          onClick={() => resolve(i, 'written_off')}>Write off</button>
                                      </div>
                                    ) : (
                                      <span className="muted">—</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <div className="clearance-foot">
                          <div className="rows" style={{ flex: 1, minWidth: '14rem' }}>
                            <div className="row">
                              <span className="row-label">Owed, for Finance to deduct</span>
                              <span className="row-value">{money(c.amount_owed)}</span>
                            </div>
                            {c.outstanding > 0 && (
                              <div className="row">
                                <span className="row-label">Still unresolved</span>
                                <span className="row-value">{c.outstanding} item{c.outstanding === 1 ? '' : 's'}</span>
                              </div>
                            )}
                          </div>

                          {detail.status === 'open' && canManage && (
                            <button className="btn btn-primary" onClick={complete}
                              disabled={busy === 'complete' || c.outstanding > 0}
                              title={c.outstanding > 0 ? 'Resolve every item first' : undefined}>
                              {busy === 'complete' ? 'Completing…' : 'Complete clearance'}
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Starting a clearance shows what the person holds BEFORE committing, so P&C
// can see what they are taking on rather than discovering it afterwards.
function NewClearance({ onCancel, onCreated }) {
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState('');
  const [lastDay, setLastDay] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [fraud, setFraud] = useState(false);
  const [holdings, setHoldings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchEmployeesList().then(setEmployees).catch(() => setError('Could not load the employee list.'));
  }, []);

  useEffect(() => {
    if (!employeeId) return;

    // `cancelled` guards against a slow response for a previously-selected
    // employee arriving after a newer one, which would show the wrong holdings.
    let cancelled = false;
    fetchEmployeeHoldings(employeeId)
      .then((h) => { if (!cancelled) setHoldings(h); })
      .catch(() => { if (!cancelled) setHoldings(null); });

    return () => { cancelled = true; };
  }, [employeeId]);

  const submit = async () => {
    if (!employeeId || !lastDay) { setError('Choose the employee and their last working day.'); return; }
    setSaving(true);
    setError('');
    try {
      const created = await openClearance({
        employee_id: Number(employeeId),
        last_working_day: lastDay,
        reason: reason.trim() || null,
        involves_fraud: fraud,
      });
      onCreated(
        `Clearance opened for ${created.employee_name}. ` +
        `${created.items_snapshotted} asset${created.items_snapshotted === 1 ? '' : 's'} to account for.`
      );
    } catch (err) {
      setError(err.response?.data?.error || 'Could not open this clearance.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div className="card-head"><h2 className="card-title">Start a clearance</h2></div>
      <div className="card-body">
        {error && <div className="notice notice-error">{error}</div>}

        <div className="field">
          <label htmlFor="c-emp">Employee leaving *</label>
          <select id="c-emp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">— Choose —</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}{e.branch ? ` · ${e.branch}` : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="c-day">Last working day *</label>
            <input id="c-day" type="date" value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
            <p className="field-hint">Assets are due back on or before this date (8.10.1).</p>
          </div>
          <div className="field">
            <label htmlFor="c-reason">Reason</label>
            <input id="c-reason" placeholder="Resignation, end of contract…" value={reason}
              onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 500 }}>
            <input type="checkbox" checked={fraud} onChange={(e) => setFraud(e.target.checked)}
              style={{ width: 'auto' }} />
            This exit involves fraud
          </label>
          <p className="field-hint">
            8.10.2 — clearance waits for the investigation to conclude, so the three-month deadline
            will not be flagged as overdue.
          </p>
        </div>

        {employeeId && holdings && (
          <div className="notice notice-info">
            {holdings.count === 0
              ? 'This person holds no assets. A clearance will still record that.'
              : `${holdings.count} asset${holdings.count === 1 ? '' : 's'} will be listed, ` +
                `worth ${money(holdings.total_value)} in total.`}
          </div>
        )}

        <div className="page-actions" style={{ marginTop: '1rem' }}>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Opening…' : 'Open clearance'}
          </button>
          <button className="btn btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}