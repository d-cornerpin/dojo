// 8110 — the chat's New conversation control shows the server's refusal, and a failed reload after it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  (globalThis as { __toast?: unknown }).__toast = stub;
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

const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider><OrbProvider><ActiveAgentProvider>
      <RightDockProvider><TechniqueSessionProvider>{page}</TechniqueSessionProvider></RightDockProvider>
    </ActiveAgentProvider></OrbProvider></AuthProvider>
  </MemoryRouter>
);
const toastCalls = () => (globalThis as unknown as { __toast: { calls: Array<{ level: string; message: string }> } }).__toast.calls;
const SENTENCE = 'Cannot start new session while agent is working';
const NOTE = 'The new conversation started but the page could not reload it. Refresh the page.';

beforeEach(() => { resetFrames(); });
afterEach(() => { vi.resetAllMocks(); });

const pressReset = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Dojo menu' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reset', hidden: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm', hidden: true }));
};

describe('the New conversation control', () => {
  it('says why when the server refuses', async () => {
    vi.mocked(api).request.mockResolvedValue({ ok: false, error: SENTENCE } as never);
    render(shell(<Chat />));
    await pressReset();
    await waitFor(() => expect(toastCalls().map((c) => c.message)).toContain(SENTENCE));
  });
  it('says so when the reload after a started conversation fails', async () => {
    vi.mocked(api).request.mockResolvedValue({ ok: true, data: { archiveId: 'a', sessionStartedAt: 't' } } as never);
    vi.mocked(api).getChatHistory.mockResolvedValue({ ok: false, error: 'down' } as never);
    render(shell(<Chat />));
    await pressReset();
    await waitFor(() => expect(toastCalls().map((c) => c.message)).toContain(NOTE));
  });
});
