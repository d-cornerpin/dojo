import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { emitFrame, resetFrames } from './helpers/frames';

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
const toastCalls = vi.hoisted(() => ({ list: [] as Array<{ level: string; message: string }> }));
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  toastCalls.list = stub.calls;
  return {
    useToast: () => stub.value,
    ToastProvider: ({ children }: { children: ReactElement }) => children,
  };
});

import * as api from '../lib/api';
import { AuthProvider } from '../hooks/useAuth';
import { Chat } from '../pages/Chat';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';
import { FX } from '../../../../deploy/checks/fixture-vocabulary.mjs';

/** The agent the ActiveAgentProvider defaults to with no selection and no list. */
const AGENT = 'primary';

/** App.tsx's own nesting, as `every-major-page-mounts.test.tsx` spells it. */
const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider><OrbProvider><ActiveAgentProvider>
      <RightDockProvider><TechniqueSessionProvider>{page}</TechniqueSessionProvider></RightDockProvider>
    </ActiveAgentProvider></OrbProvider></AuthProvider>
  </MemoryRouter>
);


async function arrive(): Promise<void> {
  vi.mocked(api).getAgent.mockResolvedValue({ ok: true, data: { id: AGENT, name: FX.n4, status: 'idle', inFlight: { turn: 0, background: 0 } } } as unknown as Awaited<ReturnType<typeof api.getAgent>>);
  render(shell(<Chat />));
  await waitFor(() => expect(api.getAgent).toHaveBeenCalled());
}
beforeEach(() => { resetFrames(); toastCalls.list.length = 0; });
afterEach(() => { vi.clearAllMocks(); });

describe('the agent on screen ends', () => {
  it('a plain information toast, never a red one', async () => {
    await arrive();
    act(() => { emitFrame('agent:terminated', { agentId: AGENT, reason: 'Killed by agent a-0001' }); });
    expect(toastCalls.list).toContainEqual({ level: 'info', message: 'This agent has ended, so it will not answer here any more.' });
    expect(toastCalls.list.some((c) => c.level === 'error' && /terminated|ended/i.test(c.message))).toBe(false);
  });
});
