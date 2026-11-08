// The board has six columns in the owner's words, and every status lands in one of them.
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Task } from '@dojo/shared';
import { KanbanBoard } from '../components/KanbanBoard';
import { ToastProvider } from '../hooks/useToast';
import { KANBAN_COLUMN_KEYS, STATUS_WORDS, columnKeyForStatus, type TaskStatus } from '../lib/task-status';

const task = (id: string, status: TaskStatus) => ({ id, title: `Task ${id}`, status, hold: null, priority: 'normal', assignedTo: null, assignedToName: null, assignedToGroup: null, assigneeGone: false, scheduleStatus: 'unscheduled', runCount: 0, createdAt: '2026-01-01 00:00:00', updatedAt: new Date().toISOString(), completedAt: null }) as unknown as Task;

const renderBoard = (tasks: Task[]) => render(
  <ToastProvider><KanbanBoard tasks={tasks} onTaskClick={() => {}} onStatusChange={() => {}} /></ToastProvider>,
);
const column = (title: string) => screen.getByText(title, { selector: '.kcol__title' }).closest('.kcol') as HTMLElement;

describe('the board shows six columns with the owner\'s words', () => {
  it('titles the columns Open, Working, Handed in, Sent back, Done, Closed', () => {
    const { container } = renderBoard([]);
    const titles = [...container.querySelectorAll('.kcol__title')].map((el) => el.textContent);
    expect(titles).toEqual(['Open', 'Working', 'Handed in', 'Sent back', 'Done', 'Closed']);
  });

  it('puts a cancelled and a could-not-be-done task in Closed, each with its own word', () => {
    renderBoard([task('t1', 'cancelled'), task('t2', 'fallen')]);
    const closed = column('Closed');
    expect(within(closed).getByText('Task t1').closest('.kcard')!.textContent).toContain('Cancelled');
    expect(within(closed).getByText('Task t2').closest('.kcard')!.textContent).toContain("Couldn't be done");
  });

  it('gives every status a column', () => {
    for (const status of Object.keys(STATUS_WORDS) as TaskStatus[]) {
      expect(KANBAN_COLUMN_KEYS, status).toContain(columnKeyForStatus(status));
    }
  });
});
