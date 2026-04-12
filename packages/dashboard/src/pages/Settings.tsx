import { useState, useEffect, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Provider, Model } from '@dojo/shared';
import * as api from '../lib/api';
import { RouterConfig } from '../components/RouterConfig';
import { RouterTest } from '../components/RouterTest';
import { GoogleWorkspaceSettings } from '../components/GoogleWorkspaceSettings';
import { MicrosoftWorkspaceSettings } from '../components/MicrosoftWorkspaceSettings';
import { formatDate } from '../lib/dates';
import { MigrationExport } from '../components/MigrationExport';
import { MigrationImport } from '../components/MigrationImport';

type Tab = 'platform' | 'providers' | 'models' | 'profile' | 'security' | 'router' | 'sensei' | 'workspace' | 'microsoft' | 'update';

export const Settings = () => {
  const [searchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as Tab) || 'platform';
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'platform', label: 'Dojo' },
    { key: 'providers', label: 'Providers' },
    { key: 'models', label: 'Models' },
    { key: 'router', label: 'Router' },
    { key: 'profile', label: 'Profile' },
    { key: 'security', label: 'Security' },
    { key: 'sensei', label: 'Sensei' },
    { key: 'workspace', label: 'Google' },
    { key: 'microsoft', label: 'Microsoft' },
    { key: 'update', label: 'Update' },
  ];

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <h1 className="text-xl font-bold text-white mb-6">Settings</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-white/[0.04] rounded-lg p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              activeTab === tab.key
                ? 'bg-white/[0.05] text-white'
                : 'white/55 hover:white/90'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'platform' && <PlatformTab />}
      {activeTab === 'providers' && <ProvidersTab />}
      {activeTab === 'models' && <ModelsTab />}
      {activeTab === 'router' && <RouterTab />}
      {activeTab === 'profile' && <ProfileTab />}
      {activeTab === 'security' && <SecurityTab />}
      {activeTab === 'sensei' && <DreamingTab />}
      {activeTab === 'workspace' && <GoogleWorkspaceSettings />}
      {activeTab === 'microsoft' && <MicrosoftWorkspaceSettings />}
      {activeTab === 'update' && <UpdateTab />}
    </div>
  );
};

// ── iMessage Bridge Settings ──

