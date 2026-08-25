import { useState } from 'react';
import api from '../api';

export default function CreateEmployee({ onBack, onCreated }) {
  const [form, setForm] = useState({ name: '', department: '', branch: '', email: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) {
      setError('Name is required.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/employees', {
        name: form.name.trim(),
        department: form.department.trim() || null,
        branch: form.branch.trim() || null,
        email: form.email.trim().toLowerCase() || null,
      });
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create this employee.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page form-page">
      <button className="btn btn-ghost" onClick={onBack} style={{ marginBottom: '1rem' }}>‹ Back</button>

      <div className="page-head">
        <div>
          <h1 className="page-title">New employee</h1>
          <p className="page-sub">Someone who can be assigned custody of an asset.</p>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <form className="card" onSubmit={handleSubmit}>
        <div className="card-body">
          <div className="field">
            <label htmlFor="e-name">Full name *</label>
            <input id="e-name" value={form.name} onChange={set('name')} />
            <p className="field-hint">Use the same spelling as the HR record, so custody reports match.</p>
          </div>

          <div className="form-row">
            <div className="field">
              <label htmlFor="e-branch">Branch</label>
              <input id="e-branch" value={form.branch} onChange={set('branch')} />
            </div>
            <div className="field">
              <label htmlFor="e-dept">Department</label>
              <input id="e-dept" value={form.department} onChange={set('department')} />
            </div>
          </div>

          <div className="field">
            <label htmlFor="e-email">Email</label>
            <input id="e-email" type="email" value={form.email} onChange={set('email')} autoCapitalize="none" />
          </div>
        </div>

        <div className="card-body" style={{ borderTop: '1px solid var(--rule)' }}>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Saving…' : 'Create employee'}
          </button>
        </div>
      </form>
    </div>
  );
}