// After the live connection drops and returns, Chat asks again: replies and the working/idle
// state sent in the gap were lost. The shared reconnect signal (`reconnectCount`) drives it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { emitFrame, resetFrames, setReconnectCount } from './helpers/frames';

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
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return {
    useToast: () => stub.value,
    ToastProvider: ({ children }: { children: ReactElement }) => children,
    ToastContainer: () => null,
  };
});

import * as api from '../lib/api';
import { AuthProvider } from '../hooks/useAuth';
import { Chat } from '../pages/Chat';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';
import { ThemeProvider } from '../themes/ThemeProvider';

const AGENT = 'primary';
const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider><ThemeProvider><OrbProvider><ActiveAgentProvider>
      <RightDockProvider><TechniqueSessionProvider>{page}</TechniqueSessionProvider></RightDockProvider>
    </ActiveAgentProvider></OrbProvider></ThemeProvider></AuthProvider>
  </MemoryRouter>
);

const msg = (id: string, role: 'user' | 'assistant', content: string, t: string) =>
  ({ id, role, content, createdAt: t, attachments: [], conversationId: 'c1' });
const M1 = msg('m1', 'user', 'first question here', '2026-10-30T10:00:00.000Z');
const M2 = msg('m2', 'assistant', 'reply sent during the gap', '2026-10-30T10:00:05.000Z');

// Older pages (a `before` cursor) are empty: the backfill stops there. Only the newest page counts.
const history = (rows: unknown[]) =>
  vi.mocked(api).getChatHistory.mockImplementation((async (_id: string, _l?: number, before?: string) => (
    { ok: true, data: before ? [] : rows }
  )) as unknown as typeof api.getChatHistory);
const newestPageCalls = () => vi.mocked(api).getChatHistory.mock.calls.filter((c) => !c[2]).length;
const agent = (status: string) =>
  vi.mocked(api).getAgent.mockResolvedValue({
    ok: true, data: { id: AGENT, name: 'Agent', status, inFlight: { turn: 0, background: 0 } },
  } as unknown as Awaited<ReturnType<typeof api.getAgent>>);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

beforeEach(() => { resetFrames(); });
afterEach(() => { vi.resetAllMocks(); });

describe('chat catches up after a reconnect', () => {
  it('(a) a reply sent in the gap appears, and nothing is doubled', async () => {
    history([M1]); agent('idle');
    const { rerender } = render(shell(<Chat />));
    await waitFor(() => expect(screen.queryByText('first question here')).not.toBeNull());
    history([M1, M2]);
    setReconnectCount(1);
    rerender(shell(<Chat />));
    await waitFor(() => expect(screen.queryByText('reply sent during the gap')).not.toBeNull());
    expect(screen.queryAllByText('first question here').length).toBe(1);
  });

  it('(b) a lost closing status frame: the answer says idle and the Stop control goes', async () => {
    history([M1]); agent('idle');
    const { rerender } = render(shell(<Chat />));
    await waitFor(() => expect(vi.mocked(api).getAgent).toHaveBeenCalled());
    await settle();
    act(() => { emitFrame('agent:status', { agentId: AGENT, status: 'working', userFacing: true }); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeNull());
    agent('idle');
    setReconnectCount(1);
    rerender(shell(<Chat />));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
  });

  it('(d) a streaming bubble whose turn ended is replaced by its stored final message, or removed', async () => {
    history([M1]); agent('idle');
    const { rerender } = render(shell(<Chat />));
    await waitFor(() => expect(vi.mocked(api).getAgent).toHaveBeenCalled());
    await settle();
    act(() => {
      emitFrame('agent:status', { agentId: AGENT, status: 'working', userFacing: true });
      emitFrame('chat:chunk', { agentId: AGENT, messageId: 'm2', content: 'half a repl', done: false });
      emitFrame('chat:chunk', { agentId: AGENT, messageId: 'm3', content: 'a lost sentence', done: false });
    });
    await waitFor(() => expect(screen.queryByText(/half a repl/)).not.toBeNull());
    expect(screen.queryByText(/a lost sentence/)).not.toBeNull();
    history([M1, M2]); agent('idle'); // m2 finished while we were away; m3 has no stored message
    setReconnectCount(1);
    rerender(shell(<Chat />));
    await waitFor(() => expect(screen.queryByText('reply sent during the gap')).not.toBeNull());
    expect(screen.queryByText(/half a repl/)).toBeNull();
    expect(screen.queryByText(/a lost sentence/)).toBeNull();
  });

  it('(c) first mount asks for history once', async () => {
    history([M1]); agent('idle');
    render(shell(<Chat />));
    await waitFor(() => expect(screen.queryByText('first question here')).not.toBeNull());
    await settle();
    expect(newestPageCalls()).toBe(1);
  });
});
