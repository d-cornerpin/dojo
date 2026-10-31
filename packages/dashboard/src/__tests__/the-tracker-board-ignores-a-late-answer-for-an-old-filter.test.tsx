// ════════════════════════════════════════════════════════════════════════════
// THE BOARD FLIPS BACK TO A PROJECT THAT WAS ALREADY LEFT.
//
// `Tracker` re-creates `loadData` per `selectedProjectId` and re-runs it from
// the effect, but every run wrote its answers unconditionally. Picking project
// A and then B before A's `getTasks` came back let A's slower answer arrive
// last: the dropdown said B, the board showed A. The same stale run could also
// rewrite projects, agents and the loading flag. The websocket guard
// (`selectedProjectIdRef`) only covers live frames, not this fetch.
//
// `loadData` now stamps each run and returns before any state write once a
// newer run has started, so a superseded call sets nothing at all.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { Task } from '@dojo/shared';
import { resetFrames } from './helpers/frames';

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

// The old project's answer waits on this; the test decides when it lands, so
// it can arrive after the newer project's board is already on screen.
let slowP1: ((v: unknown) => void) | null = null;

const renderTracker = () => render(<MemoryRouter><Tracker /></MemoryRouter>);

beforeEach(() => {
  resetFrames();
  slowP1 = null;
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
  m.getTasks.mockImplementation((filter) =>
    filter?.projectId === 'p1'
      ? new Promise((res) => { slowP1 = res; })
      : Promise.resolve({
          ok: true,
          data: filter?.projectId ? BY_PROJECT[filter.projectId] ?? [] : Object.values(BY_PROJECT).flat(),
        }));
});
afterEach(() => { vi.clearAllMocks(); });

describe('the tracker board ignores a late answer for an old filter', () => {
  it('⚠ a slow answer for the old project does not replace the newer project’s tasks', async () => {
    renderTracker();
    await screen.findByText('Alpha one');

    fireEvent.change(screen.getByLabelText('Project filter'), { target: { value: 'p1' } });
    await waitFor(() => expect(slowP1).not.toBeNull());

    fireEvent.change(screen.getByLabelText('Project filter'), { target: { value: 'p2' } });

    await waitFor(() => expect(screen.queryByText('Alpha one')).toBeNull());
    expect(screen.getByText('Beta one')).toBeTruthy();

    await act(async () => { slowP1!({ ok: true, data: BY_PROJECT.p1 }); });

    expect(screen.queryByText('Alpha one'), 'the old project’s late answer redrew the board').toBeNull();
    expect(screen.getByText('Beta one')).toBeTruthy();
  });
});
