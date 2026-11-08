// ════════════════════════════════════════════════════════════════════════════
// A REFUSED PROJECT DELETE SAYS SO — and leaves the board where it was.
//
// The Tracker's "Yes, delete" button threw the answer away: it awaited
// `api.deleteProject` (a `ApiResponse<void>`, `lib/api.ts` 1275), then
// unconditionally moved the filter to 'all', closed the confirm row and
// reloaded. So a server refusal ("has running tasks") looked exactly like
// success — the board silently switched to All while the project stayed put.
//
// The button now takes the response: a refusal rides the dashboard's existing
// toast and touches nothing else; only a success returns to All and reloads.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
// The toast provider every page mounts inside, recorded not rendered — the
// refusal has to be observable as an `error` call with the server's sentence.
const toast = vi.hoisted(() => ({ calls: [] as Array<{ level: string; message: string }> }));
vi.mock('../hooks/useToast', () => {
  const record = (level: string) => (message: string) => { toast.calls.push({ level, message }); };
  const value = { toasts: [], addToast: () => {}, addActionToast: () => {}, removeToast: () => {}, removeToastByKey: () => {}, info: record('info'), success: record('success'), warning: record('warning'), error: record('error') };
  return { useToast: () => value, ToastProvider: ({ children }: { children: ReactElement }) => children, ToastContainer: () => null };
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

const filterValue = () => (screen.getByLabelText('Project filter') as HTMLSelectElement).value;

/** Mount the Tracker with project p1 selected: the action bar's delete control
    is then on screen. */
const renderOnProject = async () => {
  render(<MemoryRouter><Tracker /></MemoryRouter>);
  await screen.findByText('Alpha one');
  fireEvent.change(screen.getByLabelText('Project filter'), { target: { value: 'p1' } });
  await screen.findByRole('button', { name: 'Delete Project' });
};

/** Arm the confirm row, then answer it. */
const clickYesDelete = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Delete Project' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
};

beforeEach(() => {
  resetFrames();
  toast.calls.length = 0;
  const m = mocked();
  m.getProjects.mockResolvedValue({
    ok: true,
    data: [
      { id: 'p1', title: 'Alpha', status: 'active' },
      { id: 'p2', title: 'Beta', status: 'active' },
    ],
  } as never);
  m.getAgents.mockResolvedValue({ ok: true, data: [] } as never);
  m.getTasks.mockImplementation((filter) =>
    Promise.resolve({
      ok: true,
      data: filter?.projectId ? BY_PROJECT[filter.projectId] ?? [] : Object.values(BY_PROJECT).flat(),
    }));
});
afterEach(() => { vi.clearAllMocks(); });

describe('a refused project delete says so', () => {
  it('⚠ a refusal rides the toast and the project filter still shows the selected project', async () => {
    mocked().deleteProject.mockResolvedValue({ ok: false, error: 'has running tasks' } as never);
    await renderOnProject();
    clickYesDelete();

    await waitFor(() => expect(toast.calls).toContainEqual({ level: 'error', message: 'has running tasks' }));
    expect(
      filterValue(),
      'the board left a project the server refused to delete',
    ).toBe('p1');
  });

  it('an accepted delete returns the board to All', async () => {
    mocked().deleteProject.mockResolvedValue({ ok: true } as never);
    await renderOnProject();
    clickYesDelete();

    await waitFor(() => expect(filterValue()).toBe('all'));
    expect(toast.calls.filter((c) => c.level === 'error')).toEqual([]);
  });
});
