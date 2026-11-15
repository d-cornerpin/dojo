// Setup wizard step: the owner's name and the "about you" note. It only reports itself saved
// (and so only opens Next) when the server actually stored them.

import { useState, useEffect } from 'react';
import * as api from '../lib/api';

export const YourProfileStep = ({ onReady }: { onReady?: (ready: boolean) => void }) => {
  const [userName, setUserName] = useState('');
  const [aboutYou, setAboutYou] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadTry, setLoadTry] = useState(0);

  useEffect(() => { onReady?.(saved); }, [saved, onReady]);

  // Hydrate from existing config so re-running the wizard shows what's already
  // set up instead of forcing re-entry. If it's already configured the step
  // starts "saved" (gate satisfied), so you can step through without changing
  // anything on the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [nameRes, idRes] = await Promise.all([
        api.getSetting('owner_name'),
        api.getIdentity('USER.md'),
      ]);
      if (cancelled) return;
      // A failed read of the saved settings is not "nothing saved": nothing here may be saved from it.
      if (!(nameRes.ok && idRes.ok)) { setLoadFailed(true); return; }
      setLoadFailed(false);
      const name = nameRes.ok ? (nameRes.data.value ?? '') : '';
      const about = idRes.ok ? (idRes.data.content ?? '') : '';
      if (name) setUserName(name);
      if (about) setAboutYou(about);
      if (name && about.trim()) setSaved(true);
    })();
    return () => { cancelled = true; };
  }, [loadTry]);

  const handleSave = async () => {
    setError(null);
    const calls: Array<() => Promise<{ ok: boolean; error?: string }>> = [];
    if (userName.trim()) {
      calls.push(() => api.setSetting('owner_name', userName.trim()));
    }
    if (aboutYou.trim()) calls.push(() => api.updateIdentity('USER.md', aboutYou.trim()));
    for (const call of calls) {
      const r = await call();
      if (!r.ok) { setError(r.error ?? 'Could not save your profile.'); return; }
    }
    setSaved(true);
  };

  if (loadFailed) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-cp-coral">
          Could not load your saved settings for this step, so it can&apos;t be changed right now. Nothing has been changed.
        </p>
        <button onClick={() => setLoadTry((n) => n + 1)} className="px-4 py-2 text-ui text-sm font-medium rounded-lg glass-btn glass-btn-primary">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ui/55">
        Tell us about yourself. Your agents will use this information to personalize their interactions with you.
        You can update this anytime in Settings &gt; Profile.
      </p>

      <div>
        <label className="block text-sm font-medium text-ui/70 mb-1">Your Name</label>
        <input type="text" value={userName} onChange={(e) => { setUserName(e.target.value); setSaved(false); }} placeholder="e.g., Alex"
          className="glass-input" />
      </div>

      <div>
        <label className="block text-sm font-medium text-ui/70 mb-1">About You</label>
        <p className="text-xs text-ui/40 mb-2">
          Your work, preferences, projects, communication style, anything you want your agents to know about you.
        </p>
        <textarea value={aboutYou} onChange={(e) => { setAboutYou(e.target.value); setSaved(false); }} rows={5}
          placeholder="I run a small tech company in Seattle. I prefer concise, direct communication..."
          className="glass-textarea resize-none" />
      </div>

      {saved && (
        <div className="px-3 py-2 rounded-lg glass-badge-teal border border-cp-teal/20 text-sm">Profile saved!</div>
      )}
      {error && <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{error}</div>}

      <button onClick={handleSave} disabled={!userName.trim() || !aboutYou.trim() || saved}
        className={`px-4 py-2 text-ui text-sm font-medium rounded-lg transition-colors ${
          saved ? 'bg-cp-teal text-[var(--btn-success-text)] font-semibold' : 'glass-btn glass-btn-primary'
        }`}>
        {saved ? '\u2713 Profile Saved' : 'Save Profile'}
      </button>
    </div>
  );
};
