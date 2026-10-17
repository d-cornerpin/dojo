// ════════════════════════════════════════════════════════════════════════════
// GITHUB #14 (v3.4 lane t191): SWITCH AGENTS AND NOTHING OF THE LAST ONE COMES WITH YOU.
//
// One `Chat` is mounted for the whole shell, and the agent under it changes. Its
// per-agent state used to be plain `useState`, so a busy agent's "working" latches
// rode over to the next agent and nothing could clear them (the load only ever set
// working TRUE; an idle agent sends no idle frame): the card said Ready while dots
// and Stop showed. The same shape let a slow load for the old agent land under the
// new one, and let an unsent draft and its attached files follow you to the wrong
// agent (owner decision 15: they stay with the agent they were written for).
//
// These clauses drive the LIFECYCLE (work, switch, look), not a single render.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
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
import { ActiveAgentProvider, useActiveAgent } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';
import { ThemeProvider } from '../themes/ThemeProvider';

/** The agent the provider defaults to, and the one we switch to. */
const A = 'primary';
const B = 'agent-bee';

/** A hand on the provider's own selector: the same call the Agents panel makes. */
function SwitchTo() {
  const { selectAgent } = useActiveAgent();
  return (
    <>
      <button onClick={() => selectAgent({ id: B, name: 'Bee' })}>go-to-b</button>
      <button onClick={() => selectAgent(null)}>go-to-a</button>
    </>
  );
}

const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider><ThemeProvider><OrbProvider><ActiveAgentProvider>
      <RightDockProvider><TechniqueSessionProvider>{page}<SwitchTo /></TechniqueSessionProvider></RightDockProvider>
    </ActiveAgentProvider></OrbProvider></ThemeProvider></AuthProvider>
  </MemoryRouter>
);

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const row = (id: string, content: string) => ({
  id, role: 'assistant', content, createdAt: new Date().toISOString(),
  modelId: null, attachments: null, source: null, origin: null, conversationId: null, displayKind: null,
});

/** `GET /agents/:id` and `GET /chat/:id/history`, per agent. */
function server(opts: {
  status: Record<string, string>;
  history?: Record<string, Array<ReturnType<typeof row>>>;
  historyGate?: Record<string, Promise<unknown>>;
}) {
  vi.mocked(api).getAgent.mockImplementation((async (id: string) => ({
    ok: true, data: { id, name: id, status: opts.status[id] ?? 'idle', inFlight: { turn: 0, background: 0 } },
  })) as unknown as typeof api.getAgent);
  vi.mocked(api).getChatHistory.mockImplementation((async (id: string, _limit?: number, before?: string) => {
    await opts.historyGate?.[id];
    // The load backfills OLDER pages until something renders; there is no older page.
    return { ok: true, data: before ? [] : opts.history?.[id] ?? [] };
  }) as unknown as typeof api.getChatHistory);
}

const stop = () => screen.queryByRole('button', { name: 'Stop' });
const dots = () => document.querySelector('.thinking-dots');
const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const switchToB = () => act(() => { fireEvent.click(screen.getByText('go-to-b')); });
const switchToA = () => act(() => { fireEvent.click(screen.getByText('go-to-a')); });

beforeEach(() => { resetFrames(); });
afterEach(() => { vi.resetAllMocks(); });

