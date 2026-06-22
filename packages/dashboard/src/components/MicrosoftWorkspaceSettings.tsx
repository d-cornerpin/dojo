import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import { MicrosoftActivityLog } from './MicrosoftActivityLog';
import { ChannelSafeSenders } from './ChannelSafeSenders';
import { CollapseToggle, usePanelCollapse } from './CollapseToggle';

type Slot = 'agent' | 'user';

interface AccountView {
  id: string;
  kind: Slot;
  position: number;
  email: string | null;
  accountType: 'msa' | 'entra' | null;
  enabled: boolean;
  connected: boolean;
  services: Record<string, boolean>;
  watchEmail: boolean;
  sendEmail: boolean;
  lastVerified: string | null;
}

interface MsStatus {
  clientId: string;
  accounts: AccountView[];
  maxPerKind: number;
  lastActivity: string | null;
  todayActivity: { reads: number; writes: number };
  officeTools: { status: 'not_installed' | 'installing' | 'installed' | 'failed'; error: string | null };
}

const serviceList = [
  { key: 'outlook', label: 'Outlook Email', desc: 'Read and send emails' },
  { key: 'calendar', label: 'Calendar', desc: 'View and create events' },
  { key: 'onedrive', label: 'OneDrive', desc: 'List, read, and upload files' },
  { key: 'teams', label: 'Teams', desc: 'Send messages', entraOnly: true },
  { key: 'contacts', label: 'Contacts', desc: 'Read and manage contacts' },
  { key: 'onenote', label: 'OneNote', desc: 'Read and write notebook pages' },
  { key: 'tasks', label: 'To Do', desc: 'Read and manage tasks' },
];

const SLOT_META: Record<Slot, { title: string; subtitle: string; addLabel: string }> = {
  agent: {
    title: "Agent's Microsoft Accounts",
    subtitle: "Accounts the agent acts as. Unprefixed tools (outlook_inbox, calendar_agenda_ms, …) hit these. Up to 5.",
    addLabel: 'Add another agent account',
  },
  user: {
    title: "User's Microsoft Accounts",
    subtitle: "Your own Microsoft accounts. The agent reaches these via user-prefixed tools (user_outlook_inbox, …). Up to 5.",
    addLabel: 'Add another user account',
  },
};

interface ConnectingState {
  key: string;
  kind: Slot;
  mode: 'add' | 'reconnect';
  baselineCount: number;
  baselineVerified: string | null;
}

