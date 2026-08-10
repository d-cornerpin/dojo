import { useState } from 'react';
import type { Task } from '@dojo/shared';
import * as api from '../lib/api';
import { formatShortDateTime, formatTimeSince } from '../lib/dates';
import { terminalOutcomeLabel } from '../lib/task-status';

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

// `next_run_at`, `paused_until` and `updated_at` all arrive as Z-LESS UTC text (`msToText`,
// `work/tracker-view.ts:189`). Both formatters live in `lib/dates.ts` and parse through
// `parseUtc`; parsing them with a bare `new Date()` read them as local time and put every
// "Next:" line on this card off by the box's UTC offset (UX-REPAIR T9).

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
  const priorityLabel = priorityLabels[task.priority] || priorityLabels.normal;
  const isScheduled = task.scheduleStatus && task.scheduleStatus !== 'unscheduled';

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await api.deleteTask(task.id);
    if (result.ok && onDeleted) onDeleted();
    setConfirmDelete(false);
  };

  // Only show the "actively being worked on" animation when the assigned
  // agent is ACTUALLY working right now — not just because the task status
  // is in_progress (which can persist after the agent finishes or errors).
  const isActive = task.status === 'in_progress' && !!agentIsWorking;
  const isBlocked = task.status === 'blocked';
  const isPaused = task.status === 'paused';
  // Paused and complete cards read as dimmed in the prototype.
  const isDim = isPaused || task.status === 'complete';
  const outcomeLabel = terminalOutcomeLabel(task.status);

  const awaitingValidation =
    (task.status === 'complete' && task.completeValidated === 0) ||
    (task.status === 'paused' && task.pauseValidated === 0) ||
    (task.status === 'blocked' && task.blockedValidated === 0);

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

      {/* T18: the terminal column holds two OUTCOMES — failed, and cancelled by choice — so
          the card says which one it is. Without this the shared column would be the old
          mislabel wearing a different hat. `terminalOutcomeLabel` returns null for every
          status whose column header already says it. */}
      {outcomeLabel && <div className="kcard__sub">{outcomeLabel}</div>}

      {/* Next-run line, only when waiting on a schedule and not paused. */}
      {isScheduled && !isPaused && task.nextRunAt && task.scheduleStatus === 'waiting' && (
        <div className="kcard__line">Next: {formatShortDateTime(task.nextRunAt)}</div>
      )}

      {/* Repeat cadence / run count. */}
      {repeatLine && <div className="kcard__sub">{repeatLine}</div>}

      {/* Paused indicator, shown for all paused tasks, with resume time if set. */}
      {isPaused && (
        <div className="kcard__sub">
          {task.pausedUntil
            ? `Paused until ${formatShortDateTime(task.pausedUntil)}`
            : 'Paused indefinitely'}
        </div>
      )}

      {/* Needs-resolution warning for indefinitely paused, non-recurring tasks. */}
      {isPaused && !task.pausedUntil && !task.repeatInterval && (
        <div className="kcard__warn" title="Paused with no auto-resume and no recurring schedule. Agents sometimes pause as a sloppy substitute for complete/blocked. Open the task to resolve it.">
          Needs resolution
        </div>
      )}

      {/* Awaiting-validation warning. Disappears the moment PM (or the user) validates. */}
      {awaitingValidation && (
        <div
          className="kcard__warn"
          title={
            task.validationEscalatedAt
              ? `Awaiting validation since ${task.updatedAt}. Engine has asked the user.`
              : `Awaiting validation by PM since ${task.updatedAt}.`
          }
        >
          {'⚠'} Awaiting validation
        </div>
      )}

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
