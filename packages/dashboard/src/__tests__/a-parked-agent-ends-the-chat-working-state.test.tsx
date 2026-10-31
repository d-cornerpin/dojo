// When the server parks an agent after an honest stop it broadcasts `agent:status: paused`
// and no `idle` follows. The chat used to keep the thinking dots and the Stop button up for
// that finished turn until a reload. `paused` now ends the working state exactly like `idle`
// and `error`; `rate_limited` is a retry wait, the turn is still alive, and keeps it.

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

/**
 * Arrive at the chat with the server answering `GET /agents/:id` exactly as
 * `live-work.ts` would for the state under test. This is the page LOAD — the
 * path the defect lived on.
 */
async function arrive(status: string, inFlight: { turn: number; background: number }) {
  vi.mocked(api).getAgent.mockResolvedValue({
    ok: true, data: { id: AGENT, name: FX.n4, status, inFlight },
  } as unknown as Awaited<ReturnType<typeof api.getAgent>>);
  render(shell(<Chat />));
  // The composer mounts with the stage; the arrival read resolves a tick later.
  await waitFor(() => expect(api.getAgent).toHaveBeenCalled());
}

const stopBeside = () => screen.queryByRole('button', { name: 'Stop background job' });
const stopInsteadOfSend = () => screen.queryByRole('button', { name: 'Stop' });
const send = () => screen.queryByRole('button', { name: 'Send message' });

const status = (s: string) => act(() => {
  emitFrame('agent:status', { agentId: AGENT, status: s, userFacing: true });
});

beforeEach(() => { resetFrames(); });
afterEach(() => { vi.resetAllMocks(); });

describe('a parked agent ends the chat working state', () => {
  it('working then paused: the Stop control goes away and send is back', async () => {
    await arrive('idle', { turn: 0, background: 0 });
    status('working');
    await waitFor(() => expect(stopInsteadOfSend(), 'a working turn lost its stop').not.toBeNull());

    status('paused');

    await waitFor(() => {
      expect(stopInsteadOfSend(), 'the agent was parked and the Stop control stayed up').toBeNull();
      expect(send()).not.toBeNull();
    });
  });

  it('CONTROL: working then rate_limited keeps the Stop control (the turn is still alive)', async () => {
    await arrive('idle', { turn: 0, background: 0 });
    status('working');
    await waitFor(() => expect(stopInsteadOfSend()).not.toBeNull());

    status('rate_limited');

    await new Promise((r) => setTimeout(r, 50));
    expect(stopInsteadOfSend(), 'a retry wait wrongly ended the working state').not.toBeNull();
  });
});
