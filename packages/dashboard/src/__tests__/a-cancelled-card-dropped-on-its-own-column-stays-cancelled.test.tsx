// THE SHARED COLUMN HOLDS TWO WORDS. A card already on it, let go, must stay
// where it was — not jump to its column's representative status.
//
// `columnKeyForStatus('cancelled')` is `'fallen'`, so the "Fallen / Cancelled"
// column carries both outcomes. Dropping is `onDrop(taskId, column.key)`, which
// is always a COLUMN key. The card's raw status is not one, so comparing
// `task.status !== newStatus` reads a cancelled card's own column as a change
// and sends the owner's "Cancelled" off as "Failed".

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Task } from '@dojo/shared';
import { KanbanBoard } from '../components/KanbanBoard';
import { ToastProvider } from '../hooks/useToast';

const task = (id: string, status: string) => ({ id, title: `Task ${id}`, status, priority: 'normal', assignedTo: null, assignedToName: null, assignedToGroup: null, scheduleStatus: 'unscheduled', repeatInterval: null, repeatUnit: null, repeatDaysOfWeek: null, runCount: 0, nextRunAt: null, pausedUntil: null, scheduledStart: null, createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00', completedAt: null, completeValidated: 1, pauseValidated: 1, blockedValidated: 1, validationEscalatedAt: null }) as unknown as Task;

const renderBoard = (onStatusChange: ReturnType<typeof vi.fn>) =>
  render(
    <ToastProvider>
      <KanbanBoard
        tasks={[task('t1', 'cancelled'), task('t2', 'fallen'), task('t3', 'on_deck')]}
        onTaskClick={() => {}}
        onStatusChange={onStatusChange}
      />
    </ToastProvider>,
  );

const dropOnto = (label: string, id: string) => {
  const column = screen.getByText(label).closest('.kcol') as HTMLElement;
  fireEvent.drop(column, { dataTransfer: { getData: () => id } });
};

describe('a cancelled card dropped on its own column stays cancelled', () => {
  it('does not report a change for a cancelled card dropped on Fallen / Cancelled', () => {
    const onStatusChange = vi.fn();
    renderBoard(onStatusChange);
    dropOnto('Fallen / Cancelled', 't1');
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('does not report a change for a fallen card dropped on Fallen / Cancelled', () => {
    const onStatusChange = vi.fn();
    renderBoard(onStatusChange);
    dropOnto('Fallen / Cancelled', 't2');
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('reports the change when the card actually moves columns', () => {
    const onStatusChange = vi.fn();
    renderBoard(onStatusChange);
    dropOnto('Fallen / Cancelled', 't3');
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith('t3', 'fallen');
  });

  it('reports the change for a cancelled card dropped on Complete', () => {
    const onStatusChange = vi.fn();
    renderBoard(onStatusChange);
    dropOnto('Complete', 't1');
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith('t1', 'complete');
  });
});
