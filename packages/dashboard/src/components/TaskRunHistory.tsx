import { useState, useEffect, useCallback } from 'react';
import type { WsEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { parseUtc } from '../lib/dates';
import { useWebSocket } from '../hooks/useWebSocket';

interface TaskRunHistoryProps {
  taskId: string;
}

const statusColors: Record<string, string> = {
  complete: 'glass-badge-teal',
  running: 'glass-badge-amber',
  on_deck: 'glass-badge-gray',
  fallen: 'glass-badge-coral',
  // T18: a cancellation is terminal but it is not an error, so it does not wear the error
  // colour. Neutral, the same weight the card's own "Cancelled" line carries.
  cancelled: 'glass-badge-gray',
  skipped: 'glass-badge-gray',
};

const formatDuration = (start: string | null, end: string | null): string => {
  if (!start || !end) return '--';
  // `startedAt`/`completedAt` are ISO-with-Z (`work/occurrence-runs.ts:53`) while the sibling
  // `scheduledFor` is Z-less second-resolution text (`:58`) — one row, two shapes, documented at
  // `occurrence-runs.ts:39-44`. `parseUtc` is right for both, so neither can drift (UX-REPAIR T9).
  const s = parseUtc(start);
  const e = parseUtc(end);
  if (!s || !e) return '--';
  const ms = e.getTime() - s.getTime();
  if (ms < 1000) return '<1s';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
};

const formatTime = (iso: string | null): string => {
  if (!iso) return '--';
  const d = parseUtc(iso);
  if (!d) return '--';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
};

export const TaskRunHistory = ({ taskId }: TaskRunHistoryProps) => {
  const { subscribe } = useWebSocket();
  const [runs, setRuns] = useState<api.TaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api.getTaskRuns(taskId);
    if (result.ok) setRuns(result.data);
    setLoading(false);
  }, [taskId]);

  useEffect(() => { void load(); }, [load]);

  // Live-update when THIS task starts or finishes a scheduled run. Previously
  // task:run_started/run_complete were emitted but consumed nowhere, so the
  // history froze at page-open until a manual refresh (FA-DB7). Filter to the
  // viewed task so an unrelated task's run doesn't refetch this one.
  useEffect(() => {
    const onRun = (event: WsEvent) => {
      if (event.type !== 'task:run_started' && event.type !== 'task:run_complete') return;
      if (event.data.taskId === taskId) void load();
    };
    const unsubStarted = subscribe('task:run_started', onRun);
    const unsubComplete = subscribe('task:run_complete', onRun);
    return () => { unsubStarted(); unsubComplete(); };
  }, [subscribe, taskId, load]);

  if (loading) return <p className="text-sm text-ui/40 py-4">Loading run history...</p>;
  if (runs.length === 0) return <p className="text-sm text-ui/25 py-4">No runs yet</p>;

  return (
    <div className="space-y-1">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2 text-[10px] text-ui/25 uppercase tracking-wide">
        <span className="w-8">#</span>
        <span className="w-28">Scheduled</span>
        <span className="w-28">Started</span>
        <span className="w-16">Duration</span>
        <span className="w-16">Status</span>
        <span className="flex-1">Agent</span>
      </div>

      {runs.map((run) => (
        <div key={run.id}>
          <div
            onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
            className="flex items-center gap-3 px-3 py-2 glass-nested rounded-lg cursor-pointer hover:bg-ui/[0.05] transition-colors"
          >
            <span className="w-8 text-xs text-ui/55 font-mono">{run.runNumber}</span>
            <span className="w-28 text-xs text-ui/55">{formatTime(run.scheduledFor)}</span>
            <span className="w-28 text-xs text-ui/55">{formatTime(run.startedAt)}</span>
            <span className="w-16 text-xs text-ui/55 font-mono">{formatDuration(run.startedAt, run.completedAt)}</span>
            <span className="w-16">
              <span className={`glass-badge text-[10px] ${statusColors[run.status] ?? 'glass-badge-gray'} capitalize`}>
                {run.status}
              </span>
            </span>
            <span className="flex-1 text-xs text-ui/55 truncate">{run.agentName ?? run.assignedTo ?? '--'}</span>
          </div>

          {/* Expanded detail */}
          {expandedRun === run.id && (run.resultSummary || run.error) && (
            <div className="ml-8 mr-3 mb-1 px-3 py-2 glass-nested rounded-lg text-xs">
              {run.resultSummary && (
                <div className="text-ui/70 whitespace-pre-wrap">{run.resultSummary}</div>
              )}
              {run.error && (
                <div className="text-cp-coral mt-1">{run.error}</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
