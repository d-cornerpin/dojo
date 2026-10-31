// When the owner presses Stop and the server refuses, the chat dropped its working
// state anyway: the dots went down, the Stop button vanished, and send came back for
// an agent that is still running. A failure shown as success. `onStop` now reads the
// stop's result: a refusal names itself in a toast and leaves the control up; only an
// accepted stop ends the turn.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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
// The stop's refusal shows in a toast; this records its text so a case can read it.
// The value keeps the full toast shape (`toasts` etc.) so the stage's own
// notifications render; only the text routes to the recorded array.
const toasts = vi.hoisted(() => ({ info: [] as string[], error: [] as string[] }));
vi.mock('../hooks/useToast', () => {
  const value = {
    toasts: [] as Array<{ level: string; message: string }>,
    addToast: () => {},
    addActionToast: () => {},
    removeToast: () => {},
    removeToastByKey: () => {},
    info: (m: string) => { toasts.info.push(m); },
    success: () => {},
    warning: () => {},
    error: (m: string) => { toasts.error.push(m); },
  };
  return {
    useToast: () => value,
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
import { FX } from '../../../../deploy/checks/fixture-vocabulary.mjs';

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

/** Arrive idle, then drive the in-flight turn live so the Stop control is up. */
async function arrive() {
  vi.mocked(api).getAgent.mockResolvedValue({
    ok: true, data: { id: AGENT, name: FX.n4, status: 'idle', inFlight: { turn: 0, background: 0 } },
  } as unknown as Awaited<ReturnType<typeof api.getAgent>>);
  render(shell(<Chat />));
  // The composer mounts with the stage; the arrival read resolves a tick later.
  await waitFor(() => expect(api.getAgent).toHaveBeenCalled());
  act(() => {
    emitFrame('agent:status', { agentId: AGENT, status: 'working', userFacing: true });
  });
}

const stopInsteadOfSend = () => screen.queryByRole('button', { name: 'Stop' });
const send = () => screen.queryByRole('button', { name: 'Send message' });

beforeEach(() => {
  resetFrames();
  toasts.error.length = 0;
  toasts.info.length = 0;
});
afterEach(() => { vi.resetAllMocks(); });

describe('a refused stop keeps the chat working state', () => {
  it('a refused stop names the refusal and keeps the Stop control up', async () => {
    vi.mocked(api).stopAgent.mockResolvedValue({ ok: false, error: 'busy' } as never);
    await arrive();
    const stop = await screen.findByRole('button', { name: 'Stop' });

    fireEvent.click(stop);

    await waitFor(() => expect(toasts.error).toContain('busy'));
    // The refusal left the turn running: the control is still up and send is still closed.
    expect(stopInsteadOfSend(), 'a refused stop dropped the working state').not.toBeNull();
    expect(send(), 'a refused stop re-opened send for a still-running turn').toBeNull();
  });

  it('CONTROL: an accepted stop ends the working state', async () => {
    vi.mocked(api).stopAgent.mockResolvedValue({ ok: true, data: undefined } as never);
    await arrive();
    const stop = await screen.findByRole('button', { name: 'Stop' });

    fireEvent.click(stop);

    await waitFor(() => expect(stopInsteadOfSend(), 'the stop went through but the control stayed').toBeNull());
    expect(send(), 'an accepted stop left send closed').not.toBeNull();
  });
});
