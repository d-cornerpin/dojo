import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useSearchParams } from 'react-router-dom';
import type { Provider, Model, GenerationParamSpec, VoiceOption } from '@dojo/shared';
import * as api from '../lib/api';
import { useToast } from '../hooks/useToast';
import { RouterConfig } from '../components/RouterConfig';
import { RouterTest } from '../components/RouterTest';
import { GoogleWorkspaceSettings } from '../components/GoogleWorkspaceSettings';
import { MicrosoftWorkspaceSettings } from '../components/MicrosoftWorkspaceSettings';
import { PlaudSettings } from '../components/PlaudSettings';
import { TwilioSettings } from '../components/TwilioSettings';
import { formatDate } from '../lib/dates';
import { MigrationExport } from '../components/MigrationExport';
import { MigrationImport } from '../components/MigrationImport';
import { useTheme } from '../themes';
import { invalidateSavedVoiceSettings } from '../hooks/useVoiceMode';

type Tab = 'platform' | 'providers' | 'models' | 'profile' | 'security' | 'router' | 'sensei' | 'channels' | 'integrations' | 'voice' | 'update';

export const Settings = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  // v2.7.24 — iMessage / Google / Microsoft cards moved from 'platform'/
  // 'integrations' into a new 'channels' tab (they're all communication
  // channels with safe-sender lists, auto-routing, etc.). Old deep links
  // map forward so bookmarks don't 404.
  const tabFromUrl = (
    rawTab === 'workspace' || rawTab === 'microsoft' || rawTab === 'imessage'
      ? 'channels'
      : rawTab
  ) as Tab | null;
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
    { key: 'channels', label: 'Channels' },
    { key: 'integrations', label: 'Integrations' },
    { key: 'voice', label: 'Voice' },
    { key: 'update', label: 'Update' },
  ];

  return (
    <>
      {/* Self-headered panel: the page owns its prototype .phead. */}
      <header className="phead">
        <h2 className="phead__title">Settings</h2>
        <span className="phead__meta">House rules</span>
      </header>

      {/* Tab bar — prototype .tabs/.tab pill row. Horizontally scrollable
          on narrow viewports (the .tabs primitive handles overflow), so
          the same control works on phones without a separate dropdown. */}
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => handleTabChange(tab.key)}
              className={`tab ${activeTab === tab.key ? 'is-active' : ''}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'platform' && <PlatformTab />}
      {activeTab === 'providers' && <ProvidersTab />}
      {activeTab === 'models' && <ModelsTab />}
      {activeTab === 'router' && <RouterTab />}
      {activeTab === 'profile' && <ProfileTab />}
      {activeTab === 'security' && <SecurityTab />}
      {activeTab === 'sensei' && <DreamingTab />}
      {activeTab === 'channels' && (
        <>
          {/* OAuth callbacks land on http://localhost:3001 — connecting from
              a Cloudflare-tunneled URL (or any remote host) breaks the
              redirect roundtrip. Surface this once at the top of the page
              so users don't get cryptic "session expired" errors after the
              Google/Microsoft sign-in popup closes. */}
          <div className="note--warn max-w-4xl" style={{ textTransform: 'none', letterSpacing: 'normal', marginBottom: 18 }}>
            <p style={{ fontWeight: 600 }}>Connect accounts from your local Mac, not via a tunnel.</p>
            <p style={{ marginTop: 4, fontWeight: 400 }}>
              Google and Microsoft sign-in redirects land on <code>http://localhost:3001</code> — that only resolves when this dashboard is open on the same machine running the Dojo. If you're hitting the dashboard through a Cloudflare tunnel or named host from another device, the OAuth callback won't reach the server and the connection will silently fail. Sit at the host machine and use <code>http://localhost:3000</code> for the connect flow; once connected, the credentials work regardless of how you access the dashboard.
            </p>
          </div>
          <div className="scards">
            <IMBridgeSettings />
            <GoogleWorkspaceSettings />
            <MicrosoftWorkspaceSettings />
          </div>
        </>
      )}
      {activeTab === 'integrations' && (
        <div className="scards">
          <PlaudSettings />
          <TwilioSettings />
        </div>
      )}
      {activeTab === 'voice' && <VoiceTab />}
      {activeTab === 'update' && <UpdateTab />}
    </>
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
    <div className="tile space-y-4">
      <div>
        <div className="scard__title">iMessage Bridge</div>
        <div className="scard__desc">
          Enable to send and receive messages with your agent via iMessage. Requires Full Disk Access for Terminal in System Settings &gt; Privacy &amp; Security &gt; Full Disk Access.
        </div>
      </div>

      {/* Toggle */}
      <div className="flex items-center justify-between">
        <label className="text-sm text-ui/70">Enable iMessage Bridge</label>
        <button
          type="button"
          aria-pressed={enabled}
          onClick={() => setEnabled(!enabled)}
          className={`switch ${enabled ? 'is-on' : ''}`}
        />
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
    <div className="scards">
      <AgentLimitsSettings />
      <OllamaSettings />
      <RemoteAccessSettings />
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
      toast.error(`Cleanup failed to start: ${result.error}`);
      setCleaning(false);
      return;
    }
    const data = result.data;
    if (data?.status === 'noop') {
      toast.info(data.message);
      setCleaning(false);
      return;
    }
    toast.info(`Cleaning up ${data?.targetCount ?? '?'} backup(s) in the background. This can take a few minutes.`);

    // Poll the cleanup status endpoint every 5s until it finishes. The
    // request itself returns instantly so Cloudflare's 100s ceiling is
    // never a factor; the actual rm -rf runs server-side independently.
    const start = Date.now();
    const MAX_POLL_MS = 10 * 60 * 1000; // 10-minute ceiling on our patience
    while (Date.now() - start < MAX_POLL_MS) {
      await new Promise(r => setTimeout(r, 5000));
      const status = await api.getCleanupStatus();
      if (!status.ok) continue; // transient; keep polling
      const s = status.data;
      if (s && !s.inProgress) {
        if (s.error) {
          toast.error(`Cleanup failed: ${s.error}`);
        } else if (s.failedCount > 0) {
          toast.warning(`Cleanup partially complete: ${s.deletedCount} deleted, ${s.failedCount} failed. ${s.remainingOnDisk} backups still on disk.`);
        } else {
          toast.info(`Cleaned up ${s.deletedCount} backup(s). ${s.remainingOnDisk} kept.`);
        }
        const refresh = await api.listPlatformBackups();
        if (refresh.ok) setBackups(refresh.data);
        setCleaning(false);
        return;
      }
    }
    // Polling timeout (10 min) - tell the user the job is still running.
    toast.warning('Cleanup is taking longer than expected. It is still running in the background; refresh the page later to check.');
    setCleaning(false);
  };

  return (
    <div className="tile space-y-3">
      <div>
        <div className="scard__title">Server</div>
        <div className="scard__desc">
          Most settings on this tab hot-reload and do not need a restart. Use this if you've changed
          something deeper (model registry, OAuth config) that asked for a restart, or if the server
          looks stuck and you want to recycle it without SSHing to the host.
        </div>
      </div>

      {!confirming && !restarting && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="btn"
        >
          Restart server
        </button>
      )}

      {confirming && !restarting && (
        <div className="space-y-2">
          <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
            This exits the server process immediately. In production it auto-restarts via launchd
            within a few seconds. <strong>If you're running `npm run dev`</strong>, tsx watch will
            NOT bring it back — you'll need to re-run the command in your terminal.
          </div>
          <div className="srow">
            <button
              type="button"
              onClick={doRestart}
              className="btn btn--primary btn--sm"
            >
              Yes, restart now
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="px-3 py-2 text-sm text-ui/55 hover:text-ui/90 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {restarting && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
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
                : `${backups.count} backup(s) on disk.`}
            </p>
            {backups.count > 1 && (
              <button
                type="button"
                onClick={doCleanup}
                disabled={cleaning}
                className="btn btn--sm"
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
    <div className="tile">
      <div className="scard__title">Feng Shui</div>
      <div className="scard__desc">
        Choose the visual theme for your Dojo.
      </div>

      {themes.map(theme => {
        const selected = themeId === theme.id;
        return (
          <div
            key={theme.id}
            role="radio"
            aria-checked={selected}
            tabIndex={0}
            onClick={() => setTheme(theme.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTheme(theme.id); } }}
            className={`radio-card ${selected ? 'is-selected' : ''}`}
          >
            <span className="radio-card__dot" />
            <div>
              <div className="radio-card__name">{theme.name}</div>
              <div className="radio-card__desc">{theme.description}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ── Migration (Export/Import) ──

const MigrationSettings = () => {
  const [showImport, setShowImport] = useState(false);

  return (
    <div className="tile">
      <div className="scard__title">Migration</div>
      <div className="scard__desc">
        Export your entire dojo to move it to another machine, or import from a previous export.
      </div>

      <div className="srow">
        <MigrationExport />
        <button
          type="button"
          onClick={() => setShowImport(!showImport)}
          className="btn"
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

  if (loading) return <div className="tile loading-state">Loading...</div>;

  const isActive = status?.status === 'active';
  const isStarting = status?.status === 'starting';

  return (
    <div className="tile space-y-4">
      <div>
        <div className="scard__title">Remote Access</div>
        <div className="scard__desc">
          Access your dojo from anywhere via Cloudflare Tunnel.
        </div>
      </div>

      {/* Security warning */}
      {(isActive || isStarting) && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
          Your dojo is accessible from the internet. Make sure you have a strong password set in Settings &gt; Security.
        </div>
      )}

      {/* cloudflared not installed */}
      {!status?.cloudflaredInstalled && (
        <div className="glass-nested rounded-xl p-3 space-y-2">
          <p className="text-xs text-ui/55">cloudflared is not installed.</p>
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing}
            className="btn btn--primary btn--sm"
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
              <div className="tech__head">
                <span className="pill pill--ok"><i className="dot" />Tunnel active</span>
                {status.mode === 'quick' && <span className="text-[10px] text-ui/25">Quick Tunnel</span>}
                {status.mode === 'named' && <span className="text-[10px] text-ui/25">Named Tunnel</span>}
                <span className="toolbar__spacer" />
                {status.url && <span className="link" onClick={copyUrl}>Copy</span>}
              </div>
              {status.url && (
                <a href={status.url} target="_blank" rel="noopener noreferrer" className="mono-url" style={{ display: 'block', marginTop: 6 }}>{status.url}</a>
              )}
              {/* When in named mode and no URL saved yet, let the user add it
                  inline without disabling+re-enabling. The URL is what was
                  configured in Cloudflare's Published Application Routes. */}
              {status.mode === 'named' && !status.url && (
                <div className="space-y-1">
                  <p className="text-[10px] text-ui/40">Add the public URL you configured in Cloudflare so the dashboard and the agent can use it.</p>
                  <div className="srow">
                    <input
                      type="text"
                      value={namedUrl}
                      onChange={(e) => setNamedUrl(e.target.value)}
                      placeholder="https://dojo.example.com"
                      className="finput"
                      style={{ flex: 1, width: 'auto' }}
                    />
                    <button
                      type="button"
                      onClick={handleSaveNamedUrl}
                      disabled={acting || !namedUrl.trim()}
                      className="btn btn--primary btn--sm"
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}
              <button
                type="button"
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
              <span className="pill pill--draft"><i className="dot" />Starting tunnel</span>
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
                    className="finput"
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
                    className="finput"
                  />
                  <p className="text-[10px] text-ui/25">
                    No domain on Cloudflare yet? Add one at <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer" className="font-mono text-cp-blue hover:underline">dash.cloudflare.com</a> &rarr; <span className="font-mono">+ Add &rarr; Existing domain</span> (free DNS transfer), or register one through Cloudflare Registrar (~$8–10/yr).
                  </p>
                </div>
              )}

              <button
                type="button"
                onClick={handleEnable}
                disabled={acting || (mode === 'named' && !token.trim())}
                className="btn btn--primary"
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

  if (loading) return <div className="tile loading-state">Loading...</div>;

  return (
    <div className="tile">
      <div className="scard__title">Ollama (Local Models)</div>
      <div className="scard__desc">
        Controls how many different Ollama models can be loaded in RAM simultaneously.
        Set to 1 for 16GB machines, 2+ if you have more RAM.
      </div>
      <label className="flabel">Max Concurrent Models</label>
      <div className="srow">
        <input
          type="number"
          min={1}
          max={8}
          value={maxConcurrent}
          onChange={(e) => setMaxConcurrent(e.target.value)}
          className="finput"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="btn btn--primary btn--sm"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
      </div>
      <div className="fhelp">
        When agents use more local models than this limit, requests queue until the current model finishes.
        A 7B model uses ~4GB RAM, a 30B model uses ~16GB.
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

  if (loading) return <div className="tile loading-state">Loading...</div>;

  return (
    <div className="tile">
      <div className="scard__title">Dojo Capacity</div>
      <div className="scard__desc">
        Controls how many agents can run and how they are spawned. Changes take effect immediately.
      </div>
      <div className="fgrid">
        {AGENT_LIMIT_KEYS.map((item) => (
          <div key={item.key}>
            <label className="flabel">{item.label}</label>
            <input
              type="number"
              min={item.min}
              max={item.max}
              value={values[item.key] ?? item.default}
              onChange={(e) => setValues(prev => ({ ...prev, [item.key]: e.target.value }))}
              className="finput"
            />
            <div className="fhelp">{item.description}</div>
          </div>
        ))}
      </div>
      <div className="srow">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="btn btn--primary"
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
    <div className="tile">
      <div className="scard__title">Web Search Provider</div>
      <div className="scard__desc">
        Configure web search for the web_search tool.
      </div>

      <label className="flabel">Provider</label>
      <select
        value={provider}
        onChange={(e) => setProvider(e.target.value)}
        className="finput field--select"
        style={{ marginBottom: 14 }}
      >
        <option value="brave">Brave Search</option>
      </select>

      <label className="flabel">Brave Search API Key</label>
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={hasKey ? '••••••••••••••••' : 'Enter Brave Search API key'}
        aria-label="API key"
        className="finput"
      />
      <div className="fhelp" style={{ marginBottom: 14 }}>
        Brave Search has a free tier (2,000 queries/month).{' '}
        <a
          href="https://api-dashboard.search.brave.com/app/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="link"
        >
          Get a key
        </a>{' '}
        · No account?{' '}
        <a
          href="https://api-dashboard.search.brave.com/register"
          target="_blank"
          rel="noopener noreferrer"
          className="link"
        >
          Sign up
        </a>
      </div>

      {error && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
          {error}
        </div>
      )}

      {validationResult === 'valid' && (
        <div className="note--warn" style={{ textTransform: 'none', letterSpacing: 'normal' }}>
          API key is valid
        </div>
      )}

      <div className="srow">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          className="btn btn--primary btn--sm"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={handleValidate}
          disabled={validating || (!apiKey.trim() && !hasKey)}
          className="btn btn--sm"
        >
          {validating ? 'Validating...' : 'Validate'}
        </button>
        <span className="toolbar__spacer" />
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
        <span className={`pill ${hasKey ? 'pill--ok' : ''}`}>
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
        Use your Claude Pro or Max subscription through the Agent SDK. Requires two things: the Claude Code CLI installed, and a signed-in Claude account.{' '}
        <a
          href="https://claude.ai/upgrade"
          target="_blank"
          rel="noopener noreferrer"
          className="text-cp-teal hover:text-cp-teal/80 underline"
        >
          Don't have Claude Pro? Sign up ↗
        </a>
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
              className="tile flex items-center justify-between"
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
                  {syncing === provider.id ? 'Syncing...' : 'Sync Models and Pricing'}
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
          type="button"
          onClick={() => setShowAdd(true)}
          className="btn btn--primary"
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
    <form onSubmit={handleSubmit} className="tile space-y-3">
      <div className="fgrid" style={{ marginBottom: 0 }}>
        <div>
          <label className="flabel">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="finput"
          />
        </div>
        <div>
          <label className="flabel">Type</label>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="finput field--select"
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
          <label className="flabel">Base URL</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434"
            className="finput"
          />
          <p className="text-[11px] text-ui/40 mt-1">
            Ollama runs models locally — no account needed.{' '}
            <a
              href="https://ollama.com/download"
              target="_blank"
              rel="noopener noreferrer"
              className="text-cp-teal hover:text-cp-teal/80 underline"
            >
              Download Ollama ↗
            </a>{' '}
            if you don't have it installed yet.
          </p>
        </div>
      )}

      {preset !== 'ollama' && (
        <>
          {preset === 'anthropic' && (
            <div>
              <label className="flabel">Auth Type</label>
              <select
                value={authType}
                onChange={(e) => setAuthType(e.target.value as 'api_key' | 'oauth' | 'agent-sdk')}
                className="finput field--select"
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
              <label className="flabel">
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
                className="finput"
              />
              {/* Per-provider help: where to grab a key (or create an
                  account first). Each link opens the provider's
                  console keys page in a new tab. */}
              {preset === 'anthropic' && authType !== 'oauth' && (
                <p className="text-[11px] text-ui/40 mt-1">
                  Don't have a key?{' '}
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Create one at Anthropic Console ↗
                  </a>{' '}
                  · No account?{' '}
                  <a href="https://console.anthropic.com/signup" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Sign up ↗
                  </a>
                </p>
              )}
              {preset === 'anthropic' && authType === 'oauth' && (
                <p className="text-[11px] text-ui/40 mt-1">
                  OAuth tokens are typically issued through a Claude Pro/Max plan.{' '}
                  <a href="https://claude.ai/upgrade" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Compare plans ↗
                  </a>
                </p>
              )}
              {preset === 'openai' && (
                <p className="text-[11px] text-ui/40 mt-1">
                  Don't have a key?{' '}
                  <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Create one at OpenAI Platform ↗
                  </a>{' '}
                  · No account?{' '}
                  <a href="https://platform.openai.com/signup" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Sign up ↗
                  </a>
                </p>
              )}
              {preset === 'openrouter' && (
                <p className="text-[11px] text-ui/40 mt-1">
                  Don't have a key?{' '}
                  <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Create one at OpenRouter ↗
                  </a>{' '}
                  · No account?{' '}
                  <a href="https://openrouter.ai/sign-up" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Sign up ↗
                  </a>
                </p>
              )}
              {preset === 'deepseek' && (
                <p className="text-[11px] text-ui/40 mt-1">
                  Don't have a key?{' '}
                  <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Create one at DeepSeek Platform ↗
                  </a>{' '}
                  · No account?{' '}
                  <a href="https://platform.deepseek.com/sign_up" target="_blank" rel="noopener noreferrer" className="text-cp-teal hover:text-cp-teal/80 underline">
                    Sign up ↗
                  </a>
                </p>
              )}
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

      <div className="srow">
        <button
          type="submit"
          disabled={status === 'saving' || status === 'validating' || status === 'valid' || !name.trim() || (preset !== 'ollama' && authType !== 'agent-sdk' && !credential.trim())}
          className="btn btn--primary btn--sm"
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
  // Collapsed by default — long catalogs (OpenRouter etc.) make the page
  // unwieldy when every group expands on load. User clicks to drill in.
  const [open, setOpen] = useState(false);
  const enabledCount = models.filter(m => m.isEnabled).length;

  return (
    <div className="tile overflow-hidden">
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
      <div className="glass-nested rounded-xl p-3 flex items-center gap-3 text-xs">
        <span className="text-ui/40 w-20">Host RAM</span>
        <span className="text-ui/70 font-mono">auto-detected (this machine)</span>
        <span className="text-[10px] text-ui/25 italic">
          num_ctx recommendations use os.totalmem()
        </span>
      </div>
    );
  }

  return (
    <div className="glass-nested rounded-xl p-3 flex items-center gap-3 text-xs">
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
    title: 'Can generate images via the image_create tool',
  },
  video_generation: {
    label: 'Video Gen',
    className: 'bg-cp-coral/15 text-cp-coral border-cp-coral/30',
    title: 'Can generate video via the video_create tool',
  },
  audio_generation: {
    label: 'TTS',
    className: 'bg-cp-teal/15 text-cp-teal border-cp-teal/30',
    title: 'Text-to-speech: reads text aloud as a voice. Drives the tts_create tool.',
  },
  music_generation: {
    label: 'Music Gen',
    className: 'bg-cp-purple/15 text-cp-purple border-cp-purple/30',
    title: 'Composes music or sound effects from a creative prompt. Different from TTS — does NOT read text aloud.',
  },
  transcription: {
    label: 'Transcription',
    className: 'bg-cp-blue/15 text-cp-blue border-cp-blue/30',
    title: 'Can convert audio to text via the transcribe_audio tool',
  },
};

// Capability keys the user can manually toggle in the edit UI. Matches
// the MANUAL_ADD_CAPABILITIES set above, but kept separately so we can
// independently evolve either without coupling the two flows.
const EDITABLE_CAPABILITIES = [
  { key: 'tools', label: 'Tools' },
  { key: 'vision', label: 'Vision' },
  { key: 'thinking', label: 'Thinking' },
  { key: 'image_generation', label: 'Image Gen' },
  { key: 'video_generation', label: 'Video Gen' },
  { key: 'audio_generation', label: 'TTS' },
  { key: 'music_generation', label: 'Music Gen' },
  { key: 'transcription', label: 'Transcription' },
] as const;

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
  const [unitCost, setUnitCost] = useState(
    model.costPerUnit === null || model.costPerUnit === undefined
      ? (model.costPerMegapixel === null || model.costPerMegapixel === undefined
        ? ''
        : String(model.costPerMegapixel))
      : String(model.costPerUnit),
  );
  type PricingUnitChoice = 'token' | 'megapixel' | 'second' | 'character' | 'minute' | 'item';
  const [pricingUnit, setPricingUnit] = useState<PricingUnitChoice>(model.pricingUnit ?? 'token');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const supportsImageGen = model.capabilities.includes('image_generation');
  const supportsVideoGen = model.capabilities.includes('video_generation');
  const supportsAudioGen = model.capabilities.includes('audio_generation');
  const supportsMusicGen = model.capabilities.includes('music_generation');
  const supportsTranscription = model.capabilities.includes('transcription');

  // Which pricing units make sense for this model's capability set.
  // Token is always offered. Each other unit appears only when the
  // matching capability is on the model. 'item' (flat per-song / image /
  // clip) applies to any generation capability.
  const availableUnits: PricingUnitChoice[] = ['token'];
  if (supportsImageGen) availableUnits.push('megapixel');
  if (supportsVideoGen || supportsAudioGen || supportsMusicGen) availableUnits.push('second');
  if (supportsAudioGen) availableUnits.push('character');
  if (supportsTranscription) availableUnits.push('minute');
  if (supportsImageGen || supportsVideoGen || supportsAudioGen || supportsMusicGen) availableUnits.push('item');
  const showUnitToggle = availableUnits.length > 1;

  const UNIT_LABEL: Record<PricingUnitChoice, string> = {
    token: 'Token',
    megapixel: 'Megapixel',
    second: 'Second',
    character: 'Character',
    minute: 'Minute',
    item: 'Item',
  };
  const UNIT_PLACEHOLDER: Record<PricingUnitChoice, string> = {
    token: '',
    megapixel: '$ per output megapixel',
    second: '$ per second of output',
    character: '$ per character of input',
    minute: '$ per minute of input',
    item: '$ per generated item (song / image / clip)',
  };
  const UNIT_INPUT_LABEL: Record<PricingUnitChoice, string> = {
    token: '$/M',
    megapixel: '$/MP',
    second: '$/sec',
    character: '$/char',
    minute: '$/min',
    item: '$/item',
  };

  // Local optimistic state for the thinking toggle. Mirrors the prop but
  // flips instantly on click while the PATCH is in flight.
  const [thinkingEnabled, setThinkingEnabled] = useState(model.thinkingEnabled);
  const supportsThinking = model.capabilities.includes('thinking');

  // Inline capability editor — opens when the user clicks Edit next to
  // the capability badges. Lets the user overwrite the probed
  // capabilities directly. Useful when a provider doesn't advertise a
  // newly-launched SKU's true output modality (e.g. OpenRouter not
  // tagging google/lyria-3-clip-preview as audio_generation).
  const [editingCaps, setEditingCaps] = useState(false);
  const [draftCaps, setDraftCaps] = useState<Set<string>>(new Set(model.capabilities));
  const [savingCaps, setSavingCaps] = useState(false);
  const capsChanged =
    editingCaps && (
      draftCaps.size !== model.capabilities.length ||
      model.capabilities.some(c => !draftCaps.has(c))
    );
  const handleCapsSave = async () => {
    setSavingCaps(true);
    const result = await api.updateModelCapabilities(model.id, Array.from(draftCaps));
    setSavingCaps(false);
    if (result.ok) {
      setEditingCaps(false);
      onPricingChange(); // reload models so badges + downstream pickers refresh
    } else {
      toast.error(result.error ?? 'Failed to save capabilities');
    }
  };
  const handleCapsCancel = () => {
    setDraftCaps(new Set(model.capabilities));
    setEditingCaps(false);
  };

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

  // Parse the per-unit cost input. Empty string → null (unknown).
  const parsedUnit = unitCost.trim() === '' ? null : Number(unitCost);
  const currentSavedUnitValue = model.costPerUnit ?? model.costPerMegapixel ?? null;
  const unitHasChanges = parsedUnit !== currentSavedUnitValue;
  const tokenHasChanges =
    Number(inputCost) !== (model.inputCostPerM ?? 0) ||
    Number(outputCost) !== (model.outputCostPerM ?? 0);
  const hasChanges =
    pricingUnit !== (model.pricingUnit ?? 'token') ||
    (pricingUnit === 'token' ? tokenHasChanges : unitHasChanges);

  const handleSave = async () => {
    setSaving(true);
    const payload: Parameters<typeof api.updateModelPricing>[1] = {
      pricingUnit,
    };
    if (pricingUnit === 'token') {
      payload.inputCostPerM = Number(inputCost) || 0;
      payload.outputCostPerM = Number(outputCost) || 0;
    } else {
      // null is meaningful (unknown), so send it through explicitly.
      payload.costPerUnit = parsedUnit;
    }
    const result = await api.updateModelPricing(model.id, payload);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onPricingChange();
    }
    setSaving(false);
  };

  const handleUnitToggle = async (next: PricingUnitChoice) => {
    if (next === pricingUnit) return;
    setPricingUnit(next);
    // Persist the mode change immediately so the model is consistent
    // even if the user navigates away without typing a new number.
    setSaving(true);
    const result = await api.updateModelPricing(model.id, { pricingUnit: next });
    if (result.ok) onPricingChange();
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
    <div className="tile">
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
          {editingCaps ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {EDITABLE_CAPABILITIES.map((cap) => {
                const checked = draftCaps.has(cap.key);
                return (
                  <button
                    key={cap.key}
                    type="button"
                    onClick={() => {
                      const next = new Set(draftCaps);
                      if (checked) next.delete(cap.key);
                      else next.add(cap.key);
                      setDraftCaps(next);
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                      checked
                        ? 'bg-cp-amber/20 text-cp-amber border-cp-amber/40'
                        : 'bg-ui/[0.03] text-ui/40 border-ui/[0.10] hover:border-ui/[0.15]'
                    }`}
                  >
                    {cap.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={handleCapsSave}
                disabled={savingCaps || !capsChanged}
                className="px-2 py-0.5 text-[10px] glass-btn-primary rounded transition-colors disabled:opacity-40"
              >
                {savingCaps ? '...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={handleCapsCancel}
                disabled={savingCaps}
                className="px-2 py-0.5 text-[10px] text-ui/40 hover:text-ui/70 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
              <CapabilityBadges capabilities={model.capabilities} />
              <button
                type="button"
                onClick={() => {
                  setDraftCaps(new Set(model.capabilities));
                  setEditingCaps(true);
                }}
                className="text-[10px] text-ui/40 hover:text-ui/70 underline transition-colors"
                title="Override the probed capabilities. Use when the provider didn't advertise a real capability of this model."
              >
                Edit
              </button>
            </div>
          )}
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
            type="button"
            aria-pressed={model.isEnabled}
            onClick={onToggle}
            className={`switch ${model.isEnabled ? 'is-on' : ''}`}
          />
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

      {/* Pricing fields — segmented control for "priced by" appears
          only when the model has more than one applicable unit. Token
          is always one option; capability-specific units appear when
          the relevant capability is on the model. */}
      {showUnitToggle && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] text-ui/40">Priced by</span>
          <div className="flex rounded-md overflow-hidden border border-ui/[0.10] text-[11px] font-medium">
            {availableUnits.map((unit) => (
              <button
                key={unit}
                onClick={() => handleUnitToggle(unit)}
                className={`px-2.5 py-1 transition-colors ${
                  pricingUnit === unit
                    ? 'bg-cp-amber/20 text-cp-amber'
                    : 'bg-ui/[0.03] text-ui/40 hover:text-ui/70'
                }`}
              >
                {UNIT_LABEL[unit]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-4 flex-wrap">
        {pricingUnit === 'token' ? (
          <>
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
          </>
        ) : (
          <div className="flex items-center gap-2">
            <label className="text-xs text-ui/40 w-20" title={UNIT_PLACEHOLDER[pricingUnit]}>
              {UNIT_INPUT_LABEL[pricingUnit]}
            </label>
            <input
              type="number"
              step="0.001"
              min="0"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              onBlur={() => hasChanges && handleSave()}
              placeholder="leave blank if unknown"
              className="glass-input w-40 font-mono text-right"
            />
          </div>
        )}
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

      {supportsVideoGen && (
        <GenerationParamsEditor model={model} onSaved={onPricingChange} />
      )}

      {supportsAudioGen && (
        <VoiceCatalogEditor model={model} onSaved={onPricingChange} />
      )}
    </div>
  );
};

// ── Generation Params Editor ──
// Per-model editor for the canonical generation params the agent must
// supply (video: duration / aspect_ratio / resolution). Each param maps to
// the model's accepted values/range plus the provider wire field it
// translates to. This is the user-confirmed override layer (decision: make
// the per-model spec editable on the card); blank or no edits leave the
// family-seeded default in place.
type ParamFieldDraft = {
  accepted: boolean;
  values: string;   // comma-separated, edited as text
  min: string;
  max: string;
  default: string;
  wireField: string;
  wireType: 'string' | 'number';
};

const specToDraft = (spec: GenerationParamSpec): Record<string, ParamFieldDraft> => {
  const out: Record<string, ParamFieldDraft> = {};
  for (const [name, f] of Object.entries(spec)) {
    out[name] = {
      accepted: f.accepted,
      values: f.values.map((v) => String(v)).join(', '),
      min: f.min === undefined ? '' : String(f.min),
      max: f.max === undefined ? '' : String(f.max),
      default: String(f.default),
      wireField: f.wireField,
      wireType: f.wireType,
    };
  }
  return out;
};

const GenerationParamsEditor = ({ model, onSaved }: { model: Model; onSaved: () => void }) => {
  const toast = useToast();
  const spec = model.generationParams;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, ParamFieldDraft>>(
    spec ? specToDraft(spec) : {},
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!spec) {
    return (
      <div className="mt-3 text-[10px] text-ui/25 italic">
        Generation params not seeded yet — restart the server to backfill, then edit here.
      </div>
    );
  }

  const paramNames = Object.keys(draft);

  const setField = (name: string, key: keyof ParamFieldDraft, value: string | boolean) => {
    setDraft((prev) => ({ ...prev, [name]: { ...prev[name], [key]: value } }));
  };

  const handleSave = async () => {
    // Rebuild a GenerationParamSpec from the draft. Numeric values are
    // coerced when the underlying wireType is number; otherwise kept as
    // strings (the agent-facing enum is matched by string equality).
    const next: GenerationParamSpec = {};
    for (const [name, d] of Object.entries(draft)) {
      const isNumeric = d.wireType === 'number';
      const values = d.values
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => (isNumeric ? Number(s) : s));
      const min = d.min.trim() === '' ? undefined : Number(d.min);
      const max = d.max.trim() === '' ? undefined : Number(d.max);
      const def = isNumeric && d.default.trim() !== '' && Number.isFinite(Number(d.default))
        ? Number(d.default)
        : d.default;
      next[name] = {
        accepted: d.accepted,
        values,
        ...(min !== undefined && Number.isFinite(min) ? { min } : {}),
        ...(max !== undefined && Number.isFinite(max) ? { max } : {}),
        default: def,
        wireField: d.wireField.trim(),
        wireType: d.wireType,
      };
    }
    setSaving(true);
    const result = await api.updateModelGenerationParams(model.id, next);
    setSaving(false);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved();
    } else {
      toast.error(result.error ?? 'Failed to save generation params');
    }
  };

  const handleReset = async () => {
    if (!confirm('Reset to the seeded defaults? Your edits will be cleared.')) return;
    setSaving(true);
    const result = await api.updateModelGenerationParams(model.id, null);
    setSaving(false);
    if (result.ok) {
      onSaved();
    } else {
      toast.error(result.error ?? 'Failed to reset generation params');
    }
  };

  return (
    <div className="mt-3 border-t border-ui/[0.08] pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-ui/55 hover:text-ui/80 transition-colors flex items-center gap-1"
        title="The agent must supply these params to use video_create. Edit the accepted values and how each maps to this model's request body."
      >
        <span>{open ? '▾' : '▸'}</span>
        Generation parameters
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-[80px_1fr_52px_52px_64px_84px_70px] gap-1.5 text-[9px] uppercase tracking-wide text-ui/30 px-0.5">
            <span>Param</span>
            <span>Allowed values</span>
            <span>Min</span>
            <span>Max</span>
            <span>Default</span>
            <span>Wire field</span>
            <span>Wire type</span>
          </div>
          {paramNames.map((name) => {
            const d = draft[name];
            return (
              <div key={name} className="grid grid-cols-[80px_1fr_52px_52px_64px_84px_70px] gap-1.5 items-center">
                <label className="inline-flex items-center gap-1 text-[11px] text-ui/60" title="Uncheck to drop this param from the request body for this model (the agent still must supply it).">
                  <input
                    type="checkbox"
                    checked={d.accepted}
                    onChange={(e) => setField(name, 'accepted', e.target.checked)}
                    className="h-3 w-3 rounded border-ui/[0.15] bg-ui/[0.05] accent-amber-500"
                  />
                  <span className="truncate">{name}</span>
                </label>
                <input
                  type="text"
                  value={d.values}
                  onChange={(e) => setField(name, 'values', e.target.value)}
                  placeholder="comma-separated; blank = use min/max"
                  className="glass-input text-[11px] font-mono"
                />
                <input
                  type="text"
                  value={d.min}
                  onChange={(e) => setField(name, 'min', e.target.value)}
                  className="glass-input text-[11px] font-mono text-right"
                />
                <input
                  type="text"
                  value={d.max}
                  onChange={(e) => setField(name, 'max', e.target.value)}
                  className="glass-input text-[11px] font-mono text-right"
                />
                <input
                  type="text"
                  value={d.default}
                  onChange={(e) => setField(name, 'default', e.target.value)}
                  className="glass-input text-[11px] font-mono text-right"
                />
                <input
                  type="text"
                  value={d.wireField}
                  onChange={(e) => setField(name, 'wireField', e.target.value)}
                  className="glass-input text-[11px] font-mono"
                />
                <select
                  value={d.wireType}
                  onChange={(e) => setField(name, 'wireType', e.target.value as 'string' | 'number')}
                  className="glass-input text-[11px]"
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                </select>
              </div>
            );
          })}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-2 py-1 text-xs glass-btn-primary rounded transition-colors"
            >
              {saving ? '...' : 'Save'}
            </button>
            <button
              onClick={handleReset}
              disabled={saving}
              className="text-[10px] text-ui/40 hover:text-ui/70 underline transition-colors"
              title="Clear your edits and re-apply the family-seeded defaults."
            >
              reset to defaults
            </button>
            {saved && <span className="text-xs text-cp-teal">Saved</span>}
            <span className="text-[10px] text-ui/25 italic">
              aspect_ratio + resolution compose the size field
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Voice Catalog Editor ──
// Per-model editor for the TTS voice list the agent may pick from (the
// tts_create tool). Each entry is an id (base timbre), a description (the
// vibe shown to the agent), and a perceived gender. Seeded from a code
// family registry; this is the user-confirmed override layer. Reset clears
// to null and lets the family seed re-apply on the next backfill.
type VoiceDraft = { id: string; description: string; gender: 'male' | 'female' | 'neutral' };

const VoiceCatalogEditor = ({ model, onSaved }: { model: Model; onSaved: () => void }) => {
  const toast = useToast();
  const catalog = model.voiceCatalog;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<VoiceDraft[]>(
    catalog ? catalog.map((v) => ({ id: v.id, description: v.description, gender: v.gender })) : [],
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!catalog) {
    return (
      <div className="mt-3 text-[10px] text-ui/25 italic">
        Voice catalog not seeded yet — restart the server to backfill, then edit here.
      </div>
    );
  }

  const setVoice = (i: number, key: keyof VoiceDraft, value: string) => {
    setDraft((prev) => prev.map((v, idx) => (idx === i ? { ...v, [key]: value } : v)));
  };
  const addVoice = () => setDraft((prev) => [...prev, { id: '', description: '', gender: 'neutral' }]);
  const removeVoice = (i: number) => setDraft((prev) => prev.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    const next: VoiceOption[] = draft
      .map((v) => ({ id: v.id.trim(), description: v.description.trim(), gender: v.gender }))
      .filter((v) => v.id.length > 0);
    setSaving(true);
    const result = await api.updateModelVoiceCatalog(model.id, next);
    setSaving(false);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved();
    } else {
      toast.error(result.error ?? 'Failed to save voice catalog');
    }
  };

  const handleReset = async () => {
    if (!confirm('Reset to the seeded voices? Your edits will be cleared.')) return;
    setSaving(true);
    const result = await api.updateModelVoiceCatalog(model.id, null);
    setSaving(false);
    if (result.ok) {
      onSaved();
    } else {
      toast.error(result.error ?? 'Failed to reset voice catalog');
    }
  };

  return (
    <div className="mt-3 border-t border-ui/[0.08] pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-ui/55 hover:text-ui/80 transition-colors flex items-center gap-1"
        title="The voices the agent may pick from for tts_create. The id sets the base timbre; the description is the vibe the agent matches against a request."
      >
        <span>{open ? '▾' : '▸'}</span>
        Voices ({draft.length})
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-[96px_1fr_84px_28px] gap-1.5 text-[9px] uppercase tracking-wide text-ui/30 px-0.5">
            <span>Voice id</span>
            <span>Character</span>
            <span>Gender</span>
            <span></span>
          </div>
          {draft.map((v, i) => (
            <div key={i} className="grid grid-cols-[96px_1fr_84px_28px] gap-1.5 items-center">
              <input
                type="text"
                value={v.id}
                onChange={(e) => setVoice(i, 'id', e.target.value)}
                placeholder="onyx"
                className="glass-input text-[11px] font-mono"
              />
              <input
                type="text"
                value={v.description}
                onChange={(e) => setVoice(i, 'description', e.target.value)}
                placeholder="deep and authoritative"
                className="glass-input text-[11px]"
              />
              <select
                value={v.gender}
                onChange={(e) => setVoice(i, 'gender', e.target.value)}
                className="glass-input text-[11px]"
              >
                <option value="male">male</option>
                <option value="female">female</option>
                <option value="neutral">neutral</option>
              </select>
              <button
                type="button"
                onClick={() => removeVoice(i)}
                className="text-ui/30 hover:text-red-400 transition-colors text-sm"
                title="Remove this voice"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addVoice}
            className="text-[10px] text-ui/40 hover:text-ui/70 underline transition-colors"
          >
            + add voice
          </button>
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-2 py-1 text-xs glass-btn-primary rounded transition-colors"
            >
              {saving ? '...' : 'Save'}
            </button>
            <button
              onClick={handleReset}
              disabled={saving}
              className="text-[10px] text-ui/40 hover:text-ui/70 underline transition-colors"
              title="Clear your edits and re-apply the family-seeded voices."
            >
              reset to defaults
            </button>
            {saved && <span className="text-xs text-cp-teal">Saved</span>}
            <span className="text-[10px] text-ui/25 italic">
              character/accent/emotion goes in the spoken text, not the id
            </span>
          </div>
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
  const [searched, setSearched] = useState(false);
  // The model the user clicked "Add" on; drives the pricing modal. Adding
  // is confirmed from inside the modal so the user can pull/enter a price.
  const [pricingModalModel, setPricingModalModel] = useState<api.BrowseModelResult | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearched(true);
    const result = await api.browseProviderModels(providerId, query.trim());
    if (result.ok) setResults(result.data);
    else setResults([]);
    setSearching(false);
  };

  const handleAdded = (apiModelId: string) => {
    setResults(prev => prev.filter(r => r.apiModelId !== apiModelId));
    setPricingModalModel(null);
    onModelAdded();
  };

  const formatCost = (cost: number | null) => {
    if (cost === null || cost === 0) return 'Free';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
  };

  return (
    <div className="tile space-y-3">
      <h3 className="scard__title">Browse {providerName} Models</h3>
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
                  {model.priceAvailable === false ? (
                    <span className="text-cp-coral font-medium">No price from API (set on add)</span>
                  ) : (
                    <>
                      <span>In: {formatCost(model.inputCostPerM)}/M</span>
                      <span>Out: {formatCost(model.outputCostPerM)}/M</span>
                    </>
                  )}
                </div>
              </div>
              <button
                onClick={() => setPricingModalModel(model)}
                className="ml-2 px-3 py-1 text-xs bg-cp-teal/20 text-cp-teal hover:bg-cp-teal/30 rounded-lg transition-colors shrink-0"
              >
                Add
              </button>
            </div>
          ))}
        </div>
      )}

      {searched && results.length === 0 && !searching && (
        <p className="text-xs text-ui/25 text-center py-2">No models found matching "{query}"</p>
      )}

      {pricingModalModel && (
        <AddModelPricingModal
          providerId={providerId}
          model={pricingModalModel}
          onClose={() => setPricingModalModel(null)}
          onAdded={() => handleAdded(pricingModalModel.apiModelId)}
        />
      )}

      {/* Manual Add — for models not in the catalog */}
      <ManualAddModel providerId={providerId} onModelAdded={onModelAdded} />
    </div>
  );
};

