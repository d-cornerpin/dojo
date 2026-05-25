import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useSearchParams } from 'react-router-dom';
import type { Provider, Model } from '@dojo/shared';
import * as api from '../lib/api';
import { useToast } from '../hooks/useToast';
import { RouterConfig } from '../components/RouterConfig';
import { RouterTest } from '../components/RouterTest';
import { GoogleWorkspaceSettings } from '../components/GoogleWorkspaceSettings';
import { MicrosoftWorkspaceSettings } from '../components/MicrosoftWorkspaceSettings';
import { formatDate } from '../lib/dates';
import { MigrationExport } from '../components/MigrationExport';
import { MigrationImport } from '../components/MigrationImport';
import { useTheme } from '../themes';
import { invalidateSavedVoiceSettings } from '../hooks/useVoiceMode';

type Tab = 'platform' | 'providers' | 'models' | 'profile' | 'security' | 'router' | 'sensei' | 'integrations' | 'voice' | 'update';

export const Settings = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tabFromUrl = (rawTab === 'workspace' || rawTab === 'microsoft' ? 'integrations' : rawTab) as Tab | null;
  const [activeTab, setActiveTab] = useState<Tab>(tabFromUrl || 'platform');

  // Sync tab with URL query param so mobile hamburger sub-menu links work
  useEffect(() => {
    if (tabFromUrl && tabFromUrl !== activeTab) {
      setActiveTab(tabFromUrl);
    }
  }, [tabFromUrl]);

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'platform', label: 'Dojo' },
    { key: 'providers', label: 'Providers' },
    { key: 'models', label: 'Models' },
    { key: 'router', label: 'Router' },
    { key: 'profile', label: 'Profile' },
    { key: 'security', label: 'Security' },
    { key: 'sensei', label: 'Sensei' },
    { key: 'integrations', label: 'Integrations' },
    { key: 'voice', label: 'Voice' },
    { key: 'update', label: 'Update' },
  ];

  return (
    <div className="flex-1 p-3 sm:p-6 overflow-y-auto">
      <h1 className="text-lg sm:text-xl font-bold text-ui mb-4 sm:mb-6">Settings</h1>

      {/* Tabs — hidden on mobile (handled by hamburger sub-menu instead).
          flex-wrap lets tabs spill onto a second row as the viewport narrows
          instead of running off the right edge. */}
      <div className="hidden md:flex md:flex-wrap gap-1 mb-6 bg-ui/[0.05] rounded-lg p-1 w-fit max-w-full">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              activeTab === tab.key
                ? 'bg-ui/[0.05] text-ui'
                : 'text-ui/55 hover:text-ui/90'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Mobile tab selector — a compact dropdown for quick switching on phones */}
      <div className="md:hidden mb-4">
        <select
          value={activeTab}
          onChange={(e) => handleTabChange(e.target.value as Tab)}
          className="glass-select w-full"
        >
          {tabs.map(tab => (
            <option key={tab.key} value={tab.key}>{tab.label}</option>
          ))}
        </select>
      </div>

      {/* Tab Content */}
      {activeTab === 'platform' && <PlatformTab />}
      {activeTab === 'providers' && <ProvidersTab />}
      {activeTab === 'models' && <ModelsTab />}
      {activeTab === 'router' && <RouterTab />}
      {activeTab === 'profile' && <ProfileTab />}
      {activeTab === 'security' && <SecurityTab />}
      {activeTab === 'sensei' && <DreamingTab />}
      {activeTab === 'integrations' && (
        <div className="max-w-4xl">
          {/* OAuth callbacks land on http://localhost:3001 — connecting from
              a Cloudflare-tunneled URL (or any remote host) breaks the
              redirect roundtrip. Surface this once at the top of the page
              so users don't get cryptic "session expired" errors after the
              Google/Microsoft sign-in popup closes. */}
          <div className="alert-banner alert-info mb-6">
            <p className="text-sm font-medium">Connect accounts from your local Mac, not via a tunnel.</p>
            <p className="text-xs text-ui/70 mt-1">
              Google and Microsoft sign-in redirects land on <code className="px-1 rounded bg-ui/[0.06]">http://localhost:3001</code> — that only resolves when this dashboard is open on the same machine running the Dojo. If you're hitting the dashboard through a Cloudflare tunnel or named host from another device, the OAuth callback won't reach the server and the connection will silently fail. Sit at the host machine and use <code className="px-1 rounded bg-ui/[0.06]">http://localhost:3000</code> for the connect flow; once connected, the credentials work regardless of how you access the dashboard.
            </p>
          </div>
          <div className="columns-1 lg:columns-2 gap-6 [&>*]:mb-6 [&>*]:break-inside-avoid">
            <GoogleWorkspaceSettings />
            <MicrosoftWorkspaceSettings />
          </div>
        </div>
      )}
      {activeTab === 'voice' && <VoiceTab />}
      {activeTab === 'update' && <UpdateTab />}
    </div>
  );
};

// ── iMessage Bridge Settings ──

// Shape matches packages/server/src/services/imessage-bridge.ts SafeSender.
// Duplicated rather than imported to keep the dashboard build standalone.
type SharingLevel = 'open_book' | 'dont_overshare' | 'cautious' | 'project_only';

interface SafeSender {
  address: string;
  name: string;
  description?: string;
  is_primary: boolean;
  sharing_level: SharingLevel;
}

const SHARING_LEVEL_LABELS: Record<SharingLevel, string> = {
  open_book: 'Open Book',
  dont_overshare: "Don't Over-Share",
  cautious: 'Be Cautious',
  project_only: 'Project Only',
};

const SHARING_LEVEL_HINTS: Record<SharingLevel, string> = {
  open_book: 'No restrictions; treat as owner.',
  dont_overshare: 'Share what is asked; do not volunteer extra details.',
  cautious: 'Answer only what is asked, briefly. High-level only.',
  project_only: 'Discuss only the specific project this contact is on.',
};

const isSharingLevel = (v: unknown): v is SharingLevel =>
  v === 'open_book' || v === 'dont_overshare' || v === 'cautious' || v === 'project_only';

// Accept both the legacy string[] shape (older installs) and the new object
// shape so reading an unmigrated config doesn't lose data.
const parseSenders = (raw: string | undefined): SafeSender[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item, idx): SafeSender[] => {
      if (typeof item === 'string') {
        const addr = item.trim();
        if (!addr) return [];
        const isPrimary = idx === 0;
        return [{
          address: addr,
          name: addr,
          description: undefined,
          is_primary: isPrimary,
          sharing_level: isPrimary ? 'open_book' : 'dont_overshare',
        }];
      }
      if (item && typeof item === 'object' && typeof item.address === 'string' && item.address.trim()) {
        const isPrimary = item.is_primary === true;
        return [{
          address: item.address.trim(),
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.address.trim(),
          description: typeof item.description === 'string' && item.description.trim() ? item.description.trim() : undefined,
          is_primary: isPrimary,
          sharing_level: isSharingLevel(item.sharing_level) ? item.sharing_level : (isPrimary ? 'open_book' : 'dont_overshare'),
        }];
      }
      return [];
    });
  } catch {
    return [];
  }
};

