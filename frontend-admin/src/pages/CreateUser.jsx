import { useState, useEffect } from 'react';
import { createUser, fetchAssetFilters } from '../api';
import { ALL_ROLES, ROLE_NOTE, ROLES } from '../roles';

export default function CreateUser({ onBack, onCreated }) {
  const [form, setForm] = useState({
    name: '', email: '', password: '', role: ROLES.OFFICER, branch: '',
  });
  const [branches, setBranches] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Branch names come from the location table rather than being typed. A
  // Branch Administrator's scope is an exact string match, so "Eldoret " with
  // a trailing space would silently show them nothing.
  useEffect(() => {
    fetchAssetFilters()
      .then((o) => setBranches(o.branches || []))
      .catch(() => setError('Could not load the branch list. Check your connection.'));
  }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const needsBranch = form.role === ROLES.BRANCH_ADMIN;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!form.name.trim() || !form.email.trim() || !form.password) {
      setError('Name, email and password are all required.');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (needsBranch && !form.branch) {
      setError('Choose the branch this administrator is responsible for.');
      return;
    }

    setLoading(true);
    try {
      await createUser({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
        role: form.role,
        // Sent only when it means something. Every other role is unscoped.
        branch: needsBranch ? form.branch : null,
      });
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create this account.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page form-page">
      <button className="btn btn-ghost" onClick={onBack} style={{ marginBottom: '1rem' }}>‹ Back</button>

      <div className="page-head">
        <div>
          <h1 className="page-title">New staff account</h1>
          <p className="page-sub">Gives someone access to the register and the scanner app.</p>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <form className="card" onSubmit={handleSubmit}>
        <div className="card-body">
          <div className="field">
            <label htmlFor="u-name">Full name *</label>
            <input id="u-name" value={form.name} onChange={set('name')} />
          </div>

          <div className="field">
            <label htmlFor="u-email">Email *</label>
            <input
              id="u-email"
              type="email"
              value={form.email}
              onChange={set('email')}
              autoCapitalize="none"
              autoComplete="off"
            />
            <p className="field-hint">This is what they sign in with, on both the panel and the app.</p>
          </div>

          <div className="field">
            <label htmlFor="u-password">Temporary password *</label>
            <input
              id="u-password"
              type="password"
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
            />
            <p className="field-hint">
              At least 8 characters. This is temporary — they'll be asked to choose
              their own the first time they sign in.
            </p>
          </div>

          <div className="field">
            <label htmlFor="u-role">Role *</label>
            <select id="u-role" value={form.role} onChange={set('role')}>
              {ALL_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <p className="field-hint">{ROLE_NOTE[form.role]}</p>
          </div>

          {/* Only shown when it applies. A branch on any other role would sit
              there doing nothing until someone changed the role and wondered
              why the account suddenly saw one branch. */}
          {needsBranch && (
            <div className="field">
              <label htmlFor="u-branch">Branch *</label>
              <select id="u-branch" value={form.branch} onChange={set('branch')}>
                <option value="">— Choose a branch —</option>
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
              <p className="field-hint">
                They will see only the assets at this branch. An account without one
                would see nothing at all, so it's required.
              </p>
            </div>
          )}
        </div>

        <div className="card-body" style={{ borderTop: '1px solid var(--rule)' }}>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </form>
    </div>
  );
}