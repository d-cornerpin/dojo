import { useState, useEffect, useCallback } from 'react';
import type { SummaryDetail as SummaryDetailType } from '@dojo/shared';
import * as api from '../lib/api';
import { parseUtc } from '../lib/dates';

const DEPTH_COLORS: Record<number, string> = {
  0: 'text-blue-400',
  1: 'text-green-400',
  2: 'text-orange-400',
};

const getDepthTextColor = (depth: number): string => {
  return DEPTH_COLORS[depth] ?? 'text-purple-400';
};

interface SummaryDetailProps {
  summaryId: string;
  agentId: string;
  onDeleted: () => void;
  onUpdated: () => void;
  onSelect: (id: string) => void;
}

export const SummaryDetail = ({
  summaryId,
  agentId,
  onDeleted,
  onUpdated,
  onSelect,
}: SummaryDetailProps) => {
  const [detail, setDetail] = useState<SummaryDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showSourceMessages, setShowSourceMessages] = useState(false);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await api.getSummaryDetail(agentId, summaryId);
    if (result.ok) {
      setDetail(result.data);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, [agentId, summaryId]);

  useEffect(() => {
    loadDetail();
    setEditing(false);
    setShowDeleteConfirm(false);
  }, [loadDetail]);

  const handleSave = async () => {
    if (!detail) return;
    setSaving(true);
    const result = await api.updateSummary(agentId, summaryId, editContent);
    if (result.ok) {
      setDetail(result.data);
      setEditing(false);
      onUpdated();
    } else {
      setError(result.error);
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    const result = await api.deleteSummary(agentId, summaryId);
    if (result.ok) {
      onDeleted();
    } else {
      setError(result.error);
    }
    setDeleting(false);
    setShowDeleteConfirm(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full white/40 text-sm">
        Loading summary...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400 text-sm">
        {error}
      </div>
    );
  }

  if (!detail) return null;

  const fmtDate = (d: string) => {
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

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b white/[0.06]">
        <div className="flex items-center gap-2">
          <span className={`font-bold ${getDepthTextColor(detail.depth)}`}>
            Depth {detail.depth}
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-white/[0.05] white/55">
            {detail.kind}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!editing && (
            <button
              onClick={() => {
                setEditContent(detail.content);
                setEditing(true);
              }}
              className="px-3 py-1.5 text-xs rounded bg-white/[0.05] white/70 hover:bg-white/[0.08] transition-colors"
            >
              Edit
            </button>
          )}
          {!showDeleteConfirm ? (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="px-3 py-1.5 text-xs rounded bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors"
            >
              Delete
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <span className="text-xs text-red-400 mr-1">Confirm?</span>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Yes'}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-3 py-1.5 text-xs rounded bg-white/[0.05] white/70 hover:bg-white/[0.08] transition-colors"
              >
                No
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="glass-textarea w-full h-64 font-mono resize-y"
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
                className="px-4 py-1.5 text-xs rounded bg-white/[0.05] white/70 hover:bg-white/[0.08] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="white/[0.03] rounded-lg p-4">
            <pre className="text-sm white/90 whitespace-pre-wrap font-mono leading-relaxed">
              {detail.content}
            </pre>
          </div>
        )}

        {/* Metadata table */}
        <div className="white/[0.03] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b white/[0.08]/50">
                <td className="px-4 py-2 white/40 font-medium w-40">ID</td>
                <td className="px-4 py-2 white/70 font-mono text-xs">{detail.id}</td>
              </tr>
              <tr className="border-b white/[0.08]/50">
                <td className="px-4 py-2 white/40 font-medium">Depth</td>
                <td className={`px-4 py-2 font-medium ${getDepthTextColor(detail.depth)}`}>
                  {detail.depth}
                </td>
              </tr>
              <tr className="border-b white/[0.08]/50">
                <td className="px-4 py-2 white/40 font-medium">Kind</td>
                <td className="px-4 py-2 white/70">{detail.kind}</td>
              </tr>
              <tr className="border-b white/[0.08]/50">
                <td className="px-4 py-2 white/40 font-medium">Tokens</td>
                <td className="px-4 py-2 white/70">{detail.tokenCount.toLocaleString()}</td>
              </tr>
              <tr className="border-b white/[0.08]/50">
                <td className="px-4 py-2 white/40 font-medium">Descendants</td>
                <td className="px-4 py-2 white/70">{detail.descendantCount}</td>
              </tr>
              <tr className="border-b white/[0.08]/50">
                <td className="px-4 py-2 white/40 font-medium">Earliest</td>
                <td className="px-4 py-2 white/70">{fmtDate(detail.earliestAt)}</td>
              </tr>
              <tr className="border-b white/[0.08]/50">
                <td className="px-4 py-2 white/40 font-medium">Latest</td>
                <td className="px-4 py-2 white/70">{fmtDate(detail.latestAt)}</td>
              </tr>
              <tr>
                <td className="px-4 py-2 white/40 font-medium">Created</td>
                <td className="px-4 py-2 white/70">{fmtDate(detail.createdAt)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Parent links */}
        {detail.parentIds.length > 0 && (
          <div>
            <h4 className="text-xs font-medium white/40 uppercase tracking-wider mb-2">
              Parents
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {detail.parentIds.map((pid) => (
                <button
                  key={pid}
                  onClick={() => onSelect(pid)}
                  className="px-2 py-1 text-xs rounded bg-white/[0.05] text-blue-400 hover:bg-white/[0.08] hover:text-blue-300 transition-colors font-mono"
                >
                  {pid.slice(0, 8)}...
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Child links */}
        {detail.childIds.length > 0 && (
          <div>
            <h4 className="text-xs font-medium white/40 uppercase tracking-wider mb-2">
              Children
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {detail.childIds.map((cid) => (
                <button
                  key={cid}
                  onClick={() => onSelect(cid)}
                  className="px-2 py-1 text-xs rounded bg-white/[0.05] text-green-400 hover:bg-white/[0.08] hover:text-green-300 transition-colors font-mono"
                >
                  {cid.slice(0, 8)}...
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Source message IDs */}
        {detail.sourceMessageIds.length > 0 && (
          <div>
            <button
              onClick={() => setShowSourceMessages(!showSourceMessages)}
              className="text-xs font-medium white/40 uppercase tracking-wider mb-2 flex items-center gap-1 hover:white/55 transition-colors"
            >
              <span>{showSourceMessages ? '\u25BC' : '\u25B6'}</span>
              <span>Source Messages ({detail.sourceMessageIds.length})</span>
            </button>
            {showSourceMessages && (
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {detail.sourceMessageIds.map((mid) => (
                  <div
                    key={mid}
                    className="px-2 py-1 text-xs rounded bg-white/[0.05] white/55 font-mono"
                  >
                    {mid}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