// ── Add-from-catalog pricing modal ──
//
// Opens when the user clicks "Add" on a browse result. If the catalog
// reported a price we pre-fill it; if not (media-only generators that
// OpenRouter lists as free), we say so in red and let the user enter one
// or leave it blank. Every pricing unit is offered so per-song / per-clip
// models can be priced correctly at add time.

type AddModalUnit = 'token' | 'megapixel' | 'second' | 'character' | 'minute' | 'item';

const ADD_MODAL_UNITS: { unit: AddModalUnit; label: string; inputLabel: string; hint: string }[] = [
  { unit: 'token', label: 'Token', inputLabel: '$ / M tokens', hint: 'Per million input/output tokens.' },
  { unit: 'item', label: 'Item', inputLabel: '$ / item', hint: 'Flat price per generated item (a song, an image, a clip).' },
  { unit: 'second', label: 'Second', inputLabel: '$ / second', hint: 'Per second of generated media (video / audio).' },
  { unit: 'megapixel', label: 'Megapixel', inputLabel: '$ / megapixel', hint: 'Per output megapixel (image gen).' },
  { unit: 'minute', label: 'Minute', inputLabel: '$ / minute', hint: 'Per minute of input audio (transcription).' },
  { unit: 'character', label: 'Character', inputLabel: '$ / character', hint: 'Per character of input text (TTS).' },
];

