import { useState, useEffect } from 'react';
import type { Briefing } from '@dojo/shared';
import * as api from '../lib/api';
import { formatDate } from '../lib/dates';
import { useGuardedLoad } from '../lib/load-guard';

interface BriefingViewProps {
  agentId: string;
}

export const BriefingView = ({ agentId }: BriefingViewProps) => {
  // Read through the shared load guard: a failed read is not "none yet", and an answer for a
  // different agent is dropped (lib/load-guard.ts).
  const load = useGuardedLoad<Briefing | null>(agentId, async (id) => api.getBriefing(id));
  const briefing = load.canSave(agentId) ? load.data : null;
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => { setEditing(false); setError(null); }, [agentId]);

  const handleSave = async () => {
    if (!briefing || !load.canSave(agentId)) return;
    setSaving(true);
    const result = await api.updateBriefing(agentId, editContent, briefing.id);
    if (result.ok) {
      setEditing(false);
      load.reload();
    } else {
      setError(result.error);
      load.reload();
    }
    setSaving(false);
  };

  const handleRegenerate = async () => {
    if (!load.canSave(agentId)) return;
    if (briefing?.editedByOwner && !window.confirm('You edited this briefing by hand. Regenerating replaces your edits. Continue?')) return;
    setRegenerating(true);
    setError(null);
    const result = await api.regenerateBriefing(agentId);
    if (result.ok) {
      load.adopt(result.data);
    } else {
      setError(result.error);
    }
    setRegenerating(false);
  };

  if (load.status === 'loading') {
    return (
      <div className="flex items-center justify-center h-full text-ui/40 text-sm">
        Loading briefing...
      </div>
    );
  }

  if (load.status === 'failed') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-ui/40 text-sm">Could not load the briefing, so it can&apos;t be changed right now. Nothing has been replaced.</p>
        <button onClick={load.reload} className="px-4 py-2 text-sm rounded-lg glass-btn-primary transition-colors">
          Retry
        </button>
      </div>
    );
  }

  if (!briefing) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-ui/40 text-sm">No briefing available yet.</p>
        {error && <p className="text-xs text-cp-coral">{error}</p>}
        <button
          onClick={handleRegenerate}
          disabled={regenerating}
          className="px-4 py-2 text-sm rounded-lg glass-btn-primary transition-colors"
        >
          {regenerating ? 'Generating...' : 'Generate Briefing'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-ui/[0.06]">
        <div>
          <h3 className="card-header">Morning Briefing</h3>
          <div className="flex items-center gap-3 mt-0.5 text-[10px] text-ui/40">
            <span>Generated: {formatDate(briefing.generatedAt)}</span>
            <span>{briefing.tokenCount.toLocaleString()} tokens</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!editing && (
            <button
              onClick={() => {
                setEditContent(briefing.content);
                setEditing(true);
              }}
              className="px-3 py-1.5 text-xs rounded bg-ui/[0.05] text-ui/70 hover:bg-ui/[0.08] transition-colors"
            >
              Edit
            </button>
          )}
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="px-3 py-1.5 text-xs rounded bg-cp-amber/20 text-cp-amber hover:bg-cp-amber/30 transition-colors disabled:opacity-50"
          >
            {regenerating ? 'Regenerating...' : 'Regenerate'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="alert-banner alert-error">
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="glass-textarea w-full h-96 font-mono resize-y"
            />
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-1.5 text-xs rounded glass-btn-primary transition-colors"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="px-4 py-1.5 text-xs rounded bg-ui/[0.05] text-ui/70 hover:bg-ui/[0.08] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <pre className="text-sm text-ui/90 whitespace-pre-wrap font-mono leading-relaxed">
            {briefing.content}
          </pre>
        )}
      </div>
    </div>
  );
};
