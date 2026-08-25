import { useState, useEffect, useCallback } from 'react';
import {
  fetchFinanceSummary, fetchDisposals, fetchLosses, fetchRecoverable, fetchFinanceExport,
} from '../api';

// Financial reporting over the register.
//
// Deliberately not the operational view. Finance does not need to know which
// labels are printed or who scanned what; they need the figures that reconcile
// to the ledger — cost, net book value, what was written off, and what a leaver
// owes.

const money = (v) =>
  v == null || Number(v) === 0
    ? '—'
    : `KES ${Number(v).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TABS = [
  { key: 'summary',     label: 'Summary' },
  { key: 'disposals',   label: 'Disposals' },
  { key: 'losses',      label: 'Write-offs' },
  { key: 'recoverable', label: 'Recoverable' },
];

export default function Finance({ scopedTo }) {
  const [tab, setTab] = useState('summary');
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const fetcher = {
        summary: fetchFinanceSummary,
        disposals: fetchDisposals,
        losses: fetchLosses,
        recoverable: fetchRecoverable,
      }[tab];
      const result = await fetcher();
      setData((d) => ({ ...d, [tab]: result }));
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || 'Could not load that report.');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Built in the browser rather than on the server: the instance is small, and
  // holding a 2,300-row file in memory to serve one download is a poor trade.
  const exportCsv = async () => {
    setExporting(true);
    try {
      const { rows } = await fetchFinanceExport();
      if (!rows.length) return;

      const headers = Object.keys(rows[0]);
      const escape = (v) => {
        if (v == null) return '';
        const s = String(v);
        // Quote anything containing a comma, quote or newline, and double any
        // internal quotes — asset descriptions contain all three.
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const csv = [
        headers.join(','),
        ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
      ].join('\n');

      // The byte order mark makes Excel open this as UTF-8 rather than mangling
      // any non-ASCII character in a supplier or employee name.
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `asset-register-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not build the export.');
    } finally {
      setExporting(false);
    }
  };

  const current = data[tab];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Finance</h1>
          <p className="page-sub">
            {scopedTo ? `${scopedTo} only` : 'The whole register'} · cost and net book value
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={exportCsv} disabled={exporting}>
            {exporting ? 'Building…' : 'Export to CSV'}
          </button>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <div className="filters" style={{ marginBottom: '1.25rem' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && !current ? (
        <p className="empty">Loading…</p>
      ) : tab === 'summary' ? (
        <Summary d={current} />
      ) : tab === 'disposals' ? (
        <Disposals d={current} />
      ) : tab === 'losses' ? (
        <Losses d={current} />
      ) : (
        <Recoverable d={current} />
      )}
    </div>
  );
}

