// A refused schedule save must say why: the owner sees the reason and the edit
// they typed stays. handleSave used to discard api.updateTask's answer, so a
// refusal hid the button, reloaded the task with its old schedule, and the edit
// vanished with no word of why.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Task } from '@dojo/shared';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, updateTask: vi.fn() };
});

import * as api from '../lib/api';
import { ScheduleEditor } from '../pages/Tracker';

const task = {
  id: 't1',
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

// Turning the schedule on makes the "Save Schedule" button appear. The toggle is
// the first button in the "Schedule this task" row.
const turnOn = () => {
  const row = screen.getByText(/Schedule this task/i).parentElement as HTMLElement;
  fireEvent.click(row.querySelector('button') as HTMLButtonElement);
};

const clickSave = () => fireEvent.click(screen.getByRole('button', { name: /Save Schedule/i }));

beforeEach(() => {
  vi.mocked(api.updateTask).mockClear();
});

describe('the schedule editor', () => {
  it('a refused save shows the reason, keeps the edit, and does not reload', async () => {
    const onUpdate = vi.fn();
    vi.mocked(api.updateTask).mockResolvedValueOnce({ ok: false, error: 'repeat unit is not valid' });
    render(<ScheduleEditor task={task} onUpdate={onUpdate} />);
    turnOn();
    clickSave();
    await waitFor(() => expect(screen.queryByText(/repeat unit is not valid/i)).not.toBeNull());
    expect(screen.queryByRole('button', { name: /Save Schedule/i })).not.toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('an accepted save reloads and hides the button, as before', async () => {
    const onUpdate = vi.fn();
    vi.mocked(api.updateTask).mockResolvedValueOnce({ ok: true, data: {} } as any);
    render(<ScheduleEditor task={task} onUpdate={onUpdate} />);
    turnOn();
    clickSave();
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: /Save Schedule/i })).toBeNull();
  });
});