export const MicrosoftWorkspaceSettings = () => {
  const [status, setStatus] = useState<MsStatus | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [connecting, setConnecting] = useState<ConnectingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { collapsed, toggle } = usePanelCollapse('channels.collapse.microsoft');

  useEffect(() => {
    loadStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.get('error')) setError(params.get('error'));
  }, []);

  useEffect(() => {
    if (!connecting) return;
    let elapsed = 0;
    const interval = setInterval(async () => {
      elapsed += 3000;
      const data = await api.request<MsStatus>('/microsoft/status');
      if (data.ok) {
        setStatus(data.data);
        const ofKind = data.data.accounts.filter(a => a.kind === connecting.kind && a.connected);
        const done = connecting.mode === 'add'
          ? ofKind.length > connecting.baselineCount
          : ofKind.some(a => a.id === connecting.key && a.lastVerified !== connecting.baselineVerified);
        if (done) setConnecting(null);
      }
      if (elapsed >= 120000) setConnecting(null);
    }, 3000);
    return () => clearInterval(interval);
  }, [connecting]);

  const loadStatus = async () => {
    const data = await api.request<MsStatus>('/microsoft/status');
    if (data.ok) setStatus(data.data);
  };

  const openOAuth = (authUrl: string) => window.open(authUrl, '_blank');

  const handleAdd = async (kind: Slot, isFirst: boolean) => {
    setError(null);
    const connected = (status?.accounts ?? []).filter(a => a.kind === kind && a.connected);
    setConnecting({ key: `add:${kind}`, kind, mode: 'add', baselineCount: connected.length, baselineVerified: null });
    const redirectUri = 'http://localhost:3001/api/microsoft/callback';
    const path = isFirst ? `/microsoft/connect?slot=${kind}` : `/microsoft/connect?add=true&kind=${kind}`;
    const result = await api.request<{ authUrl: string }>(path, { method: 'POST', body: JSON.stringify({ redirectUri }) });
    if (result.ok) openOAuth(result.data.authUrl);
    else { setError(result.error); setConnecting(null); }
  };

  const handleReconnect = async (acc: AccountView) => {
    setError(null);
    setConnecting({ key: acc.id, kind: acc.kind, mode: 'reconnect', baselineCount: 0, baselineVerified: acc.lastVerified });
    const redirectUri = 'http://localhost:3001/api/microsoft/callback';
    const result = await api.request<{ authUrl: string }>(`/microsoft/connect?accountId=${acc.id}`, { method: 'POST', body: JSON.stringify({ redirectUri }) });
    if (result.ok) openOAuth(result.data.authUrl);
    else { setError(result.error); setConnecting(null); }
  };

  const handleDisconnect = async (acc: AccountView) => {
    const isPrimary = acc.position === 1;
    const who = acc.email ?? `${acc.kind} account`;
    const msg = isPrimary
      ? `Disconnect ${who}? Tools using this account will stop working.`
      : `Remove ${who}? This account will be deleted from the Dojo.`;
    if (!confirm(msg)) return;
    await api.request(`/microsoft/disconnect?accountId=${acc.id}`, { method: 'POST' });
    await loadStatus();
  };

  const handleToggle = async (path: 'services' | 'watch-email' | 'send-email', acc: AccountView, body: Record<string, unknown>) => {
    await api.request(`/microsoft/${path}?accountId=${acc.id}`, { method: 'PUT', body: JSON.stringify(body) });
    await loadStatus();
  };

  const handleInstallOffice = async () => {
    await api.request('/microsoft/install-office-tools', { method: 'POST' });
    setTimeout(loadStatus, 5000);
  };

  if (!status) return <div className="loading-state">Loading...</div>;

  const renderAccount = (acc: AccountView) => {
    const isPrimary = acc.position === 1;
    const isReconnecting = connecting?.key === acc.id;
    const outlookOn = acc.services.outlook ?? true;

    return (
      <div key={acc.id} className="rounded-lg bg-ui/[0.03] border border-ui/[0.08] p-4 space-y-4">
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full shrink-0 ${acc.connected ? 'bg-cp-teal animate-pulse' : 'bg-cp-coral'}`} />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ui/70 truncate">{acc.email ?? '(no email)'}</p>
            <p className="text-xs text-ui/25">
              {acc.accountType === 'entra' ? 'Work/School' : 'Personal'}
              {!acc.connected ? ' · disconnected' : acc.lastVerified ? ` · Verified ${new Date(acc.lastVerified).toLocaleDateString()}` : ''}
              {isPrimary ? ' · primary' : ''}
            </p>
          </div>
        </div>

        {acc.connected && (
          <>
            <div className="space-y-1">
              <p className="form-label">Services</p>
              {serviceList.map(svc => {
                const blocked = svc.entraOnly && acc.accountType === 'msa';
                return (
                  <label key={svc.key} className={`flex items-center justify-between py-1.5 ${blocked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                    <div>
                      <span className="text-sm text-ui/70">{svc.label}</span>
                      <span className="text-xs text-ui/25 ml-2">{svc.desc}</span>
                      {blocked && <span className="text-[10px] text-cp-amber/70 ml-2">(work/school only)</span>}
                    </div>
                    <input type="checkbox" checked={!blocked && (acc.services[svc.key] ?? true)} disabled={blocked}
                      onChange={(e) => !blocked && handleToggle('services', acc, { [svc.key]: e.target.checked })}
                      className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0" />
                  </label>
                );
              })}
            </div>

            <label className="flex items-center justify-between py-1.5 cursor-pointer">
              <div className="min-w-0 pr-3">
                <span className="text-sm text-ui/70">Monitor incoming email</span>
                <span className="text-xs text-ui/25 block mt-0.5">
                  {outlookOn ? 'Notify the agent whenever new mail arrives in this inbox.' : 'Enable Outlook above first.'}
                </span>
              </div>
              <input type="checkbox" checked={acc.watchEmail && outlookOn} disabled={!outlookOn}
                onChange={(e) => handleToggle('watch-email', acc, { enabled: e.target.checked })}
                className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0 disabled:opacity-30 disabled:cursor-not-allowed" />
            </label>

            <label className="flex items-center justify-between py-1.5 cursor-pointer">
              <div className="min-w-0 pr-3">
                <span className="text-sm text-ui/70">Allow sending email</span>
                <span className="text-xs text-ui/25 block mt-0.5">
                  {outlookOn ? `Lets the agent send, reply, and forward from ${acc.email ?? 'this account'}.` : 'Enable Outlook above first.'}
                </span>
              </div>
              <input type="checkbox" checked={acc.sendEmail && outlookOn} disabled={!outlookOn}
                onChange={(e) => handleToggle('send-email', acc, { enabled: e.target.checked })}
                className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0 disabled:opacity-30 disabled:cursor-not-allowed" />
            </label>

            {acc.sendEmail && outlookOn && (
              <ChannelSafeSenders
                configKey={`outlook_approved_senders_${acc.id}`}
                channelLabel={`Outlook (${acc.email ?? acc.id})`}
                description={`Senders the agent may AUTO-reply to from ${acc.email ?? 'this account'}. When one of these people replies on a thread (subject starts with Re:), the agent's response routes back via email automatically. This list is independent per account.`}
                addressPlaceholder="name@example.com"
              />
            )}

            {isPrimary && acc.accountType === 'entra' && acc.services.teams && (
              <ChannelSafeSenders
                configKey="teams_approved_senders"
                channelLabel="Teams"
                description="Senders the agent is allowed to AUTO-reply to via Teams DMs. Teams DMs from anyone NOT on the list still show as notifications, but the agent won't auto-reply without your approval. Available only on Entra (work/school) accounts."
                addressPlaceholder="name@org.com"
              />
            )}
          </>
        )}

        <div className="flex gap-2 pt-1 flex-wrap">
          <button onClick={() => handleReconnect(acc)} disabled={isReconnecting}
            className="btn btn--primary btn--sm">
            {isReconnecting ? 'Waiting for sign-in...' : 'Reconnect'}
          </button>
          <button onClick={() => handleDisconnect(acc)}
            className="btn btn--danger btn--sm ml-auto">
            {isPrimary ? 'Disconnect' : 'Remove'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      {(['agent', 'user'] as Slot[]).map((kind) => {
        const meta = SLOT_META[kind];
        const accounts = status.accounts.filter(a => a.kind === kind).sort((a, b) => a.position - b.position);
        const connectedCount = accounts.filter(a => a.connected).length;
        // Show the account list whenever ROWS exist (connected or not). A
        // disconnected/broken account must stay visible with a Reconnect
        // affordance, never silently vanish into the empty "sign in" state.
        const hasRows = accounts.length > 0;
        const atCap = connectedCount >= status.maxPerKind;
        const adding = connecting?.key === `add:${kind}`;
        const isCollapsed = collapsed[kind] ?? true;

        return (
          <div key={kind} className="tile space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="scard__title">{meta.title}</h3>
                {!isCollapsed && <p className="text-xs text-ui/40 mt-1">{meta.subtitle}</p>}
              </div>
              <CollapseToggle collapsed={isCollapsed} onClick={() => toggle(kind)} label={meta.title} />
            </div>

            {error && kind === 'agent' && <div className="alert-banner alert-error">{error}</div>}

            {isCollapsed ? (
              <div className="space-y-2">
                {hasRows ? (
                  <>
                    {accounts.map(a => (
                      <div key={a.id} className="flex items-center gap-2 text-sm text-ui/60">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.connected ? 'bg-cp-teal' : 'bg-cp-coral'}`} />
                        <span className="truncate">{a.email ?? a.id}</span>
                        {a.accountType && <span className="text-[10px] text-ui/30">{a.accountType === 'entra' ? 'Work/School' : 'Personal'}</span>}
                        {!a.connected && <span className="text-[11px] text-cp-coral/80 shrink-0">disconnected</span>}
                      </div>
                    ))}
                    <button onClick={() => handleAdd(kind, false)} disabled={adding || atCap}
                      className="btn btn--sm mt-1">
                      {adding ? 'Waiting for sign-in...' : atCap ? `Maximum ${status.maxPerKind} reached` : `＋ ${meta.addLabel}`}
                    </button>
                  </>
                ) : (
                  <button onClick={() => handleAdd(kind, true)} disabled={adding}
                    className="btn btn--sm">
                    {adding ? 'Waiting for sign-in...' : 'Not connected — sign in'}
                  </button>
                )}
              </div>
            ) : !hasRows ? (
              <div className="space-y-3">
                <button onClick={() => handleAdd(kind, true)} disabled={adding}
                  className="btn btn--primary w-full justify-center">
                  {adding ? 'Waiting for sign-in...' : `Sign in with Microsoft${kind === 'user' ? ' (User account)' : ''}`}
                </button>
                {adding && (
                  <p className="text-xs text-ui/25">Complete the sign-in in your browser. This page will update automatically.</p>
                )}
                {kind === 'agent' && (
                  <p className="text-[10px] text-ui/25">
                    For work/school accounts: if you see "Need admin approval", your organization's admin needs to approve the app once.
                  </p>
                )}
                <p className="text-[11px] text-ui/40">
                  No Microsoft account?{' '}
                  <a href="https://signup.live.com/" target="_blank" rel="noopener noreferrer"
                    className="text-cp-teal hover:text-cp-teal/80 underline">Create one ↗</a>
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {accounts.map(renderAccount)}

                {kind === 'agent' && status.todayActivity && (status.todayActivity.reads > 0 || status.todayActivity.writes > 0) && (
                  <div className="text-xs text-ui/25">
                    Today: {status.todayActivity.reads} reads, {status.todayActivity.writes} writes
                  </div>
                )}

                {/* Office Document Tools — machine-level install, shown once under the agent kind. */}
                {kind === 'agent' && (
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
                    <p className="text-xs text-ui/25 mb-2">Word, Excel, and PowerPoint document creation.</p>
                    {status.officeTools.status === 'failed' && status.officeTools.error && (
                      <p className="text-xs text-cp-coral mb-2">{status.officeTools.error}</p>
                    )}
                    {(status.officeTools.status === 'not_installed' || status.officeTools.status === 'failed') && (
                      <button onClick={handleInstallOffice}
                        className="btn btn--primary btn--sm">
                        {status.officeTools.status === 'failed' ? 'Retry Install' : 'Install'}
                      </button>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <button onClick={() => handleAdd(kind, false)} disabled={adding || atCap}
                    className="btn btn--sm">
                    {adding ? 'Waiting for sign-in...' : atCap ? `Maximum ${status.maxPerKind} reached` : `＋ ${meta.addLabel}`}
                  </button>
                  {kind === 'agent' && (
                    <button onClick={() => setShowActivity(!showActivity)}
                      className="btn btn--sm ml-auto">
                      {showActivity ? 'Hide Activity' : 'Activity Log'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {showActivity && <div className="tile" style={{ breakInside: 'avoid' }}><MicrosoftActivityLog /></div>}
    </>
  );
};
