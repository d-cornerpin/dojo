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
  officeTools: { status: 'not_installed' | 'installing' | 'installed' | 'failed'; error: string | null };
}

const serviceList = [
  { key: 'outlook', label: 'Outlook Email', desc: 'Read and send emails' },
  { key: 'calendar', label: 'Calendar', desc: 'View and create events' },
  { key: 'onedrive', label: 'OneDrive', desc: 'List, read, and upload files' },
  { key: 'teams', label: 'Teams', desc: 'Send messages', entraOnly: true },
];

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
    const redirectUri = 'http://localhost:3001/api/microsoft/callback';
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
    if (!confirm('Disconnect Microsoft 365? Your agents will lose access to Outlook, Calendar, OneDrive, and Teams.')) return;
    await api.request('/microsoft/disconnect', { method: 'POST' });
    await loadStatus();
  };

  const handleServiceToggle = async (service: string, enabled: boolean) => {
    if (!status) return;
    const updated = { ...status.services, [service]: enabled };
    await api.request('/microsoft/services', { method: 'PUT', body: JSON.stringify(updated) });
    await loadStatus();
  };

  const handleInstallOffice = async () => {
    await api.request('/microsoft/install-office-tools', { method: 'POST' });
    setTimeout(loadStatus, 5000);
  };

  if (!status) return <div className="loading-state">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="glass-card p-4 space-y-4">
        <h3 className="card-header">Microsoft 365</h3>

        {!status.connected ? (
          <div className="space-y-3">
            <p className="text-xs text-white/40">
              Connect your Microsoft account to give agents access to Outlook, Calendar, OneDrive, and Teams.
            </p>
            {error && <div className="alert-banner alert-error">{error}</div>}
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="px-4 py-2 glass-btn-blue text-sm font-medium rounded-lg transition-colors w-full"
            >
              {connecting ? 'Waiting for sign-in...' : 'Sign in with Microsoft'}
            </button>
            {connecting && (
              <p className="text-xs text-white/30">
                Complete the sign-in in your browser. This page will update automatically.
              </p>
            )}
            <p className="text-[10px] text-white/25">
              For work/school accounts: if you see "Need admin approval", your organization's admin needs to approve the app once.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Connected status */}
            <div className="flex items-center gap-3">
              <span className="w-2 h-2 rounded-full bg-cp-teal animate-pulse shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white/80 truncate">{status.email}</p>
                <p className="text-xs text-white/30">
                  {status.accountType === 'entra' ? 'Work/School' : 'Personal'}
                  {status.lastVerified && ` · Verified ${new Date(status.lastVerified).toLocaleDateString()}`}
                </p>
              </div>
            </div>

            {/* Activity summary */}
            {status.todayActivity && (status.todayActivity.reads > 0 || status.todayActivity.writes > 0) && (
              <div className="text-xs text-white/30">
                Today: {status.todayActivity.reads} reads, {status.todayActivity.writes} writes
              </div>
            )}

            {/* Service toggles */}
            <div className="space-y-1">
              <p className="form-label">Services</p>
              {serviceList.map(svc => {
                const blocked = svc.entraOnly && status.accountType === 'msa';
                return (
                  <label key={svc.key} className={`flex items-center justify-between py-1.5 ${blocked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                    <div>
                      <span className="text-sm text-white/70">{svc.label}</span>
                      <span className="text-xs text-white/30 ml-2">{svc.desc}</span>
                      {blocked && <span className="text-[10px] text-cp-amber/70 ml-2">(work/school only)</span>}
                    </div>
                    <input
                      type="checkbox"
                      checked={!blocked && (status.services[svc.key] ?? true)}
                      onChange={(e) => !blocked && handleServiceToggle(svc.key, e.target.checked)}
                      disabled={blocked}
                      className="rounded border-white/20 bg-white/5 text-cp-amber focus:ring-cp-amber focus:ring-offset-0"
                    />
                  </label>
                );
              })}
            </div>

            {/* Office Document Tools */}
            <div className="border-t border-white/[0.06] pt-3">
              <div className="flex items-center justify-between mb-1">
                <p className="form-label mb-0">Office Document Tools</p>
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                  status.officeTools.status === 'installed' ? 'bg-cp-teal/10 text-cp-teal' :
                  status.officeTools.status === 'installing' ? 'bg-cp-amber/10 text-cp-amber' :
                  status.officeTools.status === 'failed' ? 'bg-cp-coral/10 text-cp-coral' :
                  'bg-white/[0.06] text-white/40'
                }`}>
                  {status.officeTools.status === 'installed' ? 'Ready' :
                   status.officeTools.status === 'installing' ? 'Installing...' :
                   status.officeTools.status === 'failed' ? 'Failed' : 'Not installed'}
                </span>
              </div>
              <p className="text-xs text-white/30 mb-2">
                Word, Excel, and PowerPoint document creation.
              </p>
              {status.officeTools.status === 'failed' && status.officeTools.error && (
                <p className="text-xs text-cp-coral mb-2">{status.officeTools.error}</p>
              )}
              {(status.officeTools.status === 'not_installed' || status.officeTools.status === 'failed') && (
                <button onClick={handleInstallOffice}
                  className="px-3 py-1.5 glass-btn-blue text-xs rounded-lg transition-colors">
                  {status.officeTools.status === 'failed' ? 'Retry Install' : 'Install'}
                </button>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2 flex-wrap">
              <button onClick={handleTest} disabled={testing}
                className="px-3 py-1.5 glass-btn-blue text-xs rounded-lg transition-colors">
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              <button onClick={() => setShowActivity(!showActivity)}
                className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/60 text-xs rounded-lg transition-colors">
                {showActivity ? 'Hide Activity' : 'Activity Log'}
              </button>
              <button onClick={handleDisconnect}
                className="px-3 py-1.5 bg-cp-coral/10 hover:bg-cp-coral/20 text-cp-coral text-xs rounded-lg transition-colors ml-auto">
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>

      {showActivity && <MicrosoftActivityLog />}
    </div>
  );
};
