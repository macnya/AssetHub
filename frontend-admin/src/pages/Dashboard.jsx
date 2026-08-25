import { useState, useEffect } from 'react';
import { fetchDashboardStats } from '../api';

// Kept in one place so the pie, the legend and any future chart agree.
const CATEGORY_COLORS = [
  '#0D7C74', '#2E86AB', '#4C9F70', '#8E44AD',
  '#C0392B', '#D4A017', '#16A085', '#7F8C9A',
];

export default function Dashboard({ onNavigate }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchDashboardStats()
      .then(setStats)
      .catch((err) => {
        console.error(err);
        setError('Could not load the dashboard. Check your connection and try again.');
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="page"><p className="empty">Loading dashboard…</p></div>;
  if (error || !stats) {
    return (
      <div className="page">
        <div className="notice notice-error">{error || 'Failed to load dashboard.'}</div>
      </div>
    );
  }

  // Each slice needs its start and end angle, which means a running total.
  // Done as a prefix sum rather than a mutable counter: the React Compiler
  // lint objects to reassigning a render-scope variable inside a callback, and
  // it's right to — with ~8 categories the cost of recomputing is nil.
  const totalCategories = stats.categories.reduce((sum, c) => sum + c.count, 0);
  const percents = stats.categories.map((c) =>
    totalCategories > 0 ? (c.count / totalCategories) * 100 : 0
  );
  const pieStops = percents.map((percent, i) => {
    const from = percents.slice(0, i).reduce((a, b) => a + b, 0);
    return `${CATEGORY_COLORS[i % CATEGORY_COLORS.length]} ${from}% ${from + percent}%`;
  });
  const pie = `conic-gradient(${pieStops.join(', ')})`;

  const maxBranch = Math.max(1, ...stats.assetsByBranch.map((b) => b.count));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-sub">
            {stats.totalAssets.toLocaleString()} assets across {stats.branches} branches
          </p>
        </div>
      </div>

      {/* Tiles are the entry point to a filtered list, so the ones that lead
          somewhere are buttons, not divs. */}
      <div className="stats">
        <Stat label="Total assets" value={stats.totalAssets} accent onClick={() => onNavigate('list', '')} />
        <Stat label="Assigned"     value={stats.assigned}    onClick={() => onNavigate('list', 'Assigned')} />
        <Stat label="In stock"     value={stats.inStock}     onClick={() => onNavigate('list', 'In Stock')} />
        <Stat label="Disposed"     value={stats.disposed}    onClick={() => onNavigate('list', 'Disposed')} />
        <Stat label="Lost"         value={stats.lost}        onClick={() => onNavigate('list', 'Lost')} />
        <Stat label="Employees"    value={stats.employees} />
        <Stat label="Branches"     value={stats.branches} onClick={() => onNavigate('branches')} />
      </div>

      <div className="dash-grid">
        <section className="card">
          <div className="card-head"><h2 className="card-title">Assets by category</h2></div>
          <div className="card-body dash-pie">
            <div className="pie" style={{ background: pie }} aria-hidden="true" />
            <ul className="legend">
              {stats.categories.map((cat, i) => (
                <li key={cat.name}>
                  <span className="legend-dot" style={{ background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />
                  <span className="legend-name">{cat.name}</span>
                  <span className="legend-count">{cat.count}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2 className="card-title">Assets by branch</h2></div>
          <div className="card-body">
            {stats.assetsByBranch.map((b) => (
              <div key={b.branch} className="bar-row">
                <div className="bar-head">
                  <span className="bar-name">{b.branch}</span>
                  <span className="bar-count">{b.count}</span>
                </div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(b.count / maxBranch) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card" style={{ marginTop: '1rem' }}>
        <div className="card-head"><h2 className="card-title">Recent activity</h2></div>
        <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Action</th>
                <th>Asset</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {stats.recentActivity.map((a, i) => (
                <tr key={i}>
                  <td data-label="Date">{new Date(a.timestamp).toLocaleString()}</td>
                  <td data-label="Action"><span className="badge badge-neutral">{a.action}</span></td>
                  <td data-label="Asset"><span className="code">{a.asset_code}</span></td>
                  <td data-label="Description">{a.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {stats.recentActivity.length === 0 && (
          <p className="empty">No activity recorded yet.</p>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, accent, onClick }) {
  const content = (
    <>
      <div className="stat-label">{label}</div>
      <div className={accent ? 'stat-value is-accent' : 'stat-value'}>
        {Number(value).toLocaleString()}
      </div>
    </>
  );

  if (!onClick) return <div className="stat">{content}</div>;

  return (
    <button type="button" className="stat is-link" onClick={onClick}>
      {content}
    </button>
  );
}