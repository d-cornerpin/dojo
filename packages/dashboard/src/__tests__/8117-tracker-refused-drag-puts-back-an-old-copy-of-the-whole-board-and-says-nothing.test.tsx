// A refused card move must put back only THAT card (not an old copy of the whole
// board, which would undo updates other agents sent meanwhile) and say why.

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
const toastStub = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./helpers/frames').fakeToast> }));
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  toastStub.current = stub;
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

const A = task('tA', 'Card A', 'p1');
const B = task('tB', 'Card B old title', 'p1');

beforeEach(() => {
  resetFrames();
  if (toastStub.current) toastStub.current.calls.length = 0;
  const m = mocked();
  m.getProjects.mockResolvedValue({ ok: true, data: [{ id: 'p1', title: 'Alpha', status: 'active' }] } as never);
  m.getAgents.mockResolvedValue({ ok: true, data: [] } as never);
  m.getTrackerHygiene.mockResolvedValue({ ok: false, error: 'x' } as never);
  m.getTasks.mockResolvedValue({ ok: true, data: [A, B] } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('a refused card move', () => {
  it('puts back only that card, keeps newer updates to other cards, and says why', async () => {
    let answer: (v: unknown) => void = () => {};
    mocked().updateTask.mockImplementation(() => new Promise((res) => { answer = res; }) as never);

    const { container } = render(<MemoryRouter><Tracker /></MemoryRouter>);
    await screen.findByText('Card A');
    const cols = () => Array.from(container.querySelectorAll('.kcol')) as HTMLElement[];
    const colOf = (label: string) => cols().find((c) => c.textContent?.includes(label))!;

    fireEvent.drop(colOf('In Progress'), { dataTransfer: { getData: () => 'tA' } });
    await waitFor(() => expect(colOf('In Progress').textContent).toContain('Card A'));

    act(() => { emitFrame('tracker:task_updated', { data: { ...B, title: 'Card B new title' } }); });
    await screen.findByText('Card B new title');

    await act(async () => { answer({ ok: false, error: 'not allowed' }); });

    await waitFor(() => expect(colOf('On Deck').textContent).toContain('Card A'));
    expect(colOf('In Progress').textContent).not.toContain('Card A');
    expect(screen.getByText('Card B new title')).toBeTruthy();
    expect(screen.queryByText('Card B old title')).toBeNull();
    expect(toastStub.current!.calls).toContainEqual({ level: 'error', message: 'not allowed' });
  });
});
