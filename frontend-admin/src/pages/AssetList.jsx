import { useState, useEffect, useCallback } from 'react';
import { fetchAssets, fetchAssetFilters } from '../api';

const PAGE_SIZE = 50;

const SORTS = [
  { value: 'code',        label: 'Asset code' },
  { value: 'newest',      label: 'Recently added' },
  { value: 'oldest',      label: 'Oldest first' },
  { value: 'value',       label: 'Highest value' },
  { value: 'description', label: 'Description A–Z' },
];

const EMPTY = { search: '', status: '', category: '', branch: '', assigned: '', sort: 'code' };

// Status carries meaning, so it carries colour: green in stock, navy assigned,
// red disposed, amber lost.
const STATUS_BADGE = {
  'In Stock': 'badge-good',
  'Assigned': 'badge-deep',
  'Disposed': 'badge-bad',
  'Lost':     'badge-warn',
};

export default function AssetList({
  onSelectAsset, initialStatus = '', initialBranch = '',
  canCreate, canManage, onNewAsset, onNewEmployee, onNewLocation,
}) {
  const [assets, setAssets] = useState([]);
  const [total, setTotal] = useState(0);
  const [options, setOptions] = useState({ categories: [], branches: [], statuses: [] });

  // `search` is what's in the box; `filters.search` is what's been submitted.
  // Without that split every keystroke would refire the request and reset paging.
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({
    ...EMPTY, status: initialStatus, branch: initialBranch,
  });

  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchAssetFilters()
      .then(setOptions)
      .catch(() => { /* filter bar degrades to text search; not worth an error banner */ });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchAssets({ ...filters, limit: PAGE_SIZE, offset: 0 });
      setAssets(result.data);
      setTotal(result.total);
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || 'Could not load assets. Please try again.');
      setAssets([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    setError('');
    try {
      const result = await fetchAssets({ ...filters, limit: PAGE_SIZE, offset: assets.length });
      setAssets((prev) => [...prev, ...result.data]);
      setTotal(result.total);
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || 'Could not load more assets.');
    } finally {
      setLoadingMore(false);
    }
  };

  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));

  const submitSearch = (e) => {
    e.preventDefault();
    setFilters((f) => ({ ...f, search: search.trim() }));
  };

  const clearAll = () => {
    setSearch('');
    setFilters({ ...EMPTY });
  };

  const activeCount = Object.entries(filters).filter(([k, v]) => k !== 'sort' && v).length;
  const hasMore = assets.length < total;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Assets</h1>
          <p className="page-sub">
            {total.toLocaleString()} in the register
            {activeCount > 0 ? ' matching your filters' : ''}
          </p>
        </div>

        <div className="page-actions">
          {canCreate && <button className="btn btn-primary" onClick={onNewAsset}>New asset</button>}
          {canManage && <button className="btn btn-secondary" onClick={onNewEmployee}>New employee</button>}
          {canManage && <button className="btn btn-secondary" onClick={onNewLocation}>New location</button>}
        </div>
      </div>

      <form className="toolbar-search" onSubmit={submitSearch} style={{ marginBottom: '0.75rem' }}>
        <input
          type="search"
          placeholder="Search by asset code or description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="submit" className="btn btn-primary">Search</button>
      </form>

      <div className="filters" style={{ marginBottom: '1.25rem' }}>
        <select value={filters.status} onChange={set('status')}>
          <option value="">All statuses</option>
          {options.statuses.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>

        <select value={filters.category} onChange={set('category')}>
          <option value="">All categories</option>
          {options.categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>

        <select value={filters.branch} onChange={set('branch')}>
          <option value="">All branches</option>
          {options.branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        <select value={filters.assigned} onChange={set('assigned')}>
          <option value="">Assigned or not</option>
          <option value="yes">Assigned to someone</option>
          <option value="no">Not assigned</option>
        </select>

        <select value={filters.sort} onChange={set('sort')}>
          {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>

        {activeCount > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={clearAll}>
            Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      {loading ? (
        <p className="empty">Loading assets…</p>
      ) : assets.length === 0 ? (
        <div className="card">
          <p className="empty">
            {activeCount > 0
              ? 'No assets match these filters. Try clearing one.'
              : 'No assets in the register yet.'}
          </p>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Assigned to</th>
                  <th>Branch</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id} className="is-clickable" onClick={() => onSelectAsset(a.asset_code)}>
                    <td data-label="Code"><span className="code">{a.asset_code}</span></td>
                    <td data-label="Description">{a.description}</td>
                    <td data-label="Category">{a.category_name || '—'}</td>
                    <td data-label="Status">
                      <span className={`badge ${STATUS_BADGE[a.status] || 'badge-neutral'}`}>{a.status}</span>
                    </td>
                    <td data-label="Assigned to">{a.employee_name || '—'}</td>
                    <td data-label="Branch">{a.branch || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="list-foot">
            <span className="list-count">Showing {assets.length} of {total.toLocaleString()}</span>
            {hasMore && (
              <button className="btn btn-secondary btn-sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : `Load next ${Math.min(PAGE_SIZE, total - assets.length)}`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}