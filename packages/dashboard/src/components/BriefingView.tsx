import { useState, useEffect, useCallback } from 'react';
import type { Briefing } from '@dojo/shared';
import * as api from '../lib/api';
import { parseUtc } from '../lib/dates';

interface BriefingViewProps {
  agentId: string;
}

export const BriefingView = ({ agentId }: BriefingViewProps) => {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const loadBriefing = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await api.getBriefing(agentId);
    if (result.ok) {
      setBriefing(result.data);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    loadBriefing();
  }, [loadBriefing]);

  const handleSave = async () => {
    setSaving(true);
    const result = await api.updateBriefing(agentId, editContent);
    if (result.ok) {
      setEditing(false);
      await loadBriefing();
    } else {
      setError(result.error);
    }
    setSaving(false);
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    setError(null);
    const result = await api.regenerateBriefing(agentId);
    if (result.ok) {
      setBriefing(result.data);
    } else {
      setError(result.error);
    }
    setRegenerating(false);
  };

  const formatDate = (d: string) => {
    const parsed = parseUtc(d);
    if (!parsed) return '';
    return parsed.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full white/40 text-sm">
        Loading briefing...
      </div>
    );
  }

  if (error && !briefing) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="white/40 text-sm">No briefing available yet.</p>
        <button
          onClick={handleRegenerate}
          disabled={regenerating}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
        >
          {regenerating ? 'Generating...' : 'Generate Briefing'}
        </button>
      </div>
    );
  }

  if (!briefing) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b white/[0.06]">
        <div>
          <h3 className="text-sm font-medium white/90">Morning Briefing</h3>
          <div className="flex items-center gap-3 mt-0.5 text-[10px] white/40">
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
              className="px-3 py-1.5 text-xs rounded bg-white/[0.05] white/70 hover:bg-white/[0.08] transition-colors"
            >
              Edit
            </button>
          )}
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="px-3 py-1.5 text-xs rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors disabled:opacity-50"
          >
            {regenerating ? 'Regenerating...' : 'Regenerate'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-red-900/20 border-b border-red-900/30 text-red-400 text-xs">
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
              className="w-full h-96 bg-white/[0.05] border white/[0.08] rounded-lg p-3 text-sm white/90 font-mono resize-y focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="px-4 py-1.5 text-xs rounded bg-white/[0.05] white/70 hover:bg-white/[0.08] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <pre className="text-sm white/90 whitespace-pre-wrap font-mono leading-relaxed">
            {briefing.content}
          </pre>
        )}
      </div>
    </div>
  );
};
