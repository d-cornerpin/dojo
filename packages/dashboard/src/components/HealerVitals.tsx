import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import { formatDate } from '../lib/dates';

export const HealerVitals = () => {
  const [proposals, setProposals] = useState<api.HealerProposal[]>([]);
  const [actions, setActions] = useState<api.HealerAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [denyNote, setDenyNote] = useState('');
  const [resolving, setResolving] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const [proposalsResult, actionsResult] = await Promise.all([
        api.getHealerProposals(),
        api.getHealerActions(),
      ]);
      if (proposalsResult.ok) setProposals(proposalsResult.data);
      if (actionsResult.ok) setActions(actionsResult.data);
      setLoading(false);
    };
    load();
  }, []);

  const handleApprove = async (id: string) => {
    setResolving(id);
    const result = await api.resolveHealerProposal(id, 'approve');
    if (result.ok) {
      setProposals(prev => prev.map(p => p.id === id ? { ...p, status: 'approved' } : p));
    }
    setResolving(null);
  };

  const handleDeny = async (id: string) => {
    if (denyingId !== id) {
      setDenyingId(id);
      setDenyNote('');
      return;
    }
    setResolving(id);
    const result = await api.resolveHealerProposal(id, 'deny', denyNote || undefined);
    if (result.ok) {
      setProposals(prev => prev.map(p => p.id === id ? { ...p, status: 'denied', user_note: denyNote || null } : p));
    }
    setDenyingId(null);
    setDenyNote('');
    setResolving(null);
  };

  const pendingCount = proposals.filter(p => p.status === 'pending').length;
  // v2.3.19 — show the last 50 actions in a scrollable timeline (was 10).
  const recentActions = actions.slice(0, 50);
  const pendingProposals = proposals.filter(p => p.status === 'pending');
  const resolvedProposals = proposals.filter(p => p.status !== 'pending').slice(0, 5);

  if (loading) return null;
  if (pendingCount === 0 && actions.length === 0) return null;

  const severityIcon = (s: string) => {
    if (s === 'critical') return '🔴';
    if (s === 'warning') return '🟠';
    return '🔵';
  };

  return (
    <div className="mb-6">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <h3 className="card-header">
          Healer
          {pendingCount > 0 && (
            <span className="ml-2 px-2 py-0.5 text-[10px] rounded-full bg-cp-amber/20 text-cp-amber border border-cp-amber/30">
              {pendingCount} {pendingCount === 1 ? 'suggestion' : 'suggestions'} for you
            </span>
          )}
        </h3>
        <span className="text-ui/25 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {/* Pending proposals */}
          {pendingProposals.length > 0 && (
            <div className="space-y-2">
              {pendingProposals.map(p => (
                <div key={p.id} className="glass-card p-3 border-l-2 border-cp-amber">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span>{severityIcon(p.severity)}</span>
                        <span className="text-sm font-medium text-ui/90">{p.title}</span>
                      </div>
                      <p className="text-xs text-ui/55 mb-1">{p.description}</p>
                      <p className="text-xs text-ui/70">
                        <span className="text-cp-amber">Suggested fix:</span> {p.proposed_fix}
                      </p>
                      <p className="text-[10px] text-ui/25 mt-1">
                        Flagged {formatDate(p.created_at)}
                        {p.confidence !== null && <span> · Confidence: {p.confidence}%</span>}
                      </p>
                    </div>
                  </div>

                  {denyingId === p.id ? (
                    <div className="mt-2 space-y-2">
                      <input
                        type="text"
                        value={denyNote}
                        onChange={(e) => setDenyNote(e.target.value)}
                        placeholder="Tell us what you'd rather do instead (optional)"
                        className="glass-input w-full text-xs"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleDeny(p.id)}
                          disabled={resolving === p.id}
                          className="px-3 py-1 text-xs rounded bg-cp-coral/20 text-cp-coral border border-cp-coral/30 hover:bg-cp-coral/30 transition-colors"
                        >
                          {resolving === p.id ? 'Denying...' : 'Confirm Deny'}
                        </button>
                        <button
                          onClick={() => { setDenyingId(null); setDenyNote(''); }}
                          className="px-3 py-1 text-xs rounded text-ui/40 hover:text-ui/55 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => handleApprove(p.id)}
                        disabled={resolving === p.id}
                        className="px-3 py-1 text-xs rounded glass-btn-primary"
                      >
                        {resolving === p.id ? 'Approving...' : 'Approve'}
                      </button>
                      <button
                        onClick={() => handleDeny(p.id)}
                        className="px-3 py-1 text-xs rounded bg-ui/[0.08] text-ui/55 hover:text-ui/70 border border-ui/[0.10] hover:border-ui/[0.15] transition-colors"
                      >
                        Deny
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Resolved proposals — three states post v2.3.19:
              approved + applied: Healer carried it out (green, "Applied")
              approved + not yet applied: user said yes, Healer hasn't done it
                                          yet (amber, "Approved — waiting")
              denied: user said no (coral, "Denied")
          */}
          {resolvedProposals.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-ui/25 uppercase tracking-wider">Previous Suggestions</p>
              {resolvedProposals.map(p => {
                const isApplied = p.status === 'approved' && !!p.applied_at;
                const isApprovedPending = p.status === 'approved' && !p.applied_at;
                const isDenied = p.status === 'denied';
                const isAutoResolved = p.status === 'auto_resolved';
                const iconColor = isApplied ? 'text-cp-teal'
                  : isAutoResolved ? 'text-cp-teal'
                  : isApprovedPending ? 'text-cp-amber'
                  : isDenied ? 'text-cp-coral'
                  : 'text-ui/25';
                const icon = isApplied ? '✓'
                  : isAutoResolved ? '✓'
                  : isApprovedPending ? '⋯'
                  : isDenied ? '✗'
                  : '○';
                const label = isApplied ? 'applied'
                  : isAutoResolved ? 'resolved on its own'
                  : isApprovedPending ? 'approved — waiting on Healer'
                  : p.status;
                // Show resolved-at if we have one, otherwise created-at.
                const stamp = p.resolved_at ?? p.created_at;
                return (
                  <div key={p.id} className="flex items-center gap-2 text-xs text-ui/40 py-1">
                    <span className={iconColor}>{icon}</span>
                    <span className="flex-1 truncate" title={p.title}>{p.title}</span>
                    <span className="text-ui/25">({label})</span>
                    <span className="text-ui/25 text-[10px] shrink-0">{formatDate(stamp)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Recent Healer action timeline (last 50, scrollable).
              v2.3.19 — promoted from "last 10" to a proper scrollable
              activity log so the user can see what the Healer's been
              doing over time, not just the most recent handful. */}
          {recentActions.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-ui/25 uppercase tracking-wider">
                Things the Healer Did Automatically {recentActions.length >= 50 && <span className="text-ui/25">(showing last 50)</span>}
              </p>
              <div className="max-h-64 overflow-y-auto pr-1 space-y-0.5">
                {recentActions.map(a => (
                  <div key={a.id} className="flex items-center gap-2 text-xs py-1">
                    <span className={a.result === 'success' ? 'text-cp-teal' : a.result === 'failed' ? 'text-cp-coral' : 'text-cp-amber'}>
                      {a.result === 'success' ? '✓' : a.result === 'failed' ? '✗' : '~'}
                    </span>
                    <span className="text-ui/55 flex-1 truncate" title={a.description}>{a.description}</span>
                    <span className="text-ui/25 text-[10px] shrink-0">{formatDate(a.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
