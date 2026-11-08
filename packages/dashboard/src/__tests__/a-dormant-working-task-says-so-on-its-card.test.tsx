// A Working task idle 14 days or more says "No activity since <date>"; a held task shows its hold instead.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Task } from '@dojo/shared';
import { TaskCard } from '../components/TaskCard';
import { ToastProvider } from '../hooks/useToast';
import { formatDateShort } from '../lib/dates';

const task = (lastMovedAt: string, hold: Task['hold'] = null) => ({ id: 't1', title: 'Task t1', status: 'in_progress', hold, holdReason: hold ? 'waiting for the logo' : null, priority: 'normal', assignedTo: null, assignedToName: null, assignedToGroup: null, assigneeGone: false, scheduleStatus: 'unscheduled', runCount: 0, createdAt: '2026-10-01 00:00:00', updatedAt: '2026-10-01 00:00:00', lastMovedAt, completedAt: null }) as unknown as Task;

beforeEach(() => { vi.setSystemTime(Date.UTC(2026, 10, 8, 12, 0, 0)); });
afterEach(() => { vi.useRealTimers(); });

const renderCard = (t: Task) => render(<ToastProvider><TaskCard task={t} onClick={() => {}} /></ToastProvider>);

describe('a dormant working task says so on its card', () => {
  it('shows the label with the last activity date after 14 days', () => {
    const t = task('2026-10-25 12:00:00');
    renderCard(t);
    expect(screen.getByText(`No activity since ${formatDateShort(t.lastMovedAt)}`)).toBeTruthy();
  });

  it('reads when the task last moved, not when its row was last written', () => {
    renderCard(task('2026-11-07 12:00:00'));
    expect(screen.queryByText(/No activity since/)).toBeNull();
  });

  it('shows nothing after 13 days', () => {
    renderCard(task('2026-10-26 12:00:00'));
    expect(screen.queryByText(/No activity since/)).toBeNull();
  });

  it('shows a held task\'s hold, not the dormant label', () => {
    renderCard(task('2026-10-19 12:00:00', 'paused'));
    expect(screen.getByText(/Paused: waiting for the logo/)).toBeTruthy();
    expect(screen.queryByText(/No activity since/)).toBeNull();
  });
});
