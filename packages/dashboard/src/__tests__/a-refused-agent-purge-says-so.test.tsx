// A refused agent purge must say so — clicking "Yes" on "Delete permanently?"
// used to swallow the answer of `purgeAgent`, so a refusal (agent still running,
// a server error) reloaded the list unchanged and the owner believed the delete
// happened. The row now says the server's reason and keeps the confirm open.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { AgentDetail } from '@dojo/shared';
import { resetFrames } from './helpers/frames';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the page
// mounts on its own terms and the doors this file is about are the only overrides.
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

import * as api from '../lib/api';
import { Agents } from '../pages/Agents';
import { AuthProvider } from '../hooks/useAuth';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { ToastProvider } from '../hooks/useToast';

// One terminated, non-sensei agent: it sits in "Recent History" and its row shows
// a delete control.
const ENDED_AGENT = {
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

const renderAgents = () => render(
  <MemoryRouter>
    <AuthProvider>
        <ActiveAgentProvider>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </ActiveAgentProvider>
    </AuthProvider>
  </MemoryRouter>,
);

// Expand "Recent History", open the terminated row, and open its delete confirm.
const openConfirm = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /recent history/i }));
  fireEvent.click(screen.getByText('Old Dock'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.getByText('Delete permanently?')).toBeTruthy();
};

beforeEach(() => {
  resetFrames();
  vi.mocked(api.getAgents).mockResolvedValue({ ok: true, data: [ENDED_AGENT] } as never);
});

describe('a refused agent purge says so', () => {
  it('a refusal keeps the confirm row open, says the server\'s reason, and does not reload the list', async () => {
    vi.mocked(api.purgeAgent).mockResolvedValue({ ok: false, error: 'still busy' } as never);
    renderAgents();
    await openConfirm();

    const getAgents = vi.mocked(api.getAgents);
    const before = getAgents.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('still busy');
    // a refusal must not re-fetch the list
    expect(getAgents.mock.calls.length).toBe(before);
    // ...and the confirm row must stay open for the owner to see it and retry
    expect(screen.getByText('Delete permanently?')).toBeTruthy();
  });

  it('an accepted purge closes the confirm row', async () => {
    vi.mocked(api.purgeAgent).mockResolvedValue({ ok: true, data: undefined } as never);
    renderAgents();
    await openConfirm();

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(screen.queryByText('Delete permanently?')).toBeNull());
  });
});
