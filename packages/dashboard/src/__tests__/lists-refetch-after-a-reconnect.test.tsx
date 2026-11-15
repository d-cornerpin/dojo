// The shared reconnect signal. The provider counts every reconnect (not the first connect);
// each page that keeps a list from live frames re-asks for its current view when the count
// moves. Frames sent while the socket was down are gone, so without this the lists stay stale.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames, setReconnectCount } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => 'a.e30.b'); // a token with no expiry: the provider case connects
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
  };
});

import * as api from '../lib/api';
import { Tracker } from '../pages/Tracker';
import { Techniques } from '../pages/Techniques';
import { InterAgentLane } from '../pages/InterAgentLane';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { AuthProvider } from '../hooks/useAuth';
import { OrbProvider } from '../components/orb/OrbProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';

const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider><OrbProvider><ActiveAgentProvider>
      <RightDockProvider><TechniqueSessionProvider>{page}</TechniqueSessionProvider></RightDockProvider>
    </ActiveAgentProvider></OrbProvider></AuthProvider>
  </MemoryRouter>
);

const mocked = () => vi.mocked(api) as unknown as Record<string, ReturnType<typeof vi.fn>>;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

beforeEach(() => {
  resetFrames();
});
afterEach(() => { vi.clearAllMocks(); });

/** Render, let the first load finish, bump the signal 0 -> 1, and report the call counts. */
async function bump(ui: () => ReactElement, calls: () => number) {
  const { rerender } = render(ui());
  await waitFor(() => expect(calls()).toBeGreaterThan(0));
  await settle();
  const atMount = calls();
  setReconnectCount(1);
  rerender(ui());
  await settle();
  return { atMount, after: calls() };
}

describe('a page re-asks for its current view after a reconnect', () => {
  it('Tracker refetches its tasks', async () => {
    const { atMount, after } = await bump(() => shell(<Tracker />), () => mocked().getTasks.mock.calls.length);
    expect(atMount).toBe(1);
    expect(after).toBe(2);
  });

  it('Techniques refetches', async () => {
    const n = () => mocked().request.mock.calls.filter((c) => String(c[0]).includes('/techniques')).length;
    const { atMount, after } = await bump(() => shell(<Techniques />), n);
    expect(atMount).toBe(1);
    expect(after).toBe(2);
  });

  it('the agent-to-agent lane refetches without blanking what is on screen', async () => {
    const { atMount, after } = await bump(
      () => shell(<InterAgentLane />), () => mocked().getInterAgentMessages.mock.calls.length);
    expect(atMount).toBe(1);
    expect(after).toBe(2);
  });
});

describe('the provider counts reconnects', () => {
  class FakeSocket {
    static all: FakeSocket[] = [];
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    onmessage: unknown = null; onerror: unknown = null;
    constructor(public url: string) { FakeSocket.all.push(this); }
    send() {} close() {}
    open() { this.readyState = 1; this.onopen?.(); }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  }

  it('first open leaves the count at 0; drop then reopen makes it 1', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.all = [];
    const real = await vi.importActual<typeof import('../hooks/useWebSocket')>('../hooks/useWebSocket');
    let seen = -1;
    const Probe = () => { seen = real.useWebSocket().reconnectCount; return null; };
    render(<real.WebSocketProvider><Probe /></real.WebSocketProvider>);
    act(() => { FakeSocket.all[0].open(); });
    expect(seen).toBe(0);
    act(() => { FakeSocket.all[0].drop(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(FakeSocket.all.length).toBe(2);
    act(() => { FakeSocket.all[1].open(); });
    expect(seen).toBe(1);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