describe('switching agents carries nothing of the last one', () => {
  it('RED #14: a working agent, then an idle one: no dots, no Stop, and no idle frame is needed', async () => {
    server({ status: { [A]: 'working', [B]: 'idle' } });
    render(shell(<Chat />));
    // A is mid-turn for the owner: the request latch is set exactly as a real turn sets it.
    await waitFor(() => expect(stop(), 'the working agent shows no Stop').not.toBeNull());
    act(() => { emitFrame('agent:status', { agentId: A, status: 'working', kind: 'user', userFacing: true }); });
    expect(dots(), 'the working agent shows no dots').not.toBeNull();

    switchToB();

    // B is idle and will never send an idle frame: the fetched status is the whole answer.
    await waitFor(() => expect(api.getAgent).toHaveBeenCalledWith(B));
    await waitFor(() => expect(api.getChatHistory).toHaveBeenCalledWith(B, 200, undefined, false));
    await waitFor(() => {
      expect(stop(), 'Stop on an idle agent (agent A\'s latch followed the switch)').toBeNull();
      expect(dots(), 'thinking dots on an idle agent').toBeNull();
    });
  });

  it('a slow load for the old agent never lands under the new one', async () => {
    const slowA = defer<void>();
    server({
      status: {},
      history: { [A]: [row('a1', 'text-from-agent-a')], [B]: [row('b1', 'text-from-agent-b')] },
      historyGate: { [A]: slowA.promise },
    });
    render(shell(<Chat />));
    await waitFor(() => expect(api.getChatHistory).toHaveBeenCalledWith(A, 200, undefined, false));

    switchToB();
    await waitFor(() => expect(screen.queryByText('text-from-agent-b')).not.toBeNull());

    // A's answer finally arrives, after B's.
    await act(async () => { slowA.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    expect(screen.queryByText('text-from-agent-b'), 'B\'s conversation was replaced').not.toBeNull();
    expect(screen.queryByText('text-from-agent-a'), 'A\'s conversation landed under B').toBeNull();
  });

  it('the old conversation is gone the moment you switch, not when the next one arrives', async () => {
    const slowB = defer<void>();
    server({
      status: {},
      history: { [A]: [row('a1', 'text-from-agent-a')], [B]: [] },
      historyGate: { [B]: slowB.promise },
    });
    render(shell(<Chat />));
    await waitFor(() => expect(screen.queryByText('text-from-agent-a')).not.toBeNull());
    switchToB();
    expect(screen.queryByText('text-from-agent-a'), 'A\'s messages stayed on B\'s screen while B loaded').toBeNull();
    await act(async () => { slowB.resolve(); await Promise.resolve(); });
  });

  it('an unsent draft stays with its agent: not shown for B, and back for A (decision 15)', async () => {
    server({ status: {} });
    render(shell(<Chat />));
    await waitFor(() => expect(api.getChatHistory).toHaveBeenCalled());
    fireEvent.change(box(), { target: { value: 'draft written for A' } });
    expect(box().value).toBe('draft written for A');

    switchToB();
    await waitFor(() => expect(api.getAgent).toHaveBeenCalledWith(B));
    expect(box().value, 'the draft for A followed you to B').toBe('');

    fireEvent.change(box(), { target: { value: 'draft for B' } });
    switchToA();
    await waitFor(() => expect(box().value, 'A\'s draft did not stay with A').toBe('draft written for A'));
  });

  it('files attached for A are not on B\'s composer, and are never sent to B', async () => {
    server({ status: {} });
    vi.mocked(api).uploadFiles.mockResolvedValue({ ok: true, data: [] } as never);
    vi.mocked(api).sendMessage.mockResolvedValue({ ok: true, data: {} } as never);
    const { container } = render(shell(<Chat />));
    await waitFor(() => expect(api.getChatHistory).toHaveBeenCalled());

    const file = new File(['x'], 'for-a.txt', { type: 'text/plain' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    expect(screen.queryAllByLabelText('Remove for-a.txt').length, 'the attach did not register').toBeGreaterThan(0);

    switchToB();
    await waitFor(() => expect(api.getAgent).toHaveBeenCalledWith(B));
    expect(screen.queryAllByLabelText('Remove for-a.txt').length, 'A\'s attachment showed on B\'s composer').toBe(0);

    fireEvent.change(box(), { target: { value: 'hello B' } });
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    expect(api.uploadFiles, 'A\'s file was uploaded for B').not.toHaveBeenCalled();
    expect(vi.mocked(api).sendMessage.mock.calls[0][0]).toBe(B);
  });
});
