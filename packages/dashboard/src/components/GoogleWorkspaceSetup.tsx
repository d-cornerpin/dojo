import { useState, useEffect, useRef } from 'react';

const TOKEN = () => localStorage.getItem('dojo_token');

const fetchApi = async (path: string, opts?: RequestInit) => {
  const token = TOKEN();
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
  });
  return res.json();
};

export const GoogleWorkspaceSetup = () => {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [authStarted, setAuthStarted] = useState(false);
  const [services, setServices] = useState({
    gmail: true, calendar: true, drive: true, docs: true, sheets: true, slides: true,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    checkInstalled();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const checkInstalled = async () => {
    const data = await fetchApi('/api/google/install-check');
    if (data.ok) {
      setInstalled(data.data.installed);
      setVersion(data.data.version);
    }
    // Also check if already connected
    const status = await fetchApi('/api/google/status');
    if (status.ok && status.data.connected) {
      setConnected(true);
      setEmail(status.data.email);
      if (status.data.services) setServices(status.data.services);
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    // Installation is a global npm install — trigger via the deps endpoint or exec
    try {
      const res = await fetchApi('/api/setup/deps/install', {
        method: 'POST',
        body: JSON.stringify({ package: '@googleworkspace/cli', global: true }),
      });
      // Re-check after a delay
      setTimeout(async () => {
        await checkInstalled();
        setInstalling(false);
      }, 5000);
    } catch {
      setInstalling(false);
    }
  };

  const handleConnect = async () => {
    setAuthStarted(true);
    await fetchApi('/api/google/connect', { method: 'POST' });

    // Poll for connection status every 2 seconds
    pollRef.current = setInterval(async () => {
      const data = await fetchApi('/api/google/test', { method: 'POST' });
      if (data.ok && data.data.working) {
        setConnected(true);
        setEmail(data.data.email);
        setAuthStarted(false);
        if (pollRef.current) clearInterval(pollRef.current);
      }
    }, 2000);

    // Stop polling after 2 minutes
    setTimeout(() => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setAuthStarted(false);
      }
    }, 120000);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    const data = await fetchApi('/api/google/test', { method: 'POST' });
    if (data.ok) {
      setConnected(data.data.working);
      setEmail(data.data.email);
    }
    setTesting(false);
  };

  const handleServiceToggle = async (service: string, enabled: boolean) => {
    const updated = { ...services, [service]: enabled };
    setServices(updated);
    await fetchApi('/api/google/services', { method: 'PUT', body: JSON.stringify(updated) });
  };

  const serviceList = [
    { key: 'gmail', label: 'Gmail', icon: '\u2709' },
    { key: 'calendar', label: 'Calendar', icon: '\uD83D\uDCC5' },
    { key: 'drive', label: 'Drive', icon: '\uD83D\uDCC1' },
    { key: 'docs', label: 'Docs', icon: '\uD83D\uDCC4' },
    { key: 'sheets', label: 'Sheets', icon: '\uD83D\uDCCA' },
    { key: 'slides', label: 'Slides', icon: '\uD83C\uDFA8' },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-white/55">
        Give your agents access to Gmail, Calendar, Drive, Docs, Sheets, and more.
        This step is optional — you can connect Google Workspace later from Settings.
      </p>

      {/* Section 1: Install gws CLI */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-white/80">1. Google Workspace CLI</h3>
        {installed === null ? (
          <p className="text-sm text-white/40">Checking...</p>
        ) : installed ? (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cp-teal" />
            <span className="text-sm text-white/70">Installed{version ? ` (${version})` : ''}</span>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-white/40">The gws CLI is required for Google Workspace integration.</p>
            <button
              onClick={handleInstall}
              disabled={installing}
              className="glass-btn glass-btn-primary text-sm"
            >
              {installing ? 'Installing...' : 'Install gws CLI'}
            </button>
          </div>
        )}
      </div>

      {/* Section 2: Sign In */}
      {installed && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-white/80">2. Sign in with Google</h3>
          {connected ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-cp-teal animate-pulse" />
                <span className="text-sm text-white/70">Connected as <strong className="text-white">{email}</strong></span>
              </div>
              <button onClick={handleTestConnection} disabled={testing}
                className="glass-btn glass-btn-ghost text-xs">
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-white/40">
                Sign in with your Google account to grant access. This opens a browser window for OAuth consent.
              </p>
              <button onClick={handleConnect} disabled={authStarted}
                className="glass-btn glass-btn-primary text-sm">
                {authStarted ? 'Waiting for sign-in...' : 'Sign in with Google'}
              </button>
              {authStarted && (
                <p className="text-xs text-cp-amber">Complete the sign-in in your browser. This page will update automatically.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Section 3: Choose Services */}
      {connected && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-white/80">3. Enabled Services</h3>
          <div className="grid grid-cols-3 gap-2">
            {serviceList.map(svc => (
              <label key={svc.key}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                  services[svc.key as keyof typeof services] ? 'bg-cp-teal/10 border border-cp-teal/30' : 'bg-white/[0.04] border border-white/[0.06]'
                }`}>
                <input type="checkbox"
                  checked={services[svc.key as keyof typeof services]}
                  onChange={(e) => handleServiceToggle(svc.key, e.target.checked)}
                  className="sr-only" />
                <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] ${
                  services[svc.key as keyof typeof services] ? 'bg-cp-teal text-[#0B0F1A]' : 'bg-white/10 text-white/30'
                }`}>
                  {services[svc.key as keyof typeof services] ? '\u2713' : ''}
                </span>
                <span className="text-sm text-white/70">{svc.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Skip notice */}
      {!connected && (
        <p className="text-xs text-white/30 text-center mt-4">
          Skip this step to continue without Google Workspace. You can connect later in Settings.
        </p>
      )}
    </div>
  );
};
