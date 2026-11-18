// ── Settings → The Profile tab: the owner profile and the identity files behind it.

import { useState, useEffect, useRef } from 'react';
import * as api from '../../lib/api';
import { useGuardedLoad } from '../../lib/load-guard';

type OwnerMailboxRow = { address: string; provider: 'google' | 'microsoft'; accountId: string };
const PROVIDER_LABEL: Record<OwnerMailboxRow['provider'], string> = { google: 'Google', microsoft: 'Microsoft' };


export const ProfileTab = () => {
  const [userName, setUserName] = useState('');
  const [userProfile, setUserProfile] = useState('');
  const profileNow = useRef(userProfile);   // what the box holds when an await returns, not when it began
  profileNow.current = userProfile;
  const [savingName, setSavingName] = useState(false);
  const [savedName, setSavedName] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savedProfile, setSavedProfile] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  // Both reads go through the shared load guard (lib/load-guard.ts): a failed read is never an empty
  // name or an empty profile, and nothing is offered to save on top of one.
  const nameLoad = useGuardedLoad<string | null>('owner_name', async (key) => {
    const r = await api.getSetting(key);
    return r.ok ? { ok: true as const, data: r.data.value } : r;
  });
  const profileLoad = useGuardedLoad<{ content: string; mailboxes?: OwnerMailboxRow[] }>('USER.md', (file) => api.getIdentity(file));
  const loadingName = nameLoad.status === 'loading';
  const loadingProfile = profileLoad.status === 'loading';
  const mailboxes = profileLoad.data?.mailboxes ?? [];
  const loadedName = nameLoad.data;
  const loadedProfile = profileLoad.data?.content ?? null;
  useEffect(() => { if (nameLoad.status === 'ready') setUserName(loadedName ?? ''); }, [nameLoad.status, loadedName]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (loadedProfile !== null) setUserProfile(loadedProfile); }, [profileLoad.settled]);

  const handleSaveName = async () => {
    if (!nameLoad.canSave('owner_name')) return;
    setSavingName(true);
    setSavedName(false);
    setNameError(null);
    const result = await api.setSetting('owner_name', userName.trim());
    if (result.ok) { setSavedName(true); setTimeout(() => setSavedName(false), 2000); if (profileNow.current === loadedProfile) profileLoad.reload(); }   // the profile's name line follows; an edit in progress is left alone
    else setNameError(result.error || 'Your name was not saved.');
    setSavingName(false);
  };

  const handleSaveProfile = async () => {
    if (!profileLoad.canSave('USER.md') || loadedProfile === null) return;
    setSavingProfile(true);
    setSavedProfile(false);
    setSaveError(null);
    const result = await api.updateIdentity('USER.md', userProfile, loadedProfile);
    if (result.ok) {
      setSavedProfile(true); setTimeout(() => setSavedProfile(false), 2000);
      profileLoad.adopt({ ...(profileLoad.data ?? {}), content: userProfile });
    } else {
      setSaveError(result.error || 'Could not save.');   // what the owner typed stays; the saved text loads only on request
    }
    setSavingProfile(false);
  };

  const failedBox = (what: string, retry: () => void) => (
    <>
      <div className="fhelp">Could not load {what}, so it can&apos;t be changed right now. Nothing has been changed.</div>
      <div className="srow"><button type="button" className="btn btn--sm" onClick={retry}>Retry</button></div>
    </>
  );

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="tile space-y-3">
        <div className="scard__title">Your Name</div>
        <div className="scard__desc">Used in memory summaries and agent conversations to identify you.</div>
        {loadingName ? (
          <div className="h-10 glass-nested rounded-xl animate-pulse" />
        ) : nameLoad.status === 'failed' ? (
          failedBox('your name', nameLoad.reload)
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
            {nameError && <div className="fhelp" role="alert">{nameError}</div>}
          </>
        )}
      </div>
      <div className="tile space-y-3">
        <div className="scard__title">Your Mailboxes</div>
        <div className="scard__desc">
          Filled in automatically from the Google and Microsoft accounts you connect as your own
          (Settings → Channels, Google and Microsoft cards). Disconnect an account there to remove it here.
        </div>
        {loadingProfile ? (
          <div className="h-10 glass-nested rounded-xl animate-pulse" />
        ) : profileLoad.status === 'failed' ? (
          <div className="scard__desc" style={{ marginBottom: 0 }}>Your mailboxes could not be loaded.</div>
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
      <div className="tile space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="scard__title">About You</div>
            <div className="scard__desc" style={{ marginBottom: 0 }}>
              Information about you that an agent knows when "Knows who you are" is on in its settings, under "What it knows".
              Your preferences, businesses, projects, communication style, etc.
            </div>
          </div>
          <div className="srow shrink-0">
            {savedProfile && <span className="text-xs text-cp-teal">Saved!</span>}
            {profileLoad.status === 'ready' && (
              <button type="button" onClick={handleSaveProfile} disabled={savingProfile}
                className="btn btn--primary btn--sm">
                {savingProfile ? 'Saving...' : 'Save'}
              </button>
            )}
          </div>
        </div>
        {saveError && (
          <div className="text-xs text-cp-coral">
            {saveError}{' '}
            <button type="button" className="btn btn--sm" onClick={() => { setSaveError(null); profileLoad.reload(); }}>Load the saved version</button>
          </div>
        )}
        {loadingProfile ? (
          <div className="h-40 glass-nested rounded-xl animate-pulse" />
        ) : profileLoad.status === 'failed' ? (
          failedBox('your profile', profileLoad.reload)
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
