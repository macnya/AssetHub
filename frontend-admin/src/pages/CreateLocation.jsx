import { useState } from 'react';
import api from '../api';

export default function CreateLocation({ onBack, onCreated }) {
  const [form, setForm] = useState({ branch: '', department: '', physicalLocation: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.branch.trim()) {
      setError('Branch is required.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/locations', {
        branch: form.branch.trim(),
        department: form.department.trim() || null,
        physical_location: form.physicalLocation.trim() || null,
      });
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create this location.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page form-page">
      <button className="btn btn-ghost" onClick={onBack} style={{ marginBottom: '1rem' }}>‹ Back</button>

      <div className="page-head">
        <div>
          <h1 className="page-title">New location</h1>
          <p className="page-sub">A place an asset can live — a branch, a room, a store.</p>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <form className="card" onSubmit={handleSubmit}>
        <div className="card-body">
          <div className="field">
            <label htmlFor="l-branch">Branch *</label>
            <input id="l-branch" value={form.branch} onChange={set('branch')} />
          </div>

          <div className="field">
            <label htmlFor="l-dept">Department</label>
            <input id="l-dept" value={form.department} onChange={set('department')} />
          </div>

          <div className="field">
            <label htmlFor="l-place">Physical location</label>
            <input id="l-place" placeholder="e.g. Server room, Reception desk" value={form.physicalLocation} onChange={set('physicalLocation')} />
            <p className="field-hint">
              A place, not a person. Assign assets to people through the employee list —
              putting names here is what made half the location records staff members.
            </p>
          </div>
        </div>

        <div className="card-body" style={{ borderTop: '1px solid var(--rule)' }}>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Saving…' : 'Create location'}
          </button>
        </div>
      </form>
    </div>
  );
}