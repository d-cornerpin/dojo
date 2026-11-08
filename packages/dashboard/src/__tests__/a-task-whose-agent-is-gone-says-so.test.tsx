// A task whose assigned agent no longer exists says so on its card.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Task } from '@dojo/shared';
import { TaskCard } from '../components/TaskCard';
import { ToastProvider } from '../hooks/useToast';
import { FX, FXID } from '../../../../deploy/checks/fixture-vocabulary.mjs';

const task = (assigneeGone: boolean) => ({ id: 't1', title: 'Task t1', status: 'in_progress', hold: null, priority: 'normal', assignedTo: FXID.n1, assignedToName: FX.n1, assignedToGroup: null, assigneeGone, scheduleStatus: 'unscheduled', runCount: 0, createdAt: '2026-01-01 00:00:00', updatedAt: new Date().toISOString(), completedAt: null }) as unknown as Task;

const renderCard = (t: Task) => render(<ToastProvider><TaskCard task={t} onClick={() => {}} /></ToastProvider>);

describe('a task whose agent is gone says so', () => {
  it('labels the card when the assignee is gone', () => {
    renderCard(task(true));
    expect(screen.getByText('Agent no longer exists')).toBeTruthy();
  });

  it('says nothing while the assignee exists', () => {
    renderCard(task(false));
    expect(screen.queryByText('Agent no longer exists')).toBeNull();
  });
});
