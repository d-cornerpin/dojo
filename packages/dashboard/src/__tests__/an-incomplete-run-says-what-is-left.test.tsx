// v3.5 DONE IS MEASURED (t250 fix round 4) — a run that ran and ended with its task's measure still
// listing items reads "Incomplete — N <unit> left" in the owner's run history, never "Skipped"
// (which the history means as "never ran"), and is not shown in the error colour.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getTaskRuns: vi.fn(async () => ({
      ok: true,
      data: [
        {
          id: 'r2', taskId: 't', runNumber: 2, scheduledFor: '2026-10-22 09:00:00',
          startedAt: '2026-10-22T09:00:01.000Z', completedAt: '2026-10-22T09:04:00.000Z',
          status: 'incomplete', statusLabel: 'Incomplete — 5 messages left',
          assignedTo: 'a', agentName: 'An agent', resultSummary: 'closed on that delivery', error: null,
        },
        {
          id: 'r1', taskId: 't', runNumber: 1, scheduledFor: '2026-10-21 09:00:00',
          startedAt: null, completedAt: null, status: 'skipped', statusLabel: null,
          assignedTo: null, agentName: null, resultSummary: 'no agent', error: 'no agent',
        },
      ],
    })),
  };
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import { TaskRunHistory } from '../components/TaskRunHistory';

describe('the run history names what an incomplete run left', () => {
  it('shows "Incomplete — 5 messages left", and only the real skip reads Skipped', async () => {
    render(<TaskRunHistory taskId="t" />);
    const badge = await screen.findByText('Incomplete — 5 messages left');
    expect(badge.className).not.toMatch(/coral/);
    expect(screen.getAllByText(/^skipped$/i)).toHaveLength(1);
  });
});
