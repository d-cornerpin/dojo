import { useState } from 'react';
import * as api from '../lib/api';
import { formatDate } from '../lib/dates';
import { useToast } from '../hooks/useToast';

// ── Override request queue (Phase B.1, Wordy Mode only) ──
// Renders pending override requests with approve/deny buttons.
// Lives at the top of the Tracker page so it's impossible to miss when
// the user is power-user-mode and an agent is asking for an override.
export const OverrideQueuePanel = ({
  overrides,
  onResolved,
}: {
  overrides: api.OverrideRequestRow[];
  onResolved: () => void;
}) => {
  const toast = useToast();
  const [resolving, setResolving] = useState<string | null>(null);
  const handle = async (id: string, approve: boolean) => {
    const reason = window.prompt(
      approve
        ? 'Reason for approving (one sentence):'
        : 'Reason for denying (one sentence). The agent will be notified.'
    );
    if (!reason || !reason.trim()) return;
    setResolving(id);
    const res = await api.resolveOverrideRequest(id, approve, reason.trim());
    setResolving(null);
    if (res.ok) onResolved();
    else toast.error(res.error ?? 'The decision was not recorded.');
  };
  return (
    <div className="tile" style={{ marginBottom: 16, padding: 16 }}>
      <h2 style={{ font: '500 10.5px/1 var(--dojo3-font-mono)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--dojo3-amber-deep)', marginBottom: 12 }}>
        Override requests ({overrides.length})
      </h2>
      <div className="space-y-3">
        {overrides.map((o) => (
          <div key={o.id} className="glass-nested rounded-lg p-3">
            <div className="text-xs text-ui/55 mb-1">
              from <span className="text-ui font-medium">{o.requested_by}</span>
              {' · '}
              wants <span className="text-cp-teal">{o.requested_status}</span>
              {o.attempts_attached > 1 && (
                <span className="ml-2 text-cp-coral">(circuit-breaker auto-fired x{o.attempts_attached})</span>
              )}
            </div>
            <div className="text-sm text-ui font-medium mb-1">
              Task: {o.task_title ?? o.task_id.slice(0, 8)}
            </div>
            {o.task_goal && (
              <div className="text-xs text-ui/70 mb-1">Goal: {o.task_goal}</div>
            )}
            <div className="text-xs text-ui/80 mb-1">
              <span className="text-ui/55">Justification:</span> {o.justification}
            </div>
            {o.last_engine_error && (
              <div className="text-xs text-ui/55 italic mb-2">
                Engine: {o.last_engine_error}
              </div>
            )}
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                disabled={resolving === o.id}
                onClick={() => handle(o.id, true)}
                className="btn btn--primary btn--sm"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={resolving === o.id}
                onClick={() => handle(o.id, false)}
                className="btn btn--sm"
              >
                Deny
              </button>
              <span className="text-xs text-ui/55 self-center ml-2">
                queued {formatDate(o.created_at)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
