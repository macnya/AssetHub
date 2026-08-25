import { useState } from 'react';
import { changePassword } from '../api';
import logo from '../assets/logo.png';

const MIN_LENGTH = 8;   // mirrors MIN_PASSWORD_LENGTH on the backend

export default function ChangePassword({ user, forced, onDone, onCancel }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (next.length < MIN_LENGTH) {
      setError(`Your new password must be at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    if (next === current) {
      setError('Your new password must be different from the current one.');
      return;
    }

    setSaving(true);
    try {
      await changePassword({ current_password: current, new_password: next });

      // The stored user carries must_change_password; clear it so the app
      // doesn't send them straight back here on the next render.
      const stored = JSON.parse(localStorage.getItem('user') || '{}');
      localStorage.setItem('user', JSON.stringify({ ...stored, must_change_password: false }));

      onDone({ ...user, must_change_password: false });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not change your password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={handleSubmit}>
        <img src={logo} alt="AssetHub" className="login-logo" />

        <h2 style={{ textAlign: 'center', marginBottom: '0.35rem' }}>
          {forced ? 'Choose your password' : 'Change your password'}
        </h2>
        <p className="page-sub" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          {forced
            ? 'Your account was set up with a temporary password. Choose one only you know before continuing.'
            : `Signed in as ${user?.email}`}
        </p>

        {error && <div className="notice notice-error">{error}</div>}

        <div className="field">
          <label htmlFor="cp-current">{forced ? 'Temporary password' : 'Current password'}</label>
          <input
            id="cp-current"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="cp-new">New password</label>
          <input
            id="cp-new"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            required
          />
          <p className="field-hint">At least {MIN_LENGTH} characters.</p>
        </div>

        <div className="field">
          <label htmlFor="cp-confirm">Repeat new password</label>
          <input
            id="cp-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: '100%', marginTop: '0.5rem' }}>
          {saving ? 'Saving…' : 'Set password'}
        </button>

        {/* Only offered when the change is optional. A forced change has no
            way out short of signing out, which is the point. */}
        {!forced && onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel} style={{ width: '100%', marginTop: '0.5rem' }}>
            Cancel
          </button>
        )}

        {forced && (
          <p className="field-hint" style={{ textAlign: 'center', marginTop: '1rem' }}>
            Changing this signs you out of any other device.
          </p>
        )}
      </form>
    </div>
  );
}