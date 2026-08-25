import { useState, useEffect, useMemo } from 'react';
import { fetchBranchTree } from '../api';

export default function Branches({ onSelectBranch }) {
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null);        // which branch is expanded

  useEffect(() => {
    fetchBranchTree()
      .then(setBranches)
      .catch((err) => {
        console.error(err);
        setError('Could not load the branch structure.');
      })
      .finally(() => setLoading(false));
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) =>
      [b.branch, b.region, ...b.departments.map((d) => d.name), ...b.programmes.map((p) => p.name)]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))
    );
  }, [branches, query]);

  const totals = useMemo(() => ({
    assets: branches.reduce((s, b) => s + b.assets, 0),
    regions: new Set(branches.map((b) => b.region).filter(Boolean)).size,
    programmes: new Set(branches.flatMap((b) => b.programmes.map((p) => p.name))).size,
  }), [branches]);

  if (loading) return <div className="page"><p className="empty">Loading branches…</p></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Branches</h1>
          <p className="page-sub">
            {branches.length} branches · {totals.programmes} programmes · {totals.regions} regions ·{' '}
            {totals.assets.toLocaleString()} assets currently held
          </p>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      {/* Branch counts are of assets someone currently holds. Anything in
          storage has no assignment and therefore no branch, so this will not
          match the register total — and the difference is worth knowing. */}
      <div className="notice notice-info">
        These counts cover assets currently assigned. Anything sitting in storage has no
        branch, so the totals here fall short of the full register.
      </div>

      <div className="filters" style={{ marginBottom: '1.25rem' }}>
        <input
          type="search"
          placeholder="Search branch, region, department or programme…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 'auto', minWidth: '20rem' }}
        />
        {query && (
          <button className="btn btn-ghost btn-sm" onClick={() => setQuery('')}>Clear</button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="card"><p className="empty">No branches match that search.</p></div>
      ) : (
        <div className="branch-list">
          {visible.map((b) => {
            const expanded = open === b.branch;
            const hasDetail = b.departments.length || b.programmes.length || b.places.length;

            return (
              <div key={b.branch} className="card branch-card">
                <div className="branch-head">
                  <button
                    className="branch-toggle"
                    onClick={() => setOpen(expanded ? null : b.branch)}
                    disabled={!hasDetail}
                    aria-expanded={expanded}
                  >
                    <span className={expanded ? 'branch-caret is-open' : 'branch-caret'}>
                      {hasDetail ? '›' : ''}
                    </span>
                    <span className="branch-name">{b.branch}</span>
                    {b.region && <span className="badge badge-neutral">{b.region} region</span>}
                  </button>

                  <div className="branch-meta">
                    <span className="branch-count">{b.assets.toLocaleString()}</span>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => onSelectBranch(b.branch)}
                    >
                      View assets
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="branch-body">
                    <Group title="Departments" items={b.departments} />
                    <Group title="Programmes" items={b.programmes} />
                    <Group title="Places" items={b.places} />
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

function Group({ title, items }) {
  if (!items.length) return null;
  return (
    <div className="branch-group">
      <div className="card-title" style={{ marginBottom: '0.5rem' }}>{title}</div>
      <ul className="branch-items">
        {items.map((i) => (
          <li key={i.name}>
            <span>{i.name}</span>
            <span className="branch-item-count">{i.assets}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}