// A single failed agent-list refresh (a reconnect, or a new-agent event landing while the
// server restarts) must not replace the loaded Agents page with an error for the rest of the
// visit. The agents already loaded stay on screen with a one-line warning, and a later good
// refresh clears the warning.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { AgentDetail } from '@dojo/shared';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.getSetting = vi.fn(async () => ({ ok: true, data: { key: 'setting', value: '' } }));
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { Agents } from '../pages/Agents';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { AuthProvider } from '../hooks/useAuth';
import { ThemeProvider } from '../themes/ThemeProvider';
import { emitFrame, resetFrames } from './helpers/frames';

const agent = {
  id: 'a1', name: 'Dock Desk', modelId: 'auto', status: 'idle', parkedCause: null, config: {}, agentType: 'standard',
  classification: 'ronin', createdAt: '', updatedAt: '', model: null, messageCount: 0, uptime: 0, permissions: null,
  toolsPolicy: null, equippedTechniques: [],
} as unknown as AgentDetail;

const getAgents = () => api.getAgents as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { resetFrames(); vi.clearAllMocks(); });

const mount = () => render(
  <MemoryRouter><AuthProvider><ThemeProvider><ActiveAgentProvider><Agents /></ActiveAgentProvider></ThemeProvider></AuthProvider></MemoryRouter>,
);

describe('a failed agents refresh does not blank the page', () => {
  it('keeps the loaded agent on screen and shows the reason, then clears it on a good refresh', async () => {
    // mockResolvedValue: the page loads twice on mount (initial load and the connect transition).
    getAgents().mockResolvedValue({ ok: true, data: [agent] });
    mount();
    await screen.findByText('Dock Desk');

    getAgents().mockResolvedValue({ ok: false, error: 'down' });
    act(() => emitFrame('agent:created', {}));
    await waitFor(() => expect(screen.getByText(/down/)).toBeTruthy());
    expect(screen.getByText('Dock Desk')).toBeTruthy();

    getAgents().mockResolvedValue({ ok: true, data: [agent] });
    act(() => emitFrame('agent:created', {}));
    await waitFor(() => expect(screen.queryByText(/down/)).toBeNull());
    expect(screen.getByText('Dock Desk')).toBeTruthy();
  });

  it('CONTROL: a first load that fails still shows only the error', async () => {
    getAgents().mockResolvedValue({ ok: false, error: 'down' });
    mount();
    await screen.findByText('down');
    expect(screen.queryByText('Dock Desk')).toBeNull();
  });
});
