// A card dragged to Sent back asks the owner why and goes through his decision with that reason, never a
// raw status write; with no reason nothing is sent.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Task } from '@dojo/shared';

vi.mock('../lib/api', () => ({
  decideTask: vi.fn(async () => ({ ok: true, data: { to: 'sent_back', text: '' } })),
  updateTask: vi.fn(async () => ({ ok: true, data: {} })),
}));

import * as api from '../lib/api';
import { KanbanBoard } from '../components/KanbanBoard';
import { cardMover } from '../pages/tracker-card-move';
import { ToastProvider } from '../hooks/useToast';

const tasks = [{ id: 't1', title: 'Write the report', status: 'handed_in', priority: 'normal', assignedTo: null, scheduleStatus: 'unscheduled', runCount: 0, createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' } as unknown as Task];

const dropOnSentBack = () => {
  render(<ToastProvider><KanbanBoard tasks={tasks} onTaskClick={() => {}} onStatusChange={cardMover(tasks, vi.fn(), vi.fn())} /></ToastProvider>);
  const column = screen.getByText('Sent back', { selector: '.kcol__title' }).closest('.kcol') as HTMLElement;
  fireEvent.drop(column, { dataTransfer: { getData: () => 't1' } });
};

describe('a drag to Sent back records the owner\'s decision with a reason', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks why and sends it back through his decision', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('The totals are wrong');
    dropOnSentBack();
    await waitFor(() => expect(api.decideTask).toHaveBeenCalledWith('t1', 'send_back', 'The totals are wrong'));
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('sends nothing when he gives no reason', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    dropOnSentBack();
    await new Promise((r) => setTimeout(r, 0));
    expect(api.decideTask).not.toHaveBeenCalled();
    expect(api.updateTask).not.toHaveBeenCalled();
  });
});
