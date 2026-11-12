import { useState, useRef, useEffect, useCallback, type DragEvent } from 'react';
import type { Task } from '@dojo/shared';
import { TaskCard } from './TaskCard';
import { columnKeyForStatus, COLUMN_WORDS, KANBAN_COLUMN_KEYS, type KanbanColumnKey } from '../lib/task-status';

// Subtle horizontal scrollbar rendered ABOVE the board. The board itself hides
// its native scrollbar (scrollbar-width: none), and a native one would sit at
// the bottom, below the fold when columns are tall. This thin track is always
// visible at the top so mouse users (no horizontal trackpad swipe) can drag to
// scroll the columns. Bidirectionally synced with the board's scrollLeft.
const KanbanScrollbar = ({ boardRef }: { boardRef: React.RefObject<HTMLDivElement> }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startScroll: number } | null>(null);
  const [m, setM] = useState({ visible: false, widthPct: 0, leftPct: 0 });

  const recompute = useCallback(() => {
    const board = boardRef.current;
    if (!board) return;
    const { scrollWidth, clientWidth, scrollLeft } = board;
    if (scrollWidth <= clientWidth + 1) {
      setM((prev) => (prev.visible ? { visible: false, widthPct: 0, leftPct: 0 } : prev));
      return;
    }
    setM({
      visible: true,
      widthPct: (clientWidth / scrollWidth) * 100,
      leftPct: (scrollLeft / scrollWidth) * 100,
    });
  }, [boardRef]);

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    recompute();
    board.addEventListener('scroll', recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(board);
    return () => {
      board.removeEventListener('scroll', recompute);
      ro.disconnect();
    };
  }, [boardRef, recompute]);

  const onThumbDown = (e: React.PointerEvent) => {
    const board = boardRef.current;
    if (!board) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startScroll: board.scrollLeft };
  };
  const onThumbMove = (e: React.PointerEvent) => {
    const board = boardRef.current;
    const track = trackRef.current;
    if (!drag.current || !board || !track) return;
    const dx = e.clientX - drag.current.startX;
    board.scrollLeft = drag.current.startScroll + dx * (board.scrollWidth / track.clientWidth);
  };
  const onThumbUp = (e: React.PointerEvent) => {
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onTrackDown = (e: React.PointerEvent) => {
    const board = boardRef.current;
    const track = trackRef.current;
    if (!board || !track || e.target !== track) return;
    const rect = track.getBoundingClientRect();
    const clickPct = (e.clientX - rect.left) / rect.width;
    board.scrollLeft = clickPct * board.scrollWidth - board.clientWidth / 2;
  };

  if (!m.visible) return null;
  return (
    <div className="kscroll" ref={trackRef} onPointerDown={onTrackDown}>
      <div
        className="kscroll__thumb"
        style={{ width: `${m.widthPct}%`, left: `${m.leftPct}%` }}
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
      />
    </div>
  );
};

interface KanbanBoardProps {
  tasks: Task[];
  workingAgentIds?: Set<string>;
  onTaskClick: (taskId: string) => void;
  onStatusChange: (taskId: string, newStatus: Task['status']) => void;
  onTaskDeleted?: () => void;
  /** The server pages older finished tasks; the finished columns offer the page before. */
  onShowOlderFinished?: () => void;
}

/** The columns that hold finished tasks (the server pages these). */
const FINISHED_COLUMNS: ReadonlySet<KanbanColumnKey> = new Set<KanbanColumnKey>(['complete', 'fallen']);

interface ColumnDef {
  key: KanbanColumnKey;
  label: string;
  /** The column title's color; Open has none. */
  flavor: '' | 'kcol--progress' | 'kcol--purple' | 'kcol--complete' | 'kcol--amber';
}

const FLAVORS: Record<KanbanColumnKey, ColumnDef['flavor']> = {
  on_deck: '', in_progress: 'kcol--progress', handed_in: 'kcol--purple',
  sent_back: 'kcol--amber', complete: 'kcol--complete', fallen: 'kcol--amber',
};

const columns: ColumnDef[] = KANBAN_COLUMN_KEYS.map((key) => ({ key, label: COLUMN_WORDS[key], flavor: FLAVORS[key] }));

const KanbanColumn = ({
  column,
  tasks,
  workingAgentIds,
  index,
  onTaskClick,
  onTaskDeleted,
  onDrop,
  onShowOlder,
}: {
  column: ColumnDef;
  tasks: Task[];
  workingAgentIds?: Set<string>;
  index: number;
  onTaskClick: (taskId: string) => void;
  onTaskDeleted?: () => void;
  onDrop: (taskId: string, newStatus: Task['status']) => void;
  onShowOlder?: () => void;
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

      {onShowOlder && (
        <button type="button" className="btn btn--sm" onClick={onShowOlder}>Show older finished tasks</button>
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

// Per-column order: Open soonest-to-run first, Working and the waiting columns oldest first,
// Done latest-completed first, Closed newest first.
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

const SORT_BY_COLUMN: Record<KanbanColumnKey, Cmp> = {
  on_deck: (a, b) =>
    asc(a.nextRunAt, b.nextRunAt) ||
    asc(a.scheduledStart, b.scheduledStart) ||
    asc(a.createdAt, b.createdAt),
  in_progress: (a, b) => asc(a.updatedAt, b.updatedAt),
  handed_in: (a, b) => asc(a.updatedAt, b.updatedAt),
  sent_back: (a, b) => asc(a.updatedAt, b.updatedAt),
  complete: (a, b) => desc(a.completedAt, b.completedAt) || desc(a.updatedAt, b.updatedAt),
  fallen: (a, b) => desc(a.updatedAt, b.updatedAt),
};

export const KanbanBoard = ({ tasks, workingAgentIds, onTaskClick, onStatusChange, onTaskDeleted, onShowOlderFinished }: KanbanBoardProps) => {
  const tasksByStatus = columns.reduce(
    (acc, col) => {
      acc[col.key] = tasks
        .filter((t) => columnKeyForStatus(t.status) === col.key)
        .sort(SORT_BY_COLUMN[col.key]);
      return acc;
    },
    {} as Record<KanbanColumnKey, Task[]>,
  );

  const handleDrop = (taskId: string, newStatus: Task['status']) => {
    // Find the task to check if status actually changed
    const task = tasks.find(t => t.id === taskId);
    if (task && columnKeyForStatus(task.status) !== newStatus) {
      onStatusChange(taskId, newStatus);
    }
  };

  const boardRef = useRef<HTMLDivElement>(null);

  return (
    <div className="kanban-wrap">
      <KanbanScrollbar boardRef={boardRef} />
      <div className="kanban" ref={boardRef}>
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
            onShowOlder={FINISHED_COLUMNS.has(col.key) ? onShowOlderFinished : undefined}
          />
        ))}
      </div>
    </div>
  );
};
