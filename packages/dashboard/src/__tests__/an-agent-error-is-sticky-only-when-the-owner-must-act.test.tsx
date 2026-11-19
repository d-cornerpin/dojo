// Rulings audit #7 (owner, M11): "It shouldn't be a persistent notification if it doesn't require the intervention
// of the user. It also shouldn't be red." An agent's chat:error is a sticky red card only when it declares the owner
// must act (`cardClass: 'action'`); "the Healer is looking into it" and every undeclared error read as a warning that
// leaves by itself, and the turn's working state still ends.

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
/** The toasts this frame raised (the arrival raises an unrelated canvas-load one in this harness). */
const levelsFor = (message: string): Set<string> => new Set(toastCalls.list.filter((c) => c.message === message).map((c) => c.level));
const agentError = (error: string, extra: Record<string, unknown>) => act(() => {
  emitFrame('chat:error', { agentId: AGENT, error, retryable: false, ...extra });
});

beforeEach(() => { resetFrames(); toastCalls.list.length = 0; });
afterEach(() => { vi.clearAllMocks(); });

describe('an agent chat error is sticky and red only when the owner must act', () => {
  it('"the Healer is looking into it" (error, informational) is a warning that leaves by itself', async () => {
    await arrive();
    agentError('Agent hit an error and the Healer is looking into it.', { severity: 'error', cardClass: 'informational', code: 'MODEL_FAILED' });
    expect(levelsFor('Agent hit an error and the Healer is looking into it.')).toEqual(new Set(['warning']));
  });

  it('an error that declares no class reads as a warning too', async () => {
    await arrive();
    agentError('Something went wrong.', { severity: 'error' });
    expect(levelsFor('Something went wrong.')).toEqual(new Set(['warning']));
  });

  it('CONTROL: an action card (the owner must reconnect) stays sticky and red', async () => {
    await arrive();
    agentError('Your Plaud login has expired.', { severity: 'error', cardClass: 'action', code: 'AUTH_INVALID' });
    expect(levelsFor('Your Plaud login has expired.')).toEqual(new Set(['sticky-error']));
  });
});
