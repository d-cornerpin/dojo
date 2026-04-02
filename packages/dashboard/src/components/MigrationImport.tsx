import { useState, useRef, useCallback, useContext, type DragEvent, type FormEvent } from 'react';
import type { ExportManifest } from './PostMigrationBanner';

interface Props {
  /** If true, use /api/setup/migration/* (no auth). If false, use /api/migration/* (auth required) */
  isOobe?: boolean;
  onComplete?: () => void;
}

export const MigrationImport = ({ isOobe = false, onComplete }: Props) => {
  const [file, setFile] = useState<File | null>(null);
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [password, setPassword] = useState('');
  const [importing, setImporting] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const apiBase = isOobe ? '/api/setup/migration' : '/api/migration';

  const getHeaders = useCallback((): Record<string, string> => {
    const token = localStorage.getItem('dojo_token');
    const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
    const csrf = csrfMatch ? csrfMatch[1] : null;
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    };
  }, []);

  const handleFile = async (selectedFile: File) => {
    setFile(selectedFile);
    setError(null);
    setManifest(null);

    // Read manifest without password
    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const res = await fetch(`${apiBase}/manifest`, {
        method: 'POST',
        headers: getHeaders(),
        body: formData,
      });
      const data = await res.json();
      if (data.ok) {
        setManifest(data.data);
      } else {
        setError(data.error || 'Invalid export file');
        setFile(null);
      }
    } catch {
      setError('Failed to read export file');
      setFile(null);
    }
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile?.name.endsWith('.zip')) {
      handleFile(droppedFile);
    } else {
      setError('Please drop a .zip file');
    }
  };

  const handleImport = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !password) return;
    setError(null);
    setImporting(true);
    setStage('Importing... this may take a moment.');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('password', password);

    try {
      const res = await fetch(`${apiBase}/import`, {
        method: 'POST',
        headers: getHeaders(),
        body: formData,
      });
      const data = await res.json();
      if (data.ok) {
        setSuccess(true);
        onComplete?.();
      } else {
        setError(data.error || 'Import failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  if (success) {
    return (
      <div className="space-y-4 text-center">
        <div className="text-4xl mb-2">&#x2705;</div>
        <h3 className="text-lg font-bold text-white">Your dojo has been restored!</h3>
        <p className="text-sm text-white/55">Check the post-migration checklist for any items that need attention.</p>
        {isOobe ? (
          <button
            onClick={() => { window.location.href = '/'; }}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Enter the Dojo
          </button>
        ) : (
          <button
            onClick={() => { window.location.reload(); }}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Reload Dashboard
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!isOobe && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <p className="text-amber-400 text-sm font-medium">Warning</p>
          <p className="text-amber-400/70 text-xs mt-1">
            This will REPLACE your current dojo with the imported data. This action cannot be undone.
            A backup of your current dojo will be created automatically.
          </p>
        </div>
      )}

      {/* File Upload */}
      {!file ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
            dragOver ? 'border-blue-500 bg-blue-500/5' : 'border-white/10 hover:border-white/20'
          }`}
        >
          <p className="text-white/55 text-sm">
            Drag and drop your <strong className="text-white/70">dojo-export.zip</strong> here
          </p>
          <p className="text-white/30 text-xs mt-1">or click to browse</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
            className="hidden"
          />
        </div>
      ) : manifest ? (
        <>
          {/* Manifest Preview */}
          <div className="bg-white/[0.03] border border-white/10 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-white">Export Summary</h4>
              <button
                onClick={() => { setFile(null); setManifest(null); setPassword(''); }}
                className="text-xs text-white/40 hover:text-white/60"
              >
                Choose different file
              </button>
            </div>
            <p className="text-xs text-white/40">
              Created on {new Date(manifest.exported_at).toLocaleDateString()} from{' '}
              <span className="text-white/55">{manifest.exported_from.hostname}</span>
            </p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="text-white/55">
                <span className="text-white/30">Agents:</span> {manifest.contents.agents_count}
                {manifest.contents.agents.length > 0 && (
                  <span className="text-white/30"> ({manifest.contents.agents.map(a => a.name).join(', ')})</span>
                )}
              </div>
              <div className="text-white/55">
                <span className="text-white/30">Techniques:</span> {manifest.contents.techniques_count}
              </div>
              <div className="text-white/55">
                <span className="text-white/30">Vault entries:</span> {manifest.contents.vault_entries_count}
              </div>
              <div className="text-white/55">
                <span className="text-white/30">Providers:</span> {manifest.contents.providers.join(', ') || 'None'}
              </div>
            </div>
            {manifest.contents.google_workspace_connected && (
              <p className="text-xs text-white/40">Google Workspace: {manifest.contents.google_workspace_email}</p>
            )}
            {manifest.contents.ollama_models.length > 0 && (
              <p className="text-xs text-white/40">
                Ollama models to download: {manifest.contents.ollama_models.join(', ')}
              </p>
            )}
          </div>

          {/* Password + Import */}
          {!importing ? (
            <form onSubmit={handleImport} className="space-y-3">
              <div>
                <label className="block text-sm text-white/70 mb-1">Export Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter the password used during export"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                  autoFocus
                />
              </div>
              {error && <p className="text-red-400 text-sm">{error}</p>}
              <button
                type="submit"
                disabled={!password || password.length < 8}
                className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
              >
                Import
              </button>
            </form>
          ) : (
            <div className="space-y-3">
              <div className="relative h-2 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-blue-500 rounded-full transition-all duration-300 animate-pulse"
                  style={{ width: '60%' }}
                />
              </div>
              <p className="text-sm text-white/55 text-center">{stage}</p>
            </div>
          )}
        </>
      ) : null}

      {error && !manifest && (
        <p className="text-red-400 text-sm">{error}</p>
      )}
    </div>
  );
};
