// ════════════════════════════════════════════════════════════════════════════
// t138 round 3 — AN OWNER CARD COMES BACK UNTIL HE DISMISSES IT.
//
// Round 2's owner card lived only in a tab that was open when the alert came.
// Ruling R-V333-13: on load and on every reconnect, the dashboard asks the server
// for the owner cards (re-derived from the alert conditions it already keeps) and
// shows them through the SAME cards; the card's X tells the server, so the
// dismissal holds across reloads. An all-clear frame removes the trouble card it
// answers and raises none, and it is not an agent recovering, so it does not
// sweep agents' own error cards. An agent's own chat card carrying the owner
// card's words while the owner card is up does not make a second card.
//
// Mounted: the REAL toast queue, the REAL GlobalAlerts and the REAL card stack.
// Faked: the socket (with a connection status the test moves) and the network
// door (`lib/api`'s `request`), which plays the server's two routes.
// ════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 71247b35: clauses marked `it.fails` are the witness, failing before
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

describe('on load, the server\'s owner cards are shown, pinned', () => {
  it.fails('a card the server still holds is on screen after a reload', async () => {
    server.cards = [{ words: BUDGET, severity: 'notice' }];
    render(tree());
    expect(await screen.findByText(BUDGET)).toBeTruthy();
  });

  it.fails('its X tells the server, so the dismissal holds on the next load', async () => {
    server.cards = [{ words: BUDGET, severity: 'notice' }];
    const first = render(tree());
    await screen.findByText(BUDGET);
    fireEvent.click(dismissButtons()[0]);
    await waitFor(() => expect(server.dismissed).toEqual([BUDGET]));
    first.unmount();
    render(tree()); // reload
    await waitFor(() => expect(server.gets).toBe(2));
    expect(screen.queryByText(BUDGET)).toBeNull();
  });

  it.fails('a live card the server also lists is ONE card, and its X dismisses on the server', async () => {
    render(tree());
    await waitFor(() => expect(server.gets).toBe(1));
    server.cards = [{ words: BUDGET, severity: 'notice' }];
    emit('chat:error', { agentId: 'platform', error: BUDGET, severity: 'warning', retryable: false });
    await waitFor(() => expect(screen.getAllByText(BUDGET)).toHaveLength(1));
    fireEvent.click(dismissButtons()[0]);
    await waitFor(() => expect(server.dismissed).toEqual([BUDGET]));
  });
});

describe('on reconnect, the cards are asked for again', () => {
  it.fails('a card whose condition ended while away is gone; a new one is shown', async () => {
    server.cards = [{ words: BUDGET, severity: 'notice' }];
    const view = render(tree());
    await screen.findByText(BUDGET);
    ws.status = 'disconnected';
    view.rerender(tree());
    server.cards = [{ words: PAUSED, severity: 'notice' }];
    ws.status = 'connected';
    view.rerender(tree());
    expect(await screen.findByText(PAUSED)).toBeTruthy();
    expect(screen.queryByText(BUDGET)).toBeNull();
  });
});

describe('an all-clear removes the trouble card and raises none', () => {
  it.fails('the info frame takes the expired card away; no card for the all-clear itself', async () => {
    render(tree());
    emit('chat:error', { agentId: 'platform', error: EXPIRED, severity: 'error', retryable: false });
    expect(screen.getByText(EXPIRED)).toBeTruthy();
    emit('chat:error', { agentId: 'platform', error: EXPIRED, severity: 'info', retryable: false });
    expect(screen.queryByText(EXPIRED)).toBeNull();
    expect(dismissButtons()).toHaveLength(0);
  });

  it.fails("it is not an agent recovering: an agent's own error card stays (control: a recovery sweeps it)", async () => {
    render(tree());
    fireEvent.click(screen.getByText('post plain error'));
    emit('chat:error', { agentId: 'platform', error: EXPIRED, severity: 'info', retryable: false });
    expect(screen.getByText('An agent error card.')).toBeTruthy();
    emit('chat:error', { agentId: 'a-0001', error: 'Recovered.', code: 'AGENT_RECOVERED', severity: 'info' });
    expect(screen.queryByText('An agent error card.')).toBeNull();
  });
});

describe('one card per incident on screen', () => {
  it.fails("the paused agent's own chat card with the owner card's words does not make a second card", async () => {
    render(tree());
    emit('chat:error', { agentId: 'platform', error: PAUSED, severity: 'warning', retryable: false });
    fireEvent.click(screen.getByText('chat posts the paused error'));
    expect(screen.getAllByText(PAUSED)).toHaveLength(1);
  });
});
