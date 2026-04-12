import { useState, type FormEvent } from 'react';

export const MigrationExport = () => {
  const [showModal, setShowModal] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [exporting, setExporting] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const handleExport = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setExporting(true);
    setStage('Exporting... this may take a moment.');

    try {
      const token = localStorage.getItem('dojo_token');
      const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
      const csrf = csrfMatch ? csrfMatch[1] : null;

      const res = await fetch('/api/migration/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Export failed' }));
        throw new Error(data.error || 'Export failed');
      }

      // Download the file
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date().toISOString().split('T')[0];
      a.download = `dojo-export-${date}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setShowModal(false);
      setPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="px-4 py-2 glass-btn-blue text-sm font-medium rounded-lg transition-colors"
      >
        Export Dojo
      </button>

      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#1a1a2e] border border-white/10 rounded-xl p-6 max-w-md w-full shadow-2xl">
            <h2 className="text-lg font-bold text-white mb-2">Export Your Dojo</h2>
            <p className="text-white/55 text-sm mb-4">
              This will create an encrypted backup of your entire dojo: all agents, settings, vault,
              techniques, and configuration. You&apos;ll need the password to import on another machine.
            </p>

            {!exporting ? (
              <form onSubmit={handleExport} className="space-y-4">
                <div>
                  <label className="block text-sm text-white/70 mb-1">Encryption Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm text-white/70 mb-1">Confirm Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter password"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setShowDetails(!showDetails)}
                  className="text-xs text-white/40 hover:text-white/60 transition-colors"
                >
                  {showDetails ? '▾' : '▸'} What&apos;s included
                </button>

                {showDetails && (
                  <div className="text-xs text-white/40 bg-white/[0.03] rounded-lg p-3 space-y-1">
                    <p>• All agents, their personalities, and configurations</p>
                    <p>• All vault entries and conversation archives</p>
                    <p>• All techniques and their files</p>
                    <p>• API keys and provider settings (encrypted)</p>
                    <p>• Google Workspace auth tokens (if connected)</p>
                    <p>• iMessage, remote access, and all other settings</p>
                    <p className="text-white/25 mt-2">Excludes: logs, Ollama model weights, node_modules</p>
                  </div>
                )}

                {error && (
                  <p className="text-red-400 text-sm">{error}</p>
                )}

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => { setShowModal(false); setPassword(''); setConfirmPassword(''); setError(null); }}
                    className="flex-1 px-4 py-2 bg-white/5 hover:bg-white/10 text-white/70 text-sm rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!password || !confirmPassword}
                    className="flex-1 px-4 py-2 glass-btn-blue disabled:cursor-not-allowed text-sm font-medium rounded-lg transition-colors"
                  >
                    Export
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="relative h-2 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 bg-blue-500 rounded-full transition-all duration-300 animate-pulse"
                    style={{ width: '60%' }}
                  />
                </div>
                <p className="text-sm text-white/55 text-center">{stage}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
