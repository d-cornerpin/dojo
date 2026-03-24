import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import { GoogleActivityLog } from './GoogleActivityLog';

interface GoogleStatus {
  installed: boolean;
  gcloudInstalled: boolean;
  hasCredentials: boolean;
  version: string | null;
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
  const [testing, setTesting] = useState(false);
  const [showActivity, setShowActivity] = useState(false);

  // Setup flow states
  const [installingDeps, setInstallingDeps] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [gcloudLoggingIn, setGcloudLoggingIn] = useState(false);
  const [gcloudEmail, setGcloudEmail] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [credentialJson, setCredentialJson] = useState('');
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => { loadStatus(); }, []);

  const loadStatus = async () => {
    const data = await api.request<GoogleStatus>('/google/status');
    if (data.ok) {
      setStatus(data.data);
      // If gcloud is installed, check if it's authed
      if (data.data.gcloudInstalled) {
        const gcloudData = await api.request<{ loggedIn: boolean; email?: string; projectId?: string | null }>('/google/gcloud-status');
        if (gcloudData.ok && gcloudData.data.loggedIn) {
          setGcloudEmail(gcloudData.data.email ?? null);
          if (gcloudData.data.projectId) setProjectId(gcloudData.data.projectId);
        }
      }
    }
  };

  // Step 0: Install dependencies (gws + gcloud)
  const handleInstallDeps = async () => {
    setInstallingDeps(true);
    setInstallError(null);

    // Install gws
    const gwsResult = await api.request<{ installed: boolean }>('/setup/deps/install/gws', { method: 'POST' });
    if (!gwsResult.ok) {
      setInstallError(`gws CLI: ${gwsResult.error}`);
      setInstallingDeps(false);
      return;
    }

    // Install gcloud
    const gcloudResult = await api.request<{ installed: boolean }>('/setup/deps/install/gcloud', { method: 'POST' });
    if (!gcloudResult.ok) {
      setInstallError(`Google Cloud SDK: ${gcloudResult.error}`);
      setInstallingDeps(false);
      return;
    }

    setInstallingDeps(false);
    await loadStatus();
  };

  // Step 1: Sign in to Google Cloud
  const handleGcloudLogin = async () => {
    setGcloudLoggingIn(true);
    await api.request('/google/gcloud-login', { method: 'POST' });

    const timer = setInterval(async () => {
      const data = await api.request<{ loggedIn: boolean; email?: string; projectId?: string | null }>('/google/gcloud-status');
      if (data.ok && data.data.loggedIn) {
        const setup = await api.request<{ email: string; projectId: string }>('/google/gcloud-setup', { method: 'POST' });
        if (setup.ok) {
          setGcloudEmail(setup.data.email);
          setProjectId(setup.data.projectId);
          setGcloudLoggingIn(false);
          clearInterval(timer);
        }
      }
    }, 5000);
    setTimeout(() => { clearInterval(timer); setGcloudLoggingIn(false); }, 180000);
  };

  // Step 2: Upload credentials
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCredentialJson(reader.result as string); setCredentialError(null); };
    reader.readAsText(file);
  };

  const handleSaveCredentials = async () => {
    setSavingCredentials(true);
    setCredentialError(null);
    const result = await api.request<{ saved: boolean }>('/google/credentials', {
      method: 'POST',
      body: JSON.stringify({ clientSecret: credentialJson }),
    });
    if (result.ok) { await loadStatus(); } else { setCredentialError(result.error); }
    setSavingCredentials(false);
  };

  // Step 3: Authorize
  const handleSignIn = async () => {
    setSigningIn(true);
    setAuthError(null);
    const result = await api.request<{ message: string }>('/google/connect', { method: 'POST' });
    if (!result.ok) { setAuthError(result.error); setSigningIn(false); return; }

    const timer = setInterval(async () => {
      const data = await api.request<{ working: boolean; email: string | null }>('/google/test', { method: 'POST' });
      if (data.ok && data.data.working) {
        setSigningIn(false);
        clearInterval(timer);
        await loadStatus();
      }
    }, 3000);
    setTimeout(() => { clearInterval(timer); setSigningIn(false); }, 180000);
  };

  const handleTest = async () => {
    setTesting(true);
    await api.request('/google/test', { method: 'POST' });
    await loadStatus();
    setTesting(false);
  };

  const handleDisconnect = async () => {
    await api.request('/google/disconnect', { method: 'POST' });
    await loadStatus();
  };

  const handleServiceToggle = async (service: string, enabled: boolean) => {
    if (!status) return;
    const updated = { ...status.services, [service]: enabled };
    await api.request('/google/services', { method: 'PUT', body: JSON.stringify(updated) });
    await loadStatus();
  };

  if (!status) return <p className="text-sm text-white/40">Loading...</p>;

  const serviceList = [
    { key: 'gmail', label: 'Gmail' },
    { key: 'calendar', label: 'Calendar' },
    { key: 'drive', label: 'Drive' },
    { key: 'docs', label: 'Docs' },
    { key: 'sheets', label: 'Sheets' },
    { key: 'slides', label: 'Slides' },
  ];

  const depsInstalled = status.installed && status.gcloudInstalled;
  const step1Done = !!gcloudEmail && !!projectId;
  const step2Done = status.hasCredentials;
  const step3Done = status.connected;

  // ═══════════════════════════════════════
  // Already connected — show management UI
  // ═══════════════════════════════════════
  if (status.connected) {
    return (
      <div className="space-y-6">
        <h3 className="text-sm font-semibold text-white/80 uppercase tracking-wider">Google Workspace</h3>

        {/* Connection Status */}
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cp-teal animate-pulse" />
              <span className="text-sm text-white/70">
                Connected as <strong className="text-white">{status.email}</strong>
              </span>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-cp-teal/10 text-cp-teal border border-cp-teal/20">Connected</span>
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
          <div className="grid grid-cols-3 gap-2">
            {serviceList.map(svc => (
              <label key={svc.key}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                  status.services[svc.key] ? 'bg-cp-teal/10 border border-cp-teal/30' : 'bg-white/[0.04] border border-white/[0.06]'
                }`}>
                <input type="checkbox"
                  checked={status.services[svc.key] ?? true}
                  onChange={(e) => handleServiceToggle(svc.key, e.target.checked)}
                  className="sr-only" />
                <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] ${
                  status.services[svc.key] ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/10 text-white/30'
                }`}>
                  {status.services[svc.key] ? '\u2713' : ''}
                </span>
                <span className="text-sm text-white/70">{svc.label}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-white/30">Unchecked services will not have tools available to any agent.</p>
        </div>

        {/* Activity Log */}
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-white/70">Google Activity Log</h4>
            <button onClick={() => setShowActivity(!showActivity)}
              className="text-xs text-cp-teal hover:text-cp-teal/80">
              {showActivity ? 'Hide' : 'Show'} Activity
            </button>
          </div>
          <div className="flex gap-4 text-xs text-white/40">
            <span>Today: {status.todayActivity.reads} reads, {status.todayActivity.writes} writes</span>
            {status.lastActivity && (
              <span>Last action: {new Date(status.lastActivity).toLocaleString()}</span>
            )}
          </div>
          {showActivity && <GoogleActivityLog />}
        </div>

        {/* Help Links */}
        <div className="text-xs text-white/30 space-y-1">
          <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
            Google Cloud Console
          </a>
          {' | '}
          <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
            Manage OAuth Permissions
          </a>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════
  // Not connected — show setup flow
  // ═══════════════════════════════════════
  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold text-white/80 uppercase tracking-wider">Google Workspace</h3>
      <p className="text-sm text-white/55">
        Connect a Google account to let your agents read and manage Gmail, Calendar, Drive, Docs, Sheets, and Slides.
        Your primary agent gets full access; other agents get read-only.
      </p>

      {/* Step 0: Install dependencies */}
      <div className="glass-card p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${depsInstalled ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/[0.1] text-white/50'}`}>
            {depsInstalled ? '\u2713' : '1'}
          </span>
          <span className="text-sm font-medium text-white/90">Install Dependencies</span>
          {depsInstalled && <span className="text-xs text-white/40">(gws CLI + Google Cloud SDK)</span>}
        </div>
        {!depsInstalled && (
          <div className="ml-7 space-y-2">
            <p className="text-xs text-white/50">Installs the Google Workspace CLI and Google Cloud SDK. This may take a couple of minutes.</p>
            <button onClick={handleInstallDeps} disabled={installingDeps}
              className="glass-btn glass-btn-primary text-xs">
              {installingDeps ? 'Installing...' : 'Install Google Dependencies'}
            </button>
            {installingDeps && (
              <div className="px-3 py-2 rounded-lg bg-cp-amber/10 border border-cp-amber/20 text-xs text-cp-amber animate-pulse">
                Installing dependencies... this may take a few minutes.
              </div>
            )}
            {installError && <p className="text-xs text-cp-coral">{installError}</p>}
          </div>
        )}
      </div>

      {/* Step 1: Sign in to Google Cloud */}
      <div className={`glass-card p-4 space-y-2 ${!depsInstalled ? 'opacity-40 pointer-events-none' : ''}`}>
        <div className="flex items-center gap-2">
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${step1Done ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/[0.1] text-white/50'}`}>
            {step1Done ? '\u2713' : '2'}
          </span>
          <span className="text-sm font-medium text-white/90">Sign in to Google Cloud</span>
          {step1Done && <span className="text-xs text-white/40">({gcloudEmail})</span>}
        </div>
        {!step1Done && depsInstalled && (
          <div className="ml-7 space-y-2">
            <p className="text-xs text-white/50">Opens your browser to sign in with your Google account.</p>
            <button onClick={handleGcloudLogin} disabled={gcloudLoggingIn}
              className="glass-btn glass-btn-primary text-xs">
              {gcloudLoggingIn ? 'Working...' : 'Sign in with Google'}
            </button>
            {gcloudLoggingIn && (
              <div className="px-3 py-3 rounded-lg bg-cp-amber/10 border border-cp-amber/20 text-xs space-y-2">
                <div className="flex items-center gap-2">
                  <span className="animate-spin text-cp-amber">{'\u{1F504}'}</span>
                  <span className="text-cp-amber font-medium">Setting up your Google Cloud connection...</span>
                </div>
                <p className="text-white/40">A browser window should open for you to sign in. After you approve, this page needs to configure your project and enable APIs. <strong className="text-white/50">This can take up to a minute</strong> — please don't navigate away.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 2: Create OAuth credentials */}
      <div className={`glass-card p-4 space-y-2 ${!step1Done ? 'opacity-40 pointer-events-none' : ''}`}>
        <div className="flex items-center gap-2">
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${step2Done ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/[0.1] text-white/50'}`}>
            {step2Done ? '\u2713' : '3'}
          </span>
          <span className="text-sm font-medium text-white/90">Create OAuth Credentials</span>
        </div>
        {!step2Done && step1Done && (
          <div className="ml-7 space-y-3">
            <ol className="text-xs text-white/50 space-y-2 list-decimal list-inside">
              <li>
                <a href={`https://console.cloud.google.com/apis/credentials/consent?project=${projectId}`} target="_blank" rel="noopener noreferrer"
                  className="text-blue-400 hover:underline">Open the OAuth consent screen</a>
                {' '}&mdash; click <strong className="text-white/70">Get Started</strong>, enter an app name (e.g. "Agent DOJO") and your email as support email, click <strong className="text-white/70">Next</strong>
              </li>
              <li>
                Select <strong className="text-white/70">External</strong> for audience, click <strong className="text-white/70">Next</strong>
              </li>
              <li>
                Enter your email as the contact address, agree to the data policy, click <strong className="text-white/70">Create</strong>
              </li>
              <li>
                <strong className="text-white/70">Add yourself as a test user:</strong> Go to{' '}
                <a href={`https://console.cloud.google.com/apis/credentials/consent?project=${projectId}`} target="_blank" rel="noopener noreferrer"
                  className="text-blue-400 hover:underline">OAuth consent screen</a>
                {' '}&gt; <strong className="text-white/70">Audience</strong> &gt; <strong className="text-white/70">Add users</strong> &gt; enter your Google email &gt; <strong className="text-white/70">Save</strong>
              </li>
              <li>
                <a href={`https://console.cloud.google.com/apis/credentials?project=${projectId}`} target="_blank" rel="noopener noreferrer"
                  className="text-blue-400 hover:underline">Go to Credentials</a>
                {' '}&mdash; click <strong className="text-white/70">Create Credentials</strong> &gt; <strong className="text-white/70">OAuth client ID</strong>
              </li>
              <li>
                Choose <strong className="text-white/70">Desktop app</strong>, give it a name (e.g. "DOJO"), click <strong className="text-white/70">Create</strong>
              </li>
              <li>
                On the confirmation dialog, click <strong className="text-white/70">Download JSON</strong> and upload it below
              </li>
            </ol>

            <p className="text-[10px] text-white/30">
              Note: Google says credentials may take up to 5 minutes to take effect. If step 4 fails, wait a moment and try again.
            </p>

            <div className="space-y-2">
              <div className="flex gap-2">
                <label className="flex-1 flex items-center justify-center px-3 py-2 rounded-lg border border-dashed border-white/[0.15] hover:border-white/[0.25] cursor-pointer transition-colors">
                  <input type="file" accept=".json" onChange={handleFileUpload} className="sr-only" />
                  <span className="text-xs text-white/40">
                    {credentialJson ? 'File loaded \u2713 — click Save' : 'Upload client_secret.json'}
                  </span>
                </label>
                <button onClick={handleSaveCredentials}
                  disabled={!credentialJson || savingCredentials}
                  className="px-3 py-2 glass-btn glass-btn-primary text-xs shrink-0 disabled:opacity-30">
                  {savingCredentials ? 'Saving...' : 'Save'}
                </button>
              </div>
              {credentialError && <p className="text-xs text-cp-coral">{credentialError}</p>}
            </div>
          </div>
        )}
      </div>

      {/* Step 3: Authorize access */}
      <div className={`glass-card p-4 space-y-2 ${!step2Done ? 'opacity-40 pointer-events-none' : ''}`}>
        <div className="flex items-center gap-2">
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${step3Done ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/[0.1] text-white/50'}`}>
            {step3Done ? '\u2713' : '4'}
          </span>
          <span className="text-sm font-medium text-white/90">Authorize Access</span>
        </div>
        {!step3Done && step2Done && (
          <div className="ml-7 space-y-2">
            <p className="text-xs text-white/50">Opens your browser to grant Gmail, Calendar, Drive, Docs, Sheets, and Slides access.</p>
            <button onClick={handleSignIn} disabled={signingIn}
              className="glass-btn glass-btn-primary text-xs">
              {signingIn ? 'Waiting for authorization...' : 'Authorize Google Workspace'}
            </button>
            {signingIn && (
              <div className="px-3 py-2 rounded-lg bg-cp-amber/10 border border-cp-amber/20 text-xs text-cp-amber animate-pulse">
                Approve the permissions in your browser. This page will update automatically.
              </div>
            )}
            {authError && <p className="text-xs text-cp-coral">{authError}</p>}
          </div>
        )}
      </div>

      {/* Help Links */}
      <div className="text-xs text-white/30 space-y-1">
        <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
          Google Cloud Console
        </a>
        {' | '}
        <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
          Manage OAuth Permissions
        </a>
      </div>
    </div>
  );
};
