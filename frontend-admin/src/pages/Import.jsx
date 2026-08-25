import { useState, useRef, useEffect } from 'react';
import { previewImport, applyImport, fetchImportBatches } from '../api';

// Upload a spreadsheet, see what it would do, then decide.
//
// WHY PREVIEW IS THE WHOLE POINT
// A bad import is the one action that can damage 2,311 records at once, and
// every data problem this register has had came from an import that reported
// success while doing something unexpected. Nothing is written until somebody
// has read what would change and said yes.

const money = (v) =>
  v == null || v === '' ? '—'
    : `KES ${Number(v).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;

const FIELD_LABEL = {
  description: 'Description',
  serial_number: 'Serial',
  date_of_purchase: 'Purchase date',
  purchase_price: 'Purchase price',
  supplier: 'Supplier',
  nbv: 'Net book value',
  accumulated_depreciation: 'Accumulated depreciation',
  chassis_number: 'Chassis',
  engine_number: 'Engine',
};

const shownValue = (field, v) =>
  v == null || v === '' ? '(blank)'
    : /price|nbv|depreciation/.test(field) ? money(v)
    : String(v);

export default function Import() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mode, setMode] = useState('upsert');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [batches, setBatches] = useState([]);
  const [tab, setTab] = useState('added');
  const fileRef = useRef(null);

  const loadBatches = () => {
    fetchImportBatches().then(setBatches).catch(() => setBatches([]));
  };

  useEffect(() => {
    loadBatches();
  }, []);

  const choose = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;

    setFile(f);
    setPreview(null);
    setResult(null);
    setError('');
    setBusy(true);

    try {
      setPreview(await previewImport(f));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not read that file.');
      setPreview(err.response?.data?.rejections ? { rejections: err.response.data.rejections } : null);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!window.confirm(
      `Import ${file.name}?\n\n` +
      (mode === 'add'
        ? `${preview.summary.added} new assets will be added. Existing assets are left alone.`
        : `${preview.summary.added} added and ${preview.summary.updated} updated.`) +
      `\n\nThis writes to the register.`
    )) return;

    setBusy(true);
    setError('');
    try {
      const res = await applyImport({
        rows: preview.rows,
        mode,
        filename: preview.filename,
        sheets: preview.sheets,
      });
      setResult(res);
      setPreview(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      loadBatches();
        } catch (err) {
      const d = err.response?.data;
      // The server names the row and the cause; showing only the headline
      // sent you to the Render log for something already in the response.
      setError(
        [d?.error || 'The import failed.', d?.at, d?.detail]
          .filter(Boolean)
          .join(' — ')
      );
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError('');
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Import</h1>
          <p className="page-sub">Add to the register from a spreadsheet, or update what is already there</p>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      {result && (
        <div className="notice notice-ok">
          {result.message} <span className="muted">Batch {result.batch_id}.</span>
        </div>
      )}

      {/* Choosing a file previews it. Nothing is written until the person has
          read the summary and confirmed. */}
      {!preview && (
        <section className="card">
          <div className="card-body">
            <div className="field">
              <label htmlFor="import-file">Spreadsheet</label>
              <input
                id="import-file" type="file" ref={fileRef}
                accept=".xlsx,.xls,.csv"
                onChange={choose} disabled={busy}
              />
              <p className="field-hint">
                Needs an <strong>ASSET CODE</strong> and a <strong>DESCRIPTION</strong> column.
                Every sheet in the workbook is read. Nothing is written until you confirm.
              </p>
            </div>

            {busy && <p className="empty">Reading the file…</p>}
          </div>
        </section>
      )}

      {preview?.summary && (
        <>
          <div className="stats" style={{ marginBottom: '1rem' }}>
            <div className="stat">
              <div className="stat-label">New</div>
              <div className="stat-value is-accent">{preview.summary.added}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Would change</div>
              <div className="stat-value">{preview.summary.updated}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Already correct</div>
              <div className="stat-value">{preview.summary.unchanged}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Unreadable</div>
              <div className={preview.summary.rejected ? 'stat-value is-loss' : 'stat-value'}>
                {preview.summary.rejected}
              </div>
            </div>
          </div>

          <div className="notice notice-info">
            <strong>{preview.filename}</strong> — {preview.rows_read.toLocaleString()} rows across{' '}
            {preview.sheets.length} sheet{preview.sheets.length === 1 ? '' : 's'}. Nothing has been
            written yet.
          </div>

          <section className="card" style={{ marginBottom: '1rem' }}>
            <div className="card-body">
              <div className="field">
                <label>What should this do?</label>
                <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontWeight: 500, marginBottom: '0.6rem' }}>
                  <input type="radio" checked={mode === 'upsert'} onChange={() => setMode('upsert')} style={{ width: 'auto', marginTop: '0.2rem' }} />
                  <span>
                    <strong>Add and update</strong>
                    <div className="field-hint" style={{ marginTop: 0 }}>
                      New assets are added, and existing ones updated where the sheet differs.
                      A blank cell leaves the current value alone.
                    </div>
                  </span>
                </label>
                <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontWeight: 500 }}>
                  <input type="radio" checked={mode === 'add'} onChange={() => setMode('add')} style={{ width: 'auto', marginTop: '0.2rem' }} />
                  <span>
                    <strong>Add only</strong>
                    <div className="field-hint" style={{ marginTop: 0 }}>
                      Only assets whose code is not already in the register. Nothing existing is touched.
                    </div>
                  </span>
                </label>
              </div>

              <div className="page-actions" style={{ marginTop: '1.25rem' }}>
                <button className="btn btn-primary" onClick={confirm} disabled={busy}>
                  {busy ? 'Importing…' : mode === 'add'
                    ? `Add ${preview.summary.added} assets`
                    : `Apply ${preview.summary.added + preview.summary.updated} changes`}
                </button>
                <button className="btn btn-secondary" onClick={reset} disabled={busy}>Cancel</button>
              </div>
            </div>
          </section>

          <div className="filters" style={{ marginBottom: '1rem' }}>
            {[
              ['added', `New (${preview.summary.added})`],
              ['updated', `Changes (${preview.summary.updated})`],
              ['rejections', `Unreadable (${preview.summary.rejected})`],
              ['warnings', `Warnings (${preview.warnings?.length || 0})`],
            ].map(([k, label]) => (
              <button
                key={k}
                className={tab === k ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                onClick={() => setTab(k)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'added' && (
            <PreviewTable
              title="Would be added"
              head={['Code', 'Description', 'Serial', 'Price', 'Sheet']}
              rows={(preview.added || []).map((r) => [
                r.asset_code, r.description, r.serial_number || '—',
                money(r.purchase_price), `${r.sheet} row ${r.row}`,
              ])}
              total={preview.summary.added}
              empty="Nothing new in this file."
            />
          )}

          {/* Field by field, old value beside new. A count of changed rows tells
              you nothing about whether the change is right. */}
          {tab === 'updated' && (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">Would change</h2>
                <span className="list-count">{preview.summary.updated}</span>
              </div>
              {(preview.updated || []).length === 0 ? (
                <p className="empty">Nothing would change.</p>
              ) : (
                <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
                  <table className="table">
                    <thead>
                      <tr><th>Asset</th><th>Field</th><th>Now</th><th>Would become</th></tr>
                    </thead>
                    <tbody>
                      {preview.updated.flatMap((r) =>
                        r.changes.map((ch, i) => (
                          <tr key={`${r.asset_code}-${ch.field}`}>
                            <td data-label="Asset">
                              {i === 0 && (
                                <>
                                  <span className="code">{r.asset_code}</span>
                                  <div className="cell-sub">{r.description}</div>
                                </>
                              )}
                            </td>
                            <td data-label="Field">{FIELD_LABEL[ch.field] || ch.field}</td>
                            <td data-label="Now" className="muted">{shownValue(ch.field, ch.from)}</td>
                            <td data-label="Would become"><strong>{shownValue(ch.field, ch.to)}</strong></td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              {preview.summary.updated > (preview.updated || []).length && (
                <p className="empty">
                  Showing the first {(preview.updated || []).length} of {preview.summary.updated}.
                </p>
              )}
            </section>
          )}

          {tab === 'rejections' && (
            <PreviewTable
              title="Could not be read"
              head={['Sheet', 'Row', 'Code', 'Why']}
              rows={(preview.rejections || []).map((r) => [r.sheet, r.row, r.code || '—', r.reason])}
              total={preview.summary.rejected}
              empty="Every row was readable."
            />
          )}

          {tab === 'warnings' && (
            <PreviewTable
              title="Worth a look"
              head={['Code', 'Description', 'Warning']}
              rows={(preview.warnings || []).map((r) => [r.asset_code, r.description, r.warning])}
              total={preview.warnings?.length || 0}
              empty="Nothing to flag."
            />
          )}
        </>
      )}

      {/* Every import is recorded: who, when, and exactly what it did. None of
          the earlier imports left this trail, which is why their mistakes took
          two days to unpick. */}
      {!preview && batches.length > 0 && (
        <section className="card" style={{ marginTop: '1.5rem' }}>
          <div className="card-head">
            <h2 className="card-title">Previous imports</h2>
            <span className="list-count">{batches.length}</span>
          </div>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>When</th><th>File</th><th>Mode</th>
                  <th>Added</th><th>Updated</th><th>By</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td data-label="When">{new Date(b.imported_at).toLocaleDateString()}</td>
                    <td data-label="File">
                      {b.filename}
                      <div className="cell-sub">{b.rows_read} rows read</div>
                    </td>
                    <td data-label="Mode">
                      <span className="badge badge-neutral">
                        {b.mode === 'add' ? 'Add only' : 'Add and update'}
                      </span>
                    </td>
                    <td data-label="Added">{b.rows_added}</td>
                    <td data-label="Updated">{b.rows_updated}</td>
                    <td data-label="By">{b.imported_by_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function PreviewTable({ title, head, rows, total, empty }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        <span className="list-count">{total}</span>
      </div>

      {rows.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table className="table">
              <thead>
                <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((cell, j) => (
                      <td key={j} data-label={head[j]}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > rows.length && (
            <p className="empty">Showing the first {rows.length} of {total}.</p>
          )}
        </>
      )}
    </section>
  );
}