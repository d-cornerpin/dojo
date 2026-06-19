import { useState, type DragEvent } from 'react';
import type { Task } from '@dojo/shared';
import { TaskCard } from './TaskCard';

interface KanbanBoardProps {
  tasks: Task[];
  workingAgentIds?: Set<string>;
  onTaskClick: (taskId: string) => void;
  onStatusChange: (taskId: string, newStatus: Task['status']) => void;
  onTaskDeleted?: () => void;
}

interface ColumnDef {
  key: Task['status'];
  label: string;
  // Prototype kcol flavor modifier. On Deck has no flavor (the plain .kcol);
  // the others map onto the four prototype colors.
  flavor: '' | 'kcol--progress' | 'kcol--paused' | 'kcol--complete' | 'kcol--blocked';
}

const columns: ColumnDef[] = [
  { key: 'on_deck', label: 'On Deck', flavor: '' },
  { key: 'in_progress', label: 'In Progress', flavor: 'kcol--progress' },
  { key: 'paused', label: 'Paused', flavor: 'kcol--paused' },
  { key: 'complete', label: 'Complete', flavor: 'kcol--complete' },
  { key: 'blocked', label: 'Blocked', flavor: 'kcol--blocked' },
  { key: 'fallen', label: 'Fallen', flavor: 'kcol--blocked' },
];

const KanbanColumn = ({
  column,
  tasks,
  workingAgentIds,
  index,
  onTaskClick,
  onTaskDeleted,
  onDrop,
}: {
  column: ColumnDef;
  tasks: Task[];
  workingAgentIds?: Set<string>;
  index: number;
  onTaskClick: (taskId: string) => void;
  onTaskDeleted?: () => void;
  onDrop: (taskId: string, newStatus: Task['status']) => void;
}) => {
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) {
      onDrop(taskId, column.key);
    }
  };

  return (
    <div
      className={`kcol anim ${column.flavor}`}
      style={{ '--ci': `${40 + index * 40}ms` } as React.CSSProperties}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="kcol__head">
        <span className="kcol__title">{column.label}</span>
        <span className="kcol__count">{tasks.length}</span>
      </div>

      {tasks.map((task) => (
        <DraggableTaskCard
          key={task.id}
          task={task}
          agentIsWorking={!!(task.assignedTo && workingAgentIds?.has(task.assignedTo))}
          onClick={() => onTaskClick(task.id)}
          onDeleted={onTaskDeleted}
        />
      ))}

      {tasks.length === 0 && (
        <div className="kempty">{dragOver ? 'Drop here' : 'No tasks'}</div>
      )}
    </div>
  );
};

const DraggableTaskCard = ({
  task,
  agentIsWorking,
  onClick,
  onDeleted,
}: {
  task: Task;
  agentIsWorking?: boolean;
  onClick: () => void;
  onDeleted?: () => void;
}) => {
  const [dragging, setDragging] = useState(false);

  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    setDragging(true);
  };

  const handleDragEnd = () => {
    setDragging(false);
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      style={{ cursor: 'grab', opacity: dragging ? 0.4 : undefined }}
    >
      <TaskCard task={task} agentIsWorking={agentIsWorking} onClick={onClick} onDeleted={onDeleted} />
    </div>
  );
};

// v2.7.9 — per-column chronological sort.
//
//   on_deck     → soonest-to-run at top (asc next_run_at, fallback scheduled_start, fallback created_at).
//                 Nulls sink to the bottom in each tier so unscheduled tasks
//                 don't shove scheduled ones around.
//   in_progress → earliest-started at top (asc updated_at — updated_at flips
//                 to the transition time when status becomes in_progress).
//   paused      → earliest-paused at top (asc updated_at — same proxy, the
//                 longest-sitting paused tasks surface first so they aren't
//                 forgotten).
//   complete    → latest-completed at top (desc completed_at, fallback updated_at).
//   blocked /
//   fallen      → not specified by user; left on the existing desc updated_at
//                 default for visual consistency.
type Cmp = (a: Task, b: Task) => number;

const NULL_TAIL = '￿'; // any real ISO timestamp sorts BEFORE this string.
const asc = (av: string | null, bv: string | null): number => {
  const a = av ?? NULL_TAIL;
  const b = bv ?? NULL_TAIL;
  return a.localeCompare(b);
};
const desc = (av: string | null, bv: string | null): number => {
  const a = av ?? '';
  const b = bv ?? '';
  return b.localeCompare(a);
};

const SORT_BY_COLUMN: Record<Task['status'], Cmp> = {
  on_deck: (a, b) =>
    asc(a.nextRunAt, b.nextRunAt) ||
    asc(a.scheduledStart, b.scheduledStart) ||
    asc(a.createdAt, b.createdAt),
  in_progress: (a, b) => asc(a.updatedAt, b.updatedAt),
  paused: (a, b) => asc(a.updatedAt, b.updatedAt),
  complete: (a, b) => desc(a.completedAt, b.completedAt) || desc(a.updatedAt, b.updatedAt),
  blocked: (a, b) => desc(a.updatedAt, b.updatedAt),
  fallen: (a, b) => desc(a.updatedAt, b.updatedAt),
};

export const KanbanBoard = ({ tasks, workingAgentIds, onTaskClick, onStatusChange, onTaskDeleted }: KanbanBoardProps) => {
  const tasksByStatus = columns.reduce(
    (acc, col) => {
      acc[col.key] = tasks
        .filter((t) => t.status === col.key)
        .sort(SORT_BY_COLUMN[col.key]);
      return acc;
    },
    {} as Record<Task['status'], Task[]>,
  );

  const handleDrop = (taskId: string, newStatus: Task['status']) => {
    // Find the task to check if status actually changed
    const task = tasks.find(t => t.id === taskId);
    if (task && task.status !== newStatus) {
      onStatusChange(taskId, newStatus);
    }
  };

  return (
    <div className="kanban">
      {columns.map((col, i) => (
        <KanbanColumn
          key={col.key}
          column={col}
          index={i}
          tasks={tasksByStatus[col.key] || []}
          workingAgentIds={workingAgentIds}
          onTaskClick={onTaskClick}
          onTaskDeleted={onTaskDeleted}
          onDrop={handleDrop}
        />
      ))}
    </div>
  );
};
