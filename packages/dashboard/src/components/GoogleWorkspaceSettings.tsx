import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import { GoogleActivityLog } from './GoogleActivityLog';

type Slot = 'agent' | 'user';

interface SlotInfo {
  slot: Slot;
  enabled: boolean;
  connected: boolean;
  email: string | null;
  services: Record<string, boolean>;
  lastVerified: string | null;
  missingScopes?: string[];
  watchEmail: boolean;
  sendEmail: boolean;
}

interface GoogleStatus {
  slots: { agent: SlotInfo; user: SlotInfo };
  lastActivity: string | null;
  todayActivity: { reads: number; writes: number };
  // Legacy single-account fields (mirror of agent slot — kept for compat)
  enabled: boolean;
  connected: boolean;
  email: string | null;
  services: Record<string, boolean>;
  lastVerified: string | null;
  missingScopes?: string[];
}

const services = [
  { key: 'gmail', label: 'Gmail', desc: 'Search, read, and send emails' },
  { key: 'calendar', label: 'Calendar', desc: 'View and create events' },
  { key: 'drive', label: 'Drive', desc: 'List, read, and upload files' },
  { key: 'docs', label: 'Docs', desc: 'Read and create documents' },
  { key: 'sheets', label: 'Sheets', desc: 'Read and write spreadsheets' },
  { key: 'slides', label: 'Slides', desc: 'Create presentations' },
  { key: 'forms', label: 'Forms', desc: 'Create surveys, edit questions, read responses' },
];

const SLOT_META: Record<Slot, { title: string; subtitle: string }> = {
  agent: {
    title: "Agent's Google Account",
    subtitle: "The account the agent acts as. Tools like gmail_inbox, calendar_agenda, etc. hit this account by default.",
  },
  user: {
    title: "User's Google Account",
    subtitle: "Your own Google account. The agent can read it via user-prefixed tools (user_gmail_inbox, user_calendar_agenda, etc.). Optional — connect only if you want the agent to act on your behalf.",
  },
};

function scopeLabel(scope: string): string | null {
  if (scope === 'openid') return null;
  if (scope === 'email' || scope.includes('/userinfo.email')) return null;
  if (scope === 'profile' || scope.includes('/userinfo.profile')) return null;
  if (scope.includes('/forms.')) return 'Forms';
  if (scope.includes('/gmail.')) return 'Gmail';
  if (scope.includes('/calendar')) return 'Calendar';
  if (scope.includes('/drive')) return 'Drive';
  if (scope.includes('/documents')) return 'Docs';
  if (scope.includes('/spreadsheets')) return 'Sheets';
  if (scope.includes('/presentations')) return 'Slides';
  return scope;
}

