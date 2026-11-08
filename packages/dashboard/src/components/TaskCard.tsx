import { useState } from 'react';
import type { Task } from '@dojo/shared';
import * as api from '../lib/api';
import { useToast } from '../hooks/useToast';
import { DORMANT_MS } from '@dojo/shared';
import { formatDateShort, formatShortDateTime, formatTimeSince, parseUtc } from '../lib/dates';
import { HOLD_WORDS, terminalOutcomeLabel } from '../lib/task-status';

interface TaskCardProps {
  task: Task;
  agentIsWorking?: boolean;
  onClick: () => void;
  onDeleted?: () => void;
}

const priorityLabels: Record<string, string> = {
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

// Instants arrive as Z-less UTC text; every read goes through `lib/dates.ts`.

const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatRepeat = (interval: number, unit: string, daysCSV: string | null = null): string => {
  if (unit === 'weekdays') {
    return interval === 1 ? 'Every weekday' : `Every ${interval} weekdays`;
  }
  if (unit === 'specific_days') {
    if (!daysCSV) return 'Every (no days selected)';
    const nums = daysCSV
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
      .sort((a, b) => a - b);
    if (nums.length === 0) return 'Every (no days selected)';
    if (nums.length === 7) return 'Every day';
    if (nums.length === 5 && [1, 2, 3, 4, 5].every((n) => nums.includes(n))) return 'Every weekday';
    if (nums.length === 2 && nums.includes(0) && nums.includes(6)) return 'Every weekend';
    return `Every ${nums.map((n) => DAY_NAMES_SHORT[n]).join(', ')}`;
  }
  if (interval === 1) return `Every ${unit.replace(/s$/, '')}`;
  return `Every ${interval} ${unit}`;
};

export const TaskCard = ({ task, agentIsWorking, onClick, onDeleted }: TaskCardProps) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();
  const priorityLabel = priorityLabels[task.priority] || priorityLabels.normal;
  const isScheduled = task.scheduleStatus && task.scheduleStatus !== 'unscheduled';

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await api.deleteTask(task.id);
    if (result.ok) {
      if (onDeleted) onDeleted();
    } else {
      // The delete was refused: say why, so the card does not vanish as if it worked.
      toast.error(result.error ?? 'The task could not be deleted.');
    }
    setConfirmDelete(false);
  };

  // The working animation shows only while the assigned agent is in a turn right now.
  const isActive = task.status === 'in_progress' && !!agentIsWorking;
  const isBlocked = task.hold === 'blocked';
  const isPaused = task.hold === 'paused';
  // Paused and complete cards read as dimmed in the prototype.
  const isDim = isPaused || task.status === 'complete';
  const outcomeLabel = terminalOutcomeLabel(task.status);
  const movedAt = parseUtc(task.lastMovedAt);
  const isDormant = task.status === 'in_progress' && !task.hold && !!movedAt && Date.now() - movedAt.getTime() >= DORMANT_MS;

  // The repeat line (e.g. "Every weekday · 13 runs") sits in .kcard__sub.
  let repeatLine: string | null = null;
  if (isScheduled && !isPaused && task.repeatInterval && task.repeatUnit) {
    repeatLine = formatRepeat(task.repeatInterval, task.repeatUnit, task.repeatDaysOfWeek);
    if (task.runCount > 0) repeatLine += ` · ${task.runCount} runs`;
  }

  const card = (
    <article
      onClick={onClick}
      className={`tile kcard${isDim ? ' kcard--dim' : ''}`}
      style={{ cursor: 'pointer', position: 'relative' }}
    >
      <div className="kcard__top">
        <div className="kcard__title">{task.title}</div>
        <span className="pill pill--norm">{priorityLabel}</span>
      </div>

      {/* A Closed card says whether it could not be done or was cancelled. */}
      {outcomeLabel && <div className="kcard__sub">{outcomeLabel}</div>}

      {/* Next-run line, only when waiting on a schedule and not paused. */}
      {isScheduled && !isPaused && task.nextRunAt && task.scheduleStatus === 'waiting' && (
        <div className="kcard__line">Next: {formatShortDateTime(task.nextRunAt)}</div>
      )}

      {/* Repeat cadence / run count. */}
      {repeatLine && <div className="kcard__sub">{repeatLine}</div>}

      {/* A held Working task: its hold and reason, with the resume time if set. */}
      {task.hold && (
        <div className="kcard__warn" title={task.holdReason ?? undefined}>
          {HOLD_WORDS[task.hold]}: {task.holdReason}
          {isPaused && task.pausedUntil ? ` (until ${formatShortDateTime(task.pausedUntil)})` : ''}
        </div>
      )}

      {isDormant && <div className="kcard__warn">No activity since {formatDateShort(task.lastMovedAt)}</div>}
      {task.assigneeGone && <div className="kcard__warn">Agent no longer exists</div>}

      <div className="kcard__foot">
        {task.assignedTo ? (
          <span>{task.assignedToName ?? task.assignedTo}</span>
        ) : task.assignedToGroup ? (
          <span>Group</span>
        ) : (
          <span>Unassigned</span>
        )}
        <span>{formatTimeSince(task.updatedAt)}</span>
      </div>

      {/* Delete affordance: small floating control in the card corner. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
        title="Delete task"
        aria-label="Delete task"
        style={{
          position: 'absolute', top: 8, right: 10, lineHeight: 1,
          background: 'transparent', border: 0, cursor: 'pointer',
          fontSize: 14, color: 'var(--dojo3-ink-4)', padding: 2,
        }}
      >
        &times;
      </button>

      {/* Delete confirmation overlay */}
      {confirmDelete && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', inset: 0, borderRadius: 18,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: 'rgba(58,44,28,0.55)', backdropFilter: 'blur(3px)', zIndex: 2,
          }}
        >
          <span style={{ font: '500 11px/1 var(--dojo3-font-mono)', color: '#fffaf0' }}>Delete?</span>
          <button type="button" onClick={handleDelete} className="btn btn--sm">Yes</button>
          <button type="button" onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }} className="btn btn--sm">No</button>
        </div>
      )}
    </article>
  );

  if (isActive || isBlocked) {
    return (
      <div className={isActive ? 'card-working-wrap' : 'relative'}>
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
