// ════════════════════════════════════════════════════════════════════════════
// A REFUSED TASK FIELD CHANGE IS UNDONE — the TaskDetailPanel Status, Priority
// and Assignee selects set the new value locally and then threw api.updateTask's
// answer away, so a refused change left the box showing a value the server never
// stored and said nothing about it (the [task] effect never re-ran). A refusal
// must toast the reason and put the select back; an accepted change keeps the
// new value and reloads once.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Task } from '@dojo/shared';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the panel
// mounts on its own terms (its task_log feed included) and the door this file is
// about is the only override.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});

import * as api from '../lib/api';
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket };
});
import { ToastProvider } from '../hooks/useToast';
import { Dojo3Notifications } from '../components/Dojo3Notifications';
import { TaskDetailPanel } from '../pages/Tracker';

const task = {
  id: 't1',
  title: 'Write the guide',
  status: 'on_deck',
  priority: 'normal',
  assignedTo: '',
  evidence: [],
  dependsOn: [],
  phase: 'build',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  scheduledStart: null,
  repeatInterval: null,
  repeatUnit: null,
  repeatEndType: 'never',
  repeatEndValue: null,
  repeatDaysOfWeek: null,
  anchorTime: null,
  scheduleStatus: 'unscheduled',
  nextRunAt: null,
  isPaused: false,
  runCount: 0,
} as unknown as Task;

const renderPanel = () => {
  const onUpdate = vi.fn();
  render(
    <ToastProvider>
      <TaskDetailPanel
        task={task}
        agents={[]}
        allTasks={[]}
        onClose={() => {}}
        onUpdate={onUpdate}
      />
      <Dojo3Notifications />
    </ToastProvider>,
  );
  return onUpdate;
};

// Each field's select sits in the same div as its h3 heading.
const selectFor = (heading: string) =>
  screen.getByText(heading, { selector: 'h3' }).parentElement!.querySelector('select') as HTMLSelectElement;

beforeEach(() => {
  vi.mocked(api.updateTask).mockResolvedValue({ ok: true, data: {} } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('a refused task field change is undone', () => {
  it('a refused status change toasts the reason and puts the select back', async () => {
    vi.mocked(api.updateTask).mockResolvedValueOnce({ ok: false, error: 'not allowed' } as never);
    const onUpdate = renderPanel();

    const status = selectFor('Status');
    fireEvent.change(status, { target: { value: 'complete' } });

    await waitFor(() => expect(screen.getByText('not allowed')).toBeTruthy());
    expect(status.value).toBe('on_deck');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('an accepted status change keeps the new value and reloads once', async () => {
    const onUpdate = renderPanel();

    const status = selectFor('Status');
    fireEvent.change(status, { target: { value: 'complete' } });

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(status.value).toBe('complete');
  });

  it('a refused priority change toasts the reason and puts the select back', async () => {
    vi.mocked(api.updateTask).mockResolvedValueOnce({ ok: false, error: 'not allowed' } as never);
    const onUpdate = renderPanel();

    const priority = selectFor('Priority');
    fireEvent.change(priority, { target: { value: 'high' } });

    await waitFor(() => expect(screen.getByText('not allowed')).toBeTruthy());
    expect(priority.value).toBe('normal');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('an accepted priority change keeps the new value and reloads once', async () => {
    const onUpdate = renderPanel();

    const priority = selectFor('Priority');
    fireEvent.change(priority, { target: { value: 'high' } });

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(priority.value).toBe('high');
  });
});
