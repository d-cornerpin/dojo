// ── The Dojo's two standard local models (v3.5): their state, read from the server ──
//
// Shown on the setup screen (progress while they install themselves; no choice) and in the Ollama
// tile under Settings → Platform (with a Repair button). The tags are the server's: the dashboard
// names neither model itself (`services/local-standard.ts` is the only place they are written).

import { useState, useEffect, useCallback } from 'react';
import { request } from '../../lib/api';

export interface StandardModelsState {
  decision: 'installed' | 'missing' | 'pulling';
  writer: 'installed' | 'missing' | 'pulling';
  ollama: 'running' | 'stopped' | 'absent';
  residentBytes: number;
  note: string;
  tags: { decision: string; writer: string };
  lines: string[];
}

const POLL_MS = 1000;
const isPulling = (s: StandardModelsState | null): boolean => !!s && (s.decision === 'pulling' || s.writer === 'pulling');

export const StandardModels = ({ repair, onState }: { repair?: boolean; onState?: (s: StandardModelsState) => void }) => {
  const [state, setState] = useState<StandardModelsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await request<StandardModelsState>('/setup/ollama/standard');
    if (!r.ok) { setError(r.error); return; }
    if (!r.data?.tags) return;   // an older server without the route: nothing to show
    setState(r.data); setError(null); onState?.(r.data);
  }, [onState]);

  useEffect(() => { void load(); }, [load]);
  // Poll while an install is running, so the progress lines move. On the setup screen the install is
  // started by the server a moment after this mounts, so a missing model is polled for too.
  const missing = !!state && (state.decision === 'missing' || state.writer === 'missing');
  useEffect(() => {
    if (!isPulling(state) && (repair || !missing)) return;
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [state, load, repair, missing]);

  const startRepair = async () => {
    const r = await request('/setup/ollama/standard', { method: 'POST' });
    if (!r.ok) setError(r.error);
    setTimeout(() => { void load(); }, POLL_MS);
  };

  if (error) return <div className="alert-banner alert-error">{error}</div>;
  if (!state) return <div className="text-xs text-ui/40">Checking the Dojo's own models...</div>;

  const word = (s: StandardModelsState['decision']): string => (s === 'pulling' ? 'installing' : s);
  const needsRepair = state.ollama === 'running' && !isPulling(state) && (state.decision === 'missing' || state.writer === 'missing');

  return (
    <div className="space-y-1.5">
      <div className="text-xs text-ui/70">
        {`Dojo's own models: ${state.tags.decision} (decision) — ${word(state.decision)}, ${state.tags.writer} (writer) — ${word(state.writer)}`}
      </div>
      {state.lines.map((line) => <div key={line} className="text-xs text-ui/55">{line}</div>)}
      <div className="text-xs text-ui/40">{state.note}</div>
      {repair && needsRepair && (
        <button type="button" onClick={startRepair} className="btn btn--primary btn--sm">Repair</button>
      )}
    </div>
  );
};
