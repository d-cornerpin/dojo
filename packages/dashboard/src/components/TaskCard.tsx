import { useState } from 'react';
import type { Task } from '@dojo/shared';
import * as api from '../lib/api';

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  onDeleted?: () => void;
}

const priorityColors: Record<string, string> = {
  high: 'glass-badge-coral',
  normal: 'glass-badge-amber',
  low: 'glass-badge-teal',
};

const formatTimeSince = (dateStr: string): string => {
  const normalized = dateStr.includes('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(normalized).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

const formatNextRun = (dateStr: string): string => {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

const formatRepeat = (interval: number, unit: string): string => {
  if (interval === 1) return `Every ${unit.replace(/s$/, '')}`;
  return `Every ${interval} ${unit}`;
};

export const TaskCard = ({ task, onClick, onDeleted }: TaskCardProps) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const priority = priorityColors[task.priority] || priorityColors.normal;
  const isScheduled = task.scheduleStatus && task.scheduleStatus !== 'unscheduled';

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await api.deleteTask(task.id);
    if (result.ok && onDeleted) onDeleted();
    setConfirmDelete(false);
  };

  const isActive = task.status === 'in_progress';
  const isBlocked = task.status === 'blocked';

  const card = (
    <div
      onClick={onClick}
      className="w-full text-left glass-nested p-3 hover:bg-white/[0.06] transition-colors cursor-pointer group relative"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h4 className="text-sm font-medium text-white/90 leading-tight line-clamp-2">
          {task.title}
        </h4>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`glass-badge ${priority} capitalize`}>
            {task.priority}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
            className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-cp-coral transition-all p-0.5"
            title="Delete task"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Schedule info */}
      {isScheduled && (
        <div className="mb-2 space-y-0.5">
          {task.nextRunAt && task.scheduleStatus === 'waiting' && (
            <div className="text-[10px] text-cp-blue flex items-center gap-1">
              <span>{'\u{1F551}'}</span>
              <span>Next: {formatNextRun(task.nextRunAt)}</span>
            </div>
          )}
          {task.repeatInterval && task.repeatUnit && (
            <div className="text-[10px] text-white/40 flex items-center gap-1">
              <span>{'\u{1F501}'}</span>
              <span>{formatRepeat(task.repeatInterval, task.repeatUnit)}</span>
              {task.runCount > 0 && <span>({task.runCount} runs)</span>}
            </div>
          )}
          {task.isPaused && (
            <div className="text-[10px] text-cp-amber flex items-center gap-1">
              <span>{'\u23F8'}</span>
              <span>Paused</span>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-white/40">
        {task.assignedTo ? (
          <span className="truncate max-w-[120px]">{task.assignedToName ?? task.assignedTo}</span>
        ) : task.assignedToGroup ? (
          <span className="truncate max-w-[120px] text-cp-purple">Group</span>
        ) : (
          <span className="italic">Unassigned</span>
        )}
        <span>{formatTimeSince(task.updatedAt)}</span>
      </div>

      {/* Delete confirmation overlay */}
      {confirmDelete && (
        <div
          className="absolute inset-0 bg-black/80 rounded-xl flex items-center justify-center gap-2 z-10"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-xs text-white/70">Delete?</span>
          <button onClick={handleDelete} className="glass-btn glass-btn-destructive text-xs py-1 px-2">Yes</button>
          <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }} className="glass-btn glass-btn-ghost text-xs py-1 px-2">No</button>
        </div>
      )}
    </div>
  );

  if (isActive || isBlocked) {
    return (
      <div className={isActive ? 'card-working-wrap' : ''}>
        {isActive && (
          <>
            <div className="card-working-glow card-glow-amber" />
            <div className="card-working-border card-glow-amber" />
          </>
        )}
        {isBlocked && <div className="card-error-glow" />}
        {card}
      </div>
    );
  }

  return card;
};
