import { useState, useEffect, useCallback } from 'react';
import {
  fetchPendingVerifications, fetchPendingAssets, fetchPendingCustody,
  approveVerification, rejectVerification,
  approveAsset, rejectAsset,
  approveCustody, rejectCustody,
} from '../api';

const CONDITION_BADGE = {
  'Good':             'badge-good',
  'Good with issues': 'badge-warn',
  'Faulty':           'badge-bad',
};

export default function Approvals({ onReviewed, onSelectAsset }) {
  const [verifications, setVerifications] = useState([]);
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);      // id currently being actioned
  const [custody, setCustody] = useState([]);

    const load = useCallback(async () => {
    setLoading(true);
    try {
      // allSettled, not all: one failing endpoint should not empty the whole
      // page. When the verification routes were mounted at the wrong path, a
      // single 404 hid the other queues entirely.
      const [v, a, c] = await Promise.allSettled([
        fetchPendingVerifications(), fetchPendingAssets(), fetchPendingCustody(),
      ]);

      setVerifications(v.status === 'fulfilled' ? v.value : []);
      setAssets(a.status === 'fulfilled' ? a.value : []);
      setCustody(c.status === 'fulfilled' ? c.value : []);

      const failed = [v, a, c].filter((r) => r.status === 'rejected');
      if (failed.length) {
        console.error('Some approval queues failed to load', failed);
        setNotice({ kind: 'error', text: 'Part of the approval queue could not be loaded.' });
      }

      onReviewed?.();
    } finally {
      setLoading(false);
    }
  }, [onReviewed]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const act = async (key, fn, okText) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      setNotice({ kind: 'ok', text: okText });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'That did not go through.' });
    } finally {
      setBusy(null);
    }
  };

  const rejectWithReason = (label) => {
    const reason = prompt(
      `Why is ${label} being rejected?\n\n` +
      `The person who submitted it sees this, so say what needs correcting.`
    );
    if (reason === null) return null;                    // cancelled
    if (!reason.trim()) return null;
    return reason.trim();
  };

  const total = verifications.length + assets.length + custody.length;

  if (loading) return <div className="page"><p className="empty">Loading approvals…</p></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Approvals</h1>
          <p className="page-sub">
            {total === 0
              ? 'Nothing waiting for you'
              : `${total} item${total === 1 ? '' : 's'} awaiting your review`}
          </p>
        </div>
      </div>

      {notice && (
        <div className={notice.kind === 'ok' ? 'notice notice-ok' : 'notice notice-error'}>{notice.text}</div>
      )}

      {/* Anything this admin submitted themselves is filtered out server-side.
          Four eyes means the person who recorded it cannot be the one who
          confirms it — including when that person is an administrator. */}
      <div className="notice notice-info">
        You will not see your own submissions here. Every verification and every new asset
        must be confirmed by someone other than the person who recorded it.
      </div>

      {total === 0 ? (
        <div className="card">
          <p className="empty">
            Nothing to review. New verifications and assets added at branches will appear here.
          </p>
        </div>
      ) : (
        <>
                    {custody.length > 0 && (
            <section className="card" style={{ marginBottom: '1rem' }}>
              <div className="card-head">
                <h2 className="card-title">Custody changes</h2>
                <span className="list-count">{custody.length}</span>
              </div>

              {/* HR 9.3a requires permission from the head of department or
                  branch manager before equipment moves. This is that
                  permission — nothing has moved in the register yet. */}
              <div className="card-body" style={{ paddingBottom: 0 }}>
                <p className="page-sub">
                  Nothing has changed in the register yet. Approving is what moves the asset.
                </p>
              </div>

              <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Move</th>
                      <th>Condition</th>
                      <th>Requested by</th>
                      <th aria-label="Actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {custody.map((c) => (
                      <tr key={c.id}>
                        <td data-label="Asset">
                          <button className="link-btn code" onClick={() => onSelectAsset(c.asset_code)}>
                            {c.asset_code}
                          </button>
                          <div className="cell-sub">{c.description}</div>
                        </td>

                        <td data-label="Move">
                          <span className={c.kind === 'return' ? 'badge badge-neutral' : 'badge badge-brand'}>
                            {c.kind === 'return' ? 'Return to storage' : 'Assign'}
                          </span>
                          <div className="cell-sub">
                            {[c.from_employee, c.from_place, c.from_branch].filter(Boolean).join(' · ') || 'storage'}
                            {' → '}
                            {c.kind === 'return'
                              ? 'storage'
                              : [c.to_employee, c.to_place, c.to_branch].filter(Boolean).join(' · ')}
                          </div>
                          {c.notes && <div className="cell-sub">{c.notes}</div>}
                        </td>

                        {/* The condition recorded at handover is what makes
                            HR 9.3b enforceable if the equipment is later
                            damaged. */}
                        <td data-label="Condition">
                          {c.condition_at_handover
                            ? <span className="badge badge-neutral">{c.condition_at_handover}</span>
                            : <span className="muted">—</span>}
                        </td>

                        <td data-label="Requested by">
                          {c.requested_by_name}
                          <div className="cell-sub">
                            {c.requested_by_role} · {new Date(c.requested_at).toLocaleDateString()}
                          </div>
                          {c.gps_link && (
                            <div className="cell-sub">
                              <a href={c.gps_link} target="_blank" rel="noopener noreferrer">View position</a>
                            </div>
                          )}
                        </td>

                        <td data-label="">
                          <div className="page-actions">
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={busy === `c${c.id}`}
                              onClick={() => act(`c${c.id}`, () => approveCustody(c.id),
                                `${c.asset_code} moved.`)}
                            >
                              {busy === `c${c.id}` ? '…' : 'Approve'}
                            </button>
                            <button
                              className="btn btn-danger btn-sm"
                              disabled={busy === `c${c.id}`}
                              onClick={() => {
                                const reason = rejectWithReason(`the move of ${c.asset_code}`);
                                if (reason) act(`c${c.id}`, () => rejectCustody(c.id, reason),
                                  `${c.asset_code} sent back.`);
                              }}
                            >
                              Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {verifications.length > 0 && (
            <section className="card" style={{ marginBottom: '1rem' }}>
              <div className="card-head">
                <h2 className="card-title">Verifications</h2>
                <span className="list-count">{verifications.length}</span>
              </div>

              <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Condition</th>
                      <th>Remarks</th>
                      <th>Recorded by</th>
                      <th>Where</th>
                      <th aria-label="Actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {verifications.map((v) => (
                      <tr key={v.id}>
                        <td data-label="Asset">
                          <button className="link-btn code" onClick={() => onSelectAsset(v.asset_code)}>
                            {v.asset_code}
                          </button>
                          <div className="cell-sub">{v.description}</div>
                        </td>

                        <td data-label="Condition">
                          <span className={`badge ${CONDITION_BADGE[v.condition] || 'badge-neutral'}`}>
                            {v.condition}
                          </span>
                        </td>

                        <td data-label="Remarks">{v.remarks || <span className="muted">—</span>}</td>

                        <td data-label="Recorded by">
                          {v.verified_by_name}
                          <div className="cell-sub">
                            {v.verified_by_role} · {new Date(v.verified_at).toLocaleDateString()}
                          </div>
                        </td>

                        {/* The position is the verifier's, captured where they
                            stood. Approving never changes it. */}
                        <td data-label="Where">
                          {v.branch || <span className="muted">—</span>}
                          {v.gps_link && (
                            <div className="cell-sub">
                              <a href={v.gps_link} target="_blank" rel="noopener noreferrer">View position</a>
                            </div>
                          )}
                        </td>

                        <td data-label="">
                          <div className="page-actions">
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={busy === `v${v.id}`}
                              onClick={() => act(`v${v.id}`, () => approveVerification(v.id),
                                `${v.asset_code} approved.`)}
                            >
                              {busy === `v${v.id}` ? '…' : 'Approve'}
                            </button>
                            <button
                              className="btn btn-danger btn-sm"
                              disabled={busy === `v${v.id}`}
                              onClick={() => {
                                const reason = rejectWithReason(`the verification of ${v.asset_code}`);
                                if (reason) act(`v${v.id}`, () => rejectVerification(v.id, reason),
                                  `${v.asset_code} sent back.`);
                              }}
                            >
                              Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {assets.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">New assets</h2>
                <span className="list-count">{assets.length}</span>
              </div>

              {/* A pending asset is not in the register and is not counted
                  anywhere until it is approved. */}
              <div className="card-body" style={{ paddingBottom: 0 }}>
                <p className="page-sub">
                  These are not yet part of the register and are excluded from every total
                  until approved.
                </p>
              </div>

              <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Description</th>
                      <th>Category</th>
                      <th>Added by</th>
                      <th aria-label="Actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map((a) => (
                      <tr key={a.id}>
                        <td data-label="Code"><span className="code">{a.asset_code}</span></td>
                        <td data-label="Description">
                          {a.description}
                          {a.serial_number && <div className="cell-sub">Serial {a.serial_number}</div>}
                        </td>
                        <td data-label="Category">{a.category_name || <span className="muted">—</span>}</td>
                        <td data-label="Added by">
                          {a.created_by_name || <span className="muted">unknown</span>}
                          {a.created_by_branch && <div className="cell-sub">{a.created_by_branch}</div>}
                        </td>
                        <td data-label="">
                          <div className="page-actions">
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={busy === `a${a.id}`}
                              onClick={() => act(`a${a.id}`, () => approveAsset(a.asset_code),
                                `${a.asset_code} added to the register.`)}
                            >
                              {busy === `a${a.id}` ? '…' : 'Approve'}
                            </button>
                            <button
                              className="btn btn-danger btn-sm"
                              disabled={busy === `a${a.id}`}
                              onClick={() => {
                                const reason = rejectWithReason(`asset ${a.asset_code}`);
                                if (reason) act(`a${a.id}`, () => rejectAsset(a.asset_code, reason),
                                  `${a.asset_code} sent back.`);
                              }}
                            >
                              Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}