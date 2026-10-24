// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 N42 fix round 2 — THE NO-FIT CARD IS MATCHED BY ITS CONDITION, NOT ITS WORDS.
//
// For an agent on automatic model choice, the no-fit card names the router's smallest model; for a fixed
// model it says to pick a bigger one. So its words change while it stands (the owner switches the agent,
// or the floor model changes). Its frames carry a `cardKey` (`nofit:<agent>`): the card is one card per
// key, its END frame removes it whatever the words became, and its X tells the server the key.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const { server, ws } = vi.hoisted(() => ({
  /** What the server's owner-card route answers, and what the dismiss route was told. */
  server: { cards: [] as Array<{ words: string; severity: string; cardKey?: string }>, dismissed: [] as Array<{ words: string; cardKey?: string }>, gets: 0 },
  ws: {
    status: 'connected' as 'connected' | 'connecting' | 'disconnected',
    handlers: new Map<string, Set<(e: unknown) => void>>(),
  },
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.request = vi.fn(async (p: string, opts: RequestInit = {}) => {
    if (p === '/config/owner-notices' && (opts.method ?? 'GET') === 'GET') {
      server.gets++;
      return { ok: true, data: server.cards.map((c) => ({ ...c })) };
    }
    if (p === '/config/owner-notices/dismiss' && opts.method === 'POST') {
      const body = JSON.parse(String(opts.body)) as { words: string; cardKey?: string };
      server.dismissed.push(body);
      server.cards = server.cards.filter((c) => (body.cardKey ? c.cardKey !== body.cardKey : c.words !== body.words));
      return { ok: true, data: { dismissed: 1 } };
    }
    return { ok: true, data: [] };
  });
  return stub;
});
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    subscribe: (type: string, cb: (e: unknown) => void) => {
      let set = ws.handlers.get(type);
      if (!set) { set = new Set(); ws.handlers.set(type, set); }
      set.add(cb);
      return () => { set?.delete(cb); };
    },
    isConnected: () => ws.status === 'connected',
    connectionStatus: ws.status,
  }),
}));

import { ToastProvider, useToast } from '../hooks/useToast';
import { OrbProvider } from '../components/orb/OrbProvider';
import { Dojo3Notifications } from '../components/Dojo3Notifications';
import { GlobalAlerts } from '../App';

const emit = (type: string, payload: Record<string, unknown>) => act(() => {
  for (const h of ws.handlers.get(type) ?? []) h({ type, ...payload });
});

/** A chat page posting an agent's own error, and an agent error card to sweep. */
const ChatLike = () => {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.error(PAUSED)}>chat posts the paused error</button>
      <button type="button" onClick={() => toast.error('An agent error card.')}>post plain error</button>
    </>
  );
};

const tree = () => (
  <OrbProvider>
    <ToastProvider>
      <GlobalAlerts />
      <ChatLike />
      <Dojo3Notifications />
    </ToastProvider>
  </OrbProvider>
);


const AUTO_WORDS = "Dock Desk can't run on automatic model choice: the router's smallest model, Dock Small, sets a window too small.";
const FIXED_WORDS = "Dock Desk can't run: none of its models can hold its instructions and tools.";
const KEY = 'nofit:a-desk';
const dismissButtons = () => screen.queryAllByRole('button', { name: 'Dismiss notification' });

beforeEach(() => {
  server.cards = [];
  server.dismissed = [];
  server.gets = 0;
  ws.status = 'connected';
  ws.handlers.clear();
});

describe('a keyed owner card', () => {
  it('its END frame removes it even though the words it ends with are not the words it was raised with', async () => {
    render(tree());
    await waitFor(() => expect(server.gets).toBe(1));
    emit('chat:error', { agentId: 'platform', error: AUTO_WORDS, severity: 'warning', retryable: false, cardKey: KEY });
    expect(screen.getByText(AUTO_WORDS)).toBeTruthy();
    emit('chat:error', { agentId: 'platform', error: FIXED_WORDS, severity: 'info', retryable: false, cardKey: KEY });
    await waitFor(() => expect(screen.queryByText(AUTO_WORDS)).toBeNull());
  });

  it('a reload lists it by key: new words for the same condition replace the old card, never a second card', async () => {
    const view = render(tree());
    await waitFor(() => expect(server.gets).toBe(1));
    emit('chat:error', { agentId: 'platform', error: AUTO_WORDS, severity: 'warning', retryable: false, cardKey: KEY });
    server.cards = [{ words: FIXED_WORDS, severity: 'notice', cardKey: KEY }];
    ws.status = 'disconnected';
    view.rerender(tree());
    ws.status = 'connected';
    view.rerender(tree());
    await waitFor(() => expect(server.gets).toBe(2));
    await waitFor(() => expect(screen.queryByText(AUTO_WORDS)).toBeNull());
    expect(screen.getByText(FIXED_WORDS)).toBeTruthy();
  });

  it('its X tells the server the key', async () => {
    render(tree());
    await waitFor(() => expect(server.gets).toBe(1));
    emit('chat:error', { agentId: 'platform', error: AUTO_WORDS, severity: 'warning', retryable: false, cardKey: KEY });
    fireEvent.click(dismissButtons()[0]);
    await waitFor(() => expect(server.dismissed).toEqual([{ words: AUTO_WORDS, cardKey: KEY }]));
  });
});
