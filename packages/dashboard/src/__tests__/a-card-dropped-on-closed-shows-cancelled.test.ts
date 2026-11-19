import { describe, it, expect, vi } from 'vitest';
import type { Task } from '@dojo/shared';

vi.mock('../lib/api', () => ({ updateTask: vi.fn(async () => ({ ok: true, data: {} })), decideTask: vi.fn() }));

import * as api from '../lib/api';
import { cardMover } from '../pages/tracker-card-move';

const task = { id: 't1', status: 'in_progress', updatedAt: '2026-01-01T00:00:00.000Z' } as unknown as Task;

describe('a card dropped on Closed', () => {
  it('shows Cancelled at once and still sends the drop as it was', async () => {
    let board: Task[] = [task];
    const setTasks = (next: Task[] | ((prev: Task[]) => Task[])) => { board = typeof next === 'function' ? next(board) : next; };
    await cardMover([task], setTasks as never, () => {})('t1', 'fallen');
    expect(board[0].status).toBe('cancelled');
    expect(api.updateTask).toHaveBeenCalledWith('t1', { status: 'fallen' });
  });
});
