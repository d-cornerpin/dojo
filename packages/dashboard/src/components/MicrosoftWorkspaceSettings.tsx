import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import { MicrosoftActivityLog } from './MicrosoftActivityLog';

interface MsStatus {
  clientId: string;
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
  const [connecting, setConnecting] = useState(false);
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

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);

    const redirectUri = `${window.location.origin}/api/microsoft/callback`;
    const result = await api.request<{ authUrl: string }>('/microsoft/connect', {
      method: 'POST',
      body: JSON.stringify({ redirectUri }),
    });

    if (result.ok) {
      window.open(result.data.authUrl, '_blank');
      const poll = setInterval(async () => {
        const s = await api.request<MsStatus>('/microsoft/status');
        if (s.ok && s.data.connected) {
          clearInterval(poll);
          setStatus(s.data);
          setConnecting(false);
        }
      }, 3000);
      setTimeout(() => { clearInterval(poll); setConnecting(false); }, 180000);
    } else {
      setError(result.error);
      setConnecting(false);
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

  // ═══════════════════════════════════════
  // Connected
  // ═══════════════════════════════════════
  if (status.connected) {
    return (
      <div className="space-y-6">
        <h3 className="text-sm font-semibold text-white/80 uppercase tracking-wider">Microsoft 365</h3>

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
                status.accountType === 'entra' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' : 'bg-white/[0.06] text-white/40'
              }`}>
                {status.accountType === 'entra' ? 'Work/School' : 'Personal'}
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cp-teal/10 text-cp-teal border border-cp-teal/20">Connected</span>
            </div>
          </div>
          {status.lastVerified && <p className="text-xs text-white/30">Last verified: {new Date(status.lastVerified).toLocaleString()}</p>}
          <div className="flex gap-2">
            <button onClick={handleTest} disabled={testing} className="glass-btn glass-btn-ghost text-xs">
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
            <button onClick={handleDisconnect} className="glass-btn glass-btn-ghost text-xs text-cp-coral hover:text-cp-coral">
              Disconnect
            </button>
          </div>
        </div>

        <div className="glass-card p-4 space-y-3">
          <h4 className="text-sm font-medium text-white/70">Enabled Services</h4>
          <div className="grid grid-cols-2 gap-2">
            {serviceList.map(svc => {
              const blocked = svc.entraOnly && status.accountType === 'msa';
              return (
                <div key={svc.key}>
                  <label className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                    blocked ? 'opacity-40 cursor-not-allowed' :
                    status.services[svc.key] ? 'bg-cp-teal/10 border border-cp-teal/30 cursor-pointer' : 'bg-white/[0.04] border border-white/[0.06] cursor-pointer'
                  }`}>
                    <input type="checkbox" checked={!blocked && (status.services[svc.key] ?? true)}
                      onChange={(e) => !blocked && handleServiceToggle(svc.key, e.target.checked)}
                      disabled={blocked} className="sr-only" />
                    <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] ${
                      !blocked && status.services[svc.key] ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/10 text-white/30'
                    }`}>{!blocked && status.services[svc.key] ? '\u2713' : ''}</span>
                    <span className="text-sm text-white/70">{svc.label}</span>
                  </label>
                  {blocked && <p className="text-[10px] text-cp-amber/70 mt-1 ml-1">Requires work/school account</p>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-white/70">Microsoft Activity Log</h4>
            <button onClick={() => setShowActivity(!showActivity)} className="text-xs text-cp-teal hover:text-cp-teal/80">
              {showActivity ? 'Hide' : 'Show'} Activity
            </button>
          </div>
          <div className="flex gap-4 text-xs text-white/40">
            <span>Today: {status.todayActivity.reads} reads, {status.todayActivity.writes} writes</span>
            {status.lastActivity && <span>Last: {new Date(status.lastActivity).toLocaleString()}</span>}
          </div>
          {showActivity && <MicrosoftActivityLog />}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════
  // Not connected — single button
  // ═══════════════════════════════════════
  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold text-white/80 uppercase tracking-wider">Microsoft 365</h3>
      <p className="text-sm text-white/55">
        Connect a Microsoft account to let your agents read and send Outlook email, manage the calendar, use OneDrive, and send Teams messages. Works with both personal and work/school accounts.
      </p>

      <div className="glass-card p-4 space-y-3">
        <button onClick={handleConnect} disabled={connecting} className="glass-btn glass-btn-primary text-sm w-full">
          {connecting ? 'Waiting for sign-in...' : 'Sign in with Microsoft'}
        </button>

        {connecting && (
          <div className="px-3 py-2 rounded-lg bg-cp-amber/10 border border-cp-amber/20 text-xs text-cp-amber animate-pulse">
            Complete the sign-in in your browser. This page will update automatically.
          </div>
        )}

        <p className="text-[10px] text-white/30">
          For work/school accounts: if you see "Need admin approval", your organization's admin needs to approve the app once.
          Ask them to visit the admin consent link, or sign in with an admin account first.
        </p>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{error}</div>
      )}
    </div>
  );
};
