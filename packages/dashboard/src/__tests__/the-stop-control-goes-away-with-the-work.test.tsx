// ════════════════════════════════════════════════════════════════════════════
// BOTH HALVES OF OWNER RULING #9, IN A BROWSER.
//
// The ruling has two halves and the second is as load-bearing as the first:
// *"STOP means stop for anything that agent is doing"* — so the control is shown
// while anything runs, AND **a plain idle agent shows no button**. The server
// side of both is driven from the server suite (`live-work.ts`, the route
// predicate, `composerStopControl`). What no clause could reach was the one
// thing that only exists in a mounted component: WHICH FRAMES SET AND CLEAR THE
// LATCH, and therefore whether the control ever goes away.
//
// ── THE DEFECT THIS FILE EXISTS FOR (review I1) ──
// `Chat.tsx`'s on-arrival read latched `backgroundStoppable` on TURN work too.
// But turn-scoped calls deliberately never emit `agent:jobs`, and that frame is
// the latch's only clearing edge — the turn's own `agent:status` idle does not
// touch it. So opening the chat while an ordinary turn had a provider call in
// flight (most of any turn) set a latch nothing could clear: a "Stop background
// job" button sat beside send on a genuinely idle agent, across every later
// turn, and pressing it 400'd silently. The original defect inverted — a visible
// control whose press cuts nothing — and the ruling's own mirror broken on a
// path as common as reloading the page.
//
// So these clauses drive LIFECYCLES, not renders: arrive, let the turn end, and
// look at what is left. A clause that only checked the arrival render would have
// passed on the defect, which is exactly how it shipped.
// ════════════════════════════════════════════════════════════════════════════

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

/** The agent the ActiveAgentProvider defaults to with no selection and no list. */
const AGENT = 'primary';

/** App.tsx's own nesting, as `every-major-page-mounts.test.tsx` spells it. */
const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider><ThemeProvider><OrbProvider><ActiveAgentProvider>
      <RightDockProvider><TechniqueSessionProvider>{page}</TechniqueSessionProvider></RightDockProvider>
    </ActiveAgentProvider></OrbProvider></ThemeProvider></AuthProvider>
  </MemoryRouter>
);

/**
 * Arrive at the chat with the server answering `GET /agents/:id` exactly as
 * `live-work.ts` would for the state under test. This is the page LOAD — the
 * path the defect lived on.
 */
async function arrive(status: string, inFlight: { turn: number; background: number }) {
  vi.mocked(api).getAgent.mockResolvedValue({
    ok: true, data: { id: AGENT, name: 'Zargo', status, inFlight },
  } as unknown as Awaited<ReturnType<typeof api.getAgent>>);
  render(shell(<Chat />));
  // The composer mounts with the stage; the arrival read resolves a tick later.
  await waitFor(() => expect(api.getAgent).toHaveBeenCalled());
}

const stopBeside = () => screen.queryByRole('button', { name: 'Stop background job' });
const stopInsteadOfSend = () => screen.queryByRole('button', { name: 'Stop' });
const send = () => screen.queryByRole('button', { name: 'Send message' });

/** The engine saying this turn is over. The ONLY frame an ordinary turn ends with. */
const turnEnds = () => act(() => {
  emitFrame('agent:status', { agentId: AGENT, status: 'idle', userFacing: true });
});

beforeEach(() => { resetFrames(); });
afterEach(() => { vi.resetAllMocks(); });

describe('the stop control goes away with the work', () => {
  it('⚠ THE RED: arrive mid-TURN, let the turn end, and NO button is left', async () => {
    // `inFlight.turn === 1` is the ordinary case — a provider call is in flight for most of
    // any turn — and it is what the latch must NOT be set from, because no `agent:jobs`
    // frame will ever come to clear it.
    await arrive('working', { turn: 1, background: 0 });
    await waitFor(() => expect(stopInsteadOfSend(), 'a working turn lost its stop').not.toBeNull());

    turnEnds();

    await waitFor(() => {
      expect(stopInsteadOfSend(), 'the turn ended and the stop still holds send\'s seat').toBeNull();
      expect(stopBeside(),
        'a phantom "Stop background job" sits on a genuinely idle agent — ruling #9\'s own '
        + 'mirror broken, and pressing it 400s (review I1)').toBeNull();
      expect(send(), 'the composer cannot be used at all').not.toBeNull();
    });
  });

  it('arrive mid-RENDER on an idle agent: the control is there, BESIDE send', async () => {
    // The case the whole lane is for. The row says idle because the turn is over; the render
    // is not, and a stop would cut it.
    await arrive('idle', { turn: 0, background: 1 });
    await waitFor(() => expect(stopBeside(),
      'a background render on an idle agent is offered no stop — the A-5b defect').not.toBeNull());
    // BESIDE, never instead of: the agent is free and must stay messageable while it renders.
    expect(send(), 'a background render disabled the composer').not.toBeNull();
  });

  it('a plain idle agent is offered nothing, and no frame is needed to say so', async () => {
    await arrive('idle', { turn: 0, background: 0 });
    await waitFor(() => expect(api.getChatHistory).toHaveBeenCalled());
    expect(stopBeside(), 'a button for nothing').toBeNull();
    expect(stopInsteadOfSend()).toBeNull();
    expect(send()).not.toBeNull();
  });

  it('the LIVE path: a job starting after the turn raises the control, and its end drops it', async () => {
    // L40's whole point. No reload, no re-fetch: the emission is the only thing that speaks
    // after a turn's `idle`, and the composer reads the server's own `stoppable`.
    await arrive('idle', { turn: 0, background: 0 });
    expect(stopBeside()).toBeNull();

    act(() => { emitFrame('agent:jobs', { agentId: AGENT, turn: 0, background: 1, stoppable: true }); });
    await waitFor(() => expect(stopBeside(),
      'the composer never heard the emission — L40 unfixed').not.toBeNull());

    act(() => { emitFrame('agent:jobs', { agentId: AGENT, turn: 0, background: 0, stoppable: false }); });
    await waitFor(() => expect(stopBeside(), 'the control outlived the job').toBeNull());
  });

  it('another agent\'s job never touches this composer', async () => {
    await arrive('idle', { turn: 0, background: 0 });
    act(() => { emitFrame('agent:jobs', { agentId: 'some-other-agent', turn: 0, background: 3, stoppable: true }); });
    await waitFor(() => expect(api.getChatHistory).toHaveBeenCalled());
    expect(stopBeside(), 'one agent\'s render put a stop on another agent\'s composer').toBeNull();
  });
});
