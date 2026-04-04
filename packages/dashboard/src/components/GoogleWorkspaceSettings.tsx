import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import { GoogleActivityLog } from './GoogleActivityLog';

interface GoogleStatus {
  enabled: boolean;
  connected: boolean;
  email: string | null;
  services: Record<string, boolean>;
  lastVerified: string | null;
  lastActivity: string | null;
  todayActivity: { reads: number; writes: number };
}

export const GoogleWorkspaceSettings = () => {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { loadStatus(); }, []);

  // Poll status while connecting (user is in browser doing OAuth)
  useEffect(() => {
    if (!connecting) return;
    const interval = setInterval(async () => {
      const data = await api.request<GoogleStatus>('/google/status');
      if (data.ok && data.data.connected) {
        setStatus(data.data);
        setConnecting(false);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [connecting]);

  const loadStatus = async () => {
    const data = await api.request<GoogleStatus>('/google/status');
    if (data.ok) setStatus(data.data);
  };

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    const result = await api.request<{ authUrl: string }>('/google/connect', { method: 'POST' });
    if (result.ok) {
      window.open(result.data.authUrl, '_blank', 'width=600,height=700');
    } else {
      setError(result.error);
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Google Workspace? Your agents will lose access to Gmail, Calendar, and Drive.')) return;
    await api.request('/google/disconnect', { method: 'POST' });
    await loadStatus();
  };

  const handleTest = async () => {
    setTesting(true);
    const result = await api.request<{ working: boolean; email: string | null }>('/google/test', { method: 'POST' });
    if (result.ok) {
      await loadStatus();
    }
    setTesting(false);
  };

  const handleToggleService = async (service: string, enabled: boolean) => {
    await api.request('/google/services', {
      method: 'PUT',
      body: JSON.stringify({ [service]: enabled }),
    });
    await loadStatus();
  };

  if (!status) {
    return <div className="text-white/40 py-8 text-center text-sm">Loading Google Workspace settings...</div>;
  }

  const services = [
    { key: 'gmail', label: 'Gmail', desc: 'Search, read, and send emails' },
    { key: 'calendar', label: 'Calendar', desc: 'View and create events' },
    { key: 'drive', label: 'Drive', desc: 'List, read, and upload files' },
    { key: 'docs', label: 'Docs', desc: 'Read and create documents' },
    { key: 'sheets', label: 'Sheets', desc: 'Read and write spreadsheets' },
    { key: 'slides', label: 'Slides', desc: 'Create presentations' },
  ];

  return (
    <div className="space-y-6 max-w-lg">
      <div className="bg-white/[0.03] border border-white/10 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-bold text-white/90">Google Workspace</h3>

        {!status.connected ? (
          <div className="space-y-3">
            <p className="text-xs text-white/40">
              Connect your Google account to give your agents access to Gmail, Calendar, Drive, Docs, Sheets, and Slides.
            </p>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {connecting ? 'Waiting for sign-in...' : 'Sign in with Google'}
            </button>
            {connecting && (
              <p className="text-xs text-white/30">
                Complete the sign-in in the browser window that opened. This page will update automatically.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Connected status */}
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                <span className="text-green-400 text-sm">&#x2713;</span>
              </div>
              <div>
                <p className="text-sm text-white/80">{status.email}</p>
                <p className="text-xs text-white/30">
                  {status.lastVerified ? `Verified ${new Date(status.lastVerified).toLocaleDateString()}` : 'Connected'}
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
            <div className="space-y-2">
              <p className="text-xs text-white/50 font-medium">Services</p>
              {services.map(svc => (
                <label key={svc.key} className="flex items-center justify-between py-1.5">
                  <div>
                    <span className="text-sm text-white/70">{svc.label}</span>
                    <span className="text-xs text-white/30 ml-2">{svc.desc}</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={status.services[svc.key] ?? true}
                    onChange={(e) => handleToggleService(svc.key, e.target.checked)}
                    className="rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                  />
                </label>
              ))}
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <button
                onClick={handleTest}
                disabled={testing}
                className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/60 text-xs rounded-lg transition-colors"
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              <button
                onClick={() => setShowActivity(!showActivity)}
                className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/60 text-xs rounded-lg transition-colors"
              >
                {showActivity ? 'Hide Activity' : 'Activity Log'}
              </button>
              <button
                onClick={handleDisconnect}
                className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs rounded-lg transition-colors ml-auto"
              >
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>

      {showActivity && <GoogleActivityLog />}
    </div>
  );
};