const IMBridgeSettings = () => {
  const [enabled, setEnabled] = useState(false);
  const [senders, setSenders] = useState<SafeSender[]>([]);
  const [newAddress, setNewAddress] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSharingLevel, setNewSharingLevel] = useState<SharingLevel>('dont_overshare');
  const [showAddInput, setShowAddInput] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const [enabledResult, sendersResult, defaultResult] = await Promise.all([
        api.getSetting('imessage_enabled'),
        api.getSetting('imessage_approved_senders'),
        api.getSetting('imessage_default_sender'),
      ]);

      if (enabledResult.ok && enabledResult.data.value) {
        setEnabled(enabledResult.data.value === 'true');
      }

      // Pre-fix the loader would also fall back to `imessage_recipient`
      // (a legacy single-address field) and auto-promote it to a sender
      // entry. On most installs that field holds the AGENT's own iMessage
      // address (set during installation), which then showed up as the
      // user's primary sender - confusing and wrong. We now only load
      // actual saved safe-sender records; if there are none, the list
      // starts empty so the user explicitly adds the right people.
      const loaded: SafeSender[] = sendersResult.ok && sendersResult.data.value
        ? parseSenders(sendersResult.data.value)
        : [];

      // If no record is marked primary, promote the legacy default key's
      // matching record (best-effort) or the first record. Best-effort
      // only; if no primary can be inferred, the first record gets the star.
      if (loaded.length > 0 && !loaded.some(s => s.is_primary)) {
        const legacyDefault = defaultResult.ok ? defaultResult.data.value : '';
        const idx = legacyDefault ? loaded.findIndex(s => s.address === legacyDefault) : -1;
        if (idx >= 0) loaded[idx].is_primary = true;
        else loaded[0].is_primary = true;
      }
      setSenders(loaded);
      setLoading(false);
    };
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);

    if (enabled && senders.length === 0) {
      setError('Add at least one approved sender');
      setSaving(false);
      return;
    }

    // Ensure exactly one primary on save. If somehow none, mark the first.
    const normalized = senders.map(s => ({ ...s }));
    if (normalized.length > 0 && !normalized.some(s => s.is_primary)) {
      normalized[0].is_primary = true;
    }
    // Force every primary record's sharing_level to open_book at save time.
    // The UI locks the dropdown, but a stale or hand-edited record could
    // arrive with a throttled level on the primary - normalize defensively.
    for (const s of normalized) {
      if (s.is_primary) s.sharing_level = 'open_book';
    }
    // Refuse to save a Project-Only sender with no description: the policy
    // text references the description for project scope, and an empty
    // description means the agent has nothing to enforce against.
    const badProjectOnly = normalized.find(s => !s.is_primary && s.sharing_level === 'project_only' && !s.description);
    if (badProjectOnly) {
      setError(`"${badProjectOnly.name || badProjectOnly.address}" is set to Project Only but has no description. Add a brief description that names the specific project the agent should stay inside of, or change the sharing level.`);
      setSaving(false);
      return;
    }
    const primary = normalized.find(s => s.is_primary);

    const results = await Promise.all([
      api.setSetting('imessage_enabled', enabled ? 'true' : 'false'),
      api.setSetting('imessage_approved_senders', JSON.stringify(normalized)),
      // Keep legacy fields in sync so older code paths (and any external
      // tools that read them directly) keep working until everything reads
      // the new shape via the bridge helpers.
      api.setSetting('imessage_recipient', normalized[0]?.address ?? ''),
      api.setSetting('imessage_default_sender', primary?.address ?? ''),
    ]);

    if (results.every(r => r.ok)) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError('Failed to save settings');
    }
    setSaving(false);
  };

  const addSender = () => {
    const address = newAddress.trim();
    if (!address) return;
    if (senders.some(s => s.address === address)) {
      setError(`"${address}" is already in the list`);
      return;
    }
    const name = newName.trim() || address;
    const description = newDescription.trim() || undefined;
    const isPrimary = senders.length === 0; // first sender is auto-primary
    // Primary auto-promotes to open_book regardless of dropdown value (no
    // reason to throttle sharing with yourself). Subsequent senders honor
    // the selected level from the form.
    setSenders([...senders, {
      address,
      name,
      description,
      is_primary: isPrimary,
      sharing_level: isPrimary ? 'open_book' : newSharingLevel,
    }]);
    setNewAddress('');
    setNewName('');
    setNewDescription('');
    setNewSharingLevel('dont_overshare');
    setShowAddInput(false);
    setError(null);
  };

  const removeSender = (index: number) => {
    const wasPrimary = senders[index].is_primary;
    const updated = senders.filter((_, i) => i !== index);
    if (wasPrimary && updated.length > 0) {
      updated[0].is_primary = true;
    }
    setSenders(updated);
  };

  const setPrimary = (index: number) => {
    // When promoting to primary, force sharing_level to open_book so the
    // primary is always treated as the owner. When demoting an old primary,
    // if their level was open_book (the locked default), drop them to
    // dont_overshare since open_book on a non-primary doesn't reflect a
    // deliberate choice.
    setSenders(senders.map((s, i) => {
      if (i === index) return { ...s, is_primary: true, sharing_level: 'open_book' as SharingLevel };
      if (s.is_primary) return { ...s, is_primary: false, sharing_level: s.sharing_level === 'open_book' ? 'dont_overshare' as SharingLevel : s.sharing_level };
      return { ...s, is_primary: false };
    }));
  };

  const updateField = (index: number, field: 'name' | 'description', value: string) => {
    setSenders(senders.map((s, i) => i === index ? { ...s, [field]: field === 'description' && !value.trim() ? undefined : value } : s));
  };

  const setSharingLevel = (index: number, level: SharingLevel) => {
    setSenders(senders.map((s, i) => i === index ? { ...s, sharing_level: level } : s));
  };

  if (loading) return null;

  return (
    <div className="glass-card p-4 space-y-4">
      <h3 className="card-header">iMessage Bridge</h3>
      <p className="text-xs text-ui/40">
        Enable to send and receive messages with your agent via iMessage. Requires Full Disk Access for Terminal in System Settings &gt; Privacy &amp; Security &gt; Full Disk Access.
      </p>

      {/* Toggle */}
      <div className="flex items-center justify-between">
        <label className="text-sm text-ui/70">Enable iMessage Bridge</label>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`toggle-switch ${enabled ? 'toggle-on' : ''}`}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      {/* Approved Senders */}
      {enabled && (
        <div>
          <label className="form-label mb-2">
            Approved Senders
          </label>
          <p className="text-xs text-ui/25 mb-2">
            Each safe sender is a person (or another agent) your DOJO will accept iMessages from. Star the primary user; everyone else is a household member, friend, or another agent. The agent sees each sender's name and description in the inbound message and replies to them by default - so it can't mix up who's who.
          </p>

          {/* Sender list */}
          {senders.length > 0 && (
            <div className="space-y-2 mb-3">
              {senders.map((sender, i) => (
                <div
                  key={i}
                  className="glass-nested rounded-xl px-3 py-2 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <button
                        onClick={() => setPrimary(i)}
                        title={sender.is_primary ? 'Primary user (you)' : 'Set as primary user'}
                        className={`text-lg leading-none transition-colors shrink-0 ${
                          sender.is_primary
                            ? 'text-cp-amber'
                            : 'text-ui/25 hover:text-cp-amber'
                        }`}
                      >
                        {sender.is_primary ? '\u2605' : '\u2606'}
                      </button>
                      <span className="text-sm text-ui/90 font-mono truncate">{sender.address}</span>
                    </div>
                    <button
                      onClick={() => removeSender(i)}
                      className="text-ui/40 hover:text-cp-coral transition-colors ml-2 shrink-0"
                    >
                      &times;
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-xs text-ui/40 block">Display name</label>
                      <input
                        type="text"
                        value={sender.name === sender.address ? '' : sender.name}
                        onChange={(e) => updateField(i, 'name', e.target.value)}
                        placeholder="e.g., Alex"
                        className="glass-input text-sm w-full"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-ui/40 block">Brief description</label>
                      <input
                        type="text"
                        value={sender.description ?? ''}
                        onChange={(e) => updateField(i, 'description', e.target.value)}
                        placeholder="e.g., spouse, teammate, project collaborator"
                        className="glass-input text-sm w-full"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-ui/40 block">Sharing level</label>
                    <select
                      value={sender.is_primary ? 'open_book' : sender.sharing_level}
                      onChange={(e) => setSharingLevel(i, e.target.value as SharingLevel)}
                      disabled={sender.is_primary}
                      className="glass-input text-sm w-full disabled:opacity-60"
                    >
                      {(Object.keys(SHARING_LEVEL_LABELS) as SharingLevel[]).map(level => (
                        <option key={level} value={level}>
                          {SHARING_LEVEL_LABELS[level]}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-ui/25">
                      {sender.is_primary
                        ? 'Primary user is always Open Book. Star another sender first if you want to change this.'
                        : SHARING_LEVEL_HINTS[sender.sharing_level]}
                    </p>
                    {sender.sharing_level === 'project_only' && !sender.description && !sender.is_primary && (
                      <p className="text-xs text-cp-amber">⚠ Project Only needs a description that names the specific project; without it the agent has no scope to enforce.</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {enabled && senders.length === 0 && (
            <div className="alert-banner alert-warning mb-2">
              iMessage bridge is ON but no senders are configured. The bridge will sit idle until you add at least one sender below.
            </div>
          )}

          {senders.length === 0 && !showAddInput && (
            <p className="text-xs text-ui/25 italic mb-2">No approved senders configured.</p>
          )}

          {/* Add sender form */}
          {showAddInput ? (
            <div className="glass-nested rounded-xl px-3 py-3 space-y-2">
              <div className="space-y-1">
                <label className="text-xs text-ui/40 block">Phone number or Apple ID</label>
                <input
                  type="text"
                  value={newAddress}
                  onChange={(e) => setNewAddress(e.target.value)}
                  placeholder="+15551234567 or user@icloud.com"
                  autoFocus
                  className="glass-input w-full font-mono text-sm"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs text-ui/40 block">Display name</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g., Alex"
                    className="glass-input text-sm w-full"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-ui/40 block">Brief description</label>
                  <input
                    type="text"
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addSender()}
                    placeholder="e.g., spouse, teammate, project collaborator"
                    className="glass-input text-sm w-full"
                  />
                </div>
              </div>
              {senders.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs text-ui/40 block">Sharing level</label>
                  <select
                    value={newSharingLevel}
                    onChange={(e) => setNewSharingLevel(e.target.value as SharingLevel)}
                    className="glass-input text-sm w-full"
                  >
                    {(Object.keys(SHARING_LEVEL_LABELS) as SharingLevel[]).map(level => (
                      <option key={level} value={level}>
                        {SHARING_LEVEL_LABELS[level]}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-ui/25">{SHARING_LEVEL_HINTS[newSharingLevel]}</p>
                </div>
              )}
              {senders.length === 0 && (
                <p className="text-xs text-ui/25">First sender becomes the primary user automatically (Open Book).</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={addSender}
                  disabled={!newAddress.trim()}
                  className="px-3 py-2 glass-btn-primary text-sm rounded-lg transition-colors"
                >
                  Add sender
                </button>
                <button
                  onClick={() => { setShowAddInput(false); setNewAddress(''); setNewName(''); setNewDescription(''); setNewSharingLevel('dont_overshare'); }}
                  className="px-3 py-2 text-sm text-ui/55 hover:text-ui/90 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAddInput(true)}
              className="flex items-center gap-1 text-xs text-cp-blue hover:text-cp-blue/80 transition-colors"
            >
              <span className="text-lg leading-none">+</span> Add sender
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="alert-banner alert-error">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved. Changes are live - no restart needed.</span>}
      </div>

      {enabled && (
        <div className="alert-banner alert-warning">
          If the bridge fails to read messages, ensure Terminal has Full Disk Access: System Settings &gt; Privacy &amp; Security &gt; Full Disk Access &gt; Enable Terminal.
        </div>
      )}
    </div>
  );
};

// ── Providers Tab ──

// ── Platform Tab ──

const PlatformTab = () => {
  return (
    <div className="columns-1 lg:columns-2 gap-6 max-w-4xl [&>*]:mb-6 [&>*]:break-inside-avoid">
      <AgentLimitsSettings />
      <OllamaSettings />
      <RemoteAccessSettings />
      <IMBridgeSettings />
      <SearchSettings />
      <MigrationSettings />
      <FengShuiSettings />
      <ServerControlSettings />
    </div>
  );
};

// ── Server Control (restart) ──
//
// Remote-admin escape valve. In production the DOJO server runs under
// launchd with KeepAlive=true, so exiting the process triggers a fresh
// start within seconds. In dev (tsx watch), there's no auto-restart -
// the confirm dialog warns about that case so the user doesn't end up
// staring at a dead server.
const ServerControlSettings = () => {
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [backups, setBackups] = useState<api.ListPlatformBackupsResponse | null>(null);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const load = async () => {
      setBackupsLoading(true);
      const result = await api.listPlatformBackups();
      if (result.ok) setBackups(result.data);
      setBackupsLoading(false);
    };
    load();
  }, []);

  const doRestart = async () => {
    setRestarting(true);
    const result = await api.restartServer();
    if (!result.ok) {
      toast.error(`Restart failed: ${result.error}`);
      setRestarting(false);
      setConfirming(false);
      return;
    }
    const mode = result.data?.mode ?? 'production';
    toast.info(
      mode === 'production'
        ? 'Restarting server. Reconnecting in a few seconds…'
        : 'Server exiting. Dev mode: re-run `npm run dev` to bring it back.',
    );
    // Leave the "restarting" overlay up; the WebSocket will drop and the
    // dashboard's reconnect logic will pick the server back up (in prod).
    // No setRestarting(false) — the page will reload itself on reconnect.
  };

  const doCleanup = async () => {
    setCleaning(true);
    const result = await api.cleanupPlatformBackups(1);
    if (!result.ok) {
      toast.error(`Cleanup failed: ${result.error}`);
      setCleaning(false);
      return;
    }
    const data = result.data;
    if (data) {
      if (data.deletedCount === 0) {
        toast.info('No old backups to clean up.');
      } else {
        toast.info(`Cleaned up ${data.deletedCount} backup(s), freed ${data.freedMB} MB. ${data.remaining} kept.`);
      }
    }
    // Reload the listing
    const refresh = await api.listPlatformBackups();
    if (refresh.ok) setBackups(refresh.data);
    setCleaning(false);
  };

  return (
    <div className="glass-card p-4 space-y-3">
      <h3 className="card-header">Server</h3>
      <p className="text-xs text-ui/40">
        Most settings on this tab hot-reload and do not need a restart. Use this if you've changed
        something deeper (model registry, OAuth config) that asked for a restart, or if the server
        looks stuck and you want to recycle it without SSHing to the host.
      </p>

      {!confirming && !restarting && (
        <button
          onClick={() => setConfirming(true)}
          className="px-4 py-2 glass-btn text-sm font-medium rounded-lg transition-colors"
        >
          Restart server
        </button>
      )}

      {confirming && !restarting && (
        <div className="space-y-2">
          <div className="alert-banner alert-warning text-xs">
            This exits the server process immediately. In production it auto-restarts via launchd
            within a few seconds. <strong>If you're running `npm run dev`</strong>, tsx watch will
            NOT bring it back — you'll need to re-run the command in your terminal.
          </div>
          <div className="flex gap-2">
            <button
              onClick={doRestart}
              className="px-3 py-2 glass-btn-primary text-sm rounded-lg transition-colors"
            >
              Yes, restart now
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="px-3 py-2 text-sm text-ui/55 hover:text-ui/90 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {restarting && (
        <div className="alert-banner alert-info text-xs">
          Restarting server… the dashboard will reconnect automatically once it's back up.
        </div>
      )}

      {/* ── Platform backups cleanup ── */}
      <div className="pt-3 border-t border-ui/10 space-y-2">
        <div className="text-sm font-medium text-ui/80">Platform backups</div>
        <p className="text-xs text-ui/40">
          Each auto-update saves a copy of the previous platform under <code>~/.dojo/platform.backup-&lt;version&gt;</code> for rollback safety. Updates from v2.7.18+ auto-prune the oldest, keeping the most recent {backups?.keepDefault ?? 2}. Use this if older backups have piled up and you need disk space now.
        </p>
        {backupsLoading && <p className="text-xs text-ui/40 italic">Loading backups…</p>}
        {!backupsLoading && backups && (
          <>
            <p className="text-xs text-ui/55">
              {backups.count === 0
                ? 'No backups on disk.'
                : `${backups.count} backup(s) on disk, ${backups.totalMB} MB total.`}
            </p>
            {backups.count > 1 && (
              <button
                onClick={doCleanup}
                disabled={cleaning}
                className="px-3 py-2 glass-btn text-sm rounded-lg transition-colors disabled:opacity-60"
              >
                {cleaning ? 'Cleaning up…' : 'Clean up old backups (keep most recent 1)'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// ── Feng Shui (Theme Picker) ──

const FengShuiSettings = () => {
  const { themeId, setTheme, themes } = useTheme();

  return (
    <div className="glass-card p-5 space-y-4">
      <h3 className="card-header">Feng Shui</h3>
      <p className="text-xs text-ui/40">
        Choose the visual theme for your Dojo.
      </p>

      <div className="grid gap-3">
        {themes.map(theme => (
          <button
            key={theme.id}
            onClick={() => setTheme(theme.id)}
            className={`flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${
              themeId === theme.id
                ? 'border-cp-amber bg-cp-amber/10'
                : 'border-ui/[0.10] bg-ui/[0.03] hover:bg-ui/[0.08]'
            }`}
          >
            <div className={`w-3 h-3 rounded-full shrink-0 border-2 ${
              themeId === theme.id
                ? 'border-cp-amber bg-cp-amber'
                : 'border-ui/[0.15] bg-transparent'
            }`} />
            <div>
              <div className="text-sm font-medium text-ui">{theme.name}</div>
              <div className="text-xs text-ui/40">{theme.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

// ── Migration (Export/Import) ──

const MigrationSettings = () => {
  const [showImport, setShowImport] = useState(false);

  return (
    <div className="glass-card p-5 space-y-4">
      <h3 className="card-header">Migration</h3>
      <p className="text-xs text-ui/40">
        Export your entire dojo to move it to another machine, or import from a previous export.
      </p>

      <div className="flex gap-3">
        <MigrationExport />
        <button
          onClick={() => setShowImport(!showImport)}
          className="px-4 py-2 bg-ui/[0.05] hover:bg-ui/[0.12] text-ui/70 text-sm font-medium rounded-lg transition-colors"
        >
          {showImport ? 'Cancel Import' : 'Import Dojo'}
        </button>
      </div>

      {showImport && (
        <div className="mt-4">
          <MigrationImport />
        </div>
      )}
    </div>
  );
};

// ── Remote Access (Cloudflare Tunnel) ──

const RemoteAccessSettings = () => {
  const [status, setStatus] = useState<{
    enabled: boolean;
    mode: 'quick' | 'named';
    status: string;
    url: string | null;
    error: string | null;
    startedAt: number | null;
    cloudflaredInstalled: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'quick' | 'named'>('quick');
  const [token, setToken] = useState('');
  const [namedUrl, setNamedUrl] = useState('');
  const [acting, setActing] = useState(false);
  const [installing, setInstalling] = useState(false);

  const getHeaders = () => {
    const t = localStorage.getItem('dojo_token');
    const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
    const csrf = csrfMatch ? csrfMatch[1] : null;
    return {
      'Content-Type': 'application/json',
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    };
  };

  const load = async () => {
    const t = localStorage.getItem('dojo_token');
    const res = await fetch('/api/system/tunnel', {
      headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    });
    const data = await res.json();
    if (data.ok) {
      setStatus(data.data);
      setMode(data.data.mode);
      // Pre-fill the named URL field from the saved value (when in named mode)
      // so the user can see what's stored without re-typing it.
      if (data.data.mode === 'named' && data.data.url && !namedUrl) {
        setNamedUrl(data.data.url);
      }
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Poll while tunnel is starting
  useEffect(() => {
    if (status?.status !== 'starting') return;
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [status?.status]);

  const handleSaveNamedUrl = async () => {
    setActing(true);
    await fetch('/api/system/tunnel/named-url', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ url: namedUrl.trim() || null }),
    });
    await load();
    setActing(false);
  };

  const handleEnable = async () => {
    setActing(true);
    if (mode === 'named' && token.trim()) {
      await fetch('/api/system/tunnel/token', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          token: token.trim(),
          // Send the URL alongside the token so it's persisted in the same call
          url: namedUrl.trim() || null,
        }),
      });
    }
    await fetch('/api/system/tunnel/enable', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ mode }),
    });
    await load();
    setActing(false);
  };

  const handleDisable = async () => {
    setActing(true);
    await fetch('/api/system/tunnel/disable', {
      method: 'POST',
      headers: getHeaders(),
    });
    await load();
    setActing(false);
  };

  const handleInstall = async () => {
    setInstalling(true);
    await fetch('/api/system/tunnel/install-cloudflared', {
      method: 'POST',
      headers: getHeaders(),
    });
    await load();
    setInstalling(false);
  };

  const copyUrl = () => {
    if (status?.url) {
      navigator.clipboard.writeText(status.url);
    }
  };

  if (loading) return <div className="loading-state">Loading...</div>;

  const isActive = status?.status === 'active';
  const isStarting = status?.status === 'starting';

  return (
    <div className="glass-card p-4 space-y-4">
      <h3 className="card-header">Remote Access</h3>
      <p className="text-xs text-ui/40">
        Access your dojo from anywhere via Cloudflare Tunnel.
      </p>

      {/* Security warning */}
      {(isActive || isStarting) && (
        <div className="px-3 py-2 rounded-lg bg-cp-amber/10 border border-cp-amber/20 text-xs text-cp-amber">
          Your dojo is accessible from the internet. Make sure you have a strong password set in Settings &gt; Security.
        </div>
      )}

      {/* cloudflared not installed */}
      {!status?.cloudflaredInstalled && (
        <div className="glass-nested rounded-xl p-3 space-y-2">
          <p className="text-xs text-ui/55">cloudflared is not installed.</p>
          <button
            onClick={handleInstall}
            disabled={installing}
            className="px-3 py-1.5 text-xs glass-btn-primary rounded-lg transition-colors"
          >
            {installing ? 'Installing...' : 'Install cloudflared'}
          </button>
        </div>
      )}

      {/* Main toggle and config */}
      {status?.cloudflaredInstalled && (
        <>
          {/* Status display */}
          {isActive && (
            <div className="glass-nested rounded-xl p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-cp-teal animate-pulse" />
                <span className="text-xs text-cp-teal font-medium">Tunnel Active</span>
                {status.mode === 'quick' && <span className="text-[10px] text-ui/25">Quick Tunnel</span>}
                {status.mode === 'named' && <span className="text-[10px] text-ui/25">Named Tunnel</span>}
              </div>
              {status.url && (
                <div className="flex items-center gap-2">
                  <a href={status.url} target="_blank" rel="noopener noreferrer" className="text-xs text-cp-teal font-mono flex-1 truncate hover:underline">{status.url}</a>
                  <button onClick={copyUrl} className="text-[10px] text-ui/40 hover:text-ui/70 shrink-0">Copy</button>
                </div>
              )}
              {/* When in named mode and no URL saved yet, let the user add it
                  inline without disabling+re-enabling. The URL is what was
                  configured in Cloudflare's Published Application Routes. */}
              {status.mode === 'named' && !status.url && (
                <div className="space-y-1">
                  <p className="text-[10px] text-ui/40">Add the public URL you configured in Cloudflare so the dashboard and the agent can use it.</p>
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={namedUrl}
                      onChange={(e) => setNamedUrl(e.target.value)}
                      placeholder="https://dojo.example.com"
                      className="glass-input flex-1 text-xs"
                    />
                    <button
                      onClick={handleSaveNamedUrl}
                      disabled={acting || !namedUrl.trim()}
                      className="px-3 text-xs glass-btn-primary rounded-lg shrink-0 disabled:opacity-40"
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}
              <button
                onClick={handleDisable}
                disabled={acting}
                className="text-xs text-cp-coral hover:text-cp-coral/80 transition-colors"
              >
                {acting ? 'Stopping...' : 'Disable Remote Access'}
              </button>
            </div>
          )}

          {isStarting && (
            <div className="glass-nested rounded-xl p-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-cp-amber animate-pulse" />
                <span className="text-xs text-cp-amber">Starting tunnel...</span>
              </div>
            </div>
          )}

          {status?.error && (
            <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-xs text-cp-coral">
              {status.error}
            </div>
          )}

          {/* Config (only show when not active) */}
          {!isActive && !isStarting && (
            <div className="space-y-3">
              {/* Mode selection */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="tunnel-mode"
                    checked={mode === 'quick'}
                    onChange={() => setMode('quick')}
                    className="w-4 h-4"
                  />
                  <div>
                    <span className="text-xs text-ui/70 font-medium">Quick Tunnel</span>
                    <span className="text-[10px] text-ui/25 ml-1">(no account needed)</span>
                  </div>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="tunnel-mode"
                    checked={mode === 'named'}
                    onChange={() => setMode('named')}
                    className="w-4 h-4"
                  />
                  <div>
                    <span className="text-xs text-ui/70 font-medium">Named Tunnel</span>
                    <span className="text-[10px] text-ui/25 ml-1">(persistent URL)</span>
                  </div>
                </label>
              </div>

              {mode === 'quick' && (
                <p className="text-[10px] text-ui/25">
                  Generates a random trycloudflare.com URL. No account needed. URL changes on restart.
                </p>
              )}

              {mode === 'named' && (
                <div className="space-y-2">
                  <p className="text-[10px] text-ui/40">
                    Requires a free Cloudflare account AND a domain on that account.{' '}
                    <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/" target="_blank" rel="noopener noreferrer" className="text-cp-blue hover:underline">
                      Cloudflare docs &rarr;
                    </a>
                  </p>
                  <div className="text-[10px] text-ui/40 font-medium pt-1">Phase 1 — Get the token</div>
                  <div className="text-[10px] text-ui/25 space-y-0.5">
                    <p>1. Sign in at <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noopener noreferrer" className="font-mono text-cp-blue hover:underline">one.dash.cloudflare.com</a> (NOT dash.cloudflare.com — that's a different product). First time only: pick a Team name when prompted.</p>
                    <p>2. Sidebar: <span className="font-mono">Networks &rarr; Connectors &rarr; Cloudflare Tunnels</span> &rarr; <span className="font-mono">Create a tunnel</span></p>
                    <p>3. Connector type: <span className="font-mono">Cloudflared</span>. Name it (e.g. <span className="font-mono">dojo</span>) &rarr; Save.</p>
                    <p>4. Cloudflare shows an install command. The token is the long <span className="font-mono">eyJ…</span> string after <span className="font-mono">service install</span>. Copy just that token (no spaces) and paste below.</p>
                  </div>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Cloudflare tunnel token (eyJ...)"
                    className="glass-input w-full"
                  />
                  <div className="text-[10px] text-ui/40 font-medium pt-1">Phase 2 — Bind a URL (after the tunnel connects)</div>
                  <div className="text-[10px] text-ui/25 space-y-0.5">
                    <p>5. In Cloudflare, click into your tunnel &rarr; <span className="font-mono">Published application routes</span> tab &rarr; <span className="font-mono">Add a route</span></p>
                    <p>6. Subdomain: <span className="font-mono">dojo</span> (or anything). Domain: pick from the dropdown (one of your Cloudflare-managed domains). Service type: <span className="font-mono">HTTP</span> (NOT HTTPS). URL: <span className="font-mono">localhost:3001</span></p>
                    <p>7. Save. Your Dojo is now reachable at <span className="font-mono">https://subdomain.yourdomain.com</span>.</p>
                    <p>8. Paste that final URL below so the dashboard and the agent can show/use it.</p>
                  </div>
                  <input
                    type="text"
                    value={namedUrl}
                    onChange={(e) => setNamedUrl(e.target.value)}
                    placeholder="https://dojo.example.com"
                    className="glass-input w-full"
                  />
                  <p className="text-[10px] text-ui/25">
                    No domain on Cloudflare yet? Add one at <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer" className="font-mono text-cp-blue hover:underline">dash.cloudflare.com</a> &rarr; <span className="font-mono">+ Add &rarr; Existing domain</span> (free DNS transfer), or register one through Cloudflare Registrar (~$8–10/yr).
                  </p>
                </div>
              )}

              <button
                onClick={handleEnable}
                disabled={acting || (mode === 'named' && !token.trim())}
                className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
              >
                {acting ? 'Connecting...' : mode === 'named' ? 'Save & Connect' : 'Enable Remote Access'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ── Ollama Settings ──

const OllamaSettings = () => {
  const [maxConcurrent, setMaxConcurrent] = useState('1');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const load = async () => {
      const result = await api.getSetting('ollama_max_concurrent_models');
      if (result.ok && result.data.value) {
        setMaxConcurrent(result.data.value);
      }
      setLoading(false);
    };
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    await api.setSetting('ollama_max_concurrent_models', maxConcurrent);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setSaving(false);
  };

  if (loading) return <div className="loading-state">Loading...</div>;

  return (
    <div className="glass-card p-4 space-y-4">
      <h3 className="card-header">Ollama (Local Models)</h3>
      <p className="text-xs text-ui/40">
        Controls how many different Ollama models can be loaded in RAM simultaneously.
        Set to 1 for 16GB machines, 2+ if you have more RAM.
      </p>
      <div>
        <label className="form-label">Max Concurrent Models</label>
        <input
          type="number"
          min={1}
          max={8}
          value={maxConcurrent}
          onChange={(e) => setMaxConcurrent(e.target.value)}
          className="glass-input w-24"
        />
        <p className="text-[10px] text-ui/25 mt-0.5">
          When agents use more local models than this limit, requests queue until the current model finishes.
          A 7B model uses ~4GB RAM, a 30B model uses ~16GB.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
      </div>
    </div>
  );
};

// ── Agent Limits Settings ──

const AGENT_LIMIT_KEYS = [
  { key: 'spawn_max_concurrent', label: 'Max Concurrent Agents', description: 'Maximum number of non-terminated agents running at the same time', default: 5, min: 1, max: 50 },
  { key: 'spawn_max_children', label: 'Max Children Per Agent', description: 'Maximum sub-agents a single parent can have active at once', default: 3, min: 1, max: 20 },
  { key: 'spawn_max_depth', label: 'Max Spawn Depth', description: 'How many levels deep agents can spawn sub-agents (primary agent = depth 0)', default: 2, min: 1, max: 10 },
  { key: 'spawn_default_timeout', label: 'Default Timeout (seconds)', description: 'How long a temp agent runs before auto-terminating. 900 = 15 minutes.', default: 900, min: 60, max: 86400 },
];

const AgentLimitsSettings = () => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const load = async () => {
      const initial: Record<string, string> = {};
      for (const item of AGENT_LIMIT_KEYS) {
        const result = await api.getSetting(item.key);
        initial[item.key] = result.ok && result.data.value ? result.data.value : String(item.default);
      }
      setValues(initial);
      setLoading(false);
    };
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    for (const item of AGENT_LIMIT_KEYS) {
      const val = values[item.key];
      if (val !== undefined) {
        await api.setSetting(item.key, val);
      }
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setSaving(false);
  };

  if (loading) return <div className="loading-state">Loading...</div>;

  return (
    <div className="glass-card p-4 space-y-4">
      <h3 className="card-header">Dojo Capacity</h3>
      <p className="text-xs text-ui/40">
        Controls how many agents can run and how they are spawned. Changes take effect immediately.
      </p>
      <div className="grid grid-cols-2 gap-4">
        {AGENT_LIMIT_KEYS.map((item) => (
          <div key={item.key}>
            <label className="form-label">{item.label}</label>
            <input
              type="number"
              min={item.min}
              max={item.max}
              value={values[item.key] ?? item.default}
              onChange={(e) => setValues(prev => ({ ...prev, [item.key]: e.target.value }))}
              className="glass-input w-full"
            />
            <p className="text-[10px] text-ui/25 mt-0.5">{item.description}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save Limits'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
      </div>
    </div>
  );
};

// ── Search Settings ──

const SearchSettings = () => {
  const [provider, setProvider] = useState('brave');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<'valid' | 'invalid' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const result = await api.getSearchConfig();
      if (result.ok) {
        setProvider(result.data.provider ?? 'brave');
        setHasKey(result.data.hasKey);
      }
      setLoading(false);
    };
    load();
  }, []);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    setValidationResult(null);

    const result = await api.setSearchConfig(provider, apiKey.trim());
    if (result.ok) {
      setHasKey(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError(result.error);
    }
    setSaving(false);
  };

  const handleValidate = async () => {
    const keyToValidate = apiKey.trim() || undefined;
    if (!keyToValidate && !hasKey) {
      setError('Enter an API key first');
      return;
    }
    setValidating(true);
    setError(null);
    setValidationResult(null);

    // If user typed a new key, validate that; otherwise we can't validate without the key
    if (!keyToValidate) {
      setError('Enter an API key to validate');
      setValidating(false);
      return;
    }

    const result = await api.validateSearchKey(provider, keyToValidate);
    if (result.ok && result.data.valid) {
      setValidationResult('valid');
    } else {
      setValidationResult('invalid');
      setError(result.ok ? 'Key is invalid' : result.error);
    }
    setValidating(false);
  };

  if (loading) return null;

  return (
    <div className="glass-card p-4 space-y-4">
      <h3 className="card-header">Web Search Provider</h3>
      <p className="text-xs text-ui/40">
        Configure web search for the web_search tool.
      </p>

      <div>
        <label className="form-label">Provider</label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="glass-select w-full"
        >
          <option value="brave">Brave Search</option>
        </select>
      </div>

      <div>
        <label className="form-label">
          Brave Search API Key
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? '••••••••••••••••' : 'Enter Brave Search API key'}
          className="glass-input w-full"
        />
      </div>

      {error && (
        <div className="alert-banner alert-error">
          {error}
        </div>
      )}

      {validationResult === 'valid' && (
        <div className="alert-banner alert-success">
          API key is valid
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleValidate}
          disabled={validating || (!apiKey.trim() && !hasKey)}
          className="px-4 py-2 bg-ui/[0.08] hover:bg-ui/[0.12] disabled:bg-ui/[0.05] disabled:text-ui/25 text-ui/90 text-sm font-medium rounded-lg transition-colors"
        >
          {validating ? 'Validating...' : 'Validate'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
      </div>

      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          hasKey
            ? 'bg-cp-teal/10 text-cp-teal border border-cp-teal/20'
            : 'bg-ui/[0.08] text-ui/55 border border-ui/[0.10]'
        }`}>
          {hasKey ? 'Configured' : 'Not configured'}
        </span>
      </div>
    </div>
  );
};

// ── Agent SDK Setup (inline in provider form) ──

const AgentSdkSetup = () => {
  const [status, setStatus] = useState<{ cliInstalled: boolean; version: string | null; packageAvailable: boolean } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [authResult, setAuthResult] = useState<{ authenticated: boolean; error?: string } | null>(null);

  useEffect(() => {
    api.request<{ cliInstalled: boolean; version: string | null; packageAvailable: boolean }>('/config/agent-sdk/status').then(res => {
      if (res.ok) setStatus(res.data);
    });
  }, []);

  const handleVerify = async () => {
    setVerifying(true);
    setAuthResult(null);
    const res = await api.request<{ authenticated: boolean; error?: string }>('/config/agent-sdk/verify', { method: 'POST' });
    if (res.ok) setAuthResult(res.data);
    setVerifying(false);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-ui/40">
        Use your Claude Pro or Max subscription through the Agent SDK. Requires two things: the Claude Code CLI installed, and a signed-in Claude account.
      </p>

      <div className="space-y-2 text-xs">
        {/* Step 1: CLI installed */}
        <div className="flex items-center gap-2">
          <span className={status?.cliInstalled ? 'text-cp-teal' : 'text-cp-amber'}>
            {status?.cliInstalled ? '\u2713' : '1.'}
          </span>
          <span className="text-ui/55">
            {status?.cliInstalled
              ? `Claude Code CLI installed (${status.version})`
              : 'Install Claude Code CLI'}
          </span>
        </div>
        {!status?.cliInstalled && (
          <div className="text-ui/25 ml-5 space-y-1">
            <p>Run this in your terminal:</p>
            <code className="block bg-ui/[0.05] px-2 py-1 rounded text-[11px]">curl -fsSL https://claude.ai/install.sh | bash</code>
          </div>
        )}

        {/* Step 2: Signed in */}
        <div className="flex items-center gap-2">
          <span className={authResult?.authenticated ? 'text-cp-teal' : status?.cliInstalled ? 'text-cp-amber' : 'text-ui/25'}>
            {authResult?.authenticated ? '\u2713' : '2.'}
          </span>
          <span className={status?.cliInstalled ? 'text-ui/55' : 'text-ui/25'}>
            {authResult?.authenticated ? 'Signed in to Claude' : 'Sign in to your Claude account'}
          </span>
        </div>
        {status?.cliInstalled && !authResult?.authenticated && (
          <div className="text-ui/25 ml-5 space-y-1">
            <p>Run this in your terminal and sign in with your Claude Pro/Max account:</p>
            <code className="block bg-ui/[0.05] px-2 py-1 rounded text-[11px]">claude</code>
            <p>Then click Verify below.</p>
          </div>
        )}
      </div>

      {status?.cliInstalled && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleVerify}
            disabled={verifying}
            className="px-3 py-1.5 glass-btn-primary text-xs font-medium rounded-lg transition-colors"
          >
            {verifying ? 'Verifying...' : 'Verify Connection'}
          </button>
          {authResult && !authResult.authenticated && (
            <span className="text-xs text-cp-coral">
              {authResult.error ?? 'Not authenticated. Run `claude` in your terminal and sign in.'}
            </span>
          )}
        </div>
      )}

      <div className="alert-banner alert-warning">
        <p className="text-[10px] text-cp-amber/70">
          Agent SDK subscription billing is subject to Anthropic's usage policies. If you experience issues, switch to API Key.
        </p>
      </div>
    </div>
  );
};

// ── Providers Tab ──

const ProvidersTab = () => {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const loadProviders = async () => {
    const result = await api.getProviders();
    if (result.ok) setProviders(result.data);
    setLoading(false);
  };

  useEffect(() => {
    loadProviders();
  }, []);

  const [syncing, setSyncing] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    // Fetch models for this provider to check usage
    const modelsResult = await api.getModels();
    const providerModelIds = modelsResult.ok
      ? (modelsResult.data as Array<{ id: string; providerId: string }>).filter(m => m.providerId === id).map(m => m.id)
      : [];

    let warning = 'Delete this provider? This will also remove its models.';
    if (providerModelIds.length > 0) {
      const usage = await api.checkModelUsage(providerModelIds);
      if (usage.ok && usage.data.usages.length > 0) {
        const affected = usage.data.usages.flatMap(u => u.usedBy.map((a: { name: string }) => a.name));
        const unique = [...new Set(affected)];
        warning += `\n\nCurrently used by: ${unique.join(', ')}. They will be reassigned to another model.`;
      }
    }

    if (!confirm(warning)) return;
    const result = await api.deleteProvider(id);
    if (result.ok) {
      setProviders((prev) => prev.filter((p) => p.id !== id));
    }
  };

  const handleSyncModels = async (id: string) => {
    setSyncing(id);
    await api.validateProvider(id);
    setSyncing(null);
  };

  if (loading) return <div className="loading-state">Loading...</div>;

  return (
    <div className="space-y-4 max-w-4xl">
      {/* Existing providers */}
      {providers.length === 0 ? (
        <p className="text-ui/40 text-sm">No providers configured.</p>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="glass-card p-4 flex items-center justify-between"
            >
              <div>
                <h3 className="text-sm font-medium text-ui">{provider.name}</h3>
                <p className="text-xs text-ui/40 mt-0.5">
                  {provider.type} &middot; {provider.authType === 'agent-sdk' ? 'Agent SDK' : provider.authType === 'oauth' ? 'OAuth' : 'API Key'} {provider.isValidated ? '(validated)' : '(not validated)'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleSyncModels(provider.id)}
                  disabled={syncing === provider.id}
                  className="text-xs text-cp-teal hover:text-cp-teal/80 disabled:text-ui/25 transition-colors"
                >
                  {syncing === provider.id ? 'Syncing...' : 'Sync Models'}
                </button>
                <button
                  onClick={() => handleDelete(provider.id)}
                  className="text-sm text-cp-coral hover:text-cp-coral/80 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add provider */}
      {showAdd ? (
        <AddProviderForm
          onAdded={() => {
            loadProviders();
            setShowAdd(false);
          }}
          onCancel={() => setShowAdd(false)}
        />
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
        >
          Add Provider
        </button>
      )}
    </div>
  );
};

const AddProviderForm = ({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) => {
  const [name, setName] = useState('');
  // The dropdown 'preset' is a UI-only label. Several presets (deepseek,
  // openrouter) all map to the same backend type 'openai-compatible' but
  // with different default base URLs and seeded model catalogs. The
  // mapping happens at submit time below.
  const [preset, setPreset] = useState('anthropic');
  const [authType, setAuthType] = useState<'api_key' | 'oauth' | 'agent-sdk'>('api_key');
  const [credential, setCredential] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'validating' | 'valid' | 'invalid'>('idle');

  // Translate UI preset → backend (type, default baseUrl, suggested name).
  const presetConfig = (() => {
    switch (preset) {
      case 'anthropic':   return { backendType: 'anthropic',          defaultBaseUrl: undefined,                     suggestedName: 'Anthropic' };
      case 'openai':      return { backendType: 'openai',             defaultBaseUrl: 'https://api.openai.com',      suggestedName: 'OpenAI' };
      case 'openrouter':  return { backendType: 'openai-compatible',  defaultBaseUrl: 'https://openrouter.ai/api',   suggestedName: 'OpenRouter' };
      case 'deepseek':    return { backendType: 'openai-compatible',  defaultBaseUrl: 'https://api.deepseek.com',    suggestedName: 'DeepSeek' };
      case 'ollama':      return { backendType: 'ollama',             defaultBaseUrl: 'http://localhost:11434',      suggestedName: 'Ollama' };
      default:            return { backendType: 'anthropic',          defaultBaseUrl: undefined,                     suggestedName: 'Anthropic' };
    }
  })();

  // When the preset changes, autofill the name field if the user hasn't
  // typed anything custom yet (or if it still matches a previous preset's
  // suggestion). Saves a click for the common case.
  useEffect(() => {
    setName((current) => {
      const isAutoFilled = current === '' ||
        ['Anthropic', 'OpenAI', 'OpenRouter', 'DeepSeek', 'Ollama'].includes(current);
      return isAutoFilled ? presetConfig.suggestedName : current;
    });
  }, [preset, presetConfig.suggestedName]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || (preset !== 'ollama' && authType !== 'agent-sdk' && !credential.trim())) return;
    setStatus('saving');
    setError(null);

    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const result = await api.createProvider({
      id,
      name,
      type: presetConfig.backendType,
      baseUrl: baseUrl.trim() || presetConfig.defaultBaseUrl,
      authType: preset === 'ollama' ? 'none' : authType,
      credential: preset === 'ollama' || authType === 'agent-sdk' ? undefined : credential,
    });

    if (!result.ok) {
      setError(result.error);
      setStatus('idle');
      return;
    }

    // Validate the credential
    setStatus('validating');
    const valResult = await api.validateProvider(id);
    if (valResult.ok && valResult.data.valid) {
      setStatus('valid');
      // Brief delay so the user sees the green badge before the form closes
      setTimeout(() => onAdded(), 800);
    } else {
      setStatus('invalid');
      const detail = !valResult.ok ? valResult.error : 'Unexpected result';
      setError(`Provider added but validation failed: ${detail}`);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="glass-card p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="form-label">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="glass-input w-full"
          />
        </div>
        <div>
          <label className="form-label">Type</label>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="glass-select w-full"
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="deepseek">DeepSeek</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>
      </div>

      {preset === 'ollama' && (
        <div>
          <label className="form-label">Base URL</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434"
            className="glass-input w-full"
          />
        </div>
      )}

      {preset !== 'ollama' && (
        <>
          {preset === 'anthropic' && (
            <div>
              <label className="form-label">Auth Type</label>
              <select
                value={authType}
                onChange={(e) => setAuthType(e.target.value as 'api_key' | 'oauth' | 'agent-sdk')}
                className="glass-select w-full"
              >
                <option value="api_key">API Key</option>
                <option value="oauth">OAuth Token</option>
                <option value="agent-sdk">Agent SDK (Subscription)</option>
              </select>
            </div>
          )}

          {authType === 'agent-sdk' && preset === 'anthropic' ? (
            <AgentSdkSetup />
          ) : (
            <div>
              <label className="form-label">
                {authType === 'oauth' && preset === 'anthropic' ? 'OAuth Token' : 'API Key'}
              </label>
              <input
                type="password"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder={
                  preset === 'deepseek' ? 'sk-... (DeepSeek API key from platform.deepseek.com)' :
                  preset === 'openai' ? 'sk-...' :
                  authType === 'oauth' ? 'Bearer token...' : 'sk-...'
                }
                className="glass-input w-full"
              />
            </div>
          )}
        </>
      )}

      {error && (
        <div className="alert-banner alert-error">
          {error}
        </div>
      )}

      {status === 'valid' && (
        <div className="alert-banner alert-success">
          Validated
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={status === 'saving' || status === 'validating' || status === 'valid' || !name.trim() || (preset !== 'ollama' && authType !== 'agent-sdk' && !credential.trim())}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
        >
          {status === 'saving' ? 'Adding...' : status === 'validating' ? 'Validating...' : 'Add & Validate'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={status === 'saving' || status === 'validating'}
          className="px-4 py-2 text-sm text-ui/55 hover:text-ui/90 disabled:text-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
};

// ── Models Tab ──

const ProviderModelGroup = ({
  provider,
  models,
  primaryModelId,
  onToggle,
  onPricingChange,
  browseSection,
}: {
  provider: Provider;
  models: Model[];
  primaryModelId: string | null;
  onToggle: (model: Model) => void;
  onPricingChange: () => void;
  browseSection?: React.ReactNode;
}) => {
  const [open, setOpen] = useState(true);
  const enabledCount = models.filter(m => m.isEnabled).length;

  return (
    <div className="glass-card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex items-center justify-between text-sm font-medium text-ui/70 hover:bg-ui/[0.03] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span>{provider.name}</span>
          <span className="text-xs text-ui/25">{enabledCount}/{models.length} enabled</span>
        </div>
        <span className="text-ui/40">{open ? '[-]' : '[+]'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          {provider.type === 'ollama' && (
            <OllamaHostRamRow provider={provider} onChange={onPricingChange} />
          )}
          {models.map(model => (
            <ModelRow
              key={model.id}
              model={model}
              providerType={provider.type}
              isPrimaryModel={model.id === primaryModelId}
              onToggle={() => onToggle(model)}
              onPricingChange={onPricingChange}
            />
          ))}
          {browseSection}
        </div>
      )}
    </div>
  );
};

// Detects localhost Ollama from the stored base URL. Mirrors the server-side
// helper in services/num-ctx-calculator.ts so the UI shows the right state
// (auto-detected vs. editable) before any API call.
function isLocalOllamaBaseUrlClient(baseUrl: string | null): boolean {
  if (!baseUrl) return true; // default Ollama baseUrl is localhost
  const lower = baseUrl.toLowerCase();
  return (
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('[::1]') ||
    lower.includes('0.0.0.0')
  );
}

// Ollama-only: row above the model list showing/editing how much RAM the
// Ollama host has, so the num_ctx auto-sizer can compute recommendations.
// For localhost, this is auto-detected from the dojo host; for remote
// providers, the user types it in and the server recomputes every model's
// num_ctx recommendation on the spot.
const OllamaHostRamRow = ({ provider, onChange }: { provider: Provider; onChange: () => void }) => {
  const isLocal = isLocalOllamaBaseUrlClient(provider.baseUrl);
  const [ramInput, setRamInput] = useState(
    provider.hostRamGb === null ? '' : String(provider.hostRamGb),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    const trimmed = ramInput.trim();
    let ramGb: number | null;
    if (trimmed === '') {
      ramGb = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        setError('Must be a whole number');
        return;
      }
      if (n < 1 || n > 2048) {
        setError('Must be between 1 and 2048');
        return;
      }
      ramGb = n;
    }
    if (ramGb === provider.hostRamGb) return; // no change

    setSaving(true);
    const result = await api.updateProviderHostRam(provider.id, ramGb);
    setSaving(false);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      // onChange triggers a models reload so every card's recommended
      // num_ctx picks up the newly-computed value from the server.
      onChange();
    } else {
      setError(result.error ?? 'Save failed');
    }
  };

  if (isLocal) {
    return (
      <div className="glass-card p-3 flex items-center gap-3 text-xs">
        <span className="text-ui/40 w-20">Host RAM</span>
        <span className="text-ui/70 font-mono">auto-detected (this machine)</span>
        <span className="text-[10px] text-ui/25 italic">
          num_ctx recommendations use os.totalmem()
        </span>
      </div>
    );
  }

  return (
    <div className="glass-card p-3 flex items-center gap-3 text-xs">
      <label className="text-ui/40 w-20" title="Total RAM of the remote Ollama host in GB. The dojo uses this value to auto-size num_ctx recommendations for every model on this provider.">
        Host RAM
      </label>
      <input
        type="number"
        step="1"
        min="1"
        max="2048"
        placeholder="GB"
        value={ramInput}
        onChange={(e) => setRamInput(e.target.value)}
        onBlur={handleSave}
        disabled={saving}
        className="glass-input w-20 font-mono text-right disabled:opacity-60"
      />
      <span className="text-[10px] text-ui/25">GB</span>
      {saved && <span className="text-xs text-cp-teal">Saved — recomputing…</span>}
      {error && <span className="text-xs text-cp-coral">{error}</span>}
      {!saved && !error && (
        <span className="text-[10px] text-ui/25 italic">
          {provider.hostRamGb === null
            ? 'set this to enable num_ctx recommendations for remote models'
            : `num_ctx auto-sized for ${provider.hostRamGb} GB`}
        </span>
      )}
    </div>
  );
};

const CAPABILITY_LABELS: Record<string, { label: string; className: string; title: string }> = {
  tools: {
    label: 'Tools',
    className: 'bg-cp-blue/15 text-cp-blue-light border-cp-blue/30',
    title: 'Supports function/tool calling',
  },
  vision: {
    label: 'Vision',
    className: 'bg-cp-purple/15 text-cp-purple border-cp-purple/30',
    title: 'Can accept image inputs',
  },
  thinking: {
    label: 'Thinking',
    className: 'bg-cp-amber/15 text-cp-amber-light border-cp-amber/30',
    title: 'Supports extended reasoning / thinking',
  },
  embedding: {
    label: 'Embedding',
    className: 'bg-cp-teal/15 text-cp-teal-light border-cp-teal/30',
    title: 'Embedding model (not for chat)',
  },
  image_generation: {
    label: 'Image Gen',
    className: 'bg-cp-amber/15 text-cp-amber border-cp-amber/30',
    title: 'Can generate images — available to Imaginer for image_create requests',
  },
};

const CapabilityBadges = ({ capabilities }: { capabilities: string[] }) => {
  const known = capabilities.filter(c => CAPABILITY_LABELS[c]);
  if (known.length === 0) {
    return (
      <div className="mt-1.5 flex items-center gap-1">
        <span className="text-[10px] text-ui/25 italic">capabilities unknown</span>
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {known.map(c => {
        const meta = CAPABILITY_LABELS[c];
        return (
          <span
            key={c}
            title={meta.title}
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${meta.className}`}
          >
            {meta.label}
          </span>
        );
      })}
    </div>
  );
};

const ModelRow = ({
  model,
  providerType,
  isPrimaryModel,
  onToggle,
  onPricingChange,
}: {
  model: Model;
  providerType: string;
  isPrimaryModel: boolean;
  onToggle: () => void;
  onPricingChange: () => void;
}) => {
  const toast = useToast();
  const [inputCost, setInputCost] = useState(String(model.inputCostPerM ?? 0));
  const [outputCost, setOutputCost] = useState(String(model.outputCostPerM ?? 0));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Local optimistic state for the thinking toggle. Mirrors the prop but
  // flips instantly on click while the PATCH is in flight.
  const [thinkingEnabled, setThinkingEnabled] = useState(model.thinkingEnabled);
  const supportsThinking = model.capabilities.includes('thinking');

  // Ollama-only: per-model num_ctx control. The input box shows
  // `override ?? recommended`. When the user types, it becomes an
  // override. Reset button restores to the RAM-aware recommendation.
  const isOllama = providerType === 'ollama';
  const effectiveNumCtx =
    model.numCtxOverride ?? model.numCtxRecommended ?? null;
  const [numCtxInput, setNumCtxInput] = useState(
    effectiveNumCtx === null ? '' : String(effectiveNumCtx),
  );
  const [ctxSaving, setCtxSaving] = useState(false);
  const [ctxSaved, setCtxSaved] = useState(false);
  const [ctxError, setCtxError] = useState<string | null>(null);

  const hasChanges =
    Number(inputCost) !== (model.inputCostPerM ?? 0) ||
    Number(outputCost) !== (model.outputCostPerM ?? 0);

  const handleSave = async () => {
    setSaving(true);
    const result = await api.updateModelPricing(model.id, {
      inputCostPerM: Number(inputCost) || 0,
      outputCostPerM: Number(outputCost) || 0,
    });
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onPricingChange();
    }
    setSaving(false);
  };

  const handleThinkingToggle = async () => {
    const next = !thinkingEnabled;
    setThinkingEnabled(next); // optimistic
    const result = await api.updateModelThinking(model.id, next);
    if (!result.ok) {
      setThinkingEnabled(!next); // roll back
    } else {
      onPricingChange();
    }
  };

  const handleNumCtxSave = async () => {
    setCtxError(null);
    const trimmed = numCtxInput.trim();

    // Empty input means "use the recommendation" (clear any override).
    // Otherwise parse and validate. If the typed value equals the current
    // recommendation exactly, that's also equivalent to "no override".
    let override: number | null;
    if (trimmed === '') {
      override = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        setCtxError('Must be a whole number');
        return;
      }
      if (n < 512 || n > 2_097_152) {
        setCtxError('Must be between 512 and 2097152');
        return;
      }
      override = n === model.numCtxRecommended ? null : n;
    }

    if (override === model.numCtxOverride) return; // no change

    setCtxSaving(true);
    const result = await api.updateModelNumCtx(model.id, override);
    setCtxSaving(false);
    if (result.ok) {
      setCtxSaved(true);
      setTimeout(() => setCtxSaved(false), 1500);
      onPricingChange();
    } else {
      setCtxError(result.error ?? 'Save failed');
    }
  };

  const handleNumCtxReset = async () => {
    setCtxError(null);
    // Restore the box to the recommendation (or empty if no recommendation).
    setNumCtxInput(
      model.numCtxRecommended === null ? '' : String(model.numCtxRecommended),
    );
    if (model.numCtxOverride === null) return; // nothing to clear server-side
    setCtxSaving(true);
    const result = await api.updateModelNumCtx(model.id, null);
    setCtxSaving(false);
    if (result.ok) {
      setCtxSaved(true);
      setTimeout(() => setCtxSaved(false), 1500);
      onPricingChange();
    } else {
      setCtxError(result.error ?? 'Reset failed');
    }
  };

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-ui">
            {model.name}
            {isPrimaryModel && (
              <span className="ml-2 text-xs text-cp-blue font-normal">(primary agent model)</span>
            )}
          </h3>
          <p className="text-xs text-ui/40 mt-0.5">
            {model.apiModelId}
            {model.contextWindow ? ` | ${Math.round(model.contextWindow / 1000)}k context` : ''}
            {' | '}{model.providerId}
          </p>
          <CapabilityBadges capabilities={model.capabilities} />
          {supportsThinking && (
            <label
              className="mt-2 inline-flex items-center gap-2 cursor-pointer select-none"
              title="When unchecked, the model is asked to skip extended thinking. Works for Ollama and OpenRouter models today; other providers store the preference for future use."
            >
              <input
                type="checkbox"
                checked={thinkingEnabled}
                onChange={handleThinkingToggle}
                className="h-3.5 w-3.5 rounded border-ui/[0.15] bg-ui/[0.05] accent-amber-500 cursor-pointer"
              />
              <span className="text-[11px] text-ui/55">
                Enable thinking
              </span>
            </label>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggle}
            className={`toggle-switch ${model.isEnabled ? 'toggle-on' : ''}`}
          >
            <span className="toggle-knob" />
          </button>
          <button
            onClick={async () => {
              if (!confirm(`Delete "${model.name}"? This removes it from the dojo entirely.`)) return;
              const result = await api.deleteModel(model.id);
              if (result.ok) {
                toast.success(`${model.name} deleted`);
                onPricingChange();
              } else {
                toast.error(result.error ?? 'Delete failed');
              }
            }}
            className="w-6 h-6 flex items-center justify-center rounded text-ui/25 hover:text-cp-coral hover:bg-cp-coral/10 transition-colors"
            title="Delete model"
          >
            <span className="text-sm leading-none">×</span>
          </button>
        </div>
      </div>

      {/* Pricing fields */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-xs text-ui/40 w-20">Input $/M</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={inputCost}
            onChange={(e) => setInputCost(e.target.value)}
            onBlur={() => hasChanges && handleSave()}
            className="glass-input w-24 font-mono text-right"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-ui/40 w-20">Output $/M</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={outputCost}
            onChange={(e) => setOutputCost(e.target.value)}
            onBlur={() => hasChanges && handleSave()}
            className="glass-input w-24 font-mono text-right"
          />
        </div>
        {hasChanges && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-2 py-1 text-xs glass-btn-primary rounded transition-colors"
          >
            {saving ? '...' : 'Save'}
          </button>
        )}
        {saved && <span className="text-xs text-cp-teal">Saved</span>}
      </div>

      {isOllama && (
        <div className="mt-3 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label
              className="text-xs text-ui/40 w-20"
              title="Context window (num_ctx) passed to Ollama for every call to this model. The pre-filled value is a RAM-aware recommendation based on your machine's memory and this model's architecture. Higher values use more RAM."
            >
              Context
            </label>
            <input
              type="number"
              step="1"
              min="512"
              max="2097152"
              placeholder={model.numCtxRecommended === null ? 'default' : ''}
              value={numCtxInput}
              onChange={(e) => setNumCtxInput(e.target.value)}
              onBlur={handleNumCtxSave}
              disabled={ctxSaving}
              className="glass-input w-28 font-mono text-right disabled:opacity-60"
            />
            <span className="text-[10px] text-ui/25">tokens</span>
            {model.numCtxRecommended !== null && (
              <button
                onClick={handleNumCtxReset}
                disabled={ctxSaving || (model.numCtxOverride === null && numCtxInput === String(model.numCtxRecommended))}
                className="text-[10px] text-ui/40 hover:text-ui/70 underline disabled:text-ui/25 disabled:no-underline disabled:cursor-default"
                title={`Reset to auto-sized recommendation (${model.numCtxRecommended.toLocaleString()} tokens)`}
              >
                reset
              </button>
            )}
          </div>
          {ctxSaved && <span className="text-xs text-cp-teal">Saved</span>}
          {ctxError && <span className="text-xs text-cp-coral">{ctxError}</span>}
          <span className="text-[10px] text-ui/25 italic">
            {model.numCtxOverride !== null
              ? 'override set — reset for auto-sized default'
              : model.numCtxRecommended !== null
              ? `auto-sized for your RAM (~${Math.round(model.numCtxRecommended / 1024)}k tokens)`
              : 'higher = more RAM'}
          </span>
        </div>
      )}
    </div>
  );
};

// ── Browse Models (for aggregator providers like OpenRouter) ──

const BrowseModels = ({ providerId, providerName, onModelAdded }: { providerId: string; providerName: string; onModelAdded: () => void }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<api.BrowseModelResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearched(true);
    const result = await api.browseProviderModels(providerId, query.trim());
    if (result.ok) setResults(result.data);
    else setResults([]);
    setSearching(false);
  };

  const handleAdd = async (model: api.BrowseModelResult) => {
    setAdding(model.apiModelId);
    const result = await api.addProviderModel(providerId, model);
    if (result.ok) {
      setResults(prev => prev.filter(r => r.apiModelId !== model.apiModelId));
      onModelAdded();
    }
    setAdding(null);
  };

  const formatCost = (cost: number | null) => {
    if (cost === null || cost === 0) return 'Free';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
  };

  return (
    <div className="glass-card p-4 space-y-3">
      <h3 className="card-header">Browse {providerName} Models</h3>
      <p className="text-xs text-ui/40">Search the model catalog and add models you want to use.</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search models... (e.g., claude, llama, gpt)"
          className="glass-input flex-1"
        />
        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          {searching ? 'Searching...' : 'Search'}
        </button>
      </div>

      {results.length > 0 && (
        <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
          {results.map((model) => (
            <div key={model.apiModelId} className="flex items-center justify-between glass-nested p-2.5 rounded-lg">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ui/90 truncate">{model.name}</div>
                <div className="text-[10px] text-ui/40 flex items-center gap-2 mt-0.5">
                  <span className="truncate">{model.apiModelId}</span>
                  {model.contextWindow && <span>{(model.contextWindow / 1000).toFixed(0)}k ctx</span>}
                  {model.maxOutputTokens && <span>{(model.maxOutputTokens / 1000).toFixed(0)}k out</span>}
                  <span>In: {formatCost(model.inputCostPerM)}/M</span>
                  <span>Out: {formatCost(model.outputCostPerM)}/M</span>
                </div>
              </div>
              <button
                onClick={() => handleAdd(model)}
                disabled={adding === model.apiModelId}
                className="ml-2 px-3 py-1 text-xs bg-cp-teal/20 text-cp-teal hover:bg-cp-teal/30 disabled:bg-ui/[0.05] disabled:text-ui/25 rounded-lg transition-colors shrink-0"
              >
                {adding === model.apiModelId ? 'Adding...' : 'Add'}
              </button>
            </div>
          ))}
        </div>
      )}

      {searched && results.length === 0 && !searching && (
        <p className="text-xs text-ui/25 text-center py-2">No models found matching "{query}"</p>
      )}

      {/* Manual Add — for models not in the catalog */}
      <ManualAddModel providerId={providerId} onModelAdded={onModelAdded} />
    </div>
  );
};

// ── Manual Add Model (for models not in the provider catalog) ──

const MANUAL_ADD_CAPABILITIES = [
  { key: 'tools', label: 'Tools', desc: 'Function/tool calling' },
  { key: 'vision', label: 'Vision', desc: 'Image input' },
  { key: 'thinking', label: 'Thinking', desc: 'Extended reasoning' },
  { key: 'image_generation', label: 'Image Gen', desc: 'Image output' },
] as const;

const ManualAddModel = ({ providerId, onModelAdded }: { providerId: string; onModelAdded: () => void }) => {
  const [expanded, setExpanded] = useState(false);
  const [modelId, setModelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selectedCaps, setSelectedCaps] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleCap = (key: string) => {
    setSelectedCaps(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleAdd = async () => {
    const trimmedId = modelId.trim();
    if (!trimmedId) { setError('Model ID is required'); return; }
    setError(null);
    setAdding(true);

    const result = await api.addProviderModel(providerId, {
      apiModelId: trimmedId,
      name: displayName.trim() || trimmedId,
      contextWindow: null,
      maxOutputTokens: null,
      inputCostPerM: null,
      outputCostPerM: null,
      capabilities: Array.from(selectedCaps),
    } as api.BrowseModelResult & { capabilities?: string[] });

    setAdding(false);
    if (result.ok) {
      setModelId('');
      setDisplayName('');
      setSelectedCaps(new Set());
      setExpanded(false);
      onModelAdded();
    } else {
      setError(result.error ?? 'Failed to add model');
    }
  };

  return (
    <div className="border-t border-ui/[0.06] pt-3 mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-ui/40 hover:text-ui/70 transition-colors"
      >
        {expanded ? '▾ Hide manual add' : '▸ Manual add (model not in catalog?)'}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          <p className="text-[10px] text-ui/25">
            For models not listed in the catalog (e.g. new image models, private endpoints).
            Enter the exact model ID from the provider and select its capabilities.
          </p>

          <div className="flex gap-2">
            <input
              type="text"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="Model ID (e.g. black-forest-labs/flux.2-max)"
              className="glass-input flex-1 font-mono"
            />
          </div>

          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name (optional — defaults to model ID)"
            className="glass-input w-full"
          />

          <div>
            <label className="form-label mb-2">Capabilities</label>
            <div className="flex flex-wrap gap-2">
              {MANUAL_ADD_CAPABILITIES.map(cap => (
                <button
                  key={cap.key}
                  onClick={() => toggleCap(cap.key)}
                  title={cap.desc}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium border transition-colors ${
                    selectedCaps.has(cap.key)
                      ? 'bg-cp-blue/20 text-cp-blue-light border-cp-blue/40'
                      : 'bg-ui/[0.03] text-ui/40 border-ui/[0.10] hover:border-ui/[0.15]'
                  }`}
                >
                  {cap.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleAdd}
              disabled={adding || !modelId.trim()}
              className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
            >
              {adding ? 'Adding...' : 'Add Model'}
            </button>
            {error && <span className="text-xs text-cp-coral">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
};

const ModelsTab = () => {
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [primaryModelId, setPrimaryModelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingModel, setSettingModel] = useState(false);

  const [primaryAgentId, setPrimaryAgentId] = useState('primary');

  const loadData = async () => {
    const pidResult = await api.getSetting('primary_agent_id');
    const pid = pidResult.ok && pidResult.data.value ? pidResult.data.value : 'primary';
    setPrimaryAgentId(pid);
    const [modelsResult, agentResult, providersResult] = await Promise.all([
      api.getModels(),
      api.getAgent(pid),
      api.getProviders(),
    ]);
    if (modelsResult.ok) setModels(modelsResult.data);
    if (agentResult.ok) setPrimaryModelId(agentResult.data.modelId);
    if (providersResult.ok) setProviders(providersResult.data);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, []);

  const toggleModel = async (model: Model) => {
    if (model.isEnabled) {
      // Check if any agents are using this model before disabling
      const usage = await api.checkModelUsage([model.id]);
      if (usage.ok && usage.data.usages.length > 0) {
        const affected = usage.data.usages[0].usedBy.map(u => u.name).join(', ');
        if (!window.confirm(`This model is currently used by: ${affected}.\n\nDisabling it will reassign them to the next available model. Continue?`)) {
          return;
        }
      }
      const result = await api.disableModels([model.id]);
      if (result.ok) {
        setModels((prev) =>
          prev.map((m) => (m.id === model.id ? { ...m, isEnabled: false } : m)),
        );
      }
    } else {
      const result = await api.enableModels([model.id]);
      if (result.ok) {
        setModels((prev) =>
          prev.map((m) => (m.id === model.id ? { ...m, isEnabled: true } : m)),
        );
      }
    }
  };

  const handleSetPrimaryModel = async (modelId: string) => {
    setSettingModel(true);
    const result = await api.setAgentModel(primaryAgentId, modelId);
    if (result.ok) {
      setPrimaryModelId(modelId);
    }
    setSettingModel(false);
  };

  if (loading) return <div className="loading-state">Loading...</div>;

  const enabledModels = models.filter((m) => m.isEnabled);
  const showWarning = !primaryModelId && enabledModels.length > 0;

  return (
    <div className="space-y-3 max-w-4xl">
      {/* Warning banner: primary agent has no model */}
      {showWarning && (
        <div className="alert-banner alert-warning flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-cp-amber">Primary agent has no model assigned</h3>
            <p className="text-xs text-cp-amber/70 mt-0.5">
              Your primary agent can't respond to messages without a model. Pick one below.
            </p>
          </div>
          <select
            onChange={(e) => handleSetPrimaryModel(e.target.value)}
            disabled={settingModel}
            defaultValue=""
            className="px-3 py-2 bg-ui/[0.05] border border-cp-amber/40 rounded-lg text-sm text-ui/90 focus:outline-none focus:ring-2 focus:ring-cp-amber min-w-[180px]"
          >
            <option value="" disabled>
              {settingModel ? 'Setting...' : 'Set Model'}
            </option>
            {enabledModels.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      )}

      {providers.length === 0 ? (
        <p className="text-ui/40 text-sm">No providers configured. Add one in the Providers tab first.</p>
      ) : (
        providers.map(provider => {
          const providerModels = models
            .filter(m => m.providerId === provider.id)
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          const isAggregator = provider.type === 'openai-compatible' && provider.isValidated;
          // Skip empty groups EXCEPT aggregators — they need the browse box visible
          if (providerModels.length === 0 && !isAggregator) return null;
          return (
            <ProviderModelGroup
              key={provider.id}
              provider={provider}
              models={providerModels}
              primaryModelId={primaryModelId}
              onToggle={toggleModel}
              onPricingChange={loadData}
              browseSection={isAggregator ? (
                <BrowseModels
                  providerId={provider.id}
                  providerName={provider.name}
                  onModelAdded={loadData}
                />
              ) : undefined}
            />
          );
        })
      )}
    </div>
  );
};

// ── Profile Tab ──

const ProfileTab = () => {
  const [userName, setUserName] = useState('');
  const [userProfile, setUserProfile] = useState('');
  const [loadingName, setLoadingName] = useState(true);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [savingName, setSavingName] = useState(false);
  const [savedName, setSavedName] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savedProfile, setSavedProfile] = useState(false);

  useEffect(() => {
    const load = async () => {
      const nameResult = await api.getSetting('user_name');
      if (nameResult.ok && nameResult.data.value) setUserName(nameResult.data.value);
      setLoadingName(false);

      const profileResult = await api.getIdentity('USER.md');
      if (profileResult.ok) setUserProfile(profileResult.data.content);
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
      <div className="glass-card p-4 space-y-3">
        <h3 className="card-header">Your Name</h3>
        <p className="text-xs text-ui/40">Used in memory summaries and agent conversations to identify you.</p>
        {loadingName ? (
          <div className="h-10 glass-nested rounded-xl animate-pulse" />
        ) : (
          <>
            <input
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="e.g., Alex"
              className="glass-input w-full"
            />
            <div className="flex items-center gap-2">
              <button onClick={handleSaveName} disabled={savingName || !userName.trim()}
                className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors">
                {savingName ? 'Saving...' : 'Save'}
              </button>
              {savedName && <span className="text-xs text-cp-teal">Saved!</span>}
            </div>
          </>
        )}
      </div>

      {/* About You (USER.md) */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="card-header">About You</h3>
            <p className="text-xs text-ui/40 mt-0.5">
              Information about you that agents will know when "Share User Profile" is enabled.
              Your preferences, businesses, projects, communication style, etc.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {savedProfile && <span className="text-xs text-cp-teal">Saved!</span>}
            <button onClick={handleSaveProfile} disabled={savingProfile || loadingProfile}
              className="px-3 py-1.5 glass-btn-primary text-xs font-medium rounded-lg transition-colors">
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

// ── Router Tab ──

interface RouterConfigData {
  tiers: Array<{
    id: string;
    name: string;
    description: string;
    models: Array<{ modelId: string; modelName: string; providerName?: string; priority: number }>;
  }>;
  dimensions: Array<{
    id: string;
    name: string;
    weight: number;
    isEnabled: boolean;
  }>;
}

const RouterTab = () => {
  const [config, setConfig] = useState<RouterConfigData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadConfig = async () => {
    const result = await api.getRouterConfig();
    if (result.ok) {
      // Map displayName -> name for frontend components
      const data = result.data as Record<string, unknown>;
      const tiers = (data.tiers as Array<Record<string, unknown>>).map((t) => ({
        id: t.id as string,
        name: (t.displayName ?? t.name) as string,
        description: (t.description ?? '') as string,
        models: (t.models ?? []) as Array<{ modelId: string; modelName: string; providerName?: string; priority: number }>,
      }));
      const dimensions = (data.dimensions as Array<Record<string, unknown>>).map((d) => ({
        id: d.id as string,
        name: (d.displayName ?? d.name) as string,
        weight: d.weight as number,
        isEnabled: d.isEnabled as boolean,
      }));
      setConfig({ tiers, dimensions });
    }
    setLoading(false);
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const handleUpdateTierModels = async (
    tierId: string,
    models: Array<{ modelId: string; priority: number }>,
  ) => {
    await api.updateTierModels(tierId, models);
    await loadConfig();
  };

  const handleUpdateDimension = async (
    dimensionId: string,
    updates: { weight?: number; isEnabled?: boolean },
  ) => {
    await api.updateDimension(dimensionId, updates);
    await loadConfig();
  };

  const handleTest = async (prompt: string) => {
    const result = await api.testRouter(prompt);
    if (result.ok) return result.data;
    return null;
  };

  if (loading) return <div className="loading-state">Loading...</div>;
  if (!config) return <p className="text-ui/40">Unable to load router config.</p>;

  return (
    <div className="space-y-6 max-w-4xl">
      <RouterConfig
        config={config}
        onUpdateTierModels={handleUpdateTierModels}
        onUpdateDimension={handleUpdateDimension}
      />
      <RouterTest onTest={handleTest} />
    </div>
  );
};

// ── Security Tab ──

const SecurityTab = () => {
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
    <form onSubmit={handleSubmit} className="glass-card p-4 space-y-4 max-w-lg">
      <h3 className="card-header">Change Password</h3>

      <div>
        <label className="form-label">Current Password</label>
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="glass-input w-full"
        />
      </div>

      <div>
        <label className="form-label">New Password</label>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="At least 8 characters"
          className="glass-input w-full"
        />
      </div>

      <div>
        <label className="form-label">Confirm New Password</label>
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="glass-input w-full"
        />
      </div>

      {error && (
        <div className="alert-banner alert-error">
          {error}
        </div>
      )}

      {success && (
        <div className="alert-banner alert-success">
          Password changed successfully!
        </div>
      )}

      <button
        type="submit"
        disabled={saving || !currentPassword || !newPassword || !confirmPassword}
        className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
      >
        {saving ? 'Changing...' : 'Change Password'}
      </button>
    </form>
  );
};

// ── Dreaming Tab ──

const DreamingTab = () => {
  const [models, setModels] = useState<Model[]>([]);
  const [dreamModelId, setDreamModelId] = useState('');
  const [dreamTime, setDreamTime] = useState('03:00');
  const [dreamMode, setDreamMode] = useState<'full' | 'light'>('full');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [lastDream, setLastDream] = useState<api.DreamReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<{ kind: 'ok' | 'err' | 'idle'; message: string }>({ kind: 'idle', message: '' });

  useEffect(() => {
    const load = async () => {
      const [configResult, modelsResult, latestResult] = await Promise.all([
        api.getDreamingConfig(),
        api.getModels(),
        api.getLatestDream(),
      ]);
      if (configResult.ok) {
        setDreamModelId(configResult.data.modelId ?? '');
        setDreamTime(configResult.data.dreamTime);
        setDreamMode(configResult.data.dreamMode === 'off' ? 'full' : configResult.data.dreamMode);
      }
      if (modelsResult.ok) {
        setModels(modelsResult.data.filter((m: Model) => m.isEnabled));
      }
      if (latestResult.ok) {
        setLastDream(latestResult.data);
      }
      setLoading(false);
    };
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const result = await api.updateDreamingConfig({
      modelId: dreamModelId || undefined,
      dreamTime,
      dreamMode,
    });
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  };

  const handleRunNow = async () => {
    if (running) return;
    if (!confirm('Start a Dreamer cycle now? It will process all unprocessed conversation archives.')) return;
    setRunning(true);
    setRunStatus({ kind: 'idle', message: '' });
    const result = await api.triggerDream();
    if (result.ok) {
      setRunStatus({ kind: 'ok', message: result.data.message });
    } else {
      setRunStatus({ kind: 'err', message: result.error || 'Failed to start Dreamer.' });
    }
    setRunning(false);
    setTimeout(() => setRunStatus({ kind: 'idle', message: '' }), 6000);
  };

  if (loading) return <div className="loading-state">Loading...</div>;

  return (
    <div className="max-w-4xl">
      <div className="columns-1 lg:columns-2 gap-6 [&>*]:mb-6 [&>*]:break-inside-avoid">
      <div className="glass-card p-4 space-y-4">
        <div>
          <h3 className="card-header">Dreaming</h3>
          <p className="text-xs text-ui/40 mt-1">
            Configure how the dojo processes its daily conversations into long-term memories overnight. A temporary "Dreamer" agent is spawned to do the work -- it uses the tracker, extracts knowledge, and dismisses itself when done.
          </p>
        </div>

        <div>
          <label className="form-label">Dreamer Model</label>
          <select
            value={dreamModelId}
            onChange={(e) => setDreamModelId(e.target.value)}
            className="glass-select w-full"
          >
            <option value="">Auto (first available Standard tier model)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.apiModelId})
              </option>
            ))}
          </select>
          <p className="text-[10px] text-ui/25 mt-1">
            The model the Dreamer agent uses. Standard tier recommended for good extraction quality at reasonable cost.
          </p>
        </div>

        <div>
          <label className="form-label">Dream Time</label>
          <input
            type="time"
            value={dreamTime}
            onChange={(e) => setDreamTime(e.target.value)}
            className="glass-select w-full"
          />
          <p className="text-[10px] text-ui/25 mt-1">
            When the Dreamer agent wakes up to process the day's conversations. Default: 3:00 AM.
          </p>
        </div>

        <div>
          <label className="form-label mb-2">Dream Mode</label>
          <div className="space-y-2">
            {([
              { value: 'full', label: 'Full Dream', desc: 'Extract memories + identify technique candidates + vault maintenance' },
              { value: 'light', label: 'Light Dream', desc: 'Extract memories + vault maintenance only, no technique identification' },
            ] as const).map((option) => (
              <label key={option.value} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="dreamMode"
                  value={option.value}
                  checked={dreamMode === option.value}
                  onChange={() => setDreamMode(option.value)}
                  className="mt-1 accent-cp-amber"
                />
                <div>
                  <span className="text-sm text-ui/70">{option.label}</span>
                  <p className="text-[10px] text-ui/25">{option.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2 flex-wrap">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleRunNow}
            disabled={running}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-ui/[0.08] text-ui/55 border border-ui/[0.10] hover:border-ui/[0.15] hover:text-ui/70 transition-colors disabled:opacity-40"
            title="Wake the Dreamer now to process unprocessed archives"
          >
            {running ? 'Starting...' : 'Run Now'}
          </button>
          {saved && <span className="text-xs text-cp-teal">Saved!</span>}
          {runStatus.kind === 'ok' && <span className="text-xs text-cp-teal">{runStatus.message}</span>}
          {runStatus.kind === 'err' && <span className="text-xs text-cp-coral">{runStatus.message}</span>}
        </div>
      </div>

      {/* Imaginer card — image generation sensei */}
      <ImaginerCard models={models} />

      {/* Healer card — self-healing sensei */}
      <HealerCard models={models} />
      </div>

      {/* Last Dream Report — full width below the grid */}
      {lastDream && (
        <div className="glass-card p-4 space-y-2 mt-6">
          <h3 className="card-header">Last Dream</h3>
          <p className="text-[10px] text-ui/25">
            {formatDate(lastDream.createdAt)}
            {lastDream.durationMs && ` (${(lastDream.durationMs / 1000).toFixed(1)}s)`}
          </p>
          <pre className="text-xs text-ui/55 whitespace-pre-wrap font-mono bg-ui/[0.03] rounded p-2">
            {lastDream.reportText ?? 'No report text available'}
          </pre>
        </div>
      )}
    </div>
  );
};

// ── Imaginer Settings Card ──
//
// Lives under the Dreaming tab. Controls the Imaginer Sensei agent's
// image-generation model selection, default aspect ratio / style, and
// provides a test-generate button. The Model dropdown is filtered to
// image-capable models only; if none exist, the card explains how to
// add one.

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;

const ImaginerCard = ({ models }: { models: Model[] }) => {
  const [enabled, setEnabled] = useState(true);
  const [imageModelId, setImageModelId] = useState('');
  const [defaultAspect, setDefaultAspect] = useState<string>('1:1');
  const [defaultStyle, setDefaultStyle] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Filter to models that the capability probe has flagged as image-capable.
  const imageCapableModels = models.filter(m => m.capabilities.includes('image_generation'));

  useEffect(() => {
    const load = async () => {
      const [enabledResult, modelResult, aspectResult, styleResult] = await Promise.all([
        api.getSetting('imaginer_enabled'),
        api.getSetting('imaginer_image_model'),
        api.getSetting('imaginer_default_aspect_ratio'),
        api.getSetting('imaginer_default_style'),
      ]);
      if (enabledResult.ok) {
        setEnabled(enabledResult.data.value !== 'false'); // default true
      }
      if (modelResult.ok && modelResult.data.value) {
        setImageModelId(modelResult.data.value);
      }
      if (aspectResult.ok && aspectResult.data.value) {
        setDefaultAspect(aspectResult.data.value);
      }
      if (styleResult.ok && styleResult.data.value) {
        setDefaultStyle(styleResult.data.value);
      }
      setLoading(false);
    };
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    await Promise.all([
      api.setSetting('imaginer_enabled', enabled ? 'true' : 'false'),
      api.setSetting('imaginer_image_model', imageModelId),
      api.setSetting('imaginer_default_aspect_ratio', defaultAspect),
      api.setSetting('imaginer_default_style', defaultStyle),
    ]);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Route through the primary agent so the full image_create flow is
      // exercised (acks, delivery, thumbnail routing). The result image
      // will show up in the primary agent's chat view.
      const agentsResult = await api.getAgents();
      if (!agentsResult.ok) {
        setTestResult('Failed to resolve primary agent');
        return;
      }
      const primary = agentsResult.data.find(a => a.classification === 'sensei');
      if (!primary) {
        setTestResult('No sensei agent found to route test through');
        return;
      }
      const send = await api.sendMessage(
        primary.id,
        'Please call image_create with description="A friendly stylized dojo mascot mid-kata, simple line drawing on white background". Tell me when Imaginer acknowledges, and share the image when it arrives.',
      );
      if (send.ok) {
        setTestResult(`Test request sent to ${primary.name}. Watch their chat view for the image.`);
      } else {
        setTestResult(`Failed to send test message: ${send.error}`);
      }
    } catch (err) {
      setTestResult(`Test failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting(false);
    }
  };

  if (loading) return null;

  return (
    <div className="glass-card p-4 space-y-4">
      <div>
        <h3 className="card-header">Imaginer (Image Generation Sensei)</h3>
        <p className="text-xs text-ui/40 mt-1">
          Imaginer is a system agent that turns text descriptions into images when any agent calls the{' '}
          <code className="text-cp-amber">image_create</code> tool. Kevin and sub-agents never need to switch models
          to generate images — they describe what they want and Imaginer handles the rest.
        </p>
      </div>

      {/* Enabled toggle */}
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-ui/[0.15] bg-ui/[0.05] accent-cp-amber cursor-pointer"
        />
        <span className="text-sm text-ui/70">Enable Imaginer</span>
      </label>

      {/* Model dropdown */}
      <div>
        <label className="form-label">Image Generation Model</label>
        {imageCapableModels.length === 0 ? (
          <div className="alert-banner alert-warning">
            No image-capable models configured. Add an image-generating model (e.g. Google Gemini 2.5 Flash Image or
            OpenAI GPT-5 Image via OpenRouter) in Settings → Models. Already added but not showing up? Click{' '}
            <em>Refresh capabilities</em> on that model's card — older rows may need a fresh probe to pick up the new
            <code className="mx-1 text-cp-amber">image_generation</code>capability.
          </div>
        ) : (
          <>
            <select
              value={imageModelId}
              onChange={(e) => setImageModelId(e.target.value)}
              className="glass-input w-full"
            >
              <option value="">(select an image model)</option>
              {imageCapableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.apiModelId})
                </option>
              ))}
            </select>
            <p className="text-[10px] text-ui/25 mt-1">
              Only models with the <code className="text-cp-amber">Image Gen</code> capability are shown. Imaginer
              calls this model whenever it needs to actually produce an image — its orchestration/chat brain uses a
              separate text model (Kevin's default by default).
            </p>
          </>
        )}
      </div>

      {/* Default aspect ratio */}
      <div>
        <label className="form-label">Default Aspect Ratio</label>
        <select
          value={defaultAspect}
          onChange={(e) => setDefaultAspect(e.target.value)}
          className="glass-input w-full"
        >
          {ASPECT_RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <p className="text-[10px] text-ui/25 mt-1">Used when requesting agents don't specify one.</p>
      </div>

      {/* Default style */}
      <div>
        <label className="form-label">Default Style (optional)</label>
        <input
          type="text"
          value={defaultStyle}
          onChange={(e) => setDefaultStyle(e.target.value)}
          placeholder="e.g. photorealistic, cinematic lighting"
          className="glass-input w-full"
        />
        <p className="text-[10px] text-ui/25 mt-1">Fallback style hint when requesting agents don't specify one.</p>
      </div>

      {/* Output dir (read-only info) */}
      <div>
        <label className="form-label">Output Directory</label>
        <code className="block text-[11px] text-ui/55 px-3 py-2 bg-ui/[0.03] rounded font-mono">
          ~/.dojo/uploads/generated/
        </code>
      </div>

      {/* Save + Test buttons */}
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={saving || !imageModelId || imageCapableModels.length === 0}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing || !imageModelId || imageCapableModels.length === 0}
          className="px-4 py-2 bg-ui/[0.05] hover:bg-ui/[0.08] border border-ui/[0.10] disabled:bg-ui/[0.03] disabled:text-ui/25 text-ui/70 text-sm font-medium rounded-lg transition-colors"
        >
          {testing ? 'Testing...' : 'Generate test image'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
        {testResult && <span className="text-xs text-ui/55">{testResult}</span>}
      </div>
    </div>
  );
};

// ── Healer Settings Card ──

const HealerCard = ({ models }: { models: Model[] }) => {
  const [healerModelId, setHealerModelId] = useState('');
  const [healerTime, setHealerTime] = useState('04:00');
  const [healerMode, setHealerMode] = useState<'active' | 'monitor' | 'off'>('active');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastDiagnostic, setLastDiagnostic] = useState<api.HealerDiagnostic | null>(null);
  const [sendingReport, setSendingReport] = useState(false);
  // v2.3.19 — provider-isolation surface from the API
  const [providerSharedWithPrimary, setProviderSharedWithPrimary] = useState(false);
  const [primaryProviderName, setPrimaryProviderName] = useState<string | null>(null);
  const [healerProviderName, setHealerProviderName] = useState<string | null>(null);
  const toast = useToast();

  const reloadConfig = async () => {
    const configResult = await api.getHealerConfig();
    if (configResult.ok) {
      setHealerModelId(configResult.data.modelId ?? '');
      setHealerTime(configResult.data.healerTime);
      setHealerMode(configResult.data.healerMode);
      setProviderSharedWithPrimary(configResult.data.providerSharedWithPrimary ?? false);
      setPrimaryProviderName(configResult.data.primaryProviderName ?? null);
      setHealerProviderName(configResult.data.healerProviderName ?? null);
    }
  };

  useEffect(() => {
    const load = async () => {
      const [, diagResult] = await Promise.all([
        reloadConfig(),
        api.getHealerDiagnostic(),
      ]);
      if (diagResult.ok && diagResult.data) {
        setLastDiagnostic(diagResult.data);
      }
      setLoading(false);
    };
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const result = await api.updateHealerConfig({
      modelId: healerModelId || undefined,
      healerTime,
      healerMode,
    });
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      // v2.3.19 — reload so the provider-isolation banner reflects the new
      // model selection without requiring a page refresh.
      await reloadConfig();
    }
    setSaving(false);
  };

  const handleRunNow = async () => {
    setRunning(true);
    const result = await api.triggerHealerRun();
    if (result.ok) {
      // The API returns immediately after spawning the Healer.
      // If the LLM was triggered, poll until the Healer agent finishes.
      if (result.data.llmTriggered) {
        const pollForCompletion = async () => {
          for (let i = 0; i < 60; i++) { // Poll for up to 5 minutes
            await new Promise(r => setTimeout(r, 5000));
            const agents = await api.getAgents();
            if (agents.ok) {
              const healer = agents.data.find((a: { name: string; status: string }) => a.name === 'Healer' && a.status === 'working');
              if (!healer) break; // Healer finished or terminated
            }
          }
        };
        await pollForCompletion();
      }
      // Refresh diagnostic
      const diagResult = await api.getHealerDiagnostic();
      if (diagResult.ok && diagResult.data) setLastDiagnostic(diagResult.data);
      toast.success('Healing cycle complete');
    } else {
      toast.error(result.error ?? 'Healing cycle failed');
    }
    setRunning(false);
  };

  const handleSendReport = async () => {
    setSendingReport(true);
    const result = await api.sendHealerReport();
    if (result.ok) {
      toast.success('Healer report sent and archived');
    } else if (result.error === 'NO_EMAIL_CONFIGURED') {
      toast.error('You need to connect a Google or Microsoft email account in Integrations before you can send Healer Reports.');
    } else {
      toast.error(result.error ?? 'Failed to send report');
    }
    setSendingReport(false);
  };

  if (loading) return <div className="glass-card p-4"><div className="loading-state">Loading...</div></div>;

  return (
    <div className="glass-card p-4 space-y-4">
      <div>
        <h3 className="card-header">Healing</h3>
        <p className="text-xs text-ui/40 mt-1">
          The Healer agent analyzes daily health data, auto-fixes routine issues (stuck agents, orphaned tasks), and proposes solutions for complex problems. Proposals appear on the Vitals page for your approval.
        </p>
      </div>

      <div>
        <label className="form-label">Healer Model</label>
        <select
          value={healerModelId}
          onChange={(e) => setHealerModelId(e.target.value)}
          className="glass-select w-full"
        >
          <option value="">Auto (first available mid-tier model)</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.apiModelId})
            </option>
          ))}
        </select>
        <p className="text-[10px] text-ui/25 mt-1">
          Mid-tier model recommended. Needs good reasoning but doesn't need to be frontier.
        </p>
        {/* v2.3.19 — provider-isolation warning. The Healer's whole point is
            being on a DIFFERENT provider from the main agent so it can step
            in when the main provider goes down. Same provider = no backup. */}
        {providerSharedWithPrimary && primaryProviderName && (
          <div className="mt-3 rounded-md border border-cp-amber/40 bg-cp-amber/10 px-3 py-2.5 text-xs text-cp-amber-light/90 leading-relaxed">
            <div className="font-medium mb-1 text-cp-amber-light">Heads up — both agents are using the same service</div>
            <div>
              Your main agent and your Healer agent are both using {primaryProviderName}. If {primaryProviderName} has a problem, both will stop working at the same time and there's nothing to step in and fix it. Pick a different model from a different service for one of them.
            </div>
          </div>
        )}
      </div>

      <div>
        <label className="form-label">Healing Time</label>
        <input
          type="time"
          value={healerTime}
          onChange={(e) => setHealerTime(e.target.value)}
          className="glass-select w-full"
        />
        <p className="text-[10px] text-ui/25 mt-1">
          When the Healer runs each day. Default: 4:00 AM (after the Dreamer).
        </p>
      </div>

      <div>
        <label className="form-label mb-2">Mode</label>
        <div className="space-y-2">
          {([
            { value: 'active' as const, label: 'Active', desc: 'Auto-fix routine issues + propose complex fixes for your approval' },
            { value: 'monitor' as const, label: 'Monitor', desc: 'Compile diagnostic report only, no fixes applied' },
            { value: 'off' as const, label: 'Off', desc: 'Healer disabled' },
          ]).map((option) => (
            <label key={option.value} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="healerMode"
                value={option.value}
                checked={healerMode === option.value}
                onChange={() => setHealerMode(option.value)}
                className="mt-1 accent-cp-amber"
              />
              <div>
                <span className="text-sm text-ui/70">{option.label}</span>
                <p className="text-[10px] text-ui/25">{option.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleRunNow}
          disabled={running || healerMode === 'off'}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-ui/[0.08] text-ui/55 border border-ui/[0.10] hover:border-ui/[0.15] hover:text-ui/70 transition-colors disabled:opacity-40"
        >
          {running ? 'Running...' : 'Run Now'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
      </div>

      <div>
        <button
          onClick={handleSendReport}
          disabled={sendingReport}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-ui/[0.08] text-ui/55 border border-ui/[0.10] hover:border-ui/[0.15] hover:text-ui/70 transition-colors disabled:opacity-40"
        >
          {sendingReport ? 'Sending...' : 'Send Healer Report'}
        </button>
        <p className="text-[10px] text-ui/25 mt-1">
          Emails a summary of everything the Healer has found and fixed, then starts a new log.
        </p>
      </div>

      {lastDiagnostic && (
        <div className="pt-2 border-t border-ui/[0.06]">
          <p className="text-[10px] text-ui/25 mb-1">
            Last cycle: {formatDate(lastDiagnostic.created_at)}
            {' — '}
            {lastDiagnostic.critical_count > 0 && <span className="text-cp-coral">{lastDiagnostic.critical_count} critical</span>}
            {lastDiagnostic.critical_count > 0 && lastDiagnostic.warning_count > 0 && ', '}
            {lastDiagnostic.warning_count > 0 && <span className="text-cp-amber">{lastDiagnostic.warning_count} warnings</span>}
            {(lastDiagnostic.critical_count > 0 || lastDiagnostic.warning_count > 0) && lastDiagnostic.info_count > 0 && ', '}
            {lastDiagnostic.info_count > 0 && <span className="text-ui/40">{lastDiagnostic.info_count} info</span>}
            {lastDiagnostic.critical_count === 0 && lastDiagnostic.warning_count === 0 && lastDiagnostic.info_count === 0 && <span className="text-cp-teal">All clear</span>}
          </p>
        </div>
      )}
    </div>
  );
};

// ── Update Tab ──

const UpdateTab = () => {
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<api.UpdateCheckResult | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkUpdates = async () => {
    setChecking(true);
    setError(null);
    const result = await api.checkForUpdates();
    if (result.ok) {
      setUpdateInfo(result.data);
      if (result.data.error) setError(result.data.error);
    } else {
      setError(result.error);
    }
    setChecking(false);
  };

  useEffect(() => { checkUpdates(); }, []);

  const handleUpdate = async () => {
    if (!confirm('This will download the latest version, update the platform, and restart the server. Continue?')) return;
    setUpdating(true);
    setError(null);
    setUpdateResult(null);
    const result = await api.applyUpdate();
    if (result.ok) {
      setUpdateResult(result.data.message);
      setTimeout(() => {
        const poll = setInterval(async () => {
          try {
            const r = await api.getVersion();
            if (r.ok) {
              clearInterval(poll);
              window.location.reload();
            }
          } catch { /* still restarting */ }
        }, 2000);
        setTimeout(() => clearInterval(poll), 60000);
      }, 3000);
    } else {
      setError(result.error);
      setUpdating(false);
    }
  };

  return (
    <div className="columns-1 lg:columns-2 gap-6 max-w-4xl [&>*]:mb-6 [&>*]:break-inside-avoid">
      <div className="glass-card p-4 space-y-4">
        <div>
          <h3 className="card-header">Software Update</h3>
          <p className="text-xs text-ui/40 mt-1">
            Check for and install updates from the Agent D.O.J.O. repository.
          </p>
        </div>

        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-ui/55">Current Version</span>
          <span className="text-sm text-ui/90 font-mono">{updateInfo?.currentVersion ?? '...'}</span>
        </div>

        {updateInfo?.latestVersion && (
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-ui/55">Latest Version</span>
            <span className="text-sm text-ui/90 font-mono">{updateInfo.latestVersion}</span>
          </div>
        )}

        {updateInfo && !updateInfo.updateAvailable && !updateInfo.error && (
          <div className="alert-banner alert-success text-sm">
            You're up to date.
          </div>
        )}

        {updateInfo?.updateAvailable && (
          <div className="alert-banner alert-warning text-sm">
            Update available: {updateInfo.latestVersion}
            {updateInfo.downloadSize && (
              <span className="text-xs text-cp-amber/60 ml-2">
                ({(updateInfo.downloadSize / 1024).toFixed(0)} KB)
              </span>
            )}
          </div>
        )}

        {updateInfo?.releaseNotes && updateInfo.updateAvailable && (
          <div>
            <span className="text-xs text-ui/40">Release Notes</span>
            <pre className="mt-1 text-xs text-ui/55 whitespace-pre-wrap font-mono bg-ui/[0.03] rounded p-2 max-h-40 overflow-y-auto">
              {updateInfo.releaseNotes}
            </pre>
          </div>
        )}

        {error && (
          <div className="alert-banner alert-error">
            {error}
          </div>
        )}

        {updateResult && (
          <div className="alert-banner alert-info text-sm">
            {updateResult}
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={checkUpdates}
            disabled={checking || updating}
            className="px-4 py-2 bg-ui/[0.05] hover:bg-ui/[0.08] disabled:opacity-40 text-ui/70 text-sm font-medium rounded-lg transition-colors"
          >
            {checking ? 'Checking...' : 'Check for Updates'}
          </button>

          {updateInfo?.updateAvailable && (
            <button
              onClick={handleUpdate}
              disabled={updating}
              className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors"
            >
              {updating ? 'Updating...' : 'Update Now'}
            </button>
          )}
        </div>

        {updating && (
          <div className="text-xs text-ui/40">
            Downloading and installing update. The server will restart automatically. This page will reload when the server is back.
          </div>
        )}
      </div>

      {/* Previous releases for rollback */}
      <RollbackSection currentVersion={updateInfo?.currentVersion ?? null} />
    </div>
  );
};

// ── Rollback to Previous Releases ──

const RollbackSection = ({ currentVersion }: { currentVersion: string | null }) => {
  const [releases, setReleases] = useState<api.ReleaseInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadReleases = async () => {
    setLoading(true);
    const r = await api.listReleases();
    if (r.ok) {
      setReleases(r.data.releases);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadReleases();
  }, []);

  const handleRollback = async (tag: string, version: string) => {
    if (!confirm(`Roll back to ${version}? This will download that version, replace the current install, and restart the server.`)) return;
    setRollingBack(tag);
    setError(null);
    setResult(null);
    const r = await api.rollbackToVersion(tag);
    if (r.ok) {
      setResult(r.data.message);
      setTimeout(() => {
        const poll = setInterval(async () => {
          try {
            const v = await api.getVersion();
            if (v.ok) { clearInterval(poll); window.location.reload(); }
          } catch { /* still restarting */ }
        }, 2000);
        setTimeout(() => clearInterval(poll), 60000);
      }, 3000);
    } else {
      setError(r.error ?? 'Rollback failed');
      setRollingBack(null);
    }
  };

  return (
    <div className="glass-card p-4 space-y-3">
      <h3 className="card-header">Previous Releases</h3>
      <p className="text-xs text-ui/40">
        Roll back to a previous version if the current release has issues.
      </p>

      {loading && <p className="text-xs text-ui/25">Loading releases...</p>}

      {result && (
        <div className="alert-banner alert-info text-sm">
          {result}
        </div>
      )}
      {error && (
        <div className="alert-banner alert-error">
          {error}
        </div>
      )}

      <div className="space-y-1 max-h-[500px] overflow-y-auto">
        {releases.map(r => (
          <div
            key={r.tag}
            className={`flex items-center justify-between p-2.5 rounded-lg ${
              r.isCurrent
                ? 'bg-cp-amber/10 border border-cp-amber/20'
                : 'glass-nested'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-ui/90">{r.version}</span>
                {r.isCurrent && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-cp-amber/20 text-cp-amber font-medium">
                    current
                  </span>
                )}
              </div>
              <div className="text-[10px] text-ui/40 mt-0.5 truncate">
                {r.name} · {new Date(r.publishedAt).toLocaleDateString()}
              </div>
            </div>

            {!r.isCurrent && r.downloadUrl && (
              <button
                onClick={() => handleRollback(r.tag, r.version)}
                disabled={!!rollingBack}
                className="shrink-0 ml-2 px-3 py-1.5 text-xs bg-ui/[0.05] hover:bg-ui/[0.08] border border-ui/[0.10] text-ui/70 hover:text-ui rounded-lg transition-colors disabled:opacity-30"
              >
                {rollingBack === r.tag ? 'Rolling back...' : 'Rollback'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// ── Voice Tab ──

const VAD_OPTIONS: Array<{ id: 'quick' | 'normal' | 'patient'; label: string; hint: string }> = [
  { id: 'quick',   label: 'Quick',   hint: '200ms — picks up on short pauses, may interrupt' },
  { id: 'normal',  label: 'Normal',  hint: '500ms — balanced (default)' },
  { id: 'patient', label: 'Patient', hint: '1s — waits longer, better for long thoughts' },
];

const STT_LABELS: Record<string, string> = {
  'base.en':         'Base · English only · fastest, lower quality',
  'small.en':        'Small · English only',
  'medium.en':       'Medium · English only',
  'large-v3-turbo':  'Large v3 Turbo · multilingual, best quality (default)',
};

function formatBytes(b: number): string {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(0)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const VoiceTab = () => {
  const ws = useWebSocket();
  const [voices, setVoices] = useState<api.VoicePreset[]>([]);
  const [defaultVoice, setDefaultVoice] = useState('am_michael');
  const [models, setModels] = useState<api.VoiceModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Settings (loaded from config table)
  const [voice, setVoice] = useState('am_michael');
  const [speed, setSpeed] = useState(1.0);
  const [vad, setVad] = useState<'quick' | 'normal' | 'patient'>('normal');
  const [sttModel, setSttModel] = useState('large-v3-turbo');
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [wakePhrase, setWakePhrase] = useState('');
  const [sleepPhrase, setSleepPhrase] = useState('stop listening');
  const [bargeInEnabled, setBargeInEnabled] = useState(false);
  const [soundEffectsEnabled, setSoundEffectsEnabled] = useState(true);
  // Primary agent name drives both the "Voice for X" header and the default
  // wake phrase ("hey <name>") so neither hardcodes "Kevin".
  const [primaryAgentName, setPrimaryAgentName] = useState('Agent');
  const defaultWakePhrase = `hey ${primaryAgentName.toLowerCase()}`;

  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // key = `${kind}/${id}` → fraction 0..1 (null means no active download)
  const [downloads, setDownloads] = useState<Record<string, { downloaded: number; total: number }>>({});
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const refreshModels = async () => {
    const m = await api.getVoiceModels();
    if (m.ok) setModels(m.data);
  };

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const [presets, modelsRes, vSetting, sSetting, vadSetting, sttSetting, wakeEnabled, wakeP, sleepP, primaryName, bargeIn, sfx] = await Promise.all([
        api.getVoicePresets(),
        api.getVoiceModels(),
        api.getSetting('voice.preferred_voice'),
        api.getSetting('voice.playback_speed'),
        api.getSetting('voice.vad_sensitivity'),
        api.getSetting('voice.stt_model'),
        api.getSetting('voice.wake_word_enabled'),
        api.getSetting('voice.wake_phrase'),
        api.getSetting('voice.sleep_phrase'),
        api.getSetting('primary_agent_name'),
        api.getSetting('voice.barge_in_enabled'),
        api.getSetting('voice.sound_effects_enabled'),
      ]);
      if (!mounted) return;
      if (presets.ok) {
        setVoices(presets.data.voices);
        setDefaultVoice(presets.data.defaultVoice);
        if (!vSetting.ok || !vSetting.data.value) setVoice(presets.data.defaultVoice);
      }
      if (modelsRes.ok) {
        setModels(modelsRes.data);
        if (!sttSetting.ok || !sttSetting.data.value) setSttModel(modelsRes.data.defaultWhisper);
      }
      if (vSetting.ok && vSetting.data.value) setVoice(vSetting.data.value);
      if (sSetting.ok && sSetting.data.value) {
        const n = Number(sSetting.data.value);
        if (Number.isFinite(n)) setSpeed(n);
      }
      if (vadSetting.ok && vadSetting.data.value === 'quick') setVad('quick');
      if (vadSetting.ok && vadSetting.data.value === 'patient') setVad('patient');
      if (sttSetting.ok && sttSetting.data.value) setSttModel(sttSetting.data.value);
      if (wakeEnabled.ok && wakeEnabled.data.value === 'true') setWakeWordEnabled(true);
      if (wakeP.ok && wakeP.data.value) setWakePhrase(wakeP.data.value);
      if (sleepP.ok && sleepP.data.value) setSleepPhrase(sleepP.data.value);
      if (primaryName.ok && primaryName.data.value && primaryName.data.value.trim()) {
        setPrimaryAgentName(primaryName.data.value.trim());
      }
      if (bargeIn.ok && bargeIn.data.value === 'true') setBargeInEnabled(true);
      // sound effects default ON — only flip off when explicitly stored as 'false'
      if (sfx.ok && sfx.data.value === 'false') setSoundEffectsEnabled(false);
      setLoading(false);
    };
    void load();
    return () => { mounted = false; };
  }, []);

  // Subscribe to download progress broadcasts. Multiple downloads can be
  // in flight (e.g. user picks a new STT model AND clicks Download on a
  // different one) — we key by `kind/id` so each row renders independently.
  useEffect(() => {
    const unsub = ws.subscribe('voice:model_download', (event) => {
      if (event.type !== 'voice:model_download') return;
      const { kind, modelId, bytesDownloaded, bytesTotal } = event.data;
      const key = `${kind}/${modelId}`;
      setDownloads((prev) => ({ ...prev, [key]: { downloaded: bytesDownloaded, total: bytesTotal } }));
      // Once complete, drop from active downloads after a short delay so the
      // "Saved!"-style fade happens, and refresh the on-disk list.
      if (bytesTotal > 0 && bytesDownloaded >= bytesTotal) {
        void refreshModels();
        setTimeout(() => {
          setDownloads((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }, 1500);
      }
    });
    return unsub;
  }, [ws]);

  const flashSaved = (key: string) => {
    setSavedKey(key);
    setTimeout(() => setSavedKey((cur) => (cur === key ? null : cur)), 1500);
  };

  const saveSetting = async (key: string, value: string, uiKey: string) => {
    const res = await api.setSetting(key, value);
    if (res.ok) flashSaved(uiKey);
  };

  const handlePreview = async (previewVoice: string) => {
    setPreviewError(null);
    setPreviewing(true);
    try {
      const blob = await api.fetchVoicePreview(previewVoice, speed);
      if (previewAudioRef.current) {
        try { previewAudioRef.current.pause(); } catch { /* ignore */ }
      }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const handleInstall = async (kind: 'whisper' | 'kokoro', id: string) => {
    setInstallError(null);
    setInstalling(`${kind}/${id}`);
    const res = await api.installVoiceModel(kind, id);
    if (!res.ok) setInstallError(res.error);
    await refreshModels();
    setInstalling(null);
  };

  const handleDelete = async (kind: 'whisper' | 'kokoro', id: string) => {
    if (!confirm(`Delete ${kind}/${id}? You can re-download it from this page.`)) return;
    const res = await api.deleteVoiceModel(kind, id);
    if (!res.ok) setInstallError(res.error);
    await refreshModels();
  };

  if (loading) return <div className="loading-state">Loading voice settings...</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Two-column grid for the short config cards. STT and TTS model cards
          stay full-width below because they hold per-model rows + progress bars. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Voice picker */}
      <div className="glass-card p-4 space-y-3">
        <h3 className="card-header">Voice for {primaryAgentName}</h3>
        <p className="text-xs text-ui/40">
          The voice your primary agent uses when reading replies back to you in voice mode.
        </p>
        <div className="flex items-center gap-2">
          <select
            value={voice}
            onChange={(e) => { setVoice(e.target.value); void saveSetting('voice.preferred_voice', e.target.value, 'voice'); }}
            className="glass-select flex-1"
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {v.gender === 'Female' ? 'F' : 'M'} · {v.language}{v.id === defaultVoice ? ' (default)' : ''}
              </option>
            ))}
          </select>
          <button
            onClick={() => void handlePreview(voice)}
            disabled={previewing}
            className="px-3 py-2 glass-btn-primary text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {previewing ? 'Synthesizing…' : 'Preview'}
          </button>
          {savedKey === 'voice' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
        {previewError && <p className="text-xs text-cp-coral">{previewError}</p>}
      </div>

      {/* Playback speed */}
      <div className="glass-card p-4 space-y-3">
        <h3 className="card-header">Playback speed</h3>
        <p className="text-xs text-ui/40">How fast Kevin's voice plays back. 1.0 is the natural Kokoro rate.</p>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0.8} max={1.4} step={0.05}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            onMouseUp={() => void saveSetting('voice.playback_speed', String(speed), 'speed')}
            onTouchEnd={() => void saveSetting('voice.playback_speed', String(speed), 'speed')}
            className="flex-1 accent-cp-teal"
          />
          <span className="text-sm font-mono text-ui w-12 text-right">{speed.toFixed(2)}x</span>
          {savedKey === 'speed' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
      </div>

      {/* VAD sensitivity */}
      <div className="glass-card p-4 space-y-3">
        <h3 className="card-header">Voice activity sensitivity</h3>
        <p className="text-xs text-ui/40">
          How quickly Kevin decides you've finished speaking after you pause.
        </p>
        <div className="flex flex-col gap-2">
          {VAD_OPTIONS.map((opt) => (
            <label key={opt.id} className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="vad"
                value={opt.id}
                checked={vad === opt.id}
                onChange={() => { setVad(opt.id); void saveSetting('voice.vad_sensitivity', opt.id, 'vad'); }}
                className="mt-1 accent-cp-teal"
              />
              <div>
                <div className="text-sm text-ui">{opt.label}</div>
                <div className="text-xs text-ui/40">{opt.hint}</div>
              </div>
            </label>
          ))}
          {savedKey === 'vad' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
      </div>

      {/* Voice interruption (barge-in) */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="card-header">Voice interruption</h3>
          {savedKey === 'barge' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
        <p className="text-xs text-ui/40">
          When on, talking while {primaryAgentName} is speaking interrupts the reply so you can
          jump in mid-sentence. Heads up: on phone speakers (and some laptops), the mic picks up
          {' '}{primaryAgentName}'s own voice and false-triggers the interrupt within a word or
          two. Works reliably on headphones or with good speaker isolation. Off by default.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={bargeInEnabled}
            onChange={(e) => {
              const next = e.target.checked;
              setBargeInEnabled(next);
              void saveSetting('voice.barge_in_enabled', String(next), 'barge');
              invalidateSavedVoiceSettings();
            }}
            className="accent-cp-teal"
          />
          <span className="text-sm text-ui">Allow voice to interrupt {primaryAgentName}</span>
        </label>
      </div>

      {/* Sound effects */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="card-header">Sound effects</h3>
          {savedKey === 'sfx' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
        <p className="text-xs text-ui/40">
          Subtle chimes give you audible feedback during voice mode: a wake chime when the
          wake phrase is heard, a sleep chime when the sleep phrase is heard, and a
          message-sent chime once your prompt has been submitted to {primaryAgentName}.
          Turn off if you'd rather have silent voice mode.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={soundEffectsEnabled}
            onChange={(e) => {
              const next = e.target.checked;
              setSoundEffectsEnabled(next);
              void saveSetting('voice.sound_effects_enabled', String(next), 'sfx');
              invalidateSavedVoiceSettings();
            }}
            className="accent-cp-teal"
          />
          <span className="text-sm text-ui">Play voice mode sound effects</span>
        </label>
      </div>

      {/* Hands-free wake word */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="card-header">Hands-free wake word</h3>
          {savedKey === 'wake' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
        <p className="text-xs text-ui/40">
          When enabled, voice mode stays in a passive listening state and only routes your speech
          to Kevin after it hears the wake phrase. Say the sleep phrase to put it back to sleep.
          Phrase match is case-insensitive. Heads up: passive mode runs STT continuously, so it
          uses noticeably more CPU than push-to-talk voice mode.
        </p>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={wakeWordEnabled}
            onChange={(e) => {
              const next = e.target.checked;
              setWakeWordEnabled(next);
              void saveSetting('voice.wake_word_enabled', String(next), 'wake');
              invalidateSavedVoiceSettings();
            }}
            className="accent-cp-teal"
          />
          <span className="text-sm text-ui">Enable wake word</span>
        </label>

        <div className={`space-y-3 ${wakeWordEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
          <div className="space-y-1">
            <label className="text-xs text-ui/60">Wake phrase</label>
            <input
              type="text"
              value={wakePhrase}
              onChange={(e) => setWakePhrase(e.target.value)}
              onBlur={() => {
                const trimmed = wakePhrase.trim() || defaultWakePhrase;
                if (trimmed !== wakePhrase) setWakePhrase(trimmed);
                void saveSetting('voice.wake_phrase', trimmed, 'wake');
                invalidateSavedVoiceSettings();
              }}
              placeholder={defaultWakePhrase}
              className="glass-input w-full text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-ui/60">Sleep phrase</label>
            <input
              type="text"
              value={sleepPhrase}
              onChange={(e) => setSleepPhrase(e.target.value)}
              onBlur={() => {
                const trimmed = sleepPhrase.trim() || 'stop listening';
                if (trimmed !== sleepPhrase) setSleepPhrase(trimmed);
                void saveSetting('voice.sleep_phrase', trimmed, 'wake');
                invalidateSavedVoiceSettings();
              }}
              placeholder="stop listening"
              className="glass-input w-full text-sm"
            />
          </div>
        </div>
      </div>

      </div>

      {/* Speech-to-text model (unified — pick active, download, delete, see disk) */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="card-header">Speech-to-text model</h3>
          {models && (
            <span className="text-xs text-ui/40">
              {models.freeDiskMb >= 0 ? `${(models.freeDiskMb / 1024).toFixed(1)} GB free` : ''}
            </span>
          )}
        </div>
        <p className="text-xs text-ui/40">
          Whisper transcribes your voice when voice mode is on. Larger models are more accurate
          but use more disk and CPU. The model marked Default is what the dojo uses right now.
        </p>

        {models?.whisper.map((m) => {
          const dl = downloads[`whisper/${m.id}`];
          const pct = dl && dl.total > 0 ? Math.min(100, (dl.downloaded / dl.total) * 100) : 0;
          const isActive = m.id === sttModel;
          const setAsDefault = () => {
            setSttModel(m.id);
            void saveSetting('voice.stt_model', m.id, 'stt');
            if (!m.installed && !dl) {
              setDownloads((prev) => ({ ...prev, [`whisper/${m.id}`]: { downloaded: 0, total: m.approxBytes ?? 0 } }));
              void handleInstall('whisper', m.id);
            }
          };
          return (
            <div
              key={m.id}
              className={`glass-nested px-3 py-2.5 rounded-lg space-y-2 transition-colors ${
                isActive ? 'ring-1 ring-cp-teal/40' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                {/* Default radio + label */}
                <label className="flex items-start gap-3 cursor-pointer flex-1 min-w-0">
                  <input
                    type="radio"
                    name="stt-model"
                    checked={isActive}
                    onChange={setAsDefault}
                    className="mt-1 accent-cp-teal shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="text-sm text-ui flex items-center gap-2">
                      <span className="truncate">{STT_LABELS[m.id] ?? m.id}</span>
                      {isActive && <span className="text-[10px] uppercase tracking-wide text-cp-teal shrink-0">Default</span>}
                    </div>
                    <div className="text-xs text-ui/40">
                      {m.installed
                        ? `${formatBytes(m.bytes)} on disk`
                        : m.approxBytes ? `~${formatBytes(m.approxBytes)} to download` : 'Not installed'}
                    </div>
                  </div>
                </label>

                {/* Action buttons */}
                <div className="flex gap-2 shrink-0">
                  {!m.installed && !dl && (
                    <button
                      onClick={() => {
                        setDownloads((prev) => ({ ...prev, [`whisper/${m.id}`]: { downloaded: 0, total: m.approxBytes ?? 0 } }));
                        void handleInstall('whisper', m.id);
                      }}
                      disabled={installing === `whisper/${m.id}`}
                      className="px-3 py-1.5 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
                    >
                      Download
                    </button>
                  )}
                  {m.installed && !isActive && (
                    <button
                      onClick={() => void handleDelete('whisper', m.id)}
                      className="px-3 py-1.5 text-xs text-cp-coral hover:bg-cp-coral/10 rounded-lg"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {dl && (
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-ui/40">
                    <span>{formatBytes(dl.downloaded)} / {formatBytes(dl.total)}</span>
                    <span>{pct.toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 bg-ui/[0.08] rounded-full overflow-hidden">
                    <div className="h-full bg-cp-teal transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {savedKey === 'stt' && <span className="text-xs text-cp-teal">Saved!</span>}
        <p className="text-xs text-ui/40">
          The Default model can't be deleted. Switch defaults first if you want to free its space.
        </p>
      </div>

      {/* Text-to-speech model (Kokoro lives by itself — one model, on/off) */}
      {models?.kokoro && (
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <h3 className="card-header">Text-to-speech model</h3>
            {models.totalDiskBytes > 0 && (
              <span className="text-xs text-ui/40">All voice models: {formatBytes(models.totalDiskBytes)}</span>
            )}
          </div>
          <p className="text-xs text-ui/40">
            Kokoro generates Kevin's spoken replies. One model, ~330&nbsp;MB.
          </p>

          <div className="glass-nested px-3 py-2.5 rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-ui">Kokoro 82M</div>
                <div className="text-xs text-ui/40">
                  {models.kokoro.installed
                    ? `${formatBytes(models.kokoro.bytes)} on disk${models.kokoroLoaded ? ' · loaded in memory' : ''}`
                    : 'Not installed — will download on first voice session'}
                </div>
              </div>
              <div className="flex gap-2">
                {!models.kokoro.installed && (
                  <button
                    onClick={() => {
                      const id = models.kokoro!.id;
                      setDownloads((prev) => ({ ...prev, [`kokoro/${id}`]: { downloaded: 0, total: 100 } }));
                      void handleInstall('kokoro', id);
                    }}
                    disabled={installing === `kokoro/${models.kokoro.id}`}
                    className="px-3 py-1.5 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
                  >
                    {installing === `kokoro/${models.kokoro.id}` ? 'Downloading…' : 'Download'}
                  </button>
                )}
                {models.kokoro.installed && (
                  <button
                    onClick={() => void handleDelete('kokoro', models.kokoro!.id)}
                    className="px-3 py-1.5 text-xs text-cp-coral hover:bg-cp-coral/10 rounded-lg"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
            {(() => {
              const dl = downloads[`kokoro/${models.kokoro.id}`];
              if (!dl) return null;
              const pct = dl.total > 0 ? Math.min(100, (dl.downloaded / dl.total) * 100) : 0;
              return (
                <div className="space-y-1">
                  <div className="h-1.5 bg-ui/[0.08] rounded-full overflow-hidden">
                    <div className="h-full bg-cp-teal transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-[10px] text-ui/40 text-right">{pct.toFixed(0)}%</div>
                </div>
              );
            })()}
          </div>

          {installError && <p className="text-xs text-cp-coral">{installError}</p>}
        </div>
      )}
    </div>
  );
};