export const GoogleWorkspaceSettings = () => {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  // Per-slot transient state so a connect-in-progress on one slot doesn't
  // disable the other slot's buttons.
  const [connectingSlot, setConnectingSlot] = useState<Slot | null>(null);
  const [testingSlot, setTestingSlot] = useState<Slot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { loadStatus(); }, []);

  useEffect(() => {
    if (!connectingSlot) return;
    const slot = connectingSlot;
    const interval = setInterval(async () => {
      const data = await api.request<GoogleStatus>('/google/status');
      if (data.ok && data.data.slots[slot].connected) {
        setStatus(data.data);
        setConnectingSlot(null);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [connectingSlot]);

  const loadStatus = async () => {
    const data = await api.request<GoogleStatus>('/google/status');
    if (data.ok) setStatus(data.data);
  };

  const handleConnect = async (slot: Slot) => {
    setConnectingSlot(slot);
    setError(null);
    const result = await api.request<{ authUrl: string; slot: Slot }>(`/google/connect?slot=${slot}`, { method: 'POST' });
    if (result.ok) {
      window.open(result.data.authUrl, '_blank', 'width=600,height=700');
    } else {
      setError(result.error);
      setConnectingSlot(null);
    }
  };

  const handleDisconnect = async (slot: Slot) => {
    const slotLabel = slot === 'user' ? "your User Google account" : "the Agent's Google account";
    if (!confirm(`Disconnect ${slotLabel}? ${slot === 'user' ? "user_* Gmail/Calendar/Drive tools will stop working." : "Your agents will lose access to Gmail, Calendar, and Drive."}`)) return;
    await api.request(`/google/disconnect?slot=${slot}`, { method: 'POST' });
    await loadStatus();
  };

  const handleTest = async (slot: Slot) => {
    setTestingSlot(slot);
    await api.request<{ working: boolean; email: string | null }>(`/google/test?slot=${slot}`, { method: 'POST' });
    await loadStatus();
    setTestingSlot(null);
  };

  const handleToggleService = async (slot: Slot, service: string, enabled: boolean) => {
    await api.request(`/google/services?slot=${slot}`, {
      method: 'PUT',
      body: JSON.stringify({ [service]: enabled }),
    });
    await loadStatus();
  };

  const handleToggleWatchEmail = async (slot: Slot, enabled: boolean) => {
    await api.request(`/google/watch-email?slot=${slot}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    await loadStatus();
  };

  const handleToggleSendEmail = async (slot: Slot, enabled: boolean) => {
    await api.request(`/google/send-email?slot=${slot}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    await loadStatus();
  };

  if (!status) return <div className="loading-state">Loading...</div>;

  return (
    <div className="space-y-4">
      {(['agent', 'user'] as Slot[]).map((slot) => {
        const info = status.slots[slot];
        const meta = SLOT_META[slot];
        const isConnecting = connectingSlot === slot;
        const isTesting = testingSlot === slot;
        return (
          <div key={slot} className="glass-card p-4 space-y-4">
            <div>
              <h3 className="card-header">{meta.title}</h3>
              <p className="text-xs text-ui/40 mt-1">{meta.subtitle}</p>
            </div>

            {!info.connected ? (
              <div className="space-y-3">
                {error && slot === 'agent' && <div className="alert-banner alert-error">{error}</div>}
                <button
                  onClick={() => handleConnect(slot)}
                  disabled={isConnecting}
                  className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors w-full"
                >
                  {isConnecting ? 'Waiting for sign-in...' : `Sign in with Google${slot === 'user' ? ' (User account)' : ''}`}
                </button>
                {isConnecting && (
                  <p className="text-xs text-ui/25">
                    Complete the sign-in in the browser window that opened. This page will update automatically.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {/* Missing-scopes banner per slot */}
                {(() => {
                  const labels = Array.from(new Set(
                    (info.missingScopes ?? []).map(scopeLabel).filter((l): l is string => l !== null),
                  ));
                  if (labels.length === 0) return null;
                  return (
                    <div className="alert-banner alert-warning flex items-center justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">New permissions available</p>
                        <p className="text-xs text-ui/55 mt-0.5">
                          Reconnect to enable: {labels.join(', ')}
                        </p>
                      </div>
                      <button
                        onClick={() => handleConnect(slot)}
                        disabled={isConnecting}
                        className="px-3 py-1.5 glass-btn-primary text-xs rounded-lg transition-colors shrink-0"
                      >
                        {isConnecting ? 'Waiting...' : 'Reconnect'}
                      </button>
                    </div>
                  );
                })()}

                <div className="flex items-center gap-3">
                  <span className="w-2 h-2 rounded-full bg-cp-teal animate-pulse shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-ui/70 truncate">{info.email}</p>
                    <p className="text-xs text-ui/25">
                      {info.lastVerified ? `Verified ${new Date(info.lastVerified).toLocaleDateString()}` : 'Connected'}
                    </p>
                  </div>
                </div>

                {slot === 'agent' && status.todayActivity && (status.todayActivity.reads > 0 || status.todayActivity.writes > 0) && (
                  <div className="text-xs text-ui/25">
                    Today: {status.todayActivity.reads} reads, {status.todayActivity.writes} writes
                  </div>
                )}

                <div className="space-y-1">
                  <p className="form-label">Services</p>
                  {services.map(svc => (
                    <label key={svc.key} className="flex items-center justify-between py-1.5 cursor-pointer">
                      <div>
                        <span className="text-sm text-ui/70">{svc.label}</span>
                        <span className="text-xs text-ui/25 ml-2">{svc.desc}</span>
                      </div>
                      <input
                        type="checkbox"
                        checked={info.services[svc.key] ?? true}
                        onChange={(e) => handleToggleService(slot, svc.key, e.target.checked)}
                        className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0"
                      />
                    </label>
                  ))}
                </div>

                <label className="flex items-center justify-between py-1.5 cursor-pointer">
                  <div className="min-w-0 pr-3">
                    <span className="text-sm text-ui/70">Monitor incoming email</span>
                    <span className="text-xs text-ui/25 block mt-0.5">
                      {info.services.gmail
                        ? 'Notify the agent whenever new mail arrives in this inbox.'
                        : 'Enable Gmail above first.'}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={info.watchEmail && (info.services.gmail ?? true)}
                    disabled={!(info.services.gmail ?? true)}
                    onChange={(e) => handleToggleWatchEmail(slot, e.target.checked)}
                    className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0 disabled:opacity-30 disabled:cursor-not-allowed"
                  />
                </label>

                <label className="flex items-center justify-between py-1.5 cursor-pointer">
                  <div className="min-w-0 pr-3">
                    <span className="text-sm text-ui/70">Allow sending email</span>
                    <span className="text-xs text-ui/25 block mt-0.5">
                      {info.services.gmail
                        ? `Lets the agent send, reply, and forward from ${info.email ?? 'this account'}.`
                        : 'Enable Gmail above first.'}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={info.sendEmail && (info.services.gmail ?? true)}
                    disabled={!(info.services.gmail ?? true)}
                    onChange={(e) => handleToggleSendEmail(slot, e.target.checked)}
                    className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0 disabled:opacity-30 disabled:cursor-not-allowed"
                  />
                </label>

                <div className="flex gap-2 pt-2 flex-wrap">
                  <button onClick={() => handleTest(slot)} disabled={isTesting}
                    className="px-3 py-1.5 glass-btn-primary text-xs rounded-lg transition-colors">
                    {isTesting ? 'Testing...' : 'Test Connection'}
                  </button>
                  {slot === 'agent' && (
                    <button onClick={() => setShowActivity(!showActivity)}
                      className="px-3 py-1.5 bg-ui/[0.05] hover:bg-ui/[0.12] text-ui/55 text-xs rounded-lg transition-colors">
                      {showActivity ? 'Hide Activity' : 'Activity Log'}
                    </button>
                  )}
                  <button onClick={() => handleDisconnect(slot)}
                    className="px-3 py-1.5 bg-cp-coral/10 hover:bg-cp-coral/20 text-cp-coral text-xs rounded-lg transition-colors ml-auto">
                    Disconnect
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {showActivity && <GoogleActivityLog />}
    </div>
  );
};
