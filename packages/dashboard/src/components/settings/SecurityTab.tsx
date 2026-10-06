// ── Settings → The Security tab. `SudoPolicyCard` travels with it because the page renders the two as one
// section (`<><SudoPolicyCard /><SecurityTab /></>`) — two component names, one tab.
//
// Lifted OUT of `pages/Settings.tsx` by t111-E1. The moved lines are VERBATIM; the only new
// bytes are this header, the imports below and the `export` keyword(s).

import { useState, useEffect, type FormEvent } from 'react';
import * as api from '../../lib/api';
import {
  SUDO_FLOOR_NOTE, SUDO_POLICY_DEFAULT, SUDO_POLICY_HINTS, SUDO_POLICY_KEY, SUDO_POLICY_LABELS,
  SUDO_POLICY_ORDER, readSudoPolicy, sudoPolicyWarning, type SudoPolicy,
} from '../../lib/sudo-policy';


// ── Security Tab ──

/**
 * The sudo policy (owner ruling 2026-09-26, ships v3.2.2).
 *
 * Every decision — the order, the labels, the hints, what an unknown stored value means, and the
 * floor note that must show under ALL THREE values — lives in `lib/sudo-policy.ts`, so a test can ask
 * about it without mounting this page. This component only renders and saves.
 */
export const SudoPolicyCard = () => {
  const [policy, setPolicy] = useState<SudoPolicy>(SUDO_POLICY_DEFAULT);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await api.getSetting(SUDO_POLICY_KEY);
      setPolicy(readSudoPolicy(r.ok ? r.data.value : null));
      setLoaded(true);
    })();
  }, []);

  const choose = async (next: SudoPolicy) => {
    setPolicy(next);
    setSaving(true);
    setSaved(false);
    const r = await api.setSetting(SUDO_POLICY_KEY, next);
    setSaving(false);
    if (r.ok) setSaved(true);
  };

  const warning = sudoPolicyWarning(policy);
  return (
    <div className="tile space-y-3 max-w-4xl" data-testid="sudo-policy-card">
      <div className="scard__title">Administrator privileges</div>
      <p className="text-xs text-ui/40">
        This Mac is your main agent&rsquo;s machine. Choose how much it may do as administrator
        &mdash; every other agent is refused admin rights whatever you pick. One setting covers both doors:
        <code>sudo</code> and the macOS &ldquo;with administrator privileges&rdquo; prompt.
      </p>
      <div>
        <label className="flabel" htmlFor="sudo-policy">admin privileges policy</label>
        <select
          id="sudo-policy"
          aria-label="admin privileges policy"
          value={policy}
          disabled={!loaded || saving}
          onChange={(e) => void choose(e.target.value as SudoPolicy)}
          className="finput disabled:opacity-60"
        >
          {SUDO_POLICY_ORDER.map((p) => (
            <option key={p} value={p}>{SUDO_POLICY_LABELS[p]}</option>
          ))}
        </select>
        <p className="text-xs text-ui/25 mt-1">{SUDO_POLICY_HINTS[policy]}</p>
      </div>
      {warning && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
          {warning}
        </div>
      )}
      <p className="text-xs text-ui/25">{SUDO_FLOOR_NOTE}</p>
      {saved && <p className="text-xs text-cp-green">Saved.</p>}
    </div>
  );
};

export const SecurityTab = () => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(false);

    const result = await api.changePassword(currentPassword, newPassword);
    if (result.ok) {
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } else {
      setError(result.error);
    }
    setSaving(false);
  };

  return (
    <form onSubmit={handleSubmit} className="tile space-y-4 max-w-4xl">
      <div className="scard__title">Change Password</div>

      <div>
        <label className="flabel">Current Password</label>
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="finput"
        />
      </div>

      <div>
        <label className="flabel">New Password</label>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="At least 8 characters"
          className="finput"
        />
      </div>

      <div>
        <label className="flabel">Confirm New Password</label>
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="finput"
        />
      </div>

      {error && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
          {error}
        </div>
      )}

      {success && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
          Password changed successfully!
        </div>
      )}

      <button
        type="submit"
        disabled={saving || !currentPassword || !newPassword || !confirmPassword}
        className="btn btn--primary"
      >
        {saving ? 'Changing...' : 'Change Password'}
      </button>
    </form>
  );
};
