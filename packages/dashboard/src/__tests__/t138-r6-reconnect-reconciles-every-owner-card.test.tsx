// ════════════════════════════════════════════════════════════════════════════
// t138 round 6 (review M2) — ON RECONNECT, EVERY OWNER CARD IS RECONCILED AGAINST THE SERVER.
//
// The rule: a card lives exactly as long as its condition's record says it is live. A card that
// arrived as a live frame, whose END was missed while the socket was down, must leave when the
// reconnect's GET says it no longer stands — not only cards that came from an earlier GET.
// ════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 9eecf35e: clauses marked `it.fails` are the witness, failing before
// the fix; the fix commit flips them.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const { server, ws } = vi.hoisted(() => ({
  /** What the server's owner-card route answers, and what the dismiss route was told. */
  server: { cards: [] as Array<{ words: string; severity: string }>, dismissed: [] as string[], gets: 0 },
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
      const { words } = JSON.parse(String(opts.body)) as { words: string };
      server.dismissed.push(words);
      server.cards = server.cards.filter((c) => c.words !== words);
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

const BUDGET = 'Budget alert: 50% of your daily budget is used ($5.10 of $10.00 in the last 24 hours).';
const PAUSED = 'Helper has been paused after repeated errors. Open the Vitals page to investigate, or resume it from its detail page.';
const EXPIRED = 'Google Workspace agent\'s account (helper@example.test) connection expired. Re-authenticate in Settings > Google.';
const dismissButtons = () => screen.queryAllByRole('button', { name: 'Dismiss notification' });

beforeEach(() => {
  server.cards = [];
  server.dismissed = [];
  server.gets = 0;
  ws.status = 'connected';
  ws.handlers.clear();
});

describe('reconnect reconciles every owner card', () => {
  it.fails('a live-arrived card whose END was missed leaves when the reconnect\'s GET no longer lists it', async () => {
    const view = render(tree());
    await waitFor(() => expect(server.gets).toBe(1));
    emit('chat:error', { agentId: 'platform', error: BUDGET, severity: 'warning', retryable: false });
    expect(screen.getByText(BUDGET)).toBeTruthy();
    ws.status = 'disconnected';
    view.rerender(tree());
    // ...its END was broadcast while this tab was away; the server no longer holds it.
    ws.status = 'connected';
    view.rerender(tree());
    await waitFor(() => expect(server.gets).toBe(2));
    await waitFor(() => expect(screen.queryByText(BUDGET)).toBeNull());
  });

  it('a card the reconnect still lists stays, and agents\' own cards are untouched', async () => {
    const view = render(tree());
    await waitFor(() => expect(server.gets).toBe(1));
    server.cards = [{ words: PAUSED, severity: 'notice' }];
    emit('chat:error', { agentId: 'platform', error: PAUSED, severity: 'warning', retryable: false });
    fireEvent.click(screen.getByText('post plain error'));
    ws.status = 'disconnected';
    view.rerender(tree());
    ws.status = 'connected';
    view.rerender(tree());
    await waitFor(() => expect(server.gets).toBe(2));
    expect(screen.getByText(PAUSED)).toBeTruthy();
    expect(screen.getByText('An agent error card.')).toBeTruthy();
  });
});
