import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import { MicrosoftActivityLog } from './MicrosoftActivityLog';

interface MsStatus {
  hasClientId: boolean;
  enabled: boolean;
  connected: boolean;
  email: string | null;
  accountType: 'msa' | 'entra' | null;
  services: Record<string, boolean>;
  lastVerified: string | null;
  lastActivity: string | null;
  todayActivity: { reads: number; writes: number };
}

export const MicrosoftWorkspaceSettings = () => {
  const [status, setStatus] = useState<MsStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [showActivity, setShowActivity] = useState(false);

  // Setup flow states
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    loadStatus();
    // Check URL params for callback result
    const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    if (params.get('connected') === 'true') loadStatus();
    if (params.get('error')) setConfigError(decodeURIComponent(params.get('error') ?? ''));
  }, []);

  const loadStatus = async () => {
    const data = await api.request<MsStatus>('/microsoft/status');
    if (data.ok) setStatus(data.data);
  };

  const handleConfigure = async () => {
    if (!clientId.trim()) { setConfigError('Client ID is required'); return; }
    setConfiguring(true);
    setConfigError(null);

    // Use the current browser origin for the redirect URI — this matches however
    // the user is currently accessing the dojo (localhost, tunnel, custom domain).
    const callbackUri = `${window.location.origin}/api/microsoft/callback`;

    const result = await api.request<{ authUrl: string; redirectUri: string }>('/microsoft/configure', {
      method: 'POST',
      body: JSON.stringify({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        redirectUri: callbackUri,
      }),
    });

    if (result.ok) {
      // Open the Microsoft auth URL in the browser
      window.open(result.data.authUrl, '_blank');
      // Poll for connection
      const poll = setInterval(async () => {
        const s = await api.request<MsStatus>('/microsoft/status');
        if (s.ok && s.data.connected) {
          clearInterval(poll);
          setStatus(s.data);
          setConfiguring(false);
        }
      }, 3000);
      setTimeout(() => { clearInterval(poll); setConfiguring(false); }, 180000);
    } else {
      setConfigError(result.error);
      setConfiguring(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    await api.request('/microsoft/test', { method: 'POST' });
    await loadStatus();
    setTesting(false);
  };

  const handleDisconnect = async () => {
    await api.request('/microsoft/disconnect', { method: 'POST' });
    await loadStatus();
  };

  const handleServiceToggle = async (service: string, enabled: boolean) => {
    if (!status) return;
    const updated = { ...status.services, [service]: enabled };
    await api.request('/microsoft/services', { method: 'PUT', body: JSON.stringify(updated) });
    await loadStatus();
  };

  if (!status) return <p className="text-sm text-white/40">Loading...</p>;

  const serviceList = [
    { key: 'outlook', label: 'Outlook Email' },
    { key: 'calendar', label: 'Calendar' },
    { key: 'onedrive', label: 'OneDrive' },
    { key: 'teams', label: 'Teams', entraOnly: true },
  ];

  // Show the redirect URI based on how the user is currently accessing the dojo
  const redirectUri = `${window.location.origin}/api/microsoft/callback`;

  // ═══════════════════════════════════════
  // Connected — show management UI
  // ═══════════════════════════════════════
  if (status.connected) {
    return (
      <div className="space-y-6">
        <h3 className="text-sm font-semibold text-white/80 uppercase tracking-wider">Microsoft 365</h3>

        {/* Connection Status */}
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cp-teal animate-pulse" />
              <span className="text-sm text-white/70">
                Connected as <strong className="text-white">{status.email}</strong>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                status.accountType === 'entra'
                  ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                  : 'bg-white/[0.06] text-white/40'
              }`}>
                {status.accountType === 'entra' ? 'Work/School' : 'Personal'}
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cp-teal/10 text-cp-teal border border-cp-teal/20">Connected</span>
            </div>
          </div>

          {status.lastVerified && (
            <p className="text-xs text-white/30">Last verified: {new Date(status.lastVerified).toLocaleString()}</p>
          )}

          <div className="flex gap-2">
            <button onClick={handleTest} disabled={testing}
              className="glass-btn glass-btn-ghost text-xs">
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
            <button onClick={handleDisconnect}
              className="glass-btn glass-btn-ghost text-xs text-cp-coral hover:text-cp-coral">
              Disconnect
            </button>
          </div>
        </div>

        {/* Enabled Services */}
        <div className="glass-card p-4 space-y-3">
          <h4 className="text-sm font-medium text-white/70">Enabled Services</h4>
          <div className="grid grid-cols-2 gap-2">
            {serviceList.map(svc => {
              const isMsa = status.accountType === 'msa';
              const blocked = svc.entraOnly && isMsa;
              return (
                <div key={svc.key}>
                  <label className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                    blocked ? 'opacity-40 cursor-not-allowed' :
                    status.services[svc.key] ? 'bg-cp-teal/10 border border-cp-teal/30 cursor-pointer' : 'bg-white/[0.04] border border-white/[0.06] cursor-pointer'
                  }`}>
                    <input type="checkbox"
                      checked={!blocked && (status.services[svc.key] ?? true)}
                      onChange={(e) => !blocked && handleServiceToggle(svc.key, e.target.checked)}
                      disabled={blocked}
                      className="sr-only" />
                    <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] ${
                      !blocked && status.services[svc.key] ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/10 text-white/30'
                    }`}>
                      {!blocked && status.services[svc.key] ? '\u2713' : ''}
                    </span>
                    <span className="text-sm text-white/70">{svc.label}</span>
                  </label>
                  {blocked && (
                    <p className="text-[10px] text-cp-amber/70 mt-1 ml-1">Requires work/school account</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Activity Log */}
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-white/70">Microsoft Activity Log</h4>
            <button onClick={() => setShowActivity(!showActivity)}
              className="text-xs text-cp-teal hover:text-cp-teal/80">
              {showActivity ? 'Hide' : 'Show'} Activity
            </button>
          </div>
          <div className="flex gap-4 text-xs text-white/40">
            <span>Today: {status.todayActivity.reads} reads, {status.todayActivity.writes} writes</span>
            {status.lastActivity && <span>Last: {new Date(status.lastActivity).toLocaleString()}</span>}
          </div>
          {showActivity && <MicrosoftActivityLog />}
        </div>

        <div className="glass-card p-3 space-y-1">
          <p className="text-xs text-white/40">
            If you need to re-authenticate and your dojo URL has changed (e.g., tunnel URL changed), update the
            redirect URI in your{' '}
            <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Azure app registration</a>
            {' '}to match your current URL: <code className="bg-white/[0.05] px-1 rounded text-[10px]">{window.location.origin}/api/microsoft/callback</code>
          </p>
        </div>

        <div className="text-xs text-white/30">
          <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Azure App Registrations</a>
          {' | '}
          <a href="https://myaccount.microsoft.com/settingsandprivacy/privacy" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Manage Permissions</a>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════
  // Not connected — show setup flow
  // ═══════════════════════════════════════
  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold text-white/80 uppercase tracking-wider">Microsoft 365</h3>
      <p className="text-sm text-white/55">
        Connect a Microsoft account to let your agents read and send Outlook email, manage the calendar, use OneDrive, and send Teams messages.
      </p>

      {/* Step 1: Register Azure App */}
      <div className={`glass-card p-4 space-y-2 ${status.hasClientId ? 'opacity-60' : ''}`}>
        <div className="flex items-center gap-2">
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${status.hasClientId ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/[0.1] text-white/50'}`}>
            {status.hasClientId ? '\u2713' : '1'}
          </span>
          <span className="text-sm font-medium text-white/90">Register an Azure App</span>
        </div>

        {!status.hasClientId && (
          <div className="ml-7 space-y-3">
            <ol className="text-xs text-white/50 space-y-2 list-decimal list-inside">
              <li>
                <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer"
                  className="text-blue-400 hover:underline">Open Azure App Registrations</a>
                {' '}&gt; <strong className="text-white/70">New registration</strong>
              </li>
              <li>
                Name: <strong className="text-white/70">Agent DOJO</strong> (or anything you like)
              </li>
              <li>
                Supported account types: <strong className="text-white/70">Accounts in any organizational directory and personal Microsoft accounts</strong>
              </li>
              <li>
                Redirect URI: select <strong className="text-white/70">Web</strong> and enter:
                <code className="block mt-1 px-2 py-1 rounded bg-white/[0.05] font-mono text-[10px] text-white/60 select-all">{redirectUri}</code>
              </li>
              <li>
                Click <strong className="text-white/70">Register</strong>, then copy the <strong className="text-white/70">Application (client) ID</strong>
              </li>
              <li>
                Go to <strong className="text-white/70">Certificates & secrets</strong> &gt; <strong className="text-white/70">New client secret</strong> &gt; copy the <strong className="text-white/70">Value</strong>
              </li>
              <li>
                Go to <strong className="text-white/70">API permissions</strong> &gt; <strong className="text-white/70">Add a permission</strong> &gt; <strong className="text-white/70">Microsoft Graph</strong> &gt; <strong className="text-white/70">Delegated permissions</strong> &gt; add all of these:
                <span className="text-white/60 block mt-1">User.Read, Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, Files.ReadWrite.All, Sites.ReadWrite.All, Chat.ReadWrite, ChannelMessage.Send, Team.ReadBasic.All, Channel.ReadBasic.All, Notes.ReadWrite, Tasks.ReadWrite, Contacts.ReadWrite</span>
              </li>
            </ol>

            <div className="space-y-2">
              <div>
                <label className="block text-xs font-medium text-white/55 mb-1">Application (Client) ID</label>
                <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className="glass-input font-mono text-xs" />
              </div>
              <div>
                <label className="block text-xs font-medium text-white/55 mb-1">
                  Client Secret <span className="text-white/30 font-normal">(recommended)</span>
                </label>
                <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="Enter client secret value"
                  className="glass-input text-xs" />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Step 2: Connect */}
      <div className={`glass-card p-4 space-y-2 ${!status.hasClientId && !clientId.trim() ? 'opacity-40 pointer-events-none' : ''}`}>
        <div className="flex items-center gap-2">
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${status.connected ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/[0.1] text-white/50'}`}>
            {status.connected ? '\u2713' : '2'}
          </span>
          <span className="text-sm font-medium text-white/90">Connect Your Account</span>
        </div>
        <div className="ml-7 space-y-2">
          <p className="text-xs text-white/50">
            Click below to sign in with Microsoft. A browser window will open for you to approve access.
          </p>
          <button onClick={handleConfigure} disabled={configuring}
            className="glass-btn glass-btn-primary text-xs">
            {configuring ? 'Waiting for sign-in...' : 'Connect Microsoft Account'}
          </button>
          {configuring && (
            <div className="px-3 py-2 rounded-lg bg-cp-amber/10 border border-cp-amber/20 text-xs text-cp-amber animate-pulse">
              Complete the sign-in in your browser. This page will update automatically.
            </div>
          )}
        </div>
      </div>

      {configError && (
        <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">
          {configError}
        </div>
      )}

      <div className="text-xs text-white/30">
        <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Azure App Registrations</a>
        {' | '}
        <a href="https://learn.microsoft.com/en-us/graph/overview" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Microsoft Graph Docs</a>
      </div>
    </div>
  );
};
