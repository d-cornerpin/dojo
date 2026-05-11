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
  /** v2.5.5 — scopes the current build needs but the connected user hasn't granted. */
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

/** Map a raw scope URL to the human label of the service it unlocks.
 *  Returns null for OAuth identity scopes (openid, email, profile) — those
 *  aren't user-visible features, so we hide them from the reconnect banner. */
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
  return scope; // unknown scope — show the raw value for visibility
}

export const GoogleWorkspaceSettings = () => {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { loadStatus(); }, []);

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
    await api.request<{ working: boolean; email: string | null }>('/google/test', { method: 'POST' });
    await loadStatus();
    setTesting(false);
  };

  const handleToggleService = async (service: string, enabled: boolean) => {
    await api.request('/google/services', {
      method: 'PUT',
      body: JSON.stringify({ [service]: enabled }),
    });
    await loadStatus();
  };

  if (!status) return <div className="loading-state">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="glass-card p-4 space-y-4">
        <h3 className="card-header">Google Workspace</h3>

        {!status.connected ? (
          <div className="space-y-3">
            <p className="text-xs text-ui/40">
              Connect your Google account to give agents access to Gmail, Calendar, Drive, Docs, Sheets, Slides, and Forms.
            </p>
            {error && <div className="alert-banner alert-error">{error}</div>}
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="px-4 py-2 glass-btn-primary text-sm font-medium rounded-lg transition-colors w-full"
            >
              {connecting ? 'Waiting for sign-in...' : 'Sign in with Google'}
            </button>
            {connecting && (
              <p className="text-xs text-ui/25">
                Complete the sign-in in the browser window that opened. This page will update automatically.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* v2.5.5 — Missing-scopes banner: connected, but the build wants
                scopes the user hasn't granted yet (e.g. Forms scopes added
                after the user originally connected). */}
            {(() => {
              // Map missing scopes to user-visible labels, drop nulls
              // (identity scopes), and dedupe. Only render the banner if any
              // FEATURE-level scope is missing — identity-only diffs would
              // produce an empty list, in which case there's nothing actionable
              // to show.
              const labels = Array.from(new Set(
                (status.missingScopes ?? []).map(scopeLabel).filter((l): l is string => l !== null),
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
                    onClick={handleConnect}
                    disabled={connecting}
                    className="px-3 py-1.5 glass-btn-primary text-xs rounded-lg transition-colors shrink-0"
                  >
                    {connecting ? 'Waiting...' : 'Reconnect'}
                  </button>
                </div>
              );
            })()}

            {/* Connected status */}
            <div className="flex items-center gap-3">
              <span className="w-2 h-2 rounded-full bg-cp-teal animate-pulse shrink-0" />
              <div className="min-w-0">
                <p className="text-sm text-ui/70 truncate">{status.email}</p>
                <p className="text-xs text-ui/25">
                  {status.lastVerified ? `Verified ${new Date(status.lastVerified).toLocaleDateString()}` : 'Connected'}
                </p>
              </div>
            </div>

            {/* Activity summary */}
            {status.todayActivity && (status.todayActivity.reads > 0 || status.todayActivity.writes > 0) && (
              <div className="text-xs text-ui/25">
                Today: {status.todayActivity.reads} reads, {status.todayActivity.writes} writes
              </div>
            )}

            {/* Service toggles */}
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
                    checked={status.services[svc.key] ?? true}
                    onChange={(e) => handleToggleService(svc.key, e.target.checked)}
                    className="rounded border-ui/[0.15] bg-ui/[0.05] text-cp-amber focus:ring-cp-amber focus:ring-offset-0"
                  />
                </label>
              ))}
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2 flex-wrap">
              <button onClick={handleTest} disabled={testing}
                className="px-3 py-1.5 glass-btn-primary text-xs rounded-lg transition-colors">
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              <button onClick={() => setShowActivity(!showActivity)}
                className="px-3 py-1.5 bg-ui/[0.05] hover:bg-ui/[0.12] text-ui/55 text-xs rounded-lg transition-colors">
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

      {showActivity && <GoogleActivityLog />}
    </div>
  );
};
