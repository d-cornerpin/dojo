// A delete or a history clear that the server REFUSES must say why: the owner
// sees the reason and the delete they made is not quietly undone. The task-card
// delete and the terminated-agent delete both used to read the api answer and
// close the confirm as if it had worked, so a refusal left the owner with no
// word of why. The agent-history clear (pages/Agents.tsx handleClearHistory) is
// fixed in the same way but is driven only through the whole Agents page, so it
// stays in the source and out of this component-level test.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Task, AgentDetail } from '@dojo/shared';

vi.mock('../lib/api', async () => {
  const permissive = async () => ({ ok: true, data: [] });
  return {
    __esModule: true,
    getAgents: vi.fn(async () => ({ ok: true, data: [] })),
    getModels: vi.fn(async () => ({ ok: true, data: [] })),
    getProviders: vi.fn(async () => ({ ok: true, data: [] })),
    getSettings: vi.fn(async () => ({ ok: true, data: {} })),
    getSetting: vi.fn(async () => ({ ok: true, data: { value: 's' } })),
    getToken: vi.fn(() => null),
    clearToken: vi.fn(),
    deleteTask: vi.fn(async () => ({ ok: true, data: [] })),
    purgeAgent: vi.fn(async () => ({ ok: true, data: [] })),
    archiveOldAgents: vi.fn(async () => ({ ok: true, data: [] })),
    // The rest of the surface is permissive so a mount-time fetch never touches
    // the network.
    getProviderHealth: vi.fn(async () => ({ ok: true, data: [] })),
    getAgent: vi.fn(async () => ({ ok: true, data: {} })),
    updateAgentConfig: vi.fn(async () => ({ ok: true, data: {} })),
    setAgentModel: vi.fn(async () => ({ ok: true, data: {} })),
    stopAgent: vi.fn(async () => ({ ok: true, data: {} })),
    terminateAgent: vi.fn(async () => ({ ok: true, data: {} })),
    ...Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `fn${i}`,
        vi.fn(permissive),
      ]),
    ),
  } as unknown as typeof import('../lib/api');
});

vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: unknown }) => children };
});

import * as api from '../lib/api';
import { TaskCard } from '../components/TaskCard';
import { AgentCard } from '../components/AgentCard';
import { AuthProvider } from '../hooks/useAuth';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { ToastProvider, ToastContainer } from '../hooks/useToast';

// A plain, non-recurring task: nothing special renders, so the delete affordance
// is the only interactive thing the test drives.
const task = {
  id: 'task-1',
  title: 'Refactor the queue',
  priority: 'normal',
  status: 'on_deck',
  scheduleStatus: 'unscheduled',
  runCount: 0,
  repeatInterval: null,
  repeatUnit: null,
  repeatDaysOfWeek: null,
  nextRunAt: null,
  pausedUntil: null,
  assignedTo: null,
  assignedToName: null,
  assignedToGroup: null,
  updatedAt: '2026-10-30T00:00:00Z',
} as unknown as Task;

// The delete affordance on a card only appears for a terminated, non-sensei
// agent, so this is what the card offers "Delete agent" for.
const endedAgent = {
  id: 'a1',
  name: 'Old Dock',
  modelId: null,
  status: 'terminated',
  parkedCause: null,
  config: {},
  agentType: 'standard',
  classification: 'apprentice',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
  model: null,
  messageCount: 3,
  uptime: 0,
  permissions: null,
  toolsPolicy: null,
  equippedTechniques: [],
} as unknown as AgentDetail;

describe('the task card delete', () => {
  it('a refused delete says so and does not drop the card', async () => {
    const onDeleted = vi.fn();
    vi.mocked(api.deleteTask).mockResolvedValueOnce({ ok: false, error: 'locked' });
    render(
      <ToastProvider>
        <TaskCard task={task} onClick={() => {}} onDeleted={onDeleted} />
        <ToastContainer />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await screen.findByText('locked');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('an accepted delete drops the card, as before', async () => {
    const onDeleted = vi.fn();
    vi.mocked(api.deleteTask).mockResolvedValueOnce({ ok: true, data: undefined } as any);
    render(
      <ToastProvider>
        <TaskCard task={task} onClick={() => {}} onDeleted={onDeleted} />
        <ToastContainer />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });
});

describe('the agent card delete', () => {
  const show = (onModelChanged: () => void) =>
    render(
      <ToastProvider>
        <MemoryRouter>
          <AuthProvider>
            <ActiveAgentProvider>
              <AgentCard
                agent={endedAgent}
                models={[]}
                providerNameById={{}}
                onModelChanged={onModelChanged}
              />
            </ActiveAgentProvider>
          </AuthProvider>
        </MemoryRouter>
        <ToastContainer />
      </ToastProvider>,
    );

  it('a refused purge says so and does not reload', async () => {
    const onModelChanged = vi.fn();
    vi.mocked(api.purgeAgent).mockResolvedValueOnce({ ok: false, error: 'locked' });
    show(onModelChanged);
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await screen.findByText('locked');
    expect(onModelChanged).not.toHaveBeenCalled();
  });

  it('an accepted purge reloads, as before', async () => {
    const onModelChanged = vi.fn();
    vi.mocked(api.purgeAgent).mockResolvedValueOnce({ ok: true, data: undefined } as any);
    show(onModelChanged);
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(onModelChanged).toHaveBeenCalledTimes(1));
  });
});
