import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { AgentDetail } from '@dojo/shared';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  return stub;
});
const toast = vi.hoisted(() => ({ calls: [] as Array<{ level: string; message: string }> }));
vi.mock('../hooks/useToast', () => {
  const record = (level: string) => (message: string) => { toast.calls.push({ level, message }); };
  const value = { toasts: [], addToast: () => {}, addActionToast: () => {}, removeToast: () => {}, removeToastByKey: () => {}, info: record('info'), success: record('success'), warning: record('warning'), error: record('error') };
  return { useToast: () => value, ToastProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { AgentCard } from '../components/AgentCard';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { AuthProvider } from '../hooks/useAuth';

const agent = (over: Partial<AgentDetail> = {}): AgentDetail => ({
  id: 'a1', name: 'Kite', modelId: 'auto', status: 'idle', config: { orbHue: 172 }, agentType: 'standard', classification: 'ronin',
  createdAt: '', updatedAt: '', model: null, messageCount: 0, uptime: 0, permissions: null, toolsPolicy: null, equippedTechniques: [],
  ...over,
} as unknown as AgentDetail);

beforeEach(() => {
  toast.calls.length = 0;
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { key: 'setting', value: '' } } as never);
});
afterEach(() => { vi.clearAllMocks(); });

const show = (a: AgentDetail) => render(
  <MemoryRouter><AuthProvider><ActiveAgentProvider>
    <AgentCard agent={a} models={[]} providerNameById={{}} onModelChanged={() => undefined} />
  </ActiveAgentProvider></AuthProvider></MemoryRouter>,
);

describe('a refusal on the agent card says why', () => {
  it('a refused model change', async () => {
    vi.mocked(api.setAgentModel).mockResolvedValue({ ok: false, error: 'That model is too small for an agent.' } as never);
    show(agent({ modelId: 'm-old' }));
    fireEvent.click(screen.getByTitle('Change model'));
    fireEvent.change(document.querySelector('select') as HTMLSelectElement, { target: { value: 'auto' } });
    await waitFor(() => expect(toast.calls).toContainEqual({ level: 'error', message: 'That model is too small for an agent.' }));
  });
  it('a refused Stop', async () => {
    vi.mocked(api.stopAgent).mockResolvedValue({ ok: false, error: 'Nothing to stop.' } as never);
    show(agent({ status: 'working', inFlight: { turn: 1, background: 0 } } as Partial<AgentDetail>));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(toast.calls).toContainEqual({ level: 'error', message: 'Nothing to stop.' }));
  });
  it('a refused Dismiss', async () => {
    vi.mocked(api.terminateAgent).mockResolvedValue({ ok: false, error: 'Not allowed.' } as never);
    show(agent());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(toast.calls).toContainEqual({ level: 'error', message: 'Not allowed.' }));
  });
});
