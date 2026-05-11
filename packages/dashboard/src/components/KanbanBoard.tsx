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
  headerColor: string;
}

const columns: ColumnDef[] = [
  { key: 'on_deck', label: 'On Deck', headerColor: 'text-ui/55' },
  { key: 'in_progress', label: 'In Progress', headerColor: 'text-cp-amber' },
  { key: 'paused', label: 'Paused', headerColor: 'text-cp-purple' },
  { key: 'complete', label: 'Complete', headerColor: 'text-cp-teal' },
  { key: 'blocked', label: 'Blocked', headerColor: 'text-cp-amber-light' },
  { key: 'fallen', label: 'Fallen', headerColor: 'text-cp-coral' },
];

const KanbanColumn = ({
  column,
  tasks,
  workingAgentIds,
  onTaskClick,
  onTaskDeleted,
  onDrop,
}: {
  column: ColumnDef;
  tasks: Task[];
  workingAgentIds?: Set<string>;
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
      className={`flex-1 min-w-[200px] flex flex-col rounded-xl transition-colors ${
        dragOver ? 'bg-cp-blue/10 ring-2 ring-cp-blue/40' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 mb-3 px-2">
        <h3 className={`text-sm font-semibold ${column.headerColor}`}>{column.label}</h3>
        <span className="text-xs text-ui/40 bg-ui/[0.05] px-1.5 py-0.5 rounded-full">
          {tasks.length}
        </span>
      </div>

      {/* Cards */}
      <div className={`flex-1 space-y-2 overflow-y-auto min-h-[80px] px-1 pb-1 rounded-lg ${
        dragOver ? 'bg-cp-blue/5' : ''
      }`}>
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
          <div className={`text-center py-8 text-xs rounded-lg border border-dashed ${
            dragOver ? 'border-cp-blue/40 text-cp-blue' : 'text-ui/25 text-ui/25'
          }`}>
            {dragOver ? 'Drop here' : 'No tasks'}
          </div>
        )}
      </div>
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
      className={`cursor-grab active:cursor-grabbing ${dragging ? 'opacity-40' : ''}`}
    >
      <TaskCard task={task} agentIsWorking={agentIsWorking} onClick={onClick} onDeleted={onDeleted} />
    </div>
  );
};

export const KanbanBoard = ({ tasks, workingAgentIds, onTaskClick, onStatusChange, onTaskDeleted }: KanbanBoardProps) => {
  const tasksByStatus = columns.reduce(
    (acc, col) => {
      acc[col.key] = tasks
        .filter((t) => t.status === col.key)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    <div className="flex gap-4 h-full overflow-x-auto pb-2">
      {columns.map((col) => (
        <KanbanColumn
          key={col.key}
          column={col}
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
