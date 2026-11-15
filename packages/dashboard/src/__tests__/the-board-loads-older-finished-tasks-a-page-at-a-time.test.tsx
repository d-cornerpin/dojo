// v3.5 field fix 3, re-review 2 S4: the board loads its FINISHED tasks a page at a time.
//
// The server pages the finished columns (Done, Closed) newest first and says whether an
// older page exists (`closedHasOlder`). The board shows what it was given and, when there is more, the
// existing small button (`btn btn--sm`) at the foot of those columns asks for the page before, with the
// cursor of the oldest finished task it holds. Nothing older is ever fetched unasked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { Task } from '@dojo/shared';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { Tracker } from '../pages/Tracker';

const mocked = () => vi.mocked(api);
const task = (id: string, title: string, status: Task['status'], completedAt: string | null): Task =>
  ({ id, title, projectId: 'p1', status, priority: 'normal', scheduleStatus: 'unscheduled', assignedTo: null, assignedToName: null,
    assignedToGroup: null, createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z', completedAt } as unknown as Task);

const OPEN = task('t-open', 'Still going', 'in_progress', null);
const NEW_DONE = task('t-new', 'Finished yesterday', 'complete', '2026-11-03 10:00:00');
const OLD_DONE = task('t-old', 'Finished last month', 'complete', '2026-10-01 10:00:00');

beforeEach(() => {
  resetFrames();
  const m = mocked();
  m.getProjects.mockResolvedValue({ ok: true, data: [{ id: 'p1', title: 'Alpha', status: 'active' }] } as never);
  m.getAgents.mockResolvedValue({ ok: true, data: [] } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('S4: older finished tasks come a page at a time', () => {
  it('with more on the server, the finished columns offer the page before; it is fetched with the cursor and added', async () => {
    mocked().getTasks
      .mockResolvedValueOnce({ ok: true, data: [OPEN, NEW_DONE], closedHasOlder: true } as never)
      .mockResolvedValueOnce({ ok: true, data: [OLD_DONE], closedHasOlder: false } as never);
    render(<MemoryRouter><Tracker /></MemoryRouter>);
    await screen.findByText('Finished yesterday');
    expect(screen.queryByText('Finished last month')).toBeNull();
    const more = screen.getAllByRole('button', { name: 'Show older finished tasks' });
    expect(more.length).toBeGreaterThan(0);
    expect(more[0].className).toBe('btn btn--sm');
    fireEvent.click(more[0]);
    await screen.findByText('Finished last month');
    expect(mocked().getTasks).toHaveBeenLastCalledWith(expect.objectContaining({ closedBefore: '2026-11-03 10:00:00', closedBeforeId: 't-new' }));
    expect(screen.getByText('Still going')).toBeTruthy();   // the live columns stay as they were
    await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Show older finished tasks' })).toHaveLength(0));
  });

  it('with nothing older, no such button is shown', async () => {
    mocked().getTasks.mockResolvedValue({ ok: true, data: [OPEN, NEW_DONE], closedHasOlder: false } as never);
    render(<MemoryRouter><Tracker /></MemoryRouter>);
    await screen.findByText('Finished yesterday');
    expect(screen.queryAllByRole('button', { name: 'Show older finished tasks' })).toHaveLength(0);
  });
});
