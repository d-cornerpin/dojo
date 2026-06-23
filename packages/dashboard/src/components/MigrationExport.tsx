import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

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
        type="button"
        onClick={() => setShowModal(true)}
        className="btn btn--primary"
      >
        Export Dojo
      </button>

      {/* Portaled out of the settings cards: they sit inside a CSS multi-column
          container (.scards), which establishes a stacking context the modal
          would otherwise be trapped under — landing it behind the Server panel.
          Target the .dojo3-stage element (not <body>): it escapes .scards while
          staying inside the stage's scope, so the champagne theme overrides
          (.dojo3-stage .fixed.inset-0 .glass-modal-bg) still apply and the modal
          stays readable. The stage has no transform/filter, so `fixed inset-0`
          still resolves to the viewport. Falls back to <body> if no stage. */}
      {showModal && createPortal(
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] p-4">
          <div className="glass-modal-bg rounded-xl p-6 max-w-md w-full">
            <h2 className="text-lg font-bold text-ui mb-2">Export Your Dojo</h2>
            <p className="text-ui/55 text-sm mb-4">
              This will create an encrypted backup of your entire dojo: all agents, settings, vault,
              techniques, and configuration. You&apos;ll need the password to import on another machine.
            </p>

            {!exporting ? (
              <form onSubmit={handleExport} className="space-y-4">
                <div>
                  <label className="block text-sm text-ui/70 mb-1">Encryption Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    className="glass-input"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm text-ui/70 mb-1">Confirm Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter password"
                    className="glass-input"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setShowDetails(!showDetails)}
                  className="text-xs text-ui/40 hover:text-ui/55 transition-colors"
                >
                  {showDetails ? '▾' : '▸'} What&apos;s included
                </button>

                {showDetails && (
                  <div className="text-xs text-ui/40 bg-ui/[0.03] rounded-lg p-3 space-y-1">
                    <p>• All agents, their personalities, and configurations</p>
                    <p>• All vault entries and conversation archives</p>
                    <p>• All techniques and their files</p>
                    <p>• API keys and provider settings (encrypted)</p>
                    <p>• Google Workspace auth tokens (if connected)</p>
                    <p>• iMessage, remote access, and all other settings</p>
                    <p className="text-ui/25 mt-2">Excludes: logs, Ollama model weights, node_modules</p>
                  </div>
                )}

                {error && (
                  <p className="text-cp-coral text-sm">{error}</p>
                )}

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => { setShowModal(false); setPassword(''); setConfirmPassword(''); setError(null); }}
                    className="flex-1 px-4 py-2 bg-ui/[0.05] hover:bg-ui/[0.12] text-ui/70 text-sm rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!password || !confirmPassword}
                    className="flex-1 px-4 py-2 glass-btn-primary disabled:cursor-not-allowed text-sm font-medium rounded-lg transition-colors"
                  >
                    Export
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="relative h-2 bg-ui/[0.12] rounded-full overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 bg-cp-blue rounded-full transition-all duration-300 animate-pulse"
                    style={{ width: '60%' }}
                  />
                </div>
                <p className="text-sm text-ui/55 text-center">{stage}</p>
              </div>
            )}
          </div>
        </div>,
        document.querySelector('.dojo3-stage') ?? document.body
      )}
    </>
  );
};