const AddModelPricingModal = ({
  providerId,
  model,
  onClose,
  onAdded,
}: {
  providerId: string;
  model: api.BrowseModelResult;
  onClose: () => void;
  onAdded: () => void;
}) => {
  const priceAvailable = model.priceAvailable !== false;

  // Default unit: token when the catalog gave us a price; otherwise guess
  // from the model's output modality so media generators land on a
  // sensible unit (video → second, image → megapixel, audio → item).
  const guessUnit = (): AddModalUnit => {
    if (priceAvailable) return 'token';
    const mods = model.outputModalities ?? [];
    if (mods.includes('video')) return 'second';
    if (mods.includes('audio')) return 'item';
    if (mods.includes('image')) return 'megapixel';
    return 'token';
  };

  const [unit, setUnit] = useState<AddModalUnit>(guessUnit());
  const [inputPrice, setInputPrice] = useState(
    model.inputCostPerM !== null && model.inputCostPerM !== undefined ? String(model.inputCostPerM) : '',
  );
  const [outputPrice, setOutputPrice] = useState(
    model.outputCostPerM !== null && model.outputCostPerM !== undefined ? String(model.outputCostPerM) : '',
  );
  const [unitPrice, setUnitPrice] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsePrice = (s: string): number | null => {
    const trimmed = s.trim();
    if (trimmed === '') return null;
    const n = parseFloat(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const handleConfirm = async () => {
    setAdding(true);
    setError(null);
    const result = await api.addProviderModel(providerId, {
      ...model,
      pricingUnit: unit,
      inputCostPerM: unit === 'token' ? parsePrice(inputPrice) : null,
      outputCostPerM: unit === 'token' ? parsePrice(outputPrice) : null,
      costPerUnit: unit === 'token' ? null : parsePrice(unitPrice),
    });
    setAdding(false);
    if (result.ok) onAdded();
    else setError(result.error ?? 'Failed to add model');
  };

  const activeHint = ADD_MODAL_UNITS.find(u => u.unit === unit)?.hint ?? '';
  const activeInputLabel = ADD_MODAL_UNITS.find(u => u.unit === unit)?.inputLabel ?? '$ / unit';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="glass-modal-bg relative z-10 w-full max-w-md p-5 rounded-2xl shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-ui/90">Add model</h3>
        <p className="text-xs text-ui/50 mt-0.5 truncate">{model.name}</p>
        <p className="text-[10px] text-ui/35 truncate">{model.apiModelId}</p>

        {priceAvailable ? (
          <p className="mt-3 text-[11px] text-ui/45">Pricing was pulled from the provider catalog. Adjust if needed.</p>
        ) : (
          <p className="mt-3 text-[11px] text-cp-coral">
            This provider's catalog doesn't expose a price for this model. Enter one below, or leave it blank to set it later.
          </p>
        )}

        <div className="mt-4">
          <label className="block text-[11px] font-medium text-ui/60 mb-1">Priced by</label>
          <div className="flex flex-wrap gap-1.5">
            {ADD_MODAL_UNITS.map(({ unit: u, label }) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                  unit === u
                    ? 'bg-cp-teal/25 text-cp-teal'
                    : 'bg-ui/[0.05] text-ui/50 hover:bg-ui/[0.08]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-ui/35">{activeHint}</p>
        </div>

        <div className="mt-4">
          {unit === 'token' ? (
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-[10px] text-ui/45 mb-1">Input $ / M</label>
                <input
                  type="number" min="0" step="any" value={inputPrice}
                  onChange={(e) => setInputPrice(e.target.value)}
                  placeholder="blank = unknown"
                  className="glass-input w-full text-sm"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[10px] text-ui/45 mb-1">Output $ / M</label>
                <input
                  type="number" min="0" step="any" value={outputPrice}
                  onChange={(e) => setOutputPrice(e.target.value)}
                  placeholder="blank = unknown"
                  className="glass-input w-full text-sm"
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-[10px] text-ui/45 mb-1">{activeInputLabel}</label>
              <input
                type="number" min="0" step="any" value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                placeholder="blank = unknown"
                className="glass-input w-full text-sm"
              />
            </div>
          )}
        </div>

        {error && <p className="mt-3 text-[11px] text-cp-coral">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={adding}
            className="px-3 py-1.5 rounded-lg text-xs text-ui/60 hover:text-ui/90 hover:bg-ui/[0.06] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={adding}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-cp-teal/20 text-cp-teal hover:bg-cp-teal/30 transition-colors disabled:opacity-40"
          >
            {adding ? 'Adding…' : 'Add model'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Manual Add Model (for models not in the provider catalog) ──

const MANUAL_ADD_CAPABILITIES = [
  { key: 'tools', label: 'Tools', desc: 'Function/tool calling' },
  { key: 'vision', label: 'Vision', desc: 'Image input' },
  { key: 'thinking', label: 'Thinking', desc: 'Extended reasoning' },
  { key: 'image_generation', label: 'Image Gen', desc: 'Image output' },
  { key: 'video_generation', label: 'Video Gen', desc: 'Video output' },
  { key: 'audio_generation', label: 'TTS', desc: 'Text-to-speech: reads text aloud' },
  { key: 'music_generation', label: 'Music Gen', desc: 'Composes music / sound effects from a prompt' },
  { key: 'transcription', label: 'Transcription', desc: 'Speech-to-text' },
] as const;

type ManualAddPricingUnit = 'token' | 'megapixel' | 'second' | 'character' | 'minute' | 'item';

const ManualAddModel = ({ providerId, onModelAdded }: { providerId: string; onModelAdded: () => void }) => {
  const [expanded, setExpanded] = useState(false);
  const [modelId, setModelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selectedCaps, setSelectedCaps] = useState<Set<string>>(new Set());
  const [pricingUnit, setPricingUnit] = useState<ManualAddPricingUnit>('token');
  const [inputPrice, setInputPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which units are available given the capability checkboxes the
  // user has ticked. Token is always allowed; the others mirror the
  // ModelRow rules.
  const supportsImageGen = selectedCaps.has('image_generation');
  const supportsVideoGen = selectedCaps.has('video_generation');
  const supportsAudioGen = selectedCaps.has('audio_generation');
  const supportsMusicGen = selectedCaps.has('music_generation');
  const supportsTranscription = selectedCaps.has('transcription');
  const availableUnits: ManualAddPricingUnit[] = ['token'];
  if (supportsImageGen) availableUnits.push('megapixel');
  if (supportsVideoGen || supportsAudioGen || supportsMusicGen) availableUnits.push('second');
  if (supportsAudioGen) availableUnits.push('character');
  if (supportsTranscription) availableUnits.push('minute');
  if (supportsImageGen || supportsVideoGen || supportsAudioGen || supportsMusicGen) availableUnits.push('item');

  // If the user untoggled a capability that the current unit depended
  // on, snap back to token so we don't submit an invalid combo.
  useEffect(() => {
    if (!availableUnits.includes(pricingUnit)) setPricingUnit('token');
  }, [availableUnits, pricingUnit]);

  const UNIT_LABEL: Record<ManualAddPricingUnit, string> = {
    token: 'Token', megapixel: 'Megapixel', second: 'Second',
    character: 'Character', minute: 'Minute', item: 'Item',
  };
  const UNIT_HINT: Record<ManualAddPricingUnit, string> = {
    token: 'Per million tokens. Enter 0 for free; blank for unknown.',
    megapixel: 'Per output megapixel. Useful for OpenRouter image-gen SKUs that don\'t price by token.',
    second: 'Per second of generated media. Typical for video and some audio models.',
    character: 'Per character of input text. Common for TTS providers.',
    minute: 'Per minute of input audio. Common for transcription providers.',
    item: 'Flat price per generated item (a song, an image, a clip). Common for music models that bill per track.',
  };

  const toggleCap = (key: string) => {
    setSelectedCaps(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Parse a price input. Empty → null (unknown). "0" → 0 (free).
  // Anything else → number, or null if not parseable.
  const parsePrice = (s: string): number | null => {
    const trimmed = s.trim();
    if (trimmed === '') return null;
    const n = parseFloat(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const handleAdd = async () => {
    const trimmedId = modelId.trim();
    if (!trimmedId) { setError('Model ID is required'); return; }
    setError(null);
    setAdding(true);

    // Defensively snap back to token if the chosen unit no longer
    // matches a selected capability (e.g. the user toggled MP, then
    // unchecked image_generation before submitting).
    const effectiveUnit: ManualAddPricingUnit =
      availableUnits.includes(pricingUnit) ? pricingUnit : 'token';

    const result = await api.addProviderModel(providerId, {
      apiModelId: trimmedId,
      name: displayName.trim() || trimmedId,
      contextWindow: null,
      maxOutputTokens: null,
      inputCostPerM: effectiveUnit === 'token' ? parsePrice(inputPrice) : null,
      outputCostPerM: effectiveUnit === 'token' ? parsePrice(outputPrice) : null,
      pricingUnit: effectiveUnit,
      costPerUnit: effectiveUnit === 'token' ? null : parsePrice(unitPrice),
      capabilities: Array.from(selectedCaps),
    } as api.BrowseModelResult & { capabilities?: string[]; pricingUnit?: ManualAddPricingUnit; costPerUnit?: number | null });

    setAdding(false);
    if (result.ok) {
      setModelId('');
      setDisplayName('');
      setSelectedCaps(new Set());
      setInputPrice('');
      setOutputPrice('');
      setUnitPrice('');
      setPricingUnit('token');
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

          <div>
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <label className="form-label">Pricing (optional)</label>
              {availableUnits.length > 1 && (
                <div className="flex rounded-md overflow-hidden border border-ui/[0.10] text-[11px] font-medium">
                  {availableUnits.map((unit) => (
                    <button
                      key={unit}
                      onClick={() => setPricingUnit(unit)}
                      className={`px-2.5 py-1 transition-colors ${
                        pricingUnit === unit
                          ? 'bg-cp-amber/20 text-cp-amber'
                          : 'bg-ui/[0.03] text-ui/40 hover:text-ui/70'
                      }`}
                      type="button"
                    >
                      {UNIT_LABEL[unit]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {pricingUnit === 'token' ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={inputPrice}
                    onChange={(e) => setInputPrice(e.target.value)}
                    placeholder="Input $/M — blank if unknown"
                    className="glass-input w-full"
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={outputPrice}
                    onChange={(e) => setOutputPrice(e.target.value)}
                    placeholder="Output $/M — blank if unknown"
                    className="glass-input w-full"
                  />
                </div>
                <p className="text-[10px] text-ui/25 mt-1">{UNIT_HINT.token}</p>
              </>
            ) : (
              <>
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                  placeholder={`$ per ${pricingUnit} — blank if unknown`}
                  className="glass-input w-full"
                />
                <p className="text-[10px] text-ui/25 mt-1">{UNIT_HINT[pricingUnit]}</p>
              </>
            )}
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

      {/* Platform-level model pickers — placed below the provider
          catalogs. Masonry of capability cards (matches the prototype's
          .scards). Receive the live models list as a prop so newly-
          added models show up in the dropdowns without a page reload. */}
      <div className="scards pt-3">
        <FallbackVisionModelCard models={models} />
        <ImageGenModelCard models={models} />
        <VideoGenModelCard models={models} />
        <AudioGenModelCard models={models} />
        <MusicGenModelCard models={models} />
        <TranscriptionModelCard models={models} />
      </div>
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
      <div className="scards">
      <div className="tile space-y-4">
        <div>
          <div className="scard__title">Dreaming</div>
          <p className="text-xs text-ui/40 mt-1">
            Configure how the dojo processes its daily conversations into long-term memories overnight. A temporary "Dreamer" agent is spawned to do the work -- it uses the tracker, extracts knowledge, and dismisses itself when done.
          </p>
        </div>

        <div>
          <label className="flabel">Dreamer Model</label>
          <select
            value={dreamModelId}
            onChange={(e) => setDreamModelId(e.target.value)}
            className="finput field--select"
          >
            <option value="">Auto (first available Standard tier model)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.apiModelId})
              </option>
            ))}
          </select>
          <div className="fhelp">
            The model the Dreamer agent uses. Standard tier recommended for good extraction quality at reasonable cost.
          </div>
        </div>

        <div>
          <label className="flabel">Dream Time</label>
          <input
            type="time"
            value={dreamTime}
            onChange={(e) => setDreamTime(e.target.value)}
            className="finput"
          />
          <div className="fhelp">
            When the Dreamer agent wakes up to process the day's conversations. Default: 3:00 AM.
          </div>
        </div>

        <div>
          <label className="flabel mb-2">Dream Mode</label>
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

        <div className="srow pt-2 flex-wrap">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="btn btn--primary btn--sm"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            onClick={handleRunNow}
            disabled={running}
            className="btn btn--sm"
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
        <div className="tile space-y-2 mt-6">
          <div className="scard__title">Last Dream</div>
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
  // Primary agent name pulled from runtime config so the help copy reads
  // "Kevin / Jain / whatever-this-install-named-their-agent" instead of
  // hardcoding any one user's choice.
  const [primaryAgentName, setPrimaryAgentName] = useState('the primary agent');

  // Filter to models that the capability probe has flagged as image-capable.
  const imageCapableModels = models.filter(m => m.capabilities.includes('image_generation'));

  useEffect(() => {
    const load = async () => {
      const [enabledResult, modelResult, aspectResult, styleResult, nameResult] = await Promise.all([
        api.getSetting('imaginer_enabled'),
        api.getSetting('imaginer_image_model'),
        api.getSetting('imaginer_default_aspect_ratio'),
        api.getSetting('imaginer_default_style'),
        api.getSetting('primary_agent_name'),
      ]);
      if (nameResult.ok && nameResult.data.value) {
        setPrimaryAgentName(nameResult.data.value);
      }
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
    <div className="tile space-y-4">
      <div>
        <div className="scard__title">Imaginer (Image Generation Sensei)</div>
        <p className="text-xs text-ui/40 mt-1">
          Imaginer is a system agent that turns text descriptions into images when any agent calls the{' '}
          <code className="text-cp-amber">image_create</code> tool. {primaryAgentName} and sub-agents never need to switch models
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
        <label className="flabel">Image Generation Model</label>
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
              className="finput field--select"
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
              separate text model ({primaryAgentName}'s default by default).
            </p>
          </>
        )}
      </div>

      {/* Default aspect ratio */}
      <div>
        <label className="flabel">Default Aspect Ratio</label>
        <select
          value={defaultAspect}
          onChange={(e) => setDefaultAspect(e.target.value)}
          className="finput field--select"
        >
          {ASPECT_RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <div className="fhelp">Used when requesting agents don't specify one.</div>
      </div>

      {/* Default style */}
      <div>
        <label className="flabel">Default Style (optional)</label>
        <input
          type="text"
          value={defaultStyle}
          onChange={(e) => setDefaultStyle(e.target.value)}
          placeholder="e.g. photorealistic, cinematic lighting"
          className="finput"
        />
        <div className="fhelp">Fallback style hint when requesting agents don't specify one.</div>
      </div>

      {/* Output dir (read-only info) */}
      <div>
        <label className="flabel">Output Directory</label>
        <code className="block text-[11px] text-ui/55 px-3 py-2 bg-ui/[0.03] rounded font-mono">
          ~/.dojo/uploads/generated/
        </code>
      </div>

      {/* Save + Test buttons */}
      <div className="srow pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !imageModelId || imageCapableModels.length === 0}
          className="btn btn--primary btn--sm"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={handleTest}
          disabled={testing || !imageModelId || imageCapableModels.length === 0}
          className="btn btn--sm"
        >
          {testing ? 'Testing...' : 'Generate test image'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
        {testResult && <span className="text-xs text-ui/55">{testResult}</span>}
      </div>
    </div>
  );
};

// ── Fallback Vision Model Card ──
//
// Single platform-wide choice: which vision-capable model handles
// vision work when the calling agent's own model can't see. Used by
// screen_read, web_browse screenshots, and anywhere else the engine
// needs to route an image through a vision model. Replaces the old
// per-tool "cheapest vision-ish enabled model" auto-pick.

// Self-contained: loads its own model list since it lives on the Dojo
// tab, which doesn't otherwise need the model catalog. Keeps this card
// Small cost display rendered below a model dropdown. Tri-state per
// unit field:
//   number > 0 → formatted "$X / <unit>"
//   exactly 0 → "Free"
//   null      → unknown (line collapses to a quiet hint when nothing
//               is known about pricing)
const formatTokenPrice = (n: number | null): string | null => {
  if (n === null || typeof n !== 'number') return null;
  if (n === 0) return 'Free';
  return `$${n}/M`;
};

// Per-unit formatting for the non-token pricing units. Returns null
// when the value is null or invalid. Returns the literal "Free" when
// zero. Character pricing displays per-thousand (rates are tiny,
// per-character would render as fractions of a cent).
const formatUnitPrice = (
  n: number | null,
  unit: 'megapixel' | 'second' | 'character' | 'minute' | 'item',
): string | null => {
  if (n === null || typeof n !== 'number') return null;
  if (n === 0) return 'Free';
  switch (unit) {
    case 'megapixel': return `$${n}/MP`;
    case 'second':    return `$${n}/second`;
    case 'minute':    return `$${n}/minute`;
    case 'character': return `$${n * 1000} / 1k chars`;
    case 'item':      return `$${n}/item`;
  }
};

const ModelCostLine = ({ model }: { model: Model | null }) => {
  if (!model) return null;

  // Non-token units: read costPerUnit (falls back to costPerMegapixel
  // during the v2.11.0 compat window for image-gen rows added pre-061).
  if (model.pricingUnit !== 'token') {
    const value = model.costPerUnit ?? model.costPerMegapixel;
    const label = formatUnitPrice(value, model.pricingUnit);
    if (label === null) {
      return (
        <p className="text-[11px] text-ui/35 mt-2">
          Pricing not listed for this model.
        </p>
      );
    }
    return (
      <p className="text-[11px] text-ui/55 mt-2">
        Cost: <span className="text-ui/80">{label}</span>
      </p>
    );
  }

  // Token: separate input and output rates.
  const inLabel = formatTokenPrice(model.inputCostPerM);
  const outLabel = formatTokenPrice(model.outputCostPerM);
  if (inLabel === null && outLabel === null) {
    return (
      <p className="text-[11px] text-ui/35 mt-2">
        Pricing not listed for this model.
      </p>
    );
  }
  return (
    <p className="text-[11px] text-ui/55 mt-2">
      Cost:{' '}
      {inLabel !== null && (
        <span className="text-ui/80">{inLabel} in</span>
      )}
      {inLabel !== null && outLabel !== null && <span className="text-ui/35"> &middot; </span>}
      {outLabel !== null && (
        <span className="text-ui/80">{outLabel} out</span>
      )}
    </p>
  );
};

// Generic platform-capability model picker card. Same shape every
// picker has: a dropdown over enabled-and-capability-matching models,
// a Save / Clear button, a configured-but-invalid warning, and a
// ModelCostLine under the dropdown.
//
// `extraOptions` lets a caller inject pseudo entries that aren't in
// the models table (used by the transcription card to expose
// `local:whisper` and `local:moonshine`). When one of those is
// selected, the picker calls `renderExtraCostLine` for the cost
// display instead of ModelCostLine.
interface ExtraOption {
  id: string;
  label: string;
  costLine?: React.ReactNode;
}
const CapabilityModelCard = ({
  title,
  description,
  settingKey,
  capability,
  selectorLabel,
  noModelsMessage,
  noSelectionMessage,
  models,
  extraOptions = [],
}: {
  title: string;
  description: string;
  settingKey: string;
  capability: string;
  selectorLabel: string;
  noModelsMessage: string;
  noSelectionMessage: string;
  models: Model[];
  extraOptions?: ExtraOption[];
}) => {
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const matchingModels = models.filter(m => m.isEnabled && m.capabilities.includes(capability));
  const hasAnyOption = matchingModels.length > 0 || extraOptions.length > 0;

  useEffect(() => {
    const load = async () => {
      const settingResult = await api.getSetting(settingKey);
      if (settingResult.ok && settingResult.data.value) setSelectedId(settingResult.data.value);
      setLoading(false);
    };
    load();
  }, [settingKey]);

  const handleSave = async () => {
    setSaving(true);
    await api.setSetting(settingKey, selectedId);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClear = async () => {
    setSaving(true);
    await api.setSetting(settingKey, '');
    setSelectedId('');
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return null;

  const isExtra = extraOptions.some(o => o.id === selectedId);
  const selectedModel = matchingModels.find(m => m.id === selectedId) ?? null;
  const configuredButInvalid = selectedId !== '' && !isExtra && !selectedModel;
  const selectedExtra = extraOptions.find(o => o.id === selectedId) ?? null;

  return (
    <div className="tile space-y-4">
      <div>
        <div className="scard__title">{title}</div>
        <p className="text-xs text-ui/40 mt-1">{description}</p>
      </div>

      {!hasAnyOption ? (
        <div className="alert-banner alert-warning">{noModelsMessage}</div>
      ) : !selectedId ? (
        <div className="alert-banner alert-warning">{noSelectionMessage}</div>
      ) : configuredButInvalid ? (
        <div className="alert-banner alert-warning">
          The saved model is no longer available. Pick a new one below.
        </div>
      ) : null}

      {hasAnyOption && (
        <>
          <div>
            <label className="flabel">{selectorLabel}</label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="finput field--select"
            >
              <option value="">(none)</option>
              {extraOptions.length > 0 && (
                <optgroup label="Local">
                  {extraOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </optgroup>
              )}
              {matchingModels.length > 0 && (
                <optgroup label={extraOptions.length > 0 ? 'Cloud' : ''}>
                  {matchingModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.apiModelId})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {selectedExtra
              ? (selectedExtra.costLine ?? (
                  <p className="text-[11px] text-ui/55 mt-2">Cost: <span className="text-ui/80">Free</span> <span className="text-ui/35">(runs on this machine)</span></p>
                ))
              : <ModelCostLine model={selectedModel} />}
          </div>

          <div className="srow">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="btn btn--primary btn--sm"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            {selectedId && (
              <button
                type="button"
                onClick={handleClear}
                disabled={saving}
                className="btn btn--sm"
              >
                Clear
              </button>
            )}
            {saved && <span className="text-xs text-cp-teal">Saved!</span>}
          </div>
        </>
      )}
    </div>
  );
};

// Thin wrappers around CapabilityModelCard. Each gives the generic
// component its title, description, setting key, and capability flag.
// The two existing cards (vision + image gen) replace ~120 lines each
// of nearly identical boilerplate; the three new cards (video, audio
// gen, transcription) come online for free.
const FallbackVisionModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Fallback Vision Model"
    description="The model used to look at images when your agent's own model can't see."
    settingKey="dojo_fallback_vision_model_id"
    capability="vision"
    selectorLabel="Vision model"
    noModelsMessage="No vision-capable models are enabled. Enable one above and come back here to pick it."
    noSelectionMessage="No vision model selected. Pick one below."
    models={models}
  />
);

const ImageGenModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Image Generation Model"
    description="The model used when an agent creates an image."
    settingKey="dojo_image_gen_model_id"
    capability="image_generation"
    selectorLabel="Image-gen model"
    noModelsMessage="No image-generation models are enabled. Enable one above and come back here to pick it."
    noSelectionMessage="No image-generation model selected. Pick one below."
    models={models}
  />
);

const VideoGenModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Video Generation Model"
    description="The model used when an agent creates a video. Video can take a few minutes to generate."
    settingKey="dojo_video_gen_model_id"
    capability="video_generation"
    selectorLabel="Video-gen model"
    noModelsMessage="No video-generation models are enabled. Enable one above and come back here to pick it."
    noSelectionMessage="No video-generation model selected. Pick one below."
    models={models}
  />
);

const AudioGenModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Text-to-Speech (TTS) Model"
    description="The model used to generate spoken-audio reads of text on request (the tts_create tool). Separate from the Voice tab, which is how you talk with the agent live. Music / sound-effect models have their own picker below."
    settingKey="dojo_audio_gen_model_id"
    capability="audio_generation"
    selectorLabel="TTS model"
    noModelsMessage="No TTS models are enabled. Enable one above and come back here to pick it. (Tip: untag music models from this capability via the Edit button on their row.)"
    noSelectionMessage="No TTS model selected. Pick one below."
    models={models}
  />
);

const MusicGenModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Music Generation Model"
    description="The model used when an agent composes music or sound effects from a prompt. Different from TTS, which reads text aloud."
    settingKey="dojo_music_gen_model_id"
    capability="music_generation"
    selectorLabel="Music-gen model"
    noModelsMessage="No music-generation models are enabled. Enable one above (e.g. Google Lyria) and come back here to pick it."
    noSelectionMessage="No music-generation model selected. Pick one below."
    models={models}
  />
);

// Transcription is special: it exposes two local engines (Whisper,
// Moonshine) that don't live in the models table. Those surface
// through the extraOptions prop as `local:whisper` and
// `local:moonshine` and run on this machine for free.
const TranscriptionModelCard = ({ models }: { models: Model[] }) => (
  <CapabilityModelCard
    title="Transcription Model"
    description="The model used when an agent converts audio to text. Local engines run on this machine."
    settingKey="dojo_transcription_model_id"
    capability="transcription"
    selectorLabel="Transcription model"
    noModelsMessage="Pick a local engine, or enable a transcription-capable cloud model above."
    noSelectionMessage="No transcription model selected. Pick one below."
    models={models}
    extraOptions={[
      { id: 'local:whisper', label: 'Whisper (local, via whisper.cpp)' },
      { id: 'local:moonshine', label: 'Moonshine (local, default)' },
    ]}
  />
);


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
    } else if (result.error === 'NO_REPORT_RECIPIENT') {
      toast.error('No Healer Report recipient is configured. Set healer_report_recipient in the config table before sending.');
    } else {
      toast.error(result.error ?? 'Failed to send report');
    }
    setSendingReport(false);
  };

  if (loading) return <div className="tile loading-state">Loading...</div>;

  return (
    <div className="tile space-y-4">
      <div>
        <div className="scard__title">Healing</div>
        <p className="text-xs text-ui/40 mt-1">
          The Healer agent analyzes daily health data, auto-fixes routine issues (stuck agents, orphaned tasks), and proposes solutions for complex problems. Proposals appear on the Vitals page for your approval.
        </p>
      </div>

      <div>
        <label className="flabel">Healer Model</label>
        <select
          value={healerModelId}
          onChange={(e) => setHealerModelId(e.target.value)}
          className="finput field--select"
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
        <label className="flabel">Healing Time</label>
        <input
          type="time"
          value={healerTime}
          onChange={(e) => setHealerTime(e.target.value)}
          className="finput"
        />
        <div className="fhelp">
          When the Healer runs each day. Default: 4:00 AM (after the Dreamer).
        </div>
      </div>

      <div>
        <label className="flabel mb-2">Mode</label>
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

      <div className="srow pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="btn btn--primary btn--sm"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={handleRunNow}
          disabled={running || healerMode === 'off'}
          className="btn btn--sm"
        >
          {running ? 'Running...' : 'Run Now'}
        </button>
        {saved && <span className="text-xs text-cp-teal">Saved!</span>}
      </div>

      <div>
        <button
          type="button"
          onClick={handleSendReport}
          disabled={sendingReport}
          className="btn btn--sm"
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
    <div className="scards">
      <div className="tile space-y-4">
        <div>
          <div className="scard__title">Software Update</div>
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

        <div className="srow pt-2">
          <button
            type="button"
            onClick={checkUpdates}
            disabled={checking || updating}
            className="btn btn--sm"
          >
            {checking ? 'Checking...' : 'Check for Updates'}
          </button>

          {updateInfo?.updateAvailable && (
            <button
              type="button"
              onClick={handleUpdate}
              disabled={updating}
              className="btn btn--primary btn--sm"
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
    <div className="tile space-y-3">
      <div className="scard__title">Previous Releases</div>
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
  { id: 'normal',  label: 'Normal',  hint: '500ms — balanced' },
  { id: 'patient', label: 'Patient', hint: '1s — waits longer, better for long thoughts' },
];

const STT_LABELS: Record<string, string> = {
  'moonshine-base':  'Moonshine base · English only · fastest, no native deps (default)',
  'base.en':         'Whisper Base · English only · fast, lower quality',
  'small.en':        'Whisper Small · English only',
  'medium.en':       'Whisper Medium · English only',
  'large-v3-turbo':  'Whisper Large v3 Turbo · multilingual',
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
  const [vad, setVad] = useState<'quick' | 'normal' | 'patient'>('quick');
  const [sttModel, setSttModel] = useState('moonshine-base');
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

  const refreshVoices = async () => {
    const v = await api.getVoicePresets();
    if (v.ok) setVoices(v.data.voices);
  };

  // Custom voice import form state. Kept inside the component so the form
  // doesn't outlive a tab unmount.
  const [importName, setImportName] = useState('');
  const [importId, setImportId] = useState('');
  const [importLang, setImportLang] = useState<'en-us' | 'en-gb'>('en-us');
  const [importGender, setImportGender] = useState<'Male' | 'Female'>('Male');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // ── Hume cloud TTS (Local | Cloud sub-tabs in the Voice card) ──
  // Sub-tab selection persisted as voice.tts_engine. Cloud tab is only
  // usable once a valid Hume key is on file.
  const [ttsTab, setTtsTab] = useState<'local' | 'cloud'>('local');
  const [humeKeySet, setHumeKeySet] = useState(false);
  const [humeKeyInput, setHumeKeyInput] = useState('');
  const [humeKeyBusy, setHumeKeyBusy] = useState(false);
  const [humeKeyMsg, setHumeKeyMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [humeVoices, setHumeVoices] = useState<api.HumeVoiceInfo[]>([]);
  const [humeVoicesLoading, setHumeVoicesLoading] = useState(false);
  const [humeVoicesError, setHumeVoicesError] = useState<string | null>(null);
  const [cloudVoice, setCloudVoice] = useState('');
  const [cloudVoiceProvider, setCloudVoiceProvider] = useState<'HUME_AI' | 'CUSTOM_VOICE'>('HUME_AI');
  const [cloudDescription, setCloudDescription] = useState('');
  const [cloudSpeed, setCloudSpeed] = useState(1.0);

  const refreshHumeStatus = async () => {
    const r = await api.getHumeStatus();
    if (r.ok) setHumeKeySet(r.data.keySet);
  };

  const refreshHumeVoices = async () => {
    setHumeVoicesLoading(true);
    setHumeVoicesError(null);
    try {
      const r = await api.listHumeVoices();
      if (!r.ok) {
        setHumeVoicesError(r.error);
        setHumeVoices([]);
        return;
      }
      setHumeVoices(r.data.voices);
    } finally {
      setHumeVoicesLoading(false);
    }
  };

  const handleSetHumeKey = async () => {
    const k = humeKeyInput.trim();
    if (!k) {
      setHumeKeyMsg({ kind: 'err', text: 'Paste a Hume API key first.' });
      return;
    }
    setHumeKeyBusy(true);
    setHumeKeyMsg(null);
    try {
      const r = await api.setHumeKey(k);
      if (!r.ok) {
        setHumeKeyMsg({ kind: 'err', text: r.error });
        return;
      }
      setHumeKeySet(true);
      setHumeKeyInput('');
      setHumeKeyMsg({ kind: 'ok', text: 'Loading voices…' });
      await refreshHumeVoices();
      // Clear the flash message — the static "Key set." label takes
      // over the "key is configured" indication, so a duplicate flash
      // just clutters the row.
      setHumeKeyMsg(null);
    } finally {
      setHumeKeyBusy(false);
    }
  };

  const handleClearHumeKey = async () => {
    if (!confirm('Clear the stored Hume API key? Cloud TTS will stop until you re-add one.')) return;
    const r = await api.clearHumeKey();
    if (!r.ok) {
      setHumeKeyMsg({ kind: 'err', text: r.error });
      return;
    }
    setHumeKeySet(false);
    setHumeVoices([]);
    setHumeKeyMsg({ kind: 'ok', text: 'Key cleared.' });
    // If we were on the Cloud tab, snap back to Local — the engine
    // dropped out from under us.
    if (ttsTab === 'cloud') {
      setTtsTab('local');
      void saveSetting('voice.tts_engine', 'local', 'engine');
    }
  };

  const handleCloudPreview = async () => {
    if (!cloudVoice) {
      setPreviewError('Pick a Hume voice first.');
      return;
    }
    setPreviewError(null);
    setPreviewing(true);
    try {
      const blob = await api.fetchCloudVoicePreview({
        voice: cloudVoice,
        voiceProvider: cloudVoiceProvider,
        description: cloudDescription.trim() || undefined,
        speed: cloudSpeed,
      });
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

  const handleSwitchTtsTab = async (next: 'local' | 'cloud') => {
    if (next === ttsTab) return;
    if (next === 'cloud' && !humeKeySet) {
      // Don't persist cloud as the engine when there's no key yet.
      // Show the Cloud tab anyway so the user can enter a key.
      setTtsTab('cloud');
      return;
    }
    setTtsTab(next);
    await saveSetting('voice.tts_engine', next, 'engine');
  };

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const [
        presets, modelsRes, vSetting, sSetting, vadSetting, sttSetting,
        wakeEnabled, wakeP, sleepP, primaryName, bargeIn, sfx,
        ttsEngineSetting, cloudVoiceSetting, cloudVoiceProviderSetting,
        cloudDescriptionSetting, cloudSpeedSetting, humeStatus,
      ] = await Promise.all([
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
        api.getSetting('voice.tts_engine'),
        api.getSetting('voice.cloud_voice'),
        api.getSetting('voice.cloud_voice_provider'),
        api.getSetting('voice.cloud_voice_description'),
        api.getSetting('voice.cloud_speed'),
        api.getHumeStatus(),
      ]);
      if (!mounted) return;
      if (presets.ok) {
        setVoices(presets.data.voices);
        setDefaultVoice(presets.data.defaultVoice);
        if (!vSetting.ok || !vSetting.data.value) setVoice(presets.data.defaultVoice);
      }
      if (modelsRes.ok) {
        setModels(modelsRes.data);
        // Prefer the server-reported defaultSttModel ('moonshine-base'). Fall
        // back to defaultWhisper for older builds that don't expose the new
        // key, so this code keeps working against an in-place upgrade.
        if (!sttSetting.ok || !sttSetting.data.value) {
          const fallback = (modelsRes.data as { defaultSttModel?: string }).defaultSttModel
            ?? modelsRes.data.defaultWhisper;
          setSttModel(fallback);
        }
      }
      if (vSetting.ok && vSetting.data.value) setVoice(vSetting.data.value);
      if (sSetting.ok && sSetting.data.value) {
        const n = Number(sSetting.data.value);
        if (Number.isFinite(n)) setSpeed(n);
      }
      if (vadSetting.ok && vadSetting.data.value === 'quick') setVad('quick');
      if (vadSetting.ok && vadSetting.data.value === 'normal') setVad('normal');
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
      // Hume cloud TTS state
      if (humeStatus.ok) setHumeKeySet(humeStatus.data.keySet);
      if (ttsEngineSetting.ok && ttsEngineSetting.data.value === 'cloud' && humeStatus.ok && humeStatus.data.keySet) {
        setTtsTab('cloud');
      }
      if (cloudVoiceSetting.ok && cloudVoiceSetting.data.value) setCloudVoice(cloudVoiceSetting.data.value);
      if (cloudVoiceProviderSetting.ok && cloudVoiceProviderSetting.data.value === 'CUSTOM_VOICE') {
        setCloudVoiceProvider('CUSTOM_VOICE');
      }
      if (cloudDescriptionSetting.ok && cloudDescriptionSetting.data.value) {
        setCloudDescription(cloudDescriptionSetting.data.value);
      }
      if (cloudSpeedSetting.ok && cloudSpeedSetting.data.value) {
        const n = Number(cloudSpeedSetting.data.value);
        if (Number.isFinite(n) && n >= 0.5 && n <= 2) setCloudSpeed(n);
      }
      // Pull Hume voices if the key is set; non-blocking.
      if (humeStatus.ok && humeStatus.data.keySet) {
        void refreshHumeVoices();
      }
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

  const handleInstall = async (kind: 'whisper' | 'kokoro' | 'moonshine', id: string) => {
    setInstallError(null);
    setInstalling(`${kind}/${id}`);
    const res = await api.installVoiceModel(kind, id);
    if (!res.ok) setInstallError(res.error);
    await refreshModels();
    setInstalling(null);
  };

  const handleDelete = async (kind: 'whisper' | 'kokoro' | 'moonshine', id: string) => {
    if (!confirm(`Delete ${kind}/${id}? You can re-download it from this page.`)) return;
    const res = await api.deleteVoiceModel(kind, id);
    if (!res.ok) setInstallError(res.error);
    await refreshModels();
  };

  // Build a candidate voice id from a display name. Kokoro convention:
  // first char = language (a=US, b=GB), second char = gender (f/m), then
  // underscore + slug. Returns '' if name is empty.
  const buildVoiceId = (name: string, lang: 'en-us' | 'en-gb', gender: 'Male' | 'Female'): string => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
    if (!slug) return '';
    const langChar = lang === 'en-gb' ? 'b' : 'a';
    const genderChar = gender === 'Female' ? 'f' : 'm';
    return `${langChar}${genderChar}_${slug}`;
  };

  const handleImportVoice = async () => {
    if (!importFile) {
      setImportMsg({ kind: 'err', text: 'Pick a voicepack .bin first.' });
      return;
    }
    const name = importName.trim();
    if (!name) {
      setImportMsg({ kind: 'err', text: 'Display name is required.' });
      return;
    }
    const id = (importId.trim() || buildVoiceId(name, importLang, importGender)).toLowerCase();
    setImportBusy(true);
    setImportMsg(null);
    try {
      const res = await api.importCustomVoice({
        id,
        name,
        language: importLang,
        gender: importGender,
        file: importFile,
      });
      if (!res.ok) {
        setImportMsg({ kind: 'err', text: res.error });
        return;
      }
      setImportMsg({ kind: 'ok', text: `Imported ${res.data.name}. Try it with Preview.` });
      setImportFile(null);
      setImportName('');
      setImportId('');
      await refreshVoices();
      // Auto-select the new voice and save so the user can hit Preview straight away.
      setVoice(res.data.id);
      void saveSetting('voice.preferred_voice', res.data.id, 'voice');
    } catch (err) {
      setImportMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setImportBusy(false);
    }
  };

  const handleDeleteCustomVoice = async (id: string, name: string) => {
    if (!confirm(`Delete custom voice "${name}"? You'll need the original .bin file to re-import it.`)) return;
    const res = await api.deleteCustomVoice(id);
    if (!res.ok) {
      setImportMsg({ kind: 'err', text: res.error });
      return;
    }
    await refreshVoices();
    // If the user was using the deleted voice, fall back to the default.
    if (voice === id) {
      setVoice(defaultVoice);
      void saveSetting('voice.preferred_voice', defaultVoice, 'voice');
    }
    setImportMsg({ kind: 'ok', text: `Deleted ${name}.` });
  };

  if (loading) return <div className="loading-state">Loading voice settings...</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* TTS engine sub-tabs (Local Kokoro | Cloud Hume). The Cloud tab is
          selectable even without a key — picking it shows the key entry
          form. The engine setting (voice.tts_engine) only persists as
          'cloud' once a key is on file. */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-ui/55">Text-to-speech:</span>
        {(['local', 'cloud'] as const).map((opt) => (
          <button
            key={opt}
            onClick={() => void handleSwitchTtsTab(opt)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              ttsTab === opt ? 'glass-btn-primary' : 'glass-btn'
            }`}
          >
            {opt === 'local' ? 'Local (Kokoro)' : 'Cloud (Hume)'}
          </button>
        ))}
        {savedKey === 'engine' && <span className="text-xs text-cp-teal">Saved!</span>}
        {ttsTab === 'cloud' && !humeKeySet && (
          <span className="text-xs text-cp-amber">key required</span>
        )}
      </div>

      {/* Two-column grid for the short config cards. STT and TTS model cards
          stay full-width below because they hold per-model rows + progress bars. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {ttsTab === 'local' && (<>
      {/* Voice picker */}
      <div className="tile space-y-3">
        <h3 className="scard__title">Voice for {primaryAgentName}</h3>
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
                {v.name} · {v.gender === 'Female' ? 'F' : 'M'} · {v.language}{v.id === defaultVoice ? ' (default)' : ''}{v.custom ? ' · custom' : ''}
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

      {/* Custom voice imports — full-width inside the grid so the form has room
          to breathe. Visible even when no customs exist (the form is the main
          surface). */}
      <div className="tile space-y-3 md:col-span-2">
        <h3 className="scard__title">Custom voice imports</h3>
        <p className="text-xs text-ui/40">
          Import a Kokoro voicepack (a 522,240-byte <code className="px-1 rounded bg-ui/[0.06]">.bin</code> file
          produced by fine-tuning or shared from elsewhere). Imported voices show up in the picker
          above with a "custom" tag.
        </p>
        {voices.filter((v) => v.custom).length > 0 && (
          <div className="space-y-2 border-b border-ui/10 pb-3">
            {voices.filter((v) => v.custom).map((v) => (
              <div key={v.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1 text-ui">{v.name} <span className="text-ui/40">· {v.id}</span></span>
                <button
                  onClick={() => void handlePreview(v.id)}
                  disabled={previewing}
                  className="px-2 py-1 glass-btn text-xs rounded-lg disabled:opacity-50"
                >
                  Preview
                </button>
                <button
                  onClick={() => void handleDeleteCustomVoice(v.id, v.name)}
                  className="px-2 py-1 glass-btn-destructive text-xs rounded-lg"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
          <label className="flex flex-col gap-1 text-xs text-ui/60">
            <span>Display name</span>
            <input
              type="text"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              placeholder="My voice"
              className="glass-input"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ui/60">
            <span>Voice id <span className="text-ui/40">(optional — auto-derived from name)</span></span>
            <input
              type="text"
              value={importId}
              onChange={(e) => setImportId(e.target.value)}
              placeholder={importName ? buildVoiceId(importName, importLang, importGender) : 'am_myvoice'}
              className="glass-input"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ui/60">
            <span>Language</span>
            <select
              value={importLang}
              onChange={(e) => setImportLang(e.target.value as 'en-us' | 'en-gb')}
              className="glass-select"
            >
              <option value="en-us">English (US)</option>
              <option value="en-gb">English (UK)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ui/60">
            <span>Gender</span>
            <select
              value={importGender}
              onChange={(e) => setImportGender(e.target.value as 'Male' | 'Female')}
              className="glass-select"
            >
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </select>
          </label>
          <div className="md:col-span-2 flex flex-col gap-1 text-xs text-ui/60">
            <span>Voicepack file (.bin)</span>
            <div className="flex items-center gap-2">
              {/* Hide the native file input — the rest of the dashboard does
                  the same (Techniques.tsx, MigrationImport.tsx) and triggers
                  it via a styled button so themes stay consistent. */}
              <label className="px-3 py-2 glass-btn text-xs rounded-lg cursor-pointer">
                Choose file
                <input
                  type="file"
                  accept=".bin,application/octet-stream"
                  onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
              </label>
              <span className="text-xs text-ui/55 truncate">
                {importFile ? importFile.name : 'no file selected'}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={() => void handleImportVoice()}
            disabled={importBusy || !importFile || !importName.trim()}
            className="px-3 py-2 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
          >
            {importBusy ? 'Importing…' : 'Import voice'}
          </button>
          {importMsg && (
            <span className={`text-xs ${importMsg.kind === 'ok' ? 'text-cp-teal' : 'text-cp-coral'}`}>
              {importMsg.text}
            </span>
          )}
        </div>
      </div>

      {/* Playback speed */}
      <div className="tile space-y-3">
        <h3 className="scard__title">Playback speed</h3>
        <p className="text-xs text-ui/40">How fast {primaryAgentName}'s voice plays back. 1.0 is the natural Kokoro rate.</p>
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
      </>)}

      {ttsTab === 'cloud' && (<>
      {/* Hume API key */}
      <div className="tile space-y-3 md:col-span-2">
        <h3 className="scard__title">Hume API key</h3>
        <p className="text-xs text-ui/40">
          Cloud TTS uses Hume Octave. Grab a key from your Hume dashboard and paste it here.
          The key is stored on this machine only and is never sent to the browser after it's saved.
        </p>
        <p className="text-[11px] text-ui/40">
          <a
            href="https://platform.hume.ai/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cp-teal hover:text-cp-teal/80 underline"
          >
            Get a Hume API key ↗
          </a>{' '}
          · No account?{' '}
          <a
            href="https://platform.hume.ai/sign-up"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cp-teal hover:text-cp-teal/80 underline"
          >
            Sign up ↗
          </a>
        </p>
        {humeKeySet ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-cp-teal">Key set.</span>
            <button
              onClick={() => void handleClearHumeKey()}
              className="px-3 py-1.5 glass-btn-destructive text-xs rounded-lg"
            >
              Clear key
            </button>
            {humeKeyMsg && (
              <span className={`text-xs ${humeKeyMsg.kind === 'ok' ? 'text-cp-teal' : 'text-cp-coral'}`}>
                {humeKeyMsg.text}
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={humeKeyInput}
              onChange={(e) => setHumeKeyInput(e.target.value)}
              placeholder="Paste Hume API key"
              className="glass-input flex-1 font-mono text-sm"
            />
            <button
              onClick={() => void handleSetHumeKey()}
              disabled={humeKeyBusy || !humeKeyInput.trim()}
              className="px-3 py-2 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
            >
              {humeKeyBusy ? 'Validating…' : 'Save key'}
            </button>
            {humeKeyMsg && (
              <span className={`text-xs ${humeKeyMsg.kind === 'ok' ? 'text-cp-teal' : 'text-cp-coral'}`}>
                {humeKeyMsg.text}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Hume voice picker */}
      <div className="tile space-y-3 md:col-span-2">
        <h3 className="scard__title">Voice for {primaryAgentName}</h3>
        <p className="text-xs text-ui/40">
          Pulled live from Hume's Voice Library (HUME_AI provider) plus any custom voices saved
          to your account. The voice carries between turns within a session.
        </p>
        {!humeKeySet ? (
          <p className="text-xs text-ui/55">Set a Hume API key above to load the voice list.</p>
        ) : humeVoicesLoading ? (
          <p className="text-xs text-ui/55">Loading voices…</p>
        ) : humeVoicesError ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-cp-coral flex-1">{humeVoicesError}</span>
            <button
              onClick={() => void refreshHumeVoices()}
              className="px-2 py-1 glass-btn text-xs rounded-lg"
            >Retry</button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={cloudVoice}
              onChange={(e) => {
                const selected = humeVoices.find((v) => v.id === e.target.value);
                setCloudVoice(e.target.value);
                if (selected) {
                  setCloudVoiceProvider(selected.provider);
                  void saveSetting('voice.cloud_voice_provider', selected.provider, 'cloud_voice');
                }
                void saveSetting('voice.cloud_voice', e.target.value, 'cloud_voice');
              }}
              className="glass-select flex-1"
            >
              <option value="">— pick a voice —</option>
              {humeVoices.map((v) => (
                <option key={`${v.provider}:${v.id}`} value={v.id}>
                  {v.name} {v.provider === 'CUSTOM_VOICE' ? '· custom' : ''}
                </option>
              ))}
            </select>
            <button
              onClick={() => void handleCloudPreview()}
              disabled={previewing || !cloudVoice}
              className="px-3 py-2 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
            >
              {previewing ? 'Synthesizing…' : 'Preview'}
            </button>
            {savedKey === 'cloud_voice' && <span className="text-xs text-cp-teal">Saved!</span>}
          </div>
        )}
        {previewError && <p className="text-xs text-cp-coral">{previewError}</p>}
      </div>

      {/* Baseline delivery description */}
      <div className="tile space-y-3 md:col-span-2">
        <h3 className="scard__title">Baseline delivery</h3>
        <p className="text-xs text-ui/40">
          Standing "acting instructions" Hume applies to every turn unless the agent overrides
          with a <code className="px-1 rounded bg-ui/[0.06]">((deliver: ...))</code> cue at the
          start of a reply. Keep it short and general ("Speak warmly and conversationally").
          Leave blank to let Octave's automatic emotion read do all the work.
        </p>
        <textarea
          value={cloudDescription}
          onChange={(e) => setCloudDescription(e.target.value.slice(0, 500))}
          onBlur={() => void saveSetting('voice.cloud_voice_description', cloudDescription, 'cloud_desc')}
          placeholder="Speak warmly and conversationally."
          rows={2}
          className="glass-input w-full text-sm"
        />
        <div className="flex items-center justify-between text-xs text-ui/40">
          <span>{cloudDescription.length} / 500</span>
          {savedKey === 'cloud_desc' && <span className="text-cp-teal">Saved!</span>}
        </div>
      </div>

      {/* Cloud playback speed */}
      <div className="tile space-y-3">
        <h3 className="scard__title">Playback speed</h3>
        <p className="text-xs text-ui/40">Speed multiplier for cloud TTS. 1.0 is natural.</p>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0.8} max={1.4} step={0.05}
            value={cloudSpeed}
            onChange={(e) => setCloudSpeed(Number(e.target.value))}
            onMouseUp={() => void saveSetting('voice.cloud_speed', String(cloudSpeed), 'cloud_speed')}
            onTouchEnd={() => void saveSetting('voice.cloud_speed', String(cloudSpeed), 'cloud_speed')}
            className="flex-1 accent-cp-teal"
          />
          <span className="text-sm font-mono text-ui w-12 text-right">{cloudSpeed.toFixed(2)}x</span>
          {savedKey === 'cloud_speed' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
      </div>
      </>)}

      {/* VAD sensitivity */}
      <div className="tile space-y-3">
        <h3 className="scard__title">Voice activity sensitivity</h3>
        <p className="text-xs text-ui/40">
          How quickly {primaryAgentName} decides you've finished speaking after you pause.
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
      <div className="tile space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="scard__title">Voice interruption</h3>
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
      <div className="tile space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="scard__title">Sound effects</h3>
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
      <div className="tile space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="scard__title">Hands-free wake word</h3>
          {savedKey === 'wake' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
        <p className="text-xs text-ui/40">
          When enabled, voice mode stays in a passive listening state and only routes your speech
          to {primaryAgentName} after it hears the wake phrase. Say the sleep phrase to put it back to sleep.
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
      <div className="tile space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="scard__title">Speech-to-text model</h3>
          {models && (
            <span className="text-xs text-ui/40">
              {models.freeDiskMb >= 0 ? `${(models.freeDiskMb / 1024).toFixed(1)} GB free` : ''}
            </span>
          )}
        </div>
        <p className="text-xs text-ui/40">
          Transcribes your voice when voice mode is on. Moonshine is the small,
          fast default and runs anywhere with no native dependencies. Whisper is
          available as an alternative when the whisper.cpp binary is installed.
          The model marked Default is what the dojo uses right now.
        </p>

        {/* Moonshine row (no native deps, default). */}
        {models?.moonshine && (() => {
          const m = models.moonshine;
          const id = 'moonshine-base';
          const dl = downloads[`moonshine/${id}`];
          const pct = dl && dl.total > 0 ? Math.min(100, (dl.downloaded / dl.total) * 100) : 0;
          const isActive = id === sttModel;
          const setAsDefault = () => {
            setSttModel(id);
            void saveSetting('voice.stt_model', id, 'stt');
            if (!m.installed && !dl) {
              setDownloads((prev) => ({ ...prev, [`moonshine/${id}`]: { downloaded: 0, total: 0 } }));
              void handleInstall('moonshine', id);
            }
          };
          return (
            <div
              className={`glass-nested px-3 py-2.5 rounded-lg space-y-2 transition-colors ${
                isActive ? 'ring-1 ring-cp-teal/40' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-3">
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
                      <span className="truncate">{STT_LABELS[id]}</span>
                      {isActive && <span className="text-[10px] uppercase tracking-wide text-cp-teal shrink-0">Default</span>}
                    </div>
                    <div className="text-xs text-ui/40">
                      {m.installed ? `${formatBytes(m.bytes)} on disk` : '~65 MB to download'}
                    </div>
                  </div>
                </label>
                <div className="flex gap-2 shrink-0">
                  {!m.installed && !dl && (
                    <button
                      onClick={() => {
                        setDownloads((prev) => ({ ...prev, [`moonshine/${id}`]: { downloaded: 0, total: 0 } }));
                        void handleInstall('moonshine', id);
                      }}
                      disabled={installing === `moonshine/${id}`}
                      className="px-3 py-1.5 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
                    >
                      Download
                    </button>
                  )}
                  {m.installed && !isActive && (
                    <button
                      onClick={() => void handleDelete('moonshine', id)}
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
                  <div className="h-1 bg-ui/[0.06] rounded-full overflow-hidden">
                    <div className="h-full bg-cp-teal transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* Install hint when the Whisper binary isn't present on this OS. */}
        {models && models.whisperBinaryAvailable === false && (
          <div className="text-[11px] text-ui/40 px-3 py-2 rounded-lg bg-ui/[0.03] border border-ui/[0.06]">
            Whisper requires <code className="font-mono text-ui/55">whisper-cpp</code> via Homebrew
            (<code className="font-mono text-ui/55">brew install whisper-cpp</code>). The rows below
            stay greyed out until the binary is installed.
          </div>
        )}

        {models?.whisper.map((m) => {
          const dl = downloads[`whisper/${m.id}`];
          const pct = dl && dl.total > 0 ? Math.min(100, (dl.downloaded / dl.total) * 100) : 0;
          const isActive = m.id === sttModel;
          const whisperDisabled = models.whisperBinaryAvailable === false;
          const setAsDefault = () => {
            if (whisperDisabled) return;
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
              } ${whisperDisabled ? 'opacity-50 pointer-events-none' : ''}`}
            >
              <div className="flex items-center justify-between gap-3">
                {/* Default radio + label */}
                <label className="flex items-start gap-3 cursor-pointer flex-1 min-w-0">
                  <input
                    type="radio"
                    name="stt-model"
                    checked={isActive}
                    onChange={setAsDefault}
                    disabled={whisperDisabled}
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
                      disabled={whisperDisabled || installing === `whisper/${m.id}`}
                      className="px-3 py-1.5 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
                    >
                      Download
                    </button>
                  )}
                  {m.installed && !isActive && (
                    <button
                      onClick={() => void handleDelete('whisper', m.id)}
                      disabled={whisperDisabled}
                      className="px-3 py-1.5 text-xs text-cp-coral hover:bg-cp-coral/10 rounded-lg disabled:opacity-50"
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
        <div className="tile space-y-3">
          <div className="flex items-baseline justify-between">
            <h3 className="scard__title">Text-to-speech model</h3>
            {models.totalDiskBytes > 0 && (
              <span className="text-xs text-ui/40">All voice models: {formatBytes(models.totalDiskBytes)}</span>
            )}
          </div>
          <p className="text-xs text-ui/40">
            Kokoro generates {primaryAgentName}'s spoken replies. One model, ~330&nbsp;MB.
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
