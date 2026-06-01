import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import { MicrosoftActivityLog } from './MicrosoftActivityLog';
import { ChannelSafeSenders } from './ChannelSafeSenders';

type Slot = 'agent' | 'user';

interface SlotInfo {
  slot: Slot;
  enabled: boolean;
  connected: boolean;
  email: string | null;
  accountType: 'msa' | 'entra' | null;
  services: Record<string, boolean>;
  lastVerified: string | null;
  watchEmail: boolean;
  sendEmail: boolean;
}

interface MsStatus {
  clientId: string;
  slots: { agent: SlotInfo; user: SlotInfo };
  lastActivity: string | null;
  todayActivity: { reads: number; writes: number };
  officeTools: { status: 'not_installed' | 'installing' | 'installed' | 'failed'; error: string | null };
  // Legacy single-account fields (mirror of agent slot)
  enabled: boolean;
  connected: boolean;
  email: string | null;
  accountType: 'msa' | 'entra' | null;
  services: Record<string, boolean>;
  lastVerified: string | null;
}

const serviceList = [
  { key: 'outlook', label: 'Outlook Email', desc: 'Read and send emails' },
  { key: 'calendar', label: 'Calendar', desc: 'View and create events' },
  { key: 'onedrive', label: 'OneDrive', desc: 'List, read, and upload files' },
  { key: 'teams', label: 'Teams', desc: 'Send messages', entraOnly: true },
];

const SLOT_META: Record<Slot, { title: string; subtitle: string }> = {
  agent: {
    title: "Agent's Microsoft Account",
    subtitle: "The account the agent acts as. Tools like outlook_inbox, calendar_agenda_ms, etc. hit this account by default.",
  },
  user: {
    title: "User's Microsoft Account",
    subtitle: "Your own Microsoft account. The agent can read it via user-prefixed tools (user_outlook_inbox, user_calendar_agenda_ms, etc.). Optional — connect only if you want the agent to act on your behalf.",
  },
};

