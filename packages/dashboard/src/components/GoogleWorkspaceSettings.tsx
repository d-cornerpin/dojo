import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import { GoogleActivityLog } from './GoogleActivityLog';
import { ChannelSafeSenders } from './ChannelSafeSenders';
import { CollapseToggle, usePanelCollapse } from './CollapseToggle';

type Slot = 'agent' | 'user';

interface AccountView {
  id: string;
  kind: Slot;
  position: number;
  email: string | null;
  enabled: boolean;
  connected: boolean;
  services: Record<string, boolean>;
  watchEmail: boolean;
  sendEmail: boolean;
  lastVerified: string | null;
}

interface SlotInfo {
  missingScopes?: string[];
}

interface GoogleStatus {
  slots: { agent: SlotInfo; user: SlotInfo };
  accounts: AccountView[];
  maxPerKind: number;
  lastActivity: string | null;
  todayActivity: { reads: number; writes: number };
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

const SLOT_META: Record<Slot, { title: string; subtitle: string; addLabel: string }> = {
  agent: {
    title: "Agent's Google Accounts",
    subtitle: "Accounts the agent acts as. Unprefixed tools (gmail_inbox, calendar_agenda, …) hit these. Up to 5.",
    addLabel: 'Add another agent account',
  },
  user: {
    title: "User's Google Accounts",
    subtitle: "Your own Google accounts. The agent reaches these via user-prefixed tools (user_gmail_inbox, …). Up to 5.",
    addLabel: 'Add another user account',
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

interface ConnectingState {
  key: string;        // accountId for reconnect; `add:<kind>` for a new connect
  kind: Slot;
  mode: 'add' | 'reconnect';
  baselineCount: number;
  baselineVerified: string | null;
}

export const GoogleWorkspaceSettings = () => {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [connecting, setConnecting] = useState<ConnectingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { collapsed, toggle } = usePanelCollapse('channels.collapse.google');

  useEffect(() => { loadStatus(); }, []);

  // While an OAuth window is open, poll status and clear the spinner once the
  // expected change lands (a new account appeared for "add"; the target
  // account re-verified for "reconnect"). Times out after ~2 min.
  useEffect(() => {
    if (!connecting) return;
    let elapsed = 0;
    const interval = setInterval(async () => {
      elapsed += 3000;
      const data = await api.request<GoogleStatus>('/google/status');
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
    const data = await api.request<GoogleStatus>('/google/status');
    if (data.ok) setStatus(data.data);
  };

  const openOAuth = (authUrl: string) => window.open(authUrl, '_blank', 'width=600,height=700');

  // Connect a kind's first account (creates the position-1 row) or add another.
  const handleAdd = async (kind: Slot, isFirst: boolean) => {
    setError(null);
    const connected = (status?.accounts ?? []).filter(a => a.kind === kind && a.connected);
    setConnecting({ key: `add:${kind}`, kind, mode: 'add', baselineCount: connected.length, baselineVerified: null });
    const path = isFirst ? `/google/connect?slot=${kind}` : `/google/connect?add=true&kind=${kind}`;
    const result = await api.request<{ authUrl: string }>(path, { method: 'POST' });
    if (result.ok) openOAuth(result.data.authUrl);
    else { setError(result.error); setConnecting(null); }
  };

  const handleReconnect = async (acc: AccountView) => {
    setError(null);
    setConnecting({ key: acc.id, kind: acc.kind, mode: 'reconnect', baselineCount: 0, baselineVerified: acc.lastVerified });
    const result = await api.request<{ authUrl: string }>(`/google/connect?accountId=${acc.id}`, { method: 'POST' });
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
    await api.request(`/google/disconnect?accountId=${acc.id}`, { method: 'POST' });
    await loadStatus();
  };

  const handleToggle = async (
    kindOrPath: 'services' | 'watch-email' | 'send-email',
    acc: AccountView,
    body: Record<string, unknown>,
  ) => {
    await api.request(`/google/${kindOrPath}?accountId=${acc.id}`, { method: 'PUT', body: JSON.stringify(body) });
    await loadStatus();
  };

  if (!status) return <div className="loading-state">Loading...</div>;

  const renderAccount = (acc: AccountView) => {
    const isPrimary = acc.position === 1;
    const isReconnecting = connecting?.key === acc.id;
    const gmailOn = acc.services.gmail ?? true;
    const missing = isPrimary
      ? Array.from(new Set((status.slots[acc.kind].missingScopes ?? []).map(scopeLabel).filter((l): l is string => l !== null)))
      : [];

    return (
      <div key={acc.id} className="rounded-lg bg-ui/[0.03] border border-ui/[0.08] p-4 space-y-4">
        {missing.length > 0 && (
          <div className="alert-banner alert-warning flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-medium">New permissions available</p>
              <p className="text-xs text-ui/55 mt-0.5">Reconnect to enable: {missing.join(', ')}</p>
            </div>
            <button onClick={() => handleReconnect(acc)} disabled={isReconnecting}
              className="btn btn--primary btn--sm shrink-0">
              {isReconnecting ? 'Waiting...' : 'Reconnect'}
            </button>
          </div>
        )}

        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full shrink-0 ${acc.connected ? 'bg-cp-teal animate-pulse' : 'bg-cp-coral'}`} />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ui/70 truncate">{acc.email ?? '(no email)'}</p>
            <p className="text-xs text-ui/25">
              {!acc.connected ? 'Disconnected' : acc.lastVerified ? `Verified ${new Date(acc.lastVerified).toLocaleDateString()}` : 'Connected'}
              {isPrimary ? ' · primary' : ''}
            </p>
          </div>
        </div>

        {acc.connected && (
          <>
            <div className="space-y-1">
              <p className="form-label">Services</p>
              {services.map(svc => (
                <label key={svc.key} className="flex items-center justify-between py-1.5 cursor-pointer">
                  <div>
                    <span className="text-sm text-ui/70">{svc.label}</span>
                    <span className="text-xs text-ui/25 ml-2">{svc.desc}</span>
                  </div>
                  <input type="checkbox" checked={acc.services[svc.key] ?? true}
                    onChange={(e) => handleToggle('services', acc, { [svc.key]: e.target.checked })}
                    className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0" />
                </label>
              ))}
            </div>

            <label className="flex items-center justify-between py-1.5 cursor-pointer">
              <div className="min-w-0 pr-3">
                <span className="text-sm text-ui/70">Monitor incoming email</span>
                <span className="text-xs text-ui/25 block mt-0.5">
                  {gmailOn ? 'Notify the agent whenever new mail arrives in this inbox.' : 'Enable Gmail above first.'}
                </span>
              </div>
              <input type="checkbox" checked={acc.watchEmail && gmailOn} disabled={!gmailOn}
                onChange={(e) => handleToggle('watch-email', acc, { enabled: e.target.checked })}
                className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0 disabled:opacity-30 disabled:cursor-not-allowed" />
            </label>

            <label className="flex items-center justify-between py-1.5 cursor-pointer">
              <div className="min-w-0 pr-3">
                <span className="text-sm text-ui/70">Allow sending email</span>
                <span className="text-xs text-ui/25 block mt-0.5">
                  {gmailOn ? `Lets the agent send, reply, and forward from ${acc.email ?? 'this account'}.` : 'Enable Gmail above first.'}
                </span>
              </div>
              <input type="checkbox" checked={acc.sendEmail && gmailOn} disabled={!gmailOn}
                onChange={(e) => handleToggle('send-email', acc, { enabled: e.target.checked })}
                className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0 disabled:opacity-30 disabled:cursor-not-allowed" />
            </label>

            {acc.sendEmail && gmailOn && (
              <ChannelSafeSenders
                configKey={`gmail_approved_senders_${acc.id}`}
                channelLabel={`Gmail (${acc.email ?? acc.id})`}
                description={`Senders the agent may AUTO-reply to from ${acc.email ?? 'this account'}. When one of these people replies on a thread (subject starts with Re:), the agent's response routes back via email automatically. This list is independent per account.`}
                addressPlaceholder="name@example.com"
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
                  {adding ? 'Waiting for sign-in...' : `Sign in with Google${kind === 'user' ? ' (User account)' : ''}`}
                </button>
                {adding && (
                  <p className="text-xs text-ui/25">
                    Complete the sign-in in the browser window that opened. This page will update automatically.
                  </p>
                )}
                <p className="text-[11px] text-ui/40">
                  No Google account?{' '}
                  <a href="https://accounts.google.com/signup" target="_blank" rel="noopener noreferrer"
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

      {showActivity && <div className="tile" style={{ breakInside: 'avoid' }}><GoogleActivityLog /></div>}
    </>
  );
};
