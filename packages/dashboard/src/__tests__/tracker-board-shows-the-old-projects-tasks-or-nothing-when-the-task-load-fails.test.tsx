// A failed task load must say so and must not leave another project's cards on the board.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { Task } from '@dojo/shared';
import { emitFrame, resetFrames } from './helpers/frames';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the page
// mounts on its own terms and only the doors below carry the story.
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
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return {
    useToast: () => stub.value,
    ToastProvider: ({ children }: { children: ReactElement }) => children,
  };
});

import * as api from '../lib/api';
import { Tracker } from '../pages/Tracker';

const mocked = () => vi.mocked(api);

/** The smallest task a card renders from: identity, column, and the foot line. */
const task = (id: string, title: string, projectId: string): Task =>
  ({
    id,
    title,
    projectId,
    status: 'on_deck',
    priority: 'normal',
    scheduleStatus: 'unscheduled',
    assignedTo: null,
    assignedToName: null,
    assignedToGroup: null,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  } as unknown as Task);

const BY_PROJECT: Record<string, Task[]> = {
  p1: [task('t1', 'Alpha one', 'p1')],
  p2: [task('t2', 'Beta one', 'p2')],
};

const renderTracker = () => render(<MemoryRouter><Tracker /></MemoryRouter>);

beforeEach(() => {
  resetFrames();
  const m = mocked();
  m.getProjects.mockResolvedValue({
    ok: true,
    data: [
      { id: 'p1', title: 'Alpha', status: 'active' },
      { id: 'p2', title: 'Beta', status: 'active' },
    ],
  } as never);
  m.getAgents.mockResolvedValue({ ok: true, data: [] } as never);
  m.getTasks.mockImplementation(async (filter) => ({
    ok: true,
    data: filter?.projectId ? BY_PROJECT[filter.projectId] ?? [] : Object.values(BY_PROJECT).flat(),
  }));
});
afterEach(() => { vi.clearAllMocks(); });

describe('a failed task load never shows the previous project’s cards', () => {
  it('shows the error and no stale cards when the new project’s load fails', async () => {
    renderTracker();
    await screen.findByText('Alpha one');
    fireEvent.change(screen.getByLabelText('Project filter'), { target: { value: 'p1' } });
    await waitFor(() => expect(screen.queryByText('Beta one')).toBeNull());
    expect(screen.getByText('Alpha one')).toBeTruthy();

    mocked().getTasks.mockImplementation(async () => ({ ok: false, error: 'db busy' }) as never);
    fireEvent.change(screen.getByLabelText('Project filter'), { target: { value: 'p2' } });
    await screen.findByText(/db busy/);
    expect(screen.queryByText('Alpha one'), 'project A’s card is still on project B’s board').toBeNull();
  });
});