export const MicrosoftWorkspaceSettings = () => {
  const [status, setStatus] = useState<MsStatus | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [connectingSlot, setConnectingSlot] = useState<Slot | null>(null);
  const [testingSlot, setTestingSlot] = useState<Slot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === 'true') loadStatus();
    if (params.get('error')) setError(params.get('error'));
  }, []);

  const loadStatus = async () => {
    const data = await api.request<MsStatus>('/microsoft/status');
    if (data.ok) setStatus(data.data);
  };

  const handleConnect = async (slot: Slot) => {
    setConnectingSlot(slot);
    setError(null);
    const redirectUri = 'http://localhost:3001/api/microsoft/callback';
    const result = await api.request<{ authUrl: string }>(`/microsoft/connect?slot=${slot}`, {
      method: 'POST',
      body: JSON.stringify({ redirectUri }),
    });
    if (result.ok) {
      window.open(result.data.authUrl, '_blank');
      const poll = setInterval(async () => {
        const s = await api.request<MsStatus>('/microsoft/status');
        if (s.ok && s.data.slots[slot].connected) {
          clearInterval(poll);
          setStatus(s.data);
          setConnectingSlot(null);
        }
      }, 3000);
      setTimeout(() => { clearInterval(poll); setConnectingSlot(c => c === slot ? null : c); }, 180000);
    } else {
      setError(result.error);
      setConnectingSlot(null);
    }
  };

  const handleTest = async (slot: Slot) => {
    setTestingSlot(slot);
    await api.request(`/microsoft/test?slot=${slot}`, { method: 'POST' });
    await loadStatus();
    setTestingSlot(null);
  };

  const handleDisconnect = async (slot: Slot) => {
    const slotLabel = slot === 'user' ? "your User Microsoft account" : "the Agent's Microsoft account";
    if (!confirm(`Disconnect ${slotLabel}? ${slot === 'user' ? "user_* Outlook/Calendar/OneDrive tools will stop working." : "Your agents will lose access to Outlook, Calendar, OneDrive, and Teams."}`)) return;
    await api.request(`/microsoft/disconnect?slot=${slot}`, { method: 'POST' });
    await loadStatus();
  };

  const handleServiceToggle = async (slot: Slot, service: string, enabled: boolean) => {
    if (!status) return;
    const slotInfo = status.slots[slot];
    const updated = { ...slotInfo.services, [service]: enabled };
    await api.request(`/microsoft/services?slot=${slot}`, { method: 'PUT', body: JSON.stringify(updated) });
    await loadStatus();
  };

  const handleToggleWatchEmail = async (slot: Slot, enabled: boolean) => {
    await api.request(`/microsoft/watch-email?slot=${slot}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    await loadStatus();
  };

  const handleToggleSendEmail = async (slot: Slot, enabled: boolean) => {
    await api.request(`/microsoft/send-email?slot=${slot}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    await loadStatus();
  };

  const handleInstallOffice = async () => {
    await api.request('/microsoft/install-office-tools', { method: 'POST' });
    setTimeout(loadStatus, 5000);
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
                  {isConnecting ? 'Waiting for sign-in...' : `Sign in with Microsoft${slot === 'user' ? ' (User account)' : ''}`}
                </button>
                {isConnecting && (
                  <p className="text-xs text-ui/25">
                    Complete the sign-in in your browser. This page will update automatically.
                  </p>
                )}
                {slot === 'agent' && (
                  <p className="text-[10px] text-ui/25">
                    For work/school accounts: if you see "Need admin approval", your organization's admin needs to approve the app once.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <span className="w-2 h-2 rounded-full bg-cp-teal animate-pulse shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ui/70 truncate">{info.email}</p>
                    <p className="text-xs text-ui/25">
                      {info.accountType === 'entra' ? 'Work/School' : 'Personal'}
                      {info.lastVerified && ` · Verified ${new Date(info.lastVerified).toLocaleDateString()}`}
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
                  {serviceList.map(svc => {
                    const blocked = svc.entraOnly && info.accountType === 'msa';
                    return (
                      <label key={svc.key} className={`flex items-center justify-between py-1.5 ${blocked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                        <div>
                          <span className="text-sm text-ui/70">{svc.label}</span>
                          <span className="text-xs text-ui/25 ml-2">{svc.desc}</span>
                          {blocked && <span className="text-[10px] text-cp-amber/70 ml-2">(work/school only)</span>}
                        </div>
                        <input
                          type="checkbox"
                          checked={!blocked && (info.services[svc.key] ?? true)}
                          onChange={(e) => !blocked && handleServiceToggle(slot, svc.key, e.target.checked)}
                          disabled={blocked}
                          className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0"
                        />
                      </label>
                    );
                  })}
                </div>

                <label className="flex items-center justify-between py-1.5 cursor-pointer">
                  <div className="min-w-0 pr-3">
                    <span className="text-sm text-ui/70">Monitor incoming email</span>
                    <span className="text-xs text-ui/25 block mt-0.5">
                      {info.services.outlook
                        ? 'Notify the agent whenever new mail arrives in this inbox.'
                        : 'Enable Outlook above first.'}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={info.watchEmail && (info.services.outlook ?? true)}
                    disabled={!(info.services.outlook ?? true)}
                    onChange={(e) => handleToggleWatchEmail(slot, e.target.checked)}
                    className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0 disabled:opacity-30 disabled:cursor-not-allowed"
                  />
                </label>

                <label className="flex items-center justify-between py-1.5 cursor-pointer">
                  <div className="min-w-0 pr-3">
                    <span className="text-sm text-ui/70">Allow sending email</span>
                    <span className="text-xs text-ui/25 block mt-0.5">
                      {info.services.outlook
                        ? `Lets the agent send, reply, and forward from ${info.email ?? 'this account'}.`
                        : 'Enable Outlook above first.'}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={info.sendEmail && (info.services.outlook ?? true)}
                    disabled={!(info.services.outlook ?? true)}
                    onChange={(e) => handleToggleSendEmail(slot, e.target.checked)}
                    className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0 disabled:opacity-30 disabled:cursor-not-allowed"
                  />
                </label>

                {info.sendEmail && info.services.outlook && (
                  <ChannelSafeSenders
                    configKey={`outlook_approved_senders_${slot}`}
                    channelLabel={`Outlook (${info.email ?? slot})`}
                    description={`Senders the agent is allowed to AUTO-reply to from THIS specific Outlook account (${info.email ?? `${slot} slot`}). When one of these people replies on a thread (subject starts with Re:), the agent's response routes back via email automatically. The list is independent per slot — adding someone here does NOT authorize auto-reply on the other slot's Outlook (if connected), or on iMessage / Gmail / Teams.`}
                    addressPlaceholder="name@example.com"
                  />
                )}

                {info.accountType === 'entra' && info.services.teams && (
                  <ChannelSafeSenders
                    configKey="teams_approved_senders"
                    channelLabel="Teams"
                    description="Senders the agent is allowed to AUTO-reply to via Teams DMs. When one of these people DMs the agent on Teams, the agent's response routes back via Teams automatically. Teams DMs from anyone NOT on the list still show as notifications, but the agent won't auto-reply without your approval. Available only on Entra (work/school) accounts."
                    addressPlaceholder="name@org.com"
                  />
                )}

                {/* Office Document Tools — agent slot only; the install is shared at machine level. */}
                {slot === 'agent' && (
                  <div className="border-t border-ui/[0.06] pt-3">
                    <div className="flex items-center justify-between mb-1">
                      <p className="form-label mb-0">Office Document Tools</p>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                        status.officeTools.status === 'installed' ? 'bg-cp-teal/10 text-cp-teal' :
                        status.officeTools.status === 'installing' ? 'bg-cp-amber/10 text-cp-amber' :
                        status.officeTools.status === 'failed' ? 'bg-cp-coral/10 text-cp-coral' :
                        'bg-ui/[0.08] text-ui/40'
                      }`}>
                        {status.officeTools.status === 'installed' ? 'Ready' :
                         status.officeTools.status === 'installing' ? 'Installing...' :
                         status.officeTools.status === 'failed' ? 'Failed' : 'Not installed'}
                      </span>
                    </div>
                    <p className="text-xs text-ui/25 mb-2">
                      Word, Excel, and PowerPoint document creation.
                    </p>
                    {status.officeTools.status === 'failed' && status.officeTools.error && (
                      <p className="text-xs text-cp-coral mb-2">{status.officeTools.error}</p>
                    )}
                    {(status.officeTools.status === 'not_installed' || status.officeTools.status === 'failed') && (
                      <button onClick={handleInstallOffice}
                        className="px-3 py-1.5 glass-btn-primary text-xs rounded-lg transition-colors">
                        {status.officeTools.status === 'failed' ? 'Retry Install' : 'Install'}
                      </button>
                    )}
                  </div>
                )}

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

      {showActivity && <MicrosoftActivityLog />}
    </div>
  );
};
