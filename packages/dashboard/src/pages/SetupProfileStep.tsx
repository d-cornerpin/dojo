// Setup wizard step: the owner's name and the "about you" note. It only reports itself saved
// (and so only opens Next) when the server actually stored them.

import { useState, useEffect } from 'react';
import * as api from '../lib/api';

export const YourProfileStep = ({ onReady }: { onReady?: (ready: boolean) => void }) => {
  const [userName, setUserName] = useState('');
  const [aboutYou, setAboutYou] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { onReady?.(saved); }, [saved, onReady]);

  // Hydrate from existing config so re-running the wizard shows what's already
  // set up instead of forcing re-entry. If it's already configured the step
  // starts "saved" (gate satisfied), so you can step through without changing
  // anything on the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [nameRes, idRes] = await Promise.all([
        api.getSetting('user_name'),
        api.getIdentity('USER.md'),
      ]);
      if (cancelled) return;
      const name = nameRes.ok ? (nameRes.data.value ?? '') : '';
      const about = idRes.ok ? (idRes.data.content ?? '') : '';
      if (name) setUserName(name);
      if (about) setAboutYou(about);
      if (name && about.trim()) setSaved(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setError(null);
    const calls: Array<() => Promise<{ ok: boolean; error?: string }>> = [];
    if (userName.trim()) {
      calls.push(() => api.setSetting('user_name', userName.trim()), () => api.setSetting('owner_name', userName.trim()));
    }
    if (aboutYou.trim()) calls.push(() => api.updateIdentity('USER.md', aboutYou.trim()));
    for (const call of calls) {
      const r = await call();
      if (!r.ok) { setError(r.error ?? 'Could not save your profile.'); return; }
    }
    setSaved(true);
  };

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
          Your work, preferences, projects, communication style — anything you want your agents to know about you.
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
