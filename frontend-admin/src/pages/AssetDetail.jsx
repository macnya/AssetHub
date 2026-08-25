import { useState, useEffect, useCallback } from 'react';
import {
  fetchAssetDetail, fetchAssetHistory, markAssetDisposed, markAssetLost,
  updateAsset, fetchAssetFilters, checkDeletable, deleteAsset,
} from '../api';
import { API_BASE_URL } from '../config';
import { isAdmin, canDispose } from '../roles';


function currentUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}

// Mirrors the EDITABLE list on the backend. asset_code and status are absent
// on purpose: the code is printed on a physical label, and status is derived
// from assignment, disposal and loss actions.
const EDITABLE_FIELDS = [
  { key: 'description',       label: 'Description',      type: 'text', required: true },
  { key: 'asset_category_id', label: 'Category',         type: 'category' },
  { key: 'serial_number',     label: 'Serial number',    type: 'text', mono: true },
  { key: 'chassis_number',    label: 'Chassis number',   type: 'text', mono: true },
  { key: 'engine_number',     label: 'Engine number',    type: 'text', mono: true },
  { key: 'supplier',          label: 'Supplier',         type: 'text' },
  { key: 'purchase_price',    label: 'Purchase price',   type: 'number' },
  { key: 'nbv',               label: 'NBV',              type: 'number' },
  { key: 'date_of_purchase',  label: 'Date of purchase', type: 'date' },
  { key: 'condition',         label: 'Condition',        type: 'condition' },
];

const STATUS_BADGE = {
  'In Stock': 'badge-good',
  'Assigned': 'badge-deep',
  'Disposed': 'badge-bad',
  'Lost':     'badge-warn',
};

const CONDITION_BADGE = {
  'Good':             'badge-good',
  'Good with issues': 'badge-warn',
  'Faulty':           'badge-bad',
};

const EVENT_BADGE = {
  'Transfer':     'badge-deep',
  'Check-In':     'badge-good',
  'Verification': 'badge-brand',
  'Disposed':     'badge-bad',
  'Lost':         'badge-warn',
};

