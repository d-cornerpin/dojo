// Nothing on the board asks the owner to validate: no chip, no hygiene panel, and the decision
// buttons only on a handed-in task.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: ReactElement }) => children, ToastContainer: () => null };
});

import * as api from '../lib/api';
import { Tracker, TaskDetailPanel } from '../pages/Tracker';

const task = (id: string, status: Task['status']): Task =>
  ({ id, title: `Task ${id}`, projectId: null, status, hold: null, priority: 'normal', scheduleStatus: 'unscheduled', assignedTo: null,
    assignedToName: null, assignedToGroup: null, assigneeGone: false, dependsOn: [], evidence: [], phase: 1, runCount: 0,
    createdAt: '2026-11-01 00:00:00', updatedAt: new Date().toISOString(), completedAt: null } as unknown as Task);

const panel = (t: Task) => render(<MemoryRouter><TaskDetailPanel task={t} agents={[]} allTasks={[t]} onClose={() => {}} onUpdate={() => {}} /></MemoryRouter>);

beforeEach(() => {
  resetFrames();
  vi.mocked(api).getProjects.mockResolvedValue({ ok: true, data: [] } as never);
  vi.mocked(api).getAgents.mockResolvedValue({ ok: true, data: [] } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('nothing on the board asks the owner to validate', () => {
  it('shows a done task with no validation chip and the page with no hygiene panel', async () => {
    vi.mocked(api).getTasks.mockResolvedValue({ ok: true, data: [task('t1', 'complete')], closedHasOlder: false } as never);
    render(<MemoryRouter><Tracker /></MemoryRouter>);
    await screen.findByText('Task t1');
    expect(screen.queryByText(/validat/i)).toBeNull();
    expect(screen.queryByText(/hygiene/i)).toBeNull();
  });

  it('offers Approve and Send back on a handed-in task', () => {
    panel(task('t1', 'handed_in'));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send back' })).toBeTruthy();
  });

  it('never offers the owner "Couldn\'t be done", which only a worker\'s hand-in can say', () => {
    panel(task('t1', 'in_progress'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).not.toContain("Couldn't be done");
  });

  it('offers no decision on any other task', () => {
    for (const status of ['on_deck', 'in_progress', 'sent_back', 'complete'] as const) {
      const { unmount } = panel(task(`t-${status}`, status));
      expect(screen.queryByRole('button', { name: 'Approve' }), status).toBeNull();
      expect(screen.queryByRole('button', { name: 'Send back' }), status).toBeNull();
      expect(screen.queryByText(/validat|override/i), status).toBeNull();
      unmount();
    }
  });
});
