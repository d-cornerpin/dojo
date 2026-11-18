// Scroll-back history: one failed "older messages" request must not end history, and a slow older
// page must not land in a different agent's chat.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
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

const row = (id: string, content: string) => ({
  id, role: 'assistant', content, createdAt: '2026-10-30T10:00:00.000Z',
  modelId: null, attachments: null, source: null, origin: null, conversationId: null, displayKind: null,
});
const newest = Array.from({ length: 50 }, (_, i) => row(`n${i}`, `newest page row ${i}`));
const olderPageCalls = () => vi.mocked(api).getChatHistory.mock.calls.filter((c) => c[2]);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const scrollToTop = (el: HTMLElement) => act(async () => {
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: 0 });
  el.dispatchEvent(new Event('scroll'));
  await new Promise((r) => setTimeout(r, 30));
});

beforeEach(() => {
  resetFrames();
  vi.mocked(api).getAgent.mockImplementation((async (id: string) => ({
    ok: true, data: { id, name: id, status: 'idle', inFlight: { turn: 0, background: 0 } },
  })) as unknown as typeof api.getAgent);
});
afterEach(() => { vi.resetAllMocks(); localStorage.clear(); });

describe('scroll-back history', () => {
  it('(a) a failed older-page request does not end the history: the next scroll asks again', async () => {
    let olderAsked = 0;
    vi.mocked(api).getChatHistory.mockImplementation((async (_id: string, _l?: number, before?: string) => {
      if (!before) return { ok: true, data: newest };
      olderAsked += 1;
      return olderAsked === 1 ? { ok: false, error: 'x' } : { ok: true, data: [row('o1', 'an older row')] };
    }) as unknown as typeof api.getChatHistory);
    const view = render(shell(<Chat />));
    await waitFor(() => expect(screen.queryByText('newest page row 49')).not.toBeNull());
    await settle();
    const el = view.container.querySelector('.dojo3-chat-scroll') as HTMLElement;
    await scrollToTop(el);
    const afterFirst = olderPageCalls().length;
    expect(afterFirst, 'the first older-page request was never made').toBeGreaterThan(0);
    await scrollToTop(el);
    expect(olderPageCalls().length, 'after a failed request no further older page was asked for').toBeGreaterThan(afterFirst);
  });

  it('(b) an older page that arrives after wordy mode was toggled is not pasted into the new feed', async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api).getChatHistory.mockImplementation((async (_id: string, _l?: number, before?: string) => {
      const wordy = localStorage.getItem('dojo_wordy_mode') === 'true';
      if (!before) return { ok: true, data: wordy ? [row('w0', 'the wordy feed newest')] : newest };
      if (wordy) return { ok: true, data: [] };
      return new Promise((r) => { release = r; });
    }) as unknown as typeof api.getChatHistory);
    const view = render(shell(<Chat />));
    await waitFor(() => expect(screen.queryByText('newest page row 49')).not.toBeNull());
    await settle();
    const el = view.container.querySelector('.dojo3-chat-scroll') as HTMLElement;
    await scrollToTop(el);
    expect(olderPageCalls().length).toBeGreaterThan(0);
    const wordyButton = view.container.querySelector('.dojo3-fan-btn--trace') as HTMLElement;
    await act(async () => { wordyButton.click(); });
    await waitFor(() => expect(screen.queryByText('the wordy feed newest')).not.toBeNull());
    await act(async () => { release({ ok: true, data: [row('late', 'late older row from the plain feed')] }); await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByText('late older row from the plain feed'), 'the late page landed in the other feed').toBeNull();
  });
});