const money = (v) =>
  v == null || v === '' ? null : `KES ${Number(v).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function AssetDetail({ assetCode, onBack }) {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);   // { kind: 'ok' | 'error', text }
  const [options, setOptions] = useState({ categories: [], conditions: [] });
  const [deletable, setDeletable] = useState(null);
  const me = currentUser();
  const admin = isAdmin(me);

  // useCallback so the effect below can depend on it honestly, and so saveEdit
  // gets a stable reference rather than a new function on every render.
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const detail = await fetchAssetDetail(assetCode);
      setData(detail);
      const hist = await fetchAssetHistory(detail.asset.id);
      setHistory(hist);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [assetCode]);

    useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
  }, [loadData]);

  // Asked up front rather than on click. Offering an action that will be
  // refused is worse than not offering it at all.
  useEffect(() => {
    if (!data?.asset?.asset_code || !isAdmin(me)) return;
    checkDeletable(data.asset.asset_code)
      .then(setDeletable)
      .catch(() => setDeletable(null));
  }, [data, me]);

  useEffect(() => {
    if (!admin) return;
    fetchAssetFilters().then(setOptions).catch(() => {});
  }, [admin]);

  const startEdit = () => {
    const d = {};
    EDITABLE_FIELDS.forEach(({ key, type }) => {
      const v = data.asset[key];
      d[key] = v == null ? '' : type === 'date' ? String(v).split('T')[0] : String(v);
    });
    setDraft(d);
    setNotice(null);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!draft.description?.trim()) {
      setNotice({ kind: 'error', text: 'Description cannot be empty.' });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      // Send only what actually changed, so an untouched field can't be
      // overwritten by a stale value from when the form was opened.
      const changes = {};
      EDITABLE_FIELDS.forEach(({ key, type }) => {
        const original = data.asset[key];
        const asString = original == null ? '' : type === 'date' ? String(original).split('T')[0] : String(original);
        if (asString !== draft[key]) changes[key] = draft[key];
      });

      if (Object.keys(changes).length === 0) {
        setEditing(false);
        return;
      }

      const updated = await updateAsset(assetCode, changes);
      setData((prev) => ({ ...prev, asset: { ...prev.asset, ...updated } }));
      setEditing(false);
      const n = Object.keys(changes).length;
      setNotice({ kind: 'ok', text: `Saved ${n} change${n === 1 ? '' : 's'}.` });
      loadData();     // refresh the category name and history
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'Could not save these changes.' });
    } finally {
      setSaving(false);
    }
  };

  const handleMarkDisposed = async () => {
    const salesProceeds = prompt('Sales proceeds (leave blank if none):');
    const notes = prompt('Notes (optional):') || '';
    if (!window.confirm(`Mark ${data.asset.asset_code} as disposed?`)) return;
    try {
      await markAssetDisposed({
        asset_id: data.asset.id,
        sales_proceeds: salesProceeds ? parseFloat(salesProceeds) : null,
        disposal_month: new Date().toISOString().split('T')[0],
        notes,
      });
      setNotice({ kind: 'ok', text: 'Asset marked as disposed.' });
      loadData();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'Failed to mark as disposed.' });
    }
  };

  const handleMarkLost = async () => {
    const notes = prompt('Notes on the loss (optional):') || '';
    if (!window.confirm(`Report ${data.asset.asset_code} as lost?`)) return;
    try {
      await markAssetLost({ asset_id: data.asset.id, notes });
      setNotice({ kind: 'ok', text: 'Asset reported as lost.' });
      loadData();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'Failed to report as lost.' });
    }
  };

    // Deleting is for removing a mistake — a row entered twice, junk from an
  // import. A real asset with history is disposed of or written off instead,
  // and the backend refuses anything else.
  const handleDelete = async () => {
    const reason = prompt(
      `Delete ${data.asset.asset_code} permanently?\n\n` +
      `This is for removing a mistake, not for an asset that has left the ` +
      `organisation — use "Mark as disposed" for that.\n\nWhy is it being removed?`
    );
    if (!reason?.trim()) return;

    try {
      await deleteAsset(data.asset.asset_code, reason.trim());
      alert(`${data.asset.asset_code} removed from the register.`);
      onBack();
    } catch (err) {
      setNotice({ kind: 'error', text: err.response?.data?.error || 'Could not delete that asset.' });
    }
  };

  const handlePrintBarcode = async () => {
    try {
      const token = localStorage.getItem('token');
      // Was hardcoded to production, so barcodes printed from a local dev
      // session silently hit the live server.
      const response = await fetch(
        `${API_BASE_URL}/assets/${encodeURIComponent(data.asset.asset_code)}/barcode`,
        { headers: { Authorization: 'Bearer ' + token } }
      );
      if (!response.ok) throw new Error('Failed to fetch barcode');
      const blob = await response.blob();
      window.open(window.URL.createObjectURL(blob), '_blank');
    } catch (err) {
      console.error(err);
      setNotice({ kind: 'error', text: 'Could not load the barcode image.' });
    }
  };

  if (loading) return <div className="page"><p className="empty">Loading asset…</p></div>;
  if (!data) {
    return (
      <div className="page">
        <button className="btn btn-ghost" onClick={onBack}>‹ Back to list</button>
        <div className="notice notice-error" style={{ marginTop: '1rem' }}>Asset not found.</div>
      </div>
    );
  }

  const asset = data.asset;
  const assignment = data.current_assignment;
  const active = asset.status !== 'Disposed' && asset.status !== 'Lost';

  return (
    <div className="page">
      <button className="btn btn-ghost" onClick={onBack} style={{ marginBottom: '1rem' }}>‹ Back to list</button>

      <div className="page-head">
        <div>
          {/* The code is set in mono here and in the scanner — it's the thing
              matched against the label stuck to the equipment. */}
          <h1 className="asset-code">{asset.asset_code}</h1>
          <p className="page-sub">{asset.description}</p>
          <div className="asset-chips">
            <span className={`badge ${STATUS_BADGE[asset.status] || 'badge-neutral'}`}>{asset.status}</span>
            <span className={`badge ${CONDITION_BADGE[asset.condition] || 'badge-neutral'}`}>
              {asset.condition || 'Not yet verified'}
            </span>
          </div>
        </div>

        <div className="page-actions">
          <button className="btn btn-secondary btn-sm" onClick={handlePrintBarcode}>View barcode</button>
          {admin && !editing && (
            <button className="btn btn-primary btn-sm" onClick={startEdit}>Edit details</button>
          )}
        </div>
      </div>

      {notice && (
        <div className={notice.kind === 'ok' ? 'notice notice-ok' : 'notice notice-error'}>{notice.text}</div>
      )}

      <div className="detail-grid">
        <section className="card">
          <div className="card-head"><h2 className="card-title">Details</h2></div>
          <div className="card-body">
            {editing ? (
              <>
                <div className="rows">
                  {EDITABLE_FIELDS.map((f) => (
                    <EditRow
                      key={f.key}
                      field={f}
                      value={draft[f.key] ?? ''}
                      options={options}
                      onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                    />
                  ))}
                </div>
                <p className="locked-note">
                  The asset code is printed on the physical label, and status follows
                  assignment, disposal and loss actions — neither is edited here.
                </p>
                <div className="page-actions" style={{ marginTop: '1rem' }}>
                  <button className="btn btn-primary" onClick={saveEdit} disabled={saving}>
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                  <button className="btn btn-secondary" onClick={() => setEditing(false)} disabled={saving}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div className="rows">
                <Row label="Category" value={asset.category_name} />
                <Row label="Serial number" value={asset.serial_number} mono />
                {asset.chassis_number && <Row label="Chassis number" value={asset.chassis_number} mono />}
                {asset.engine_number && <Row label="Engine number" value={asset.engine_number} mono />}
                <Row label="Supplier" value={asset.supplier} />
                <Row label="Purchase price" value={money(asset.purchase_price)} />
                <Row label="NBV" value={money(asset.nbv)} />
                <Row label="Date of purchase" value={asset.date_of_purchase ? asset.date_of_purchase.split('T')[0] : null} />
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2 className="card-title">Current assignment</h2></div>
          <div className="card-body">
            {assignment ? (
              <div className="rows">
                <Row label="Employee" value={assignment.employee_name} />
                <Row label="Branch" value={assignment.branch} />
                <Row label="Location" value={assignment.physical_location} />
              </div>
            ) : (
              <p className="muted">Not currently assigned — in storage.</p>
            )}
          </div>

          {/* Disposal and write-off are register decisions, not field ones. A
              read-only role used to see both buttons, fill in the prompts, and
              only then hit a 403 from the backend. */}
          {active && canDispose(me) && (
            <div className="card-body" style={{ borderTop: '1px solid var(--rule)' }}>
              <div className="page-actions">
                <button className="btn btn-danger btn-sm" onClick={handleMarkDisposed}>Mark as disposed</button>
                <button className="btn btn-warn btn-sm" onClick={handleMarkLost}>Report as lost</button>

                {/* Only when the asset has no history. Anything with a record
                    is disposed of or written off — the register is an audit
                    document, and a deleted row leaves no account of itself. */}
                {deletable?.deletable && (
                  <button className="btn btn-danger btn-sm" onClick={handleDelete}>Delete</button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: '1rem' }}>
        <div className="card-head">
          <h2 className="card-title">Audit history</h2>
          {history.length > 0 && <span className="list-count">{history.length} events</span>}
        </div>

        {history.length === 0 ? (
          <p className="empty">No history recorded.</p>
        ) : (
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Action</th>
                  <th>By</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const hasGPS = h.latitude != null && h.longitude != null;
                  // Built with concatenation rather than a template literal:
                  // a backtick string holding an ampersand, inside a JSX
                  // attribute, is fragile to copy and paste.
                  const mapUrl = hasGPS
                    ? 'https://www.google.com/maps/search/?api=1&query=' + h.latitude + ',' + h.longitude
                    : null;
                  return (
                    <tr key={h.id}>
                      <td data-label="Date">{new Date(h.timestamp).toLocaleString()}</td>
                      <td data-label="Action">
                        <span className={`badge ${EVENT_BADGE[h.action] || 'badge-neutral'}`}>{h.action}</span>
                      </td>
                      <td data-label="By">{h.scanned_by_name || 'Unknown'}</td>
                      <td data-label="From">{h.from_employee_name || h.from_branch || '—'}</td>
                      <td data-label="To">{h.to_employee_name || h.to_branch || '—'}</td>
                      <td data-label="Location">
                        {mapUrl ? (
                          <a href={mapUrl} target="_blank" rel="noopener noreferrer">
                            {Number(h.latitude).toFixed(4)}, {Number(h.longitude).toFixed(4)}
                          </a>
                        ) : (
                          <span className="muted">No GPS</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function EditRow({ field, value, options, onChange }) {
  const onInput = (e) => onChange(e.target.value);

  return (
    <div className="row">
      <label className="row-label">
        {field.label}{field.required ? ' *' : ''}
      </label>

      {field.type === 'category' ? (
        <select value={value} onChange={onInput}>
          <option value="">— None —</option>
          {options.categories.map((cat) => (
            <option key={cat.id} value={cat.id}>{cat.name}</option>
          ))}
        </select>
      ) : field.type === 'condition' ? (
        <select value={value} onChange={onInput}>
          <option value="">Not yet verified</option>
          {options.conditions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      ) : (
        <input
          value={value}
          onChange={onInput}
          className={field.mono ? 'is-mono' : undefined}
          type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
          step={field.type === 'number' ? '0.01' : undefined}
        />
      )}
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className={mono ? 'row-value is-mono' : 'row-value'}>
        {value == null || value === '' ? '—' : value}
      </span>
    </div>
  );
}