// ── Settings → The Profile tab: the owner profile and the identity files behind it.
//
// Lifted OUT of `pages/Settings.tsx` by t111-E1. The moved lines are VERBATIM; the only new
// bytes are this header, the imports below and the `export` keyword(s).

import { useState, useEffect } from 'react';
import * as api from '../../lib/api';

type OwnerMailboxRow = { address: string; provider: 'google' | 'microsoft'; accountId: string };
const PROVIDER_LABEL: Record<OwnerMailboxRow['provider'], string> = { google: 'Google', microsoft: 'Microsoft' };


// ── Profile Tab ──

export const ProfileTab = () => {
  const [userName, setUserName] = useState('');
  const [userProfile, setUserProfile] = useState('');
  const [loadingName, setLoadingName] = useState(true);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [savingName, setSavingName] = useState(false);
  const [savedName, setSavedName] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savedProfile, setSavedProfile] = useState(false);
  const [mailboxes, setMailboxes] = useState<OwnerMailboxRow[]>([]);

  useEffect(() => {
    const load = async () => {
      const nameResult = await api.getSetting('user_name');
      if (nameResult.ok && nameResult.data.value) setUserName(nameResult.data.value);
      setLoadingName(false);

      const profileResult = await api.getIdentity('USER.md');
      if (profileResult.ok) {
        setUserProfile(profileResult.data.content);
        setMailboxes(profileResult.data.mailboxes ?? []);
      }
      setLoadingProfile(false);
    };
    load();
  }, []);

  const handleSaveName = async () => {
    setSavingName(true);
    setSavedName(false);
    const result = await api.setSetting('user_name', userName.trim());
    if (result.ok) { setSavedName(true); setTimeout(() => setSavedName(false), 2000); }
    setSavingName(false);
  };

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    setSavedProfile(false);
    const result = await api.updateIdentity('USER.md', userProfile);
    if (result.ok) { setSavedProfile(true); setTimeout(() => setSavedProfile(false), 2000); }
    setSavingProfile(false);
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Your Name */}
      <div className="tile space-y-3">
        <div className="scard__title">Your Name</div>
        <div className="scard__desc">Used in memory summaries and agent conversations to identify you.</div>
        {loadingName ? (
          <div className="h-10 glass-nested rounded-xl animate-pulse" />
        ) : (
          <>
            <input
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="e.g., Alex"
              className="finput"
            />
            <div className="srow">
              <button type="button" onClick={handleSaveName} disabled={savingName || !userName.trim()}
                className="btn btn--primary btn--sm">
                {savingName ? 'Saving...' : 'Save'}
              </button>
              {savedName && <span className="text-xs text-cp-teal">Saved!</span>}
            </div>
          </>
        )}
      </div>

      {/* Your Mailboxes (owner ruling 2026-10-27): read-only, filled from the owner's connected accounts */}
      <div className="tile space-y-3">
        <div className="scard__title">Your Mailboxes</div>
        <div className="scard__desc">
          Filled in automatically from the Google and Microsoft accounts you connect as your own
          (Settings, Google and Microsoft). Disconnect an account there to remove it here.
        </div>
        {loadingProfile ? (
          <div className="h-10 glass-nested rounded-xl animate-pulse" />
        ) : mailboxes.length === 0 ? (
          <div className="scard__desc" style={{ marginBottom: 0 }}>None yet. Connect your own Google or Microsoft account and it appears here.</div>
        ) : (
          <ul className="space-y-1">
            {mailboxes.map((m) => (
              <li key={m.accountId} className="srow">
                <span className="font-mono text-sm">{m.address}</span>
                <span className="text-xs">{PROVIDER_LABEL[m.provider]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* About You (USER.md) */}
      <div className="tile space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="scard__title">About You</div>
            <div className="scard__desc" style={{ marginBottom: 0 }}>
              Information about you that agents will know when "Share User Profile" is enabled.
              Your preferences, businesses, projects, communication style, etc.
            </div>
          </div>
          <div className="srow shrink-0">
            {savedProfile && <span className="text-xs text-cp-teal">Saved!</span>}
            <button type="button" onClick={handleSaveProfile} disabled={savingProfile || loadingProfile}
              className="btn btn--primary btn--sm">
              {savingProfile ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
        {loadingProfile ? (
          <div className="h-40 glass-nested rounded-xl animate-pulse" />
        ) : (
          <textarea
            value={userProfile}
            onChange={(e) => setUserProfile(e.target.value)}
            rows={12}
            className="glass-textarea w-full font-mono resize-y"
          />
        )}
      </div>
    </div>
  );
};
