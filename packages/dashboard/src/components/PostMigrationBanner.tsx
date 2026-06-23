import { useState, useEffect, useCallback } from 'react';
import type { PostMigrationCheck } from '@dojo/shared';
import { useWebSocket } from '../hooks/useWebSocket';
import { ImportWizard } from './ImportWizard';

// FENG-SHUI EXEMPTION: migration flow uses standard Tailwind status colors.
// Migration is explicitly exempt per FENG-SHUI-THEME-SPEC.md.

// Kept here (and imported by ImportWizard as a type) so the manifest shape lives
// in one place on the dashboard side.
export interface ExportManifest {
  version: string;
  platform_version: string;
  exported_at: string;
  exported_from: {
    hostname: string;
    username: string;
    home_directory: string;
    os_version: string;
    node_version: string;
  };
  contents: {
    database: boolean;
    database_size_bytes: number;
    prompts: string[];
    techniques_count: number;
    techniques: string[];
    vault_entries_count: number;
    agents_count: number;
    agents: Array<{ name: string; classification: string; model: string | null }>;
    google_workspace_connected: boolean;
    google_workspace_email: string | null;
    microsoft_connected: boolean;
    ollama_models: string[];
    providers: string[];
    uploads_size_bytes: number;
    cloudflare_named_tunnel?: boolean;
  };
  encryption: string;
  checksum: string;
}

// After an import, the guided "Set up" step lives in the ImportWizard. This
// banner is just the resumability hook: if there are still items that need the
// user, it offers to reopen the wizard at that step. No more flat check dump.
export const PostMigrationBanner = () => {
  const [checks, setChecks] = useState<PostMigrationCheck[]>([]);
  const [dismissed, setDismissed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [resume, setResume] = useState(false);
  const { subscribe } = useWebSocket();

  const getHeaders = useCallback((): Record<string, string> => {
    const token = localStorage.getItem('dojo_token');
    const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
    const csrf = csrfMatch ? csrfMatch[1] : null;
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/migration/import/status', { headers: getHeaders() });
        const data = await res.json();
        if (data.ok) {
          setChecks(data.data.checks || []);
          setDismissed(data.data.dismissed);
        }
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [getHeaders]);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = subscribe('migration:checks', (e: any) => {
      if (e.data?.checks) setChecks(e.data.checks);
      if (typeof e.data?.dismissed === 'boolean') setDismissed(e.data.dismissed);
    });
    return unsub;
  }, [subscribe]);

  const handleDismiss = async () => {
    await fetch('/api/migration/import/dismiss', {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    });
    setDismissed(true);
  };

  // Items that still need the user: action items + technique setup cards.
  const remaining = checks.filter(
    (c) => c.status === 'action_needed' && (c.category === 'action' || c.category === 'technique'),
  ).length;

  if (loading || dismissed || remaining === 0) return null;

  return (
    <>
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3 mx-6 mt-4 flex items-center gap-3">
        <span className="text-blue-400 shrink-0">{'✨'}</span>
        <p className="text-sm text-ui/80 flex-1">
          Finish setting up your imported dojo — <strong className="text-ui">{remaining}</strong> item{remaining === 1 ? '' : 's'} need your attention.
        </p>
        <button onClick={() => setResume(true)} className="btn btn--primary text-xs shrink-0">Resume setup</button>
        <button onClick={handleDismiss} className="text-ui/25 hover:text-ui/55 text-xs shrink-0">Dismiss</button>
      </div>

      {resume && (
        <ImportWizard
          asModal
          initialStep="setup"
          onClose={() => setResume(false)}
          onComplete={() => { setResume(false); void handleDismiss(); }}
        />
      )}
    </>
  );
};
