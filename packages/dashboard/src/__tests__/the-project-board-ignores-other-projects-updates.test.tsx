// ════════════════════════════════════════════════════════════════════════════
// THE BOARD SHOWS TASKS OF THE PROJECT YOU DID NOT PICK.
//
// `Tracker` loads the selected project's tasks through `loadData`, but its
// `tracker:task_updated` handler lives in an effect that depends only on
// `[subscribe]` — it cannot see `selectedProjectId`. So for any task id not
// already in the list it appends `e.data` whatever project the task belongs
// to. Agents update tasks all day: with "View project: Alpha" selected, other
// projects' tasks kept landing on Alpha's board and the "N tasks" counter kept
// growing. And the other direction was wrong too — a task MOVED out of the
// selected project stayed on the board, because the in-place replace never
// looked at its project.
//
// The handler now reads the filter through a ref and checks each frame against
// it: a foreign task that is already on the board leaves, a foreign task that
// is not on the board never arrives, and the selected project's own updates
// behave exactly as before.
// ════════════════════════════════════════════════════════════════════════════

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
    ToastContainer: () => null,
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
  m.getOverrideRequests.mockResolvedValue({ ok: true, data: [] } as never);
  // Failure keeps the hygiene panel unrendered; the permissive `[]` would
  // crash it (it reads named fields off its data).
  m.getTrackerHygiene.mockResolvedValue({ ok: false, error: 'x' } as never);
  m.getTasks.mockImplementation(async (filter) => ({
    ok: true,
    data: filter?.projectId ? BY_PROJECT[filter.projectId] ?? [] : Object.values(BY_PROJECT).flat(),
  }));
});
afterEach(() => { vi.clearAllMocks(); });

describe('the project board ignores other projects’ updates', () => {
  it('⚠ with All projects selected, any project’s task lands on the board', async () => {
    renderTracker();
    await screen.findByText('Alpha one');
    await screen.findByText('Beta one');

    act(() => { emitFrame('tracker:task_updated', { data: task('t3', 'Gamma new', 'p2') }); });
    expect(screen.getByText('Gamma new'), 'the all-projects view still takes a new task').toBeTruthy();
  });

  it('⚠ with Alpha selected, another project’s task never reaches the board', async () => {
    renderTracker();
    await screen.findByText('Alpha one');
    await screen.findByText('Beta one');

    fireEvent.change(screen.getByLabelText('Project filter'), { target: { value: 'p1' } });
    await waitFor(() => expect(screen.queryByText('Beta one'), 'the reload for Alpha finished').toBeNull());

    act(() => { emitFrame('tracker:task_updated', { data: task('t4', 'Other project task', 'p2') }); });
    expect(screen.queryByText('Other project task'), 'a p2 task joined Alpha’s board').toBeNull();
  });

  it('⚠ with Alpha selected, its own updates land and a task moved away leaves', async () => {
    renderTracker();
    await screen.findByText('Alpha one');
    await screen.findByText('Beta one');

    fireEvent.change(screen.getByLabelText('Project filter'), { target: { value: 'p1' } });
    await waitFor(() => expect(screen.queryByText('Beta one')).toBeNull());

    act(() => { emitFrame('tracker:task_updated', { data: task('t5', 'Alpha two', 'p1') }); });
    expect(screen.getByText('Alpha two'), 'the selected project’s own new task was refused').toBeTruthy();

    // Same id, now belonging to p2: it is no longer Alpha’s, so the board
    // must drop it — an in-place replace would leave it standing there.
    act(() => { emitFrame('tracker:task_updated', { data: task('t1', 'Alpha one', 'p2') }); });
    await waitFor(() =>
      expect(screen.queryByText('Alpha one'), 'a task moved out of the selected project stayed on the board')
        .toBeNull());
  });
});