function Summary({ d }) {
  if (!d) return null;

  const cost = d.by_category.reduce((s, r) => s + Number(r.cost || 0), 0);
  const nbv = d.by_category.reduce((s, r) => s + Number(r.nbv || 0), 0);
  const assets = d.by_category.reduce((s, r) => s + r.assets, 0);

  return (
    <>
      <div className="stats" style={{ marginBottom: '1rem' }}>
        <div className="stat">
          <div className="stat-label">Assets</div>
          <div className="stat-value">{assets.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="stat-label">At cost</div>
          <div className="stat-value is-accent">{money(cost)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Net book value</div>
          <div className="stat-value">{money(nbv)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">No cost recorded</div>
          <div className="stat-value">{d.assets_without_a_cost}</div>
        </div>
      </div>

      {/* A total that quietly excludes assets is how this register once
          understated itself by a factor of sixty-six. Better shown than
          discovered. */}
      {d.assets_without_a_cost > 0 && (
        <div className="notice notice-info">
          {d.assets_without_a_cost} asset{d.assets_without_a_cost === 1 ? ' has' : 's have'} no
          purchase price on record, so the totals above exclude {d.assets_without_a_cost === 1 ? 'it' : 'them'}.
        </div>
      )}

      <Table
        title="By category"
        head={['Category', 'Assets', 'At cost', 'Accumulated depreciation', 'Net book value']}
        rows={d.by_category.map((r) => [
          r.category, r.assets, money(r.cost), money(r.accumulated_depreciation), money(r.nbv),
        ])}
      />

      <Table
        title="By status"
        head={['Status', 'Assets', 'At cost', 'Net book value']}
        rows={d.by_status.map((r) => [r.status, r.assets, money(r.cost), money(r.nbv)])}
      />

      <Table
        title="By branch"
        head={['Branch', 'Assets', 'At cost', 'Net book value']}
        rows={d.by_branch.map((r) => [r.branch, r.assets, money(r.cost), money(r.nbv)])}
      />
    </>
  );
}

function Disposals({ d }) {
  if (!d) return null;
  return (
    <>
      <div className="stats" style={{ marginBottom: '1rem' }}>
        <div className="stat">
          <div className="stat-label">Disposed</div>
          <div className="stat-value">{d.count}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Gross value</div>
          <div className="stat-value">{money(d.total_gross)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">NBV at disposal</div>
          <div className="stat-value">{money(d.total_nbv)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Proceeds</div>
          <div className="stat-value">{money(d.total_proceeds)}</div>
        </div>
        {/* Gain or loss is the figure that reaches the accounts, so it is the
            one given the accent. Negative is shown in red because a loss read
            as a gain is the kind of mistake a colour prevents. */}
        <div className="stat">
          <div className="stat-label">Gain or loss</div>
          <div className={Number(d.total_gain_or_loss) < 0 ? 'stat-value is-loss' : 'stat-value is-accent'}>
            {money(d.total_gain_or_loss)}
          </div>
        </div>
      </div>

      <Table
        title="Disposals"
        head={['Asset', 'Category', 'Month', 'Gross', 'NBV', 'Proceeds', 'Gain / loss']}
        rows={d.disposals.map((r) => [
          `${r.asset_code} — ${r.description}`,
          r.category || '—',
          r.disposal_month
            ? new Date(r.disposal_month).toLocaleDateString('en-KE', { year: 'numeric', month: 'short' })
            : '—',
          money(r.base_gross_value),
          money(r.nbv_at_disposal),
          money(r.sales_proceeds),
          money(r.gain_or_loss),
        ])}
        empty="No disposals recorded."
      />
    </>
  );
}

function Losses({ d }) {
  if (!d) return null;
  return (
    <>
      <div className="stats" style={{ marginBottom: '1rem' }}>
        <div className="stat">
          <div className="stat-label">Written off</div>
          <div className="stat-value">{d.count}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Original cost</div>
          <div className="stat-value">{money(d.total_cost)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Net book value</div>
          <div className="stat-value is-accent">{money(d.total_nbv)}</div>
        </div>
      </div>

      <Table
        title="Write-offs"
        head={['Asset', 'Category', 'Reported', 'Last held by', 'At cost', 'NBV']}
        rows={d.losses.map((r) => [
          `${r.asset_code} — ${r.description}`,
          r.category || '—',
          r.reported_date ? new Date(r.reported_date).toLocaleDateString() : '—',
          r.last_held_by || '—',
          money(r.purchase_price),
          money(r.nbv),
        ])}
        empty="Nothing written off."
      />
    </>
  );
}

function Recoverable({ d }) {
  if (!d) return null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="stats" style={{ marginBottom: '1rem' }}>
        <div className="stat">
          <div className="stat-label">Owed, to deduct</div>
          <div className="stat-value is-accent">{money(d.total_owed)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Still unresolved</div>
          <div className="stat-value">{money(d.total_unresolved)}</div>
        </div>
      </div>

      {/* 8.10.2 makes this Finance's figure, not IT's — it is deducted from
          final dues, and the three-month deadline is theirs to watch. */}
      <div className="notice notice-info">
        HR Manual 8.10.2 — where a leaver does not return an asset, its value is deducted from
        their final dues, and the process must be started within three months of their exit.
      </div>

      <Table
        title="Owed"
        head={['Employee', 'Branch', 'Last working day', 'Items', 'Amount', 'Deadline']}
        rows={d.owed.map((r) => [
          r.employee,
          r.branch || '—',
          r.last_working_day || '—',
          r.items,
          money(r.amount),
          r.deadline < today ? `${r.deadline} — overdue` : r.deadline,
        ])}
        empty="Nothing currently owed."
      />

      <Table
        title="Unresolved on an open clearance"
        head={['Employee', 'Items', 'Value', 'Deadline']}
        rows={d.unresolved.map((r) => [
          r.employee, r.items, money(r.amount),
          r.deadline < today ? `${r.deadline} — overdue` : r.deadline,
        ])}
        empty="Nothing outstanding."
      />
    </>
  );
}

// One table shape for all four reports. Numeric columns right-align, which is
// the only way a column of money is readable.
function Table({ title, head, rows, empty }) {
  return (
    <section className="card" style={{ marginBottom: '1rem' }}>
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        <span className="list-count">{rows.length}</span>
      </div>

      {rows.length === 0 ? (
        <p className="empty">{empty || 'Nothing to show.'}</p>
      ) : (
        <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
          <table className="table">
            <thead>
              <tr>
                {head.map((h, i) => (
                  <th key={h} className={i > 0 ? 'is-num' : undefined}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    <td key={j} data-label={head[j]} className={j > 0 ? 'is-num' : undefined}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}