import { useState, useEffect } from 'react';
import { createAsset, fetchAssetFilters } from '../api';

export default function CreateAsset({ onBack, onCreated }) {
  const [options, setOptions] = useState({ categories: [], conditions: [] });
  const [form, setForm] = useState({
    assetCode: '', description: '', categoryId: '', serialNumber: '',
    datePurchased: '', purchasePrice: '', supplier: '', condition: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Conditions come from the backend rather than being hardcoded. This form
  // used to offer "Fair", which the API rejects with a 400 — the condition
  // vocabulary is Good / Good with issues / Faulty.
  useEffect(() => {
    fetchAssetFilters()
      .then((o) => {
        setOptions(o);
        setForm((f) => ({
          ...f,
          categoryId: o.categories[0] ? String(o.categories[0].id) : '',
          condition: o.conditions[0] || '',
        }));
      })
      .catch(() => setError('Could not load categories. Check your connection.'));
  }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.assetCode.trim() || !form.description.trim()) {
      setError('Asset code and description are both required.');
      return;
    }
    setLoading(true);
    try {
      await createAsset({
        asset_code: form.assetCode.trim(),
        description: form.description.trim(),
        asset_category_id: form.categoryId ? parseInt(form.categoryId, 10) : null,
        serial_number: form.serialNumber.trim() || null,
        date_of_purchase: form.datePurchased || null,
        purchase_price: form.purchasePrice ? parseFloat(form.purchasePrice) : null,
        supplier: form.supplier.trim() || null,
        condition: form.condition || null,
      });
      onCreated(form.assetCode.trim());
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create this asset.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page form-page">
      <button className="btn btn-ghost" onClick={onBack} style={{ marginBottom: '1rem' }}>‹ Back</button>

      <div className="page-head">
        <div>
          <h1 className="page-title">New asset</h1>
          <p className="page-sub">Adds a record to the register. Print its barcode afterwards.</p>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <form className="card" onSubmit={handleSubmit}>
        <div className="card-body">
          <div className="field">
            <label htmlFor="a-code">Asset code *</label>
            <input
              id="a-code"
              className="is-mono"
              placeholder="e.g. KDT003000"
              value={form.assetCode}
              onChange={set('assetCode')}
              autoCapitalize="characters"
            />
            <p className="field-hint">Must match the barcode label you attach. Cannot be changed later.</p>
          </div>

          <div className="field">
            <label htmlFor="a-desc">Description *</label>
            <input id="a-desc" placeholder="e.g. HP EliteBook 840 laptop" value={form.description} onChange={set('description')} />
          </div>

          <div className="field">
            <label htmlFor="a-cat">Category</label>
            <select id="a-cat" value={form.categoryId} onChange={set('categoryId')}>
              <option value="">— None —</option>
              {options.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <div className="field">
            <label htmlFor="a-serial">Serial number</label>
            <input id="a-serial" className="is-mono" value={form.serialNumber} onChange={set('serialNumber')} autoCapitalize="characters" />
          </div>

          <div className="form-row">
            <div className="field">
              <label htmlFor="a-date">Date of purchase</label>
              <input id="a-date" type="date" value={form.datePurchased} onChange={set('datePurchased')} />
            </div>
            <div className="field">
              <label htmlFor="a-price">Purchase price</label>
              <input id="a-price" type="number" step="0.01" placeholder="KES" value={form.purchasePrice} onChange={set('purchasePrice')} />
            </div>
          </div>

          <div className="field">
            <label htmlFor="a-supplier">Supplier</label>
            <input id="a-supplier" value={form.supplier} onChange={set('supplier')} />
          </div>

          <div className="field">
            <label htmlFor="a-condition">Condition</label>
            <select id="a-condition" value={form.condition} onChange={set('condition')}>
              <option value="">Not yet verified</option>
              {options.conditions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <p className="field-hint">Leave as not verified unless you have physically inspected it.</p>
          </div>
        </div>

        <div className="card-body" style={{ borderTop: '1px solid var(--rule)' }}>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Creating…' : 'Create asset'}
          </button>
        </div>
      </form>
    </div>
  );
} 