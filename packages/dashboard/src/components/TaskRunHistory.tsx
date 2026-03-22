import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import { parseUtc } from '../lib/dates';

interface TaskRunHistoryProps {
  taskId: string;
}

const statusColors: Record<string, string> = {
  complete: 'glass-badge-teal',
  running: 'glass-badge-amber',
  on_deck: 'glass-badge-gray',
  fallen: 'glass-badge-coral',
  skipped: 'glass-badge-gray',
};

const formatDuration = (start: string | null, end: string | null): string => {
  if (!start || !end) return '--';
  const ms = new Date(end).getTime() - new Date(start).getTime();
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
  const [runs, setRuns] = useState<api.TaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const result = await api.getTaskRuns(taskId);
      if (result.ok) setRuns(result.data);
      setLoading(false);
    };
    load();
  }, [taskId]);

  if (loading) return <p className="text-sm text-white/40 py-4">Loading run history...</p>;
  if (runs.length === 0) return <p className="text-sm text-white/30 py-4">No runs yet</p>;

  return (
    <div className="space-y-1">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2 text-[10px] text-white/30 uppercase tracking-wide">
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
            className="flex items-center gap-3 px-3 py-2 glass-nested rounded-lg cursor-pointer hover:bg-white/[0.04] transition-colors"
          >
            <span className="w-8 text-xs text-white/50 font-mono">{run.runNumber}</span>
            <span className="w-28 text-xs text-white/60">{formatTime(run.scheduledFor)}</span>
            <span className="w-28 text-xs text-white/60">{formatTime(run.startedAt)}</span>
            <span className="w-16 text-xs text-white/50 font-mono">{formatDuration(run.startedAt, run.completedAt)}</span>
            <span className="w-16">
              <span className={`glass-badge text-[10px] ${statusColors[run.status] ?? 'glass-badge-gray'} capitalize`}>
                {run.status}
              </span>
            </span>
            <span className="flex-1 text-xs text-white/60 truncate">{run.agentName ?? run.assignedTo ?? '--'}</span>
          </div>

          {/* Expanded detail */}
          {expandedRun === run.id && (run.resultSummary || run.error) && (
            <div className="ml-8 mr-3 mb-1 px-3 py-2 glass-nested rounded-lg text-xs">
              {run.resultSummary && (
                <div className="text-white/70 whitespace-pre-wrap">{run.resultSummary}</div>
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
