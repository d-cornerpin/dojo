// ════════════════════════════════════════════════════════════════════════════════════════
// Rulings audit #14 (M20). The owner: "Dreaming is a core principal of the Dojo and I don't believe it can run
// effectively without dreaming." The main agent's config page offered "Skip in Dreamer cycle"; it no longer does.
// Other agents keep the toggle (ephemeral test agents).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  return stub;
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: ReactElement }) => children };
});

vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: unknown }) => children };
});

import * as api from '../lib/api';
import { AgentConfigPanel } from '../pages/AgentConfigPanel';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';


const detail = (id: string, name: string) => ({
  ok: true, data: { id, name, classification: 'worker', status: 'idle', modelId: 'auto', inFlight: { turn: 0, background: 0 } },
});
const open = (id: string) => render(
  <MemoryRouter initialEntries={[`/agents/${id}`]}>
    <ActiveAgentProvider><Routes><Route path="agents/:id" element={<AgentConfigPanel />} /></Routes></ActiveAgentProvider>
  </MemoryRouter>,
);
const arrange = () => {
  vi.mocked(api).getAgent.mockImplementation((async (id: string) => detail(id, id === 'main' ? 'Main-Agent' : 'Helper-Agent')) as unknown as typeof api.getAgent);
  vi.mocked(api).getSetting.mockImplementation((async (key: string) => ({ ok: true, data: { key, value: key === 'primary_agent_id' ? 'main' : 'Main-Agent' } })) as unknown as typeof api.getSetting);
};

afterEach(() => { vi.resetAllMocks(); });

describe('the main agent always dreams: no Skip-in-Dreamer toggle on its page', () => {
  it('the main agent\'s page has no "Skip in Dreamer cycle"', async () => {
    arrange();
    open('main');
    await waitFor(() => expect(screen.queryAllByText('Main-Agent').length).toBeGreaterThan(0));
    await waitFor(() => expect(api.getSetting).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Skip in Dreamer cycle')).toBeNull();
  });

  it('CONTROL: another agent\'s page keeps it', async () => {
    arrange();
    open('helper');
    await waitFor(() => expect(screen.queryByText('Skip in Dreamer cycle')).not.toBeNull());
  });
});