const IMBridgeSettings = () => {
  const [enabled, setEnabled] = useState(false);
  const [senders, setSenders] = useState<string[]>([]);
  const [defaultSender, setDefaultSender] = useState<string | null>(null);
  const [newSender, setNewSender] = useState('');
  const [showAddInput, setShowAddInput] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const [enabledResult, sendersResult, legacyResult, defaultResult] = await Promise.all([
        api.getSetting('imessage_enabled'),
        api.getSetting('imessage_approved_senders'),
        api.getSetting('imessage_recipient'), // legacy single recipient
        api.getSetting('imessage_default_sender'),
      ]);

      if (enabledResult.ok && enabledResult.data.value) {
        setEnabled(enabledResult.data.value === 'true');
      }

      let loadedSenders: string[] = [];
      if (sendersResult.ok && sendersResult.data.value) {
        try {
          const parsed = JSON.parse(sendersResult.data.value);
          if (Array.isArray(parsed)) loadedSenders = parsed;
        } catch {}
      } else if (legacyResult.ok && legacyResult.data.value) {
        // Migrate legacy single recipient to array
        loadedSenders = [legacyResult.data.value];
      }
      setSenders(loadedSenders);

      // Load default sender; fall back to first sender
      if (defaultResult.ok && defaultResult.data.value && loadedSenders.includes(defaultResult.data.value)) {
        setDefaultSender(defaultResult.data.value);
      } else if (loadedSenders.length > 0) {
        setDefaultSender(loadedSenders[0]);
      }

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

    const effectiveDefault = defaultSender && senders.includes(defaultSender) ? defaultSender : senders[0] ?? '';
    const results = await Promise.all([
      api.setSetting('imessage_enabled', enabled ? 'true' : 'false'),
      api.setSetting('imessage_approved_senders', JSON.stringify(senders)),
      // Keep legacy field in sync for bridge compatibility
      api.setSetting('imessage_recipient', senders[0] ?? ''),
      api.setSetting('imessage_default_sender', effectiveDefault),
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
    const s = newSender.trim();
    if (!s || senders.includes(s)) return;
    const updated = [...senders, s];
    setSenders(updated);
    // Auto-set as default if it's the first sender
    if (updated.length === 1) {
      setDefaultSender(s);
    }
    setNewSender('');
    setShowAddInput(false);
  };

  const removeSender = (index: number) => {
    const removed = senders[index];
    const updated = senders.filter((_, i) => i !== index);
    setSenders(updated);
    // If removing the default sender, auto-promote the next one
    if (removed === defaultSender) {
      setDefaultSender(updated.length > 0 ? updated[0] : null);
    }
  };

  if (loading) return null;

  return (
    <div className="glass-card p-4 space-y-4">
      <h3 className="text-sm font-medium white/70">iMessage Bridge</h3>
      <p className="text-xs white/40">
        Enable to send and receive messages with your agent via iMessage. Requires Full Disk Access for Terminal in System Settings &gt; Privacy &amp; Security &gt; Full Disk Access.
      </p>

      {/* Toggle */}
      <div className="flex items-center justify-between">
        <label className="text-sm white/70">Enable iMessage Bridge</label>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            enabled ? 'bg-blue-600' : 'bg-white/[0.12]'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Approved Senders */}
      {enabled && (
        <div>
          <label className="block text-xs font-medium white/55 mb-2">
            Approved Senders
          </label>
          <p className="text-xs white/30 mb-2">
            Phone numbers or Apple IDs that your agent will accept iMessages from and reply to.
          </p>

          {/* Sender list */}
          {senders.length > 0 && (
            <div className="space-y-1 mb-2">
              {senders.map((sender, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between glass-nested rounded-xl px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setDefaultSender(sender)}
                      title={sender === defaultSender ? 'Default sender' : 'Set as default sender'}
                      className={`text-lg leading-none transition-colors ${
                        sender === defaultSender
                          ? 'text-yellow-400'
                          : 'white/30 hover:text-yellow-400'
                      }`}
                    >
                      {sender === defaultSender ? '\u2605' : '\u2606'}
                    </button>
                    <span className="text-sm white/90 font-mono">{sender}</span>
                  </div>
                  <button
                    onClick={() => removeSender(i)}
                    className="white/40 hover:text-red-400 transition-colors ml-2"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          {senders.length === 0 && !showAddInput && (
            <p className="text-xs white/30 italic mb-2">No approved senders configured.</p>
          )}

          {/* Add sender input */}
          {showAddInput ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={newSender}
                onChange={(e) => setNewSender(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addSender()}
                placeholder="+15551234567 or user@icloud.com"
                autoFocus
                className="flex-1 px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
              />
              <button
                onClick={addSender}
                disabled={!newSender.trim()}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-sm rounded-lg transition-colors"
              >
                Add
              </button>
              <button
                onClick={() => { setShowAddInput(false); setNewSender(''); }}
                className="px-3 py-2 text-sm white/55 hover:white/90 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowAddInput(true)}
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              <span className="text-lg leading-none">+</span> Add sender
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="text-xs text-green-400">Saved! Restart server to apply.</span>}
      </div>

      {enabled && (
        <div className="px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs">
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
    <div className="space-y-6 max-w-lg">
      {/* Agent Limits */}
      <AgentLimitsSettings />

      {/* Ollama Settings */}
      <OllamaSettings />

      {/* Remote Access */}
      <RemoteAccessSettings />

      {/* iMessage Bridge */}
      <IMBridgeSettings />

      {/* Web Search */}
      <SearchSettings />

      {/* Migration */}
      <MigrationSettings />
    </div>
  );
};

// ── Migration (Export/Import) ──

const MigrationSettings = () => {
  const [showImport, setShowImport] = useState(false);

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl p-5 space-y-4">
      <h3 className="text-sm font-bold text-white/90">Migration</h3>
      <p className="text-xs text-white/40">
        Export your entire dojo to move it to another machine, or import from a previous export.
      </p>

      <div className="flex gap-3">
        <MigrationExport />
        <button
          onClick={() => setShowImport(!showImport)}
          className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white/70 text-sm font-medium rounded-lg transition-colors"
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

  const handleEnable = async () => {
    setActing(true);
    if (mode === 'named' && token.trim()) {
      await fetch('/api/system/tunnel/token', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ token: token.trim() }),
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

  if (loading) return <div className="glass-card p-4"><p className="white/40 text-sm">Loading...</p></div>;

  const isActive = status?.status === 'active';
  const isStarting = status?.status === 'starting';

  return (
    <div className="glass-card p-4 space-y-4">
      <h3 className="text-sm font-medium white/70">Remote Access</h3>
      <p className="text-xs white/40">
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
          <p className="text-xs white/50">cloudflared is not installed.</p>
          <button
            onClick={handleInstall}
            disabled={installing}
            className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white rounded-lg transition-colors"
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
                {status.mode === 'quick' && <span className="text-[10px] white/30">Quick Tunnel</span>}
                {status.mode === 'named' && <span className="text-[10px] white/30">Named Tunnel</span>}
              </div>
              {status.url && (
                <div className="flex items-center gap-2">
                  <code className="text-xs text-cp-teal font-mono flex-1 truncate">{status.url}</code>
                  <button onClick={copyUrl} className="text-[10px] text-white/40 hover:text-white/70 shrink-0">Copy</button>
                </div>
              )}
              {status.mode === 'named' && !status.url && (
                <p className="text-[10px] white/30">URL configured in your Cloudflare dashboard</p>
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
                    <span className="text-xs white/80 font-medium">Quick Tunnel</span>
                    <span className="text-[10px] white/30 ml-1">(no account needed)</span>
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
                    <span className="text-xs white/80 font-medium">Named Tunnel</span>
                    <span className="text-[10px] white/30 ml-1">(persistent URL)</span>
                  </div>
                </label>
              </div>

              {mode === 'quick' && (
                <p className="text-[10px] white/30">
                  Generates a random trycloudflare.com URL. No account needed. URL changes on restart.
                </p>
              )}

              {mode === 'named' && (
                <div className="space-y-2">
                  <p className="text-[10px] white/40">
                    Requires a free Cloudflare account.{' '}
                    <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/" target="_blank" rel="noopener noreferrer" className="text-cp-blue hover:underline">
                      Set up a Cloudflare Tunnel &rarr;
                    </a>
                  </p>
                  <div className="text-[10px] white/30 space-y-0.5">
                    <p>1. Create a free account at dash.cloudflare.com</p>
                    <p>2. Go to Networks &gt; Tunnels &gt; Create Tunnel</p>
                    <p>3. Name your tunnel and copy the token</p>
                    <p>4. Paste the token below</p>
                  </div>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Cloudflare tunnel token..."
                    className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-xs white/90 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}

              <button
                onClick={handleEnable}
                disabled={acting || (mode === 'named' && !token.trim())}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-sm font-medium rounded-lg transition-colors"
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

  if (loading) return <div className="glass-card p-4"><p className="white/40 text-sm">Loading...</p></div>;

  return (
    <div className="glass-card p-4 space-y-4">
      <h3 className="text-sm font-medium white/70">Ollama (Local Models)</h3>
      <p className="text-xs white/40">
        Controls how many different Ollama models can be loaded in RAM simultaneously.
        Set to 1 for 16GB machines, 2+ if you have more RAM.
      </p>
      <div>
        <label className="block text-xs font-medium white/55 mb-1">Max Concurrent Models</label>
        <input
          type="number"
          min={1}
          max={8}
          value={maxConcurrent}
          onChange={(e) => setMaxConcurrent(e.target.value)}
          className="w-24 px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-[10px] white/30 mt-0.5">
          When agents use more local models than this limit, requests queue until the current model finishes.
          A 7B model uses ~4GB RAM, a 30B model uses ~16GB.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="text-xs text-green-400">Saved!</span>}
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

  if (loading) return <div className="glass-card p-4"><p className="white/40 text-sm">Loading...</p></div>;

  return (
    <div className="glass-card p-4 space-y-4">
      <h3 className="text-sm font-medium white/70">Dojo Capacity</h3>
      <p className="text-xs white/40">
        Controls how many agents can run and how they are spawned. Changes take effect immediately.
      </p>
      <div className="grid grid-cols-2 gap-4">
        {AGENT_LIMIT_KEYS.map((item) => (
          <div key={item.key}>
            <label className="block text-xs font-medium white/55 mb-1">{item.label}</label>
            <input
              type="number"
              min={item.min}
              max={item.max}
              value={values[item.key] ?? item.default}
              onChange={(e) => setValues(prev => ({ ...prev, [item.key]: e.target.value }))}
              className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-[10px] white/30 mt-0.5">{item.description}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save Limits'}
        </button>
        {saved && <span className="text-xs text-green-400">Saved!</span>}
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
      <h3 className="text-sm font-medium white/70">Web Search Provider</h3>
      <p className="text-xs white/40">
        Configure web search for the web_search tool.
      </p>

      <div>
        <label className="block text-xs font-medium white/55 mb-1">Provider</label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="brave">Brave Search</option>
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium white/55 mb-1">
          Brave Search API Key
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? '••••••••••••••••' : 'Enter Brave Search API key'}
          className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          {error}
        </div>
      )}

      {validationResult === 'valid' && (
        <div className="px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs">
          API key is valid
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleValidate}
          disabled={validating || (!apiKey.trim() && !hasKey)}
          className="px-4 py-2 bg-white/[0.08] hover:bg-white/[0.12] disabled:bg-white/[0.05] disabled:white/30 white/90 text-sm font-medium rounded-lg transition-colors"
        >
          {validating ? 'Validating...' : 'Validate'}
        </button>
        {saved && <span className="text-xs text-green-400">Saved!</span>}
      </div>

      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          hasKey
            ? 'bg-green-500/10 text-green-400 border border-green-500/20'
            : 'bg-white/[0.08] white/55 border white/[0.10]'
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
      <p className="text-xs text-white/40">
        Use your Claude Pro or Max subscription through the Agent SDK. Requires two things: the Claude Code CLI installed, and a signed-in Claude account.
      </p>

      <div className="space-y-2 text-xs">
        {/* Step 1: CLI installed */}
        <div className="flex items-center gap-2">
          <span className={status?.cliInstalled ? 'text-green-400' : 'text-amber-400'}>
            {status?.cliInstalled ? '\u2713' : '1.'}
          </span>
          <span className="text-white/60">
            {status?.cliInstalled
              ? `Claude Code CLI installed (${status.version})`
              : 'Install Claude Code CLI'}
          </span>
        </div>
        {!status?.cliInstalled && (
          <div className="text-white/30 ml-5 space-y-1">
            <p>Run this in your terminal:</p>
            <code className="block bg-white/5 px-2 py-1 rounded text-[11px]">curl -fsSL https://claude.ai/install.sh | bash</code>
          </div>
        )}

        {/* Step 2: Signed in */}
        <div className="flex items-center gap-2">
          <span className={authResult?.authenticated ? 'text-green-400' : status?.cliInstalled ? 'text-amber-400' : 'text-white/20'}>
            {authResult?.authenticated ? '\u2713' : '2.'}
          </span>
          <span className={status?.cliInstalled ? 'text-white/60' : 'text-white/20'}>
            {authResult?.authenticated ? 'Signed in to Claude' : 'Sign in to your Claude account'}
          </span>
        </div>
        {status?.cliInstalled && !authResult?.authenticated && (
          <div className="text-white/30 ml-5 space-y-1">
            <p>Run this in your terminal and sign in with your Claude Pro/Max account:</p>
            <code className="block bg-white/5 px-2 py-1 rounded text-[11px]">claude</code>
            <p>Then click Verify below.</p>
          </div>
        )}
      </div>

      {status?.cliInstalled && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleVerify}
            disabled={verifying}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {verifying ? 'Verifying...' : 'Verify Connection'}
          </button>
          {authResult && !authResult.authenticated && (
            <span className="text-xs text-red-400">
              {authResult.error ?? 'Not authenticated. Run `claude` in your terminal and sign in.'}
            </span>
          )}
        </div>
      )}

      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2">
        <p className="text-[10px] text-amber-400/70">
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

  if (loading) return <p className="white/40">Loading providers...</p>;

  return (
    <div className="space-y-4">
      {/* Existing providers */}
      {providers.length === 0 ? (
        <p className="white/40 text-sm">No providers configured.</p>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="glass-card p-4 flex items-center justify-between"
            >
              <div>
                <h3 className="text-sm font-medium text-white">{provider.name}</h3>
                <p className="text-xs white/40 mt-0.5">
                  {provider.type} &middot; {provider.authType === 'agent-sdk' ? 'Agent SDK' : provider.authType === 'oauth' ? 'OAuth' : 'API Key'} {provider.isValidated ? '(validated)' : '(not validated)'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleSyncModels(provider.id)}
                  disabled={syncing === provider.id}
                  className="text-xs text-cp-teal hover:text-cp-teal/80 disabled:white/30 transition-colors"
                >
                  {syncing === provider.id ? 'Syncing...' : 'Sync Models'}
                </button>
                <button
                  onClick={() => handleDelete(provider.id)}
                  className="text-sm text-red-400 hover:text-red-300 transition-colors"
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
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Add Provider
        </button>
      )}
    </div>
  );
};

const AddProviderForm = ({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) => {
  const [name, setName] = useState('');
  const [type, setType] = useState('anthropic');
  const [authType, setAuthType] = useState<'api_key' | 'oauth' | 'agent-sdk'>('api_key');
  const [credential, setCredential] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'validating' | 'valid' | 'invalid'>('idle');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || (type !== 'ollama' && authType !== 'agent-sdk' && !credential.trim())) return;
    setStatus('saving');
    setError(null);

    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const result = await api.createProvider({
      id,
      name,
      type,
      baseUrl: type === 'ollama' ? (baseUrl || 'http://localhost:11434')
        : type === 'openai-compatible' ? (baseUrl || 'https://openrouter.ai/api')
        : type === 'openai' ? (baseUrl || 'https://api.openai.com')
        : undefined,
      authType: type === 'ollama' ? 'none' : authType,
      credential: type === 'ollama' || authType === 'agent-sdk' ? undefined : credential,
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
          <label className="block text-xs font-medium white/55 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium white/55 mb-1">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="openai-compatible">OpenRouter</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>
      </div>

      {type === 'ollama' && (
        <div>
          <label className="block text-xs font-medium white/55 mb-1">Base URL</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434"
            className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      {type !== 'ollama' && (
        <>
          {type === 'anthropic' && (
            <div>
              <label className="block text-xs font-medium white/55 mb-1">Auth Type</label>
              <select
                value={authType}
                onChange={(e) => setAuthType(e.target.value as 'api_key' | 'oauth' | 'agent-sdk')}
                className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="api_key">API Key</option>
                <option value="oauth">OAuth Token</option>
                <option value="agent-sdk">Agent SDK (Subscription)</option>
              </select>
            </div>
          )}

          {authType === 'agent-sdk' && type === 'anthropic' ? (
            <AgentSdkSetup />
          ) : (
            <div>
              <label className="block text-xs font-medium white/55 mb-1">
                {authType === 'oauth' && type === 'anthropic' ? 'OAuth Token' : 'API Key'}
              </label>
              <input
                type="password"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder={type === 'openai' ? 'sk-...' : authType === 'oauth' ? 'Bearer token...' : 'sk-...'}
                className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}
        </>
      )}

      {error && (
        <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          {error}
        </div>
      )}

      {status === 'valid' && (
        <div className="px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs">
          Validated
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={status === 'saving' || status === 'validating' || status === 'valid' || !name.trim() || (type !== 'ollama' && authType !== 'agent-sdk' && !credential.trim())}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {status === 'saving' ? 'Adding...' : status === 'validating' ? 'Validating...' : 'Add & Validate'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={status === 'saving' || status === 'validating'}
          className="px-4 py-2 text-sm white/55 hover:white/90 disabled:text-gray-700 transition-colors"
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
        className="w-full px-4 py-3 flex items-center justify-between text-sm font-medium white/70 hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span>{provider.name}</span>
          <span className="text-xs white/30">{enabledCount}/{models.length} enabled</span>
        </div>
        <span className="white/40">{open ? '[-]' : '[+]'}</span>
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
        <span className="white/40 w-20">Host RAM</span>
        <span className="white/70 font-mono">auto-detected (this machine)</span>
        <span className="text-[10px] text-white/25 italic">
          num_ctx recommendations use os.totalmem()
        </span>
      </div>
    );
  }

  return (
    <div className="glass-card p-3 flex items-center gap-3 text-xs">
      <label className="white/40 w-20" title="Total RAM of the remote Ollama host in GB. The dojo uses this value to auto-size num_ctx recommendations for every model on this provider.">
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
        className="w-20 px-2 py-1 bg-white/[0.05] border white/[0.08] rounded text-xs white/90 font-mono text-right focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60"
      />
      <span className="text-[10px] text-white/30">GB</span>
      {saved && <span className="text-xs text-green-400">Saved — recomputing…</span>}
      {error && <span className="text-xs text-red-400">{error}</span>}
      {!saved && !error && (
        <span className="text-[10px] text-white/25 italic">
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
    className: 'bg-blue-500/15 text-blue-300 border-blue-400/30',
    title: 'Supports function/tool calling',
  },
  vision: {
    label: 'Vision',
    className: 'bg-purple-500/15 text-purple-300 border-purple-400/30',
    title: 'Can accept image inputs',
  },
  thinking: {
    label: 'Thinking',
    className: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
    title: 'Supports extended reasoning / thinking',
  },
  embedding: {
    label: 'Embedding',
    className: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
    title: 'Embedding model (not for chat)',
  },
  image_generation: {
    label: 'Image Gen',
    className: 'bg-pink-500/15 text-pink-300 border-pink-400/30',
    title: 'Can generate images — available to Imaginer for image_create requests',
  },
};

const CapabilityBadges = ({ capabilities }: { capabilities: string[] }) => {
  const known = capabilities.filter(c => CAPABILITY_LABELS[c]);
  if (known.length === 0) {
    return (
      <div className="mt-1.5 flex items-center gap-1">
        <span className="text-[10px] text-white/25 italic">capabilities unknown</span>
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
          <h3 className="text-sm font-medium text-white">
            {model.name}
            {isPrimaryModel && (
              <span className="ml-2 text-xs text-blue-400 font-normal">(primary agent model)</span>
            )}
          </h3>
          <p className="text-xs white/40 mt-0.5">
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
                className="h-3.5 w-3.5 rounded border-white/20 bg-white/[0.05] accent-amber-500 cursor-pointer"
              />
              <span className="text-[11px] text-white/60">
                Enable thinking
              </span>
            </label>
          )}
        </div>
        <button
          onClick={onToggle}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            model.isEnabled ? 'bg-blue-600' : 'bg-white/[0.12]'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
              model.isEnabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Pricing fields */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-xs white/40 w-20">Input $/M</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={inputCost}
            onChange={(e) => setInputCost(e.target.value)}
            onBlur={() => hasChanges && handleSave()}
            className="w-24 px-2 py-1 bg-white/[0.05] border white/[0.08] rounded text-xs white/90 font-mono text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs white/40 w-20">Output $/M</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={outputCost}
            onChange={(e) => setOutputCost(e.target.value)}
            onBlur={() => hasChanges && handleSave()}
            className="w-24 px-2 py-1 bg-white/[0.05] border white/[0.08] rounded text-xs white/90 font-mono text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        {hasChanges && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] text-white rounded transition-colors"
          >
            {saving ? '...' : 'Save'}
          </button>
        )}
        {saved && <span className="text-xs text-green-400">Saved</span>}
      </div>

      {isOllama && (
        <div className="mt-3 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label
              className="text-xs white/40 w-20"
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
              className="w-28 px-2 py-1 bg-white/[0.05] border white/[0.08] rounded text-xs white/90 font-mono text-right focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60"
            />
            <span className="text-[10px] text-white/30">tokens</span>
            {model.numCtxRecommended !== null && (
              <button
                onClick={handleNumCtxReset}
                disabled={ctxSaving || (model.numCtxOverride === null && numCtxInput === String(model.numCtxRecommended))}
                className="text-[10px] text-white/40 hover:text-white/80 underline disabled:text-white/20 disabled:no-underline disabled:cursor-default"
                title={`Reset to auto-sized recommendation (${model.numCtxRecommended.toLocaleString()} tokens)`}
              >
                reset
              </button>
            )}
          </div>
          {ctxSaved && <span className="text-xs text-green-400">Saved</span>}
          {ctxError && <span className="text-xs text-red-400">{ctxError}</span>}
          <span className="text-[10px] text-white/25 italic">
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
      <h3 className="text-sm font-medium white/70">Browse {providerName} Models</h3>
      <p className="text-xs white/40">Search the model catalog and add models you want to use.</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search models... (e.g., claude, llama, gpt)"
          className="flex-1 px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          {searching ? 'Searching...' : 'Search'}
        </button>
      </div>

      {results.length > 0 && (
        <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
          {results.map((model) => (
            <div key={model.apiModelId} className="flex items-center justify-between glass-nested p-2.5 rounded-lg">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white/90 truncate">{model.name}</div>
                <div className="text-[10px] white/40 flex items-center gap-2 mt-0.5">
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
                className="ml-2 px-3 py-1 text-xs bg-cp-teal/20 text-cp-teal hover:bg-cp-teal/30 disabled:bg-white/[0.05] disabled:white/30 rounded-lg transition-colors shrink-0"
              >
                {adding === model.apiModelId ? 'Adding...' : 'Add'}
              </button>
            </div>
          ))}
        </div>
      )}

      {searched && results.length === 0 && !searching && (
        <p className="text-xs white/30 text-center py-2">No models found matching "{query}"</p>
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

  if (loading) return <p className="white/40">Loading models...</p>;

  const enabledModels = models.filter((m) => m.isEnabled);
  const showWarning = !primaryModelId && enabledModels.length > 0;

  return (
    <div className="space-y-3">
      {/* Warning banner: primary agent has no model */}
      {showWarning && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-yellow-400">Primary agent has no model assigned</h3>
            <p className="text-xs text-yellow-400/70 mt-0.5">
              Your primary agent can't respond to messages without a model. Pick one below.
            </p>
          </div>
          <select
            onChange={(e) => handleSetPrimaryModel(e.target.value)}
            disabled={settingModel}
            defaultValue=""
            className="px-3 py-2 bg-white/[0.05] border border-yellow-500/40 rounded-lg text-sm white/90 focus:outline-none focus:ring-2 focus:ring-yellow-500 min-w-[180px]"
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
        <p className="white/40 text-sm">No providers configured. Add one in the Providers tab first.</p>
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
    <div className="space-y-6 max-w-2xl">
      {/* Your Name */}
      <div className="glass-card p-4 space-y-3">
        <h3 className="text-sm font-medium white/70">Your Name</h3>
        <p className="text-xs white/40">Used in memory summaries and agent conversations to identify you.</p>
        {loadingName ? (
          <div className="h-10 glass-nested rounded-xl animate-pulse" />
        ) : (
          <>
            <input
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="e.g., David"
              className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex items-center gap-2">
              <button onClick={handleSaveName} disabled={savingName || !userName.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-sm font-medium rounded-lg transition-colors">
                {savingName ? 'Saving...' : 'Save'}
              </button>
              {savedName && <span className="text-xs text-green-400">Saved!</span>}
            </div>
          </>
        )}
      </div>

      {/* About You (USER.md) */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium white/70">About You</h3>
            <p className="text-xs white/40 mt-0.5">
              Information about you that agents will know when "Share User Profile" is enabled.
              Your preferences, businesses, projects, communication style, etc.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {savedProfile && <span className="text-xs text-green-400">Saved!</span>}
            <button onClick={handleSaveProfile} disabled={savingProfile || loadingProfile}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-xs font-medium rounded-lg transition-colors">
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
            className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
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

  if (loading) return <p className="white/40">Loading router config...</p>;
  if (!config) return <p className="white/40">Unable to load router config.</p>;

  return (
    <div className="space-y-6">
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
    <form onSubmit={handleSubmit} className="glass-card p-4 space-y-4 max-w-md">
      <h3 className="text-sm font-medium white/70">Change Password</h3>

      <div>
        <label className="block text-xs font-medium white/55 mb-1">Current Password</label>
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs font-medium white/55 mb-1">New Password</label>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="At least 8 characters"
          className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs font-medium white/55 mb-1">Confirm New Password</label>
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full px-3 py-2 bg-white/[0.05] border white/[0.08] rounded-lg text-sm white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          {error}
        </div>
      )}

      {success && (
        <div className="px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs">
          Password changed successfully!
        </div>
      )}

      <button
        type="submit"
        disabled={saving || !currentPassword || !newPassword || !confirmPassword}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:white/40 text-white text-sm font-medium rounded-lg transition-colors"
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

  if (loading) return <div className="text-white/40 text-sm">Loading...</div>;

  return (
    <div className="space-y-6 max-w-lg">
      <div className="glass-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-white/70">Dreaming</h3>
          <p className="text-xs text-white/40 mt-1">
            Configure how the dojo processes its daily conversations into long-term memories overnight. A temporary "Dreamer" agent is spawned to do the work -- it uses the tracker, extracts knowledge, and dismisses itself when done.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-white/55 mb-1">Dreamer Model</label>
          <select
            value={dreamModelId}
            onChange={(e) => setDreamModelId(e.target.value)}
            className="w-full px-3 py-2 bg-white/[0.05] border border-white/[0.08] rounded-lg text-sm text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Auto (first available Standard tier model)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.apiModelId})
              </option>
            ))}
          </select>
          <p className="text-[10px] text-white/30 mt-1">
            The model the Dreamer agent uses. Standard tier recommended for good extraction quality at reasonable cost.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-white/55 mb-1">Dream Time</label>
          <input
            type="time"
            value={dreamTime}
            onChange={(e) => setDreamTime(e.target.value)}
            className="w-full px-3 py-2 bg-white/[0.05] border border-white/[0.08] rounded-lg text-sm text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-[10px] text-white/30 mt-1">
            When the Dreamer agent wakes up to process the day's conversations. Default: 3:00 AM.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-white/55 mb-2">Dream Mode</label>
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
                  className="mt-1 accent-blue-500"
                />
                <div>
                  <span className="text-sm text-white/80">{option.label}</span>
                  <p className="text-[10px] text-white/30">{option.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:text-white/40 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {saved && <span className="text-xs text-green-400">Saved!</span>}
        </div>
      </div>

      {/* Last Dream Report */}
      {lastDream && (
        <div className="glass-card p-4 space-y-2">
          <h3 className="text-sm font-medium text-white/70">Last Dream</h3>
          <p className="text-[10px] text-white/30">
            {formatDate(lastDream.createdAt)}
            {lastDream.durationMs && ` (${(lastDream.durationMs / 1000).toFixed(1)}s)`}
          </p>
          <pre className="text-xs text-white/60 whitespace-pre-wrap font-mono bg-white/[0.03] rounded p-2">
            {lastDream.reportText ?? 'No report text available'}
          </pre>
        </div>
      )}

      {/* Imaginer card — image generation sensei */}
      <ImaginerCard models={models} />
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
        <h3 className="text-sm font-medium text-white/70">Imaginer (Image Generation Sensei)</h3>
        <p className="text-xs text-white/40 mt-1">
          Imaginer is a system agent that turns text descriptions into images when any agent calls the{' '}
          <code className="text-pink-300">image_create</code> tool. Kevin and sub-agents never need to switch models
          to generate images — they describe what they want and Imaginer handles the rest.
        </p>
      </div>

      {/* Enabled toggle */}
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-white/20 bg-white/[0.05] accent-pink-500 cursor-pointer"
        />
        <span className="text-sm text-white/80">Enable Imaginer</span>
      </label>

      {/* Model dropdown */}
      <div>
        <label className="block text-xs font-medium text-white/55 mb-1">Image Generation Model</label>
        {imageCapableModels.length === 0 ? (
          <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
            No image-capable models configured. Add an image-generating model (e.g. Google Gemini 2.5 Flash Image or
            OpenAI GPT-5 Image via OpenRouter) in Settings → Models. Already added but not showing up? Click{' '}
            <em>Refresh capabilities</em> on that model's card — older rows may need a fresh probe to pick up the new
            <code className="mx-1 text-pink-300">image_generation</code>capability.
          </div>
        ) : (
          <>
            <select
              value={imageModelId}
              onChange={(e) => setImageModelId(e.target.value)}
              className="w-full px-3 py-2 bg-white/[0.05] border border-white/[0.08] rounded-lg text-sm text-white/90 focus:outline-none focus:ring-2 focus:ring-pink-500"
            >
              <option value="">(select an image model)</option>
              {imageCapableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.apiModelId})
                </option>
              ))}
            </select>
            <p className="text-[10px] text-white/30 mt-1">
              Only models with the <code className="text-pink-300">Image Gen</code> capability are shown. Imaginer
              calls this model whenever it needs to actually produce an image — its orchestration/chat brain uses a
              separate text model (Kevin's default by default).
            </p>
          </>
        )}
      </div>

      {/* Default aspect ratio */}
      <div>
        <label className="block text-xs font-medium text-white/55 mb-1">Default Aspect Ratio</label>
        <select
          value={defaultAspect}
          onChange={(e) => setDefaultAspect(e.target.value)}
          className="w-full px-3 py-2 bg-white/[0.05] border border-white/[0.08] rounded-lg text-sm text-white/90 focus:outline-none focus:ring-2 focus:ring-pink-500"
        >
          {ASPECT_RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <p className="text-[10px] text-white/30 mt-1">Used when requesting agents don't specify one.</p>
      </div>

      {/* Default style */}
      <div>
        <label className="block text-xs font-medium text-white/55 mb-1">Default Style (optional)</label>
        <input
          type="text"
          value={defaultStyle}
          onChange={(e) => setDefaultStyle(e.target.value)}
          placeholder="e.g. photorealistic, cinematic lighting"
          className="w-full px-3 py-2 bg-white/[0.05] border border-white/[0.08] rounded-lg text-sm text-white/90 placeholder-white/25 focus:outline-none focus:ring-2 focus:ring-pink-500"
        />
        <p className="text-[10px] text-white/30 mt-1">Fallback style hint when requesting agents don't specify one.</p>
      </div>

      {/* Output dir (read-only info) */}
      <div>
        <label className="block text-xs font-medium text-white/55 mb-1">Output Directory</label>
        <code className="block text-[11px] text-white/50 px-3 py-2 bg-white/[0.03] rounded font-mono">
          ~/.dojo/uploads/generated/
        </code>
      </div>

      {/* Save + Test buttons */}
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={saving || !imageModelId || imageCapableModels.length === 0}
          className="px-4 py-2 bg-pink-600 hover:bg-pink-700 disabled:bg-white/[0.08] disabled:text-white/40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing || !imageModelId || imageCapableModels.length === 0}
          className="px-4 py-2 bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] disabled:bg-white/[0.02] disabled:text-white/30 text-white/80 text-sm font-medium rounded-lg transition-colors"
        >
          {testing ? 'Testing...' : 'Generate test image'}
        </button>
        {saved && <span className="text-xs text-green-400">Saved!</span>}
        {testResult && <span className="text-xs text-white/60">{testResult}</span>}
      </div>
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
    <div className="space-y-6 max-w-lg">
      <div className="glass-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-white/70">Software Update</h3>
          <p className="text-xs text-white/40 mt-1">
            Check for and install updates from the Agent D.O.J.O. repository.
          </p>
        </div>

        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-white/50">Current Version</span>
          <span className="text-sm text-white/90 font-mono">{updateInfo?.currentVersion ?? '...'}</span>
        </div>

        {updateInfo?.latestVersion && (
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-white/50">Latest Version</span>
            <span className="text-sm text-white/90 font-mono">{updateInfo.latestVersion}</span>
          </div>
        )}

        {updateInfo && !updateInfo.updateAvailable && !updateInfo.error && (
          <div className="px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
            You're up to date.
          </div>
        )}

        {updateInfo?.updateAvailable && (
          <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm">
            Update available: {updateInfo.latestVersion}
            {updateInfo.downloadSize && (
              <span className="text-xs text-amber-400/60 ml-2">
                ({(updateInfo.downloadSize / 1024).toFixed(0)} KB)
              </span>
            )}
          </div>
        )}

        {updateInfo?.releaseNotes && updateInfo.updateAvailable && (
          <div>
            <span className="text-xs text-white/40">Release Notes</span>
            <pre className="mt-1 text-xs text-white/60 whitespace-pre-wrap font-mono bg-white/[0.03] rounded p-2 max-h-40 overflow-y-auto">
              {updateInfo.releaseNotes}
            </pre>
          </div>
        )}

        {error && (
          <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            {error}
          </div>
        )}

        {updateResult && (
          <div className="px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm">
            {updateResult}
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={checkUpdates}
            disabled={checking || updating}
            className="px-4 py-2 bg-white/[0.05] hover:bg-white/[0.08] disabled:opacity-40 text-white/70 text-sm font-medium rounded-lg transition-colors"
          >
            {checking ? 'Checking...' : 'Check for Updates'}
          </button>

          {updateInfo?.updateAvailable && (
            <button
              onClick={handleUpdate}
              disabled={updating}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {updating ? 'Updating...' : 'Update Now'}
            </button>
          )}
        </div>

        {updating && (
          <div className="text-xs text-white/40">
            Downloading and installing update. The server will restart automatically. This page will reload when the server is back.
          </div>
        )}
      </div>
    </div>
  );
};
