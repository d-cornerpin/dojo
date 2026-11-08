// A held task is Working work: the board shows it in Working with its hold and reason. There is no
// Paused or Blocked column.
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Task } from '@dojo/shared';
import { KanbanBoard } from '../components/KanbanBoard';
import { ToastProvider } from '../hooks/useToast';

const task = (id: string, hold: Task['hold'], holdReason: string | null) => ({ id, title: `Task ${id}`, status: 'in_progress', hold, holdReason, priority: 'normal', assignedTo: null, assignedToName: null, assignedToGroup: null, scheduleStatus: 'unscheduled', repeatInterval: null, repeatUnit: null, repeatDaysOfWeek: null, runCount: 0, nextRunAt: null, pausedUntil: null, scheduledStart: null, createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00', completedAt: null }) as unknown as Task;

describe('a held task shows its hold in Working', () => {
  it('renders paused and blocked tasks in Working with their reasons', () => {
    render(
      <ToastProvider>
        <KanbanBoard
          tasks={[task('t1', 'paused', 'waiting for the logo'), task('t2', 'blocked', 'need the API key')]}
          onTaskClick={() => {}}
          onStatusChange={() => {}}
        />
      </ToastProvider>,
    );
    const working = screen.getByText('Working').closest('.kcol') as HTMLElement;
    expect(within(working).getByText(/Paused: waiting for the logo/)).toBeTruthy();
    expect(within(working).getByText(/Blocked: need the API key/)).toBeTruthy();
    expect(screen.queryByText('Paused')).toBeNull();
    expect(screen.queryByText('Blocked')).toBeNull();
  });
});
