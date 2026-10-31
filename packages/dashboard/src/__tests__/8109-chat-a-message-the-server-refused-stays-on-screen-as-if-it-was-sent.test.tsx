// X connection drops and returns, Chat asks again: replies and the working/idle
// state sent in the gap were lost. The shared reconnect signal (`reconnectCount`) drives it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

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
  (globalThis as { __toastStub?: typeof stub }).__toastStub = stub;
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


const toasts = () => (globalThis as unknown as { __toastStub: { calls: Array<{ level: string; message: string }> } }).__toastStub.calls;
const history = () =>
  vi.mocked(api).getChatHistory.mockImplementation((async () => ({ ok: true, data: [] })) as unknown as typeof api.getChatHistory);
const agent = () =>
  vi.mocked(api).getAgent.mockResolvedValue({
    ok: true, data: { id: AGENT, name: 'Agent', status: 'idle', inFlight: { turn: 0, background: 0 } },
  } as unknown as Awaited<ReturnType<typeof api.getAgent>>);
const typeAndSend = async (text: string) => {
  const box = await screen.findByPlaceholderText('Message the Dojo');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
};

beforeEach(() => { resetFrames(); toasts().length = 0; });
afterEach(() => { vi.resetAllMocks(); });

describe('a refused chat message', () => {
  it('leaves no sent bubble and the toast carries the owner text', async () => {
    history(); agent();
    vi.mocked(api).sendMessage.mockResolvedValue({ ok: false, error: 'Agent is terminated' } as never);
    render(shell(<Chat />));
    await typeAndSend('hello there');
    await waitFor(() => expect(vi.mocked(api).sendMessage).toHaveBeenCalled());
    await waitFor(() => expect(toasts().some((t) => t.level === 'error')).toBe(true));
    const msg = toasts().find((t) => t.level === 'error')!.message;
    expect(msg).toContain('Agent is terminated');
    expect(msg).toContain('hello there');
    expect(screen.queryByText('hello there')).toBeNull();
  });

  it('a long refused message comes back whole', async () => {
    history(); agent();
    vi.mocked(api).sendMessage.mockResolvedValue({ ok: false, error: 'Agent is terminated' } as never);
    const long = 'word '.repeat(150).trim() + ' THE-END';
    render(shell(<Chat />));
    await typeAndSend(long);
    await waitFor(() => expect(toasts().some((t) => t.level === 'error')).toBe(true));
    expect(toasts().find((t) => t.level === 'error')!.message).toContain('THE-END');
  });

  it('a sent message keeps its bubble', async () => {
    history(); agent();
    vi.mocked(api).sendMessage.mockResolvedValue({ ok: true, data: {} } as never);
    render(shell(<Chat />));
    await typeAndSend('hello there');
    await waitFor(() => expect(screen.queryByText('hello there')).not.toBeNull());
    expect(toasts().some((t) => t.level === 'error')).toBe(false);
  });
});
