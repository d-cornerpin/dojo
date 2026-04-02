import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

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
  };
  encryption: string;
  checksum: string;
}

interface PostMigrationCheck {
  id: string;
  label: string;
  status: 'ok' | 'action_needed' | 'in_progress';
  action?: string;
  detail?: string;
}

export const PostMigrationBanner = () => {
  const [checks, setChecks] = useState<PostMigrationCheck[]>([]);
  const [dismissed, setDismissed] = useState(true);
  const [loading, setLoading] = useState(true);
  const { subscribe } = useWebSocket();

  const getHeaders = useCallback((): Record<string, string> => {
    const token = localStorage.getItem('dojo_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  // Fetch initial state
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/migration/import/status', { headers: getHeaders() });
        const data = await res.json();
        if (data.ok) {
          setChecks(data.data.checks || []);
          setDismissed(data.data.dismissed);
        }
      } catch { /* ignore */ }
      setLoading(false);
    };
    load();
  }, [getHeaders]);

  // Listen for real-time check updates
  useEffect(() => {
    const unsub = subscribe('migration:checks', (event: any) => {
      if (event.data) {
        setChecks(event.data.checks || []);
        setDismissed(event.data.dismissed);
      }
    });
    return unsub;
  }, [subscribe]);

  const handleDismiss = async () => {
    const token = localStorage.getItem('dojo_token');
    const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
    const csrf = csrfMatch ? csrfMatch[1] : null;

    await fetch('/api/migration/import/dismiss', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
    });
    setDismissed(true);
  };

  if (loading || dismissed || checks.length === 0) return null;

  const statusIcon = (status: string) => {
    switch (status) {
      case 'ok': return <span className="text-green-500">&#x2713;</span>;
      case 'in_progress': return <span className="text-blue-400 animate-pulse">&#x23F3;</span>;
      case 'action_needed': return <span className="text-amber-400">&#x26A0;&#xFE0F;</span>;
      default: return null;
    }
  };

  const getActionLink = (check: PostMigrationCheck) => {
    if (!check.action) return null;
    if (check.action.includes('Settings > Google')) {
      return <a href="/settings?tab=workspace" className="text-blue-400 hover:text-blue-300 ml-2">Re-connect</a>;
    }
    if (check.action.includes('Settings > Microsoft')) {
      return <a href="/settings?tab=microsoft" className="text-blue-400 hover:text-blue-300 ml-2">Re-authenticate</a>;
    }
    if (check.action.includes('Settings > Providers')) {
      return <a href="/settings?tab=providers" className="text-blue-400 hover:text-blue-300 ml-2">Configure</a>;
    }
    return <span className="text-white/30 ml-2 text-xs">{check.action}</span>;
  };

  return (
    <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 mx-6 mt-4">
      <div className="flex items-start justify-between mb-3">
        <h3 className="text-sm font-bold text-white">
          {checks.some(c => c.status === 'action_needed' || c.status === 'in_progress')
            ? 'Dojo imported successfully! A few things need attention:'
            : 'Dojo imported successfully! Everything looks good.'}
        </h3>
        <button
          onClick={handleDismiss}
          className="text-white/30 hover:text-white/50 text-xs ml-4 shrink-0"
        >
          Dismiss
        </button>
      </div>

      <div className="space-y-1.5">
        {checks.map((check) => (
          <div key={check.id} className="flex items-center gap-2 text-sm">
            <span className="w-5 text-center">{statusIcon(check.status)}</span>
            <span className={check.status === 'ok' ? 'text-white/55' : 'text-white/70'}>{check.label}</span>
            {check.status === 'action_needed' && getActionLink(check)}
          </div>
        ))}
      </div>
    </div>
  );
};
