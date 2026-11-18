// ════════════════════════════════════════════════════════════════════════════
// A reconnect re-reads the server's standing owner cards. A card already on
// screen with the same key and the same words is left as it is: it keeps its
// id, so the orb is not startled again for a card the owner has already seen.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const { server, ws } = vi.hoisted(() => ({
  /** What the server's owner-card route answers, and what the dismiss route was told. */
  server: { cards: [] as Array<{ words: string; severity: string; cardKey?: string }>, dismissed: [] as string[], gets: 0 },
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

// The orb is spied, not mounted: the startle this test counts is the one
// Dojo3Notifications raises for a toast id it has never seen.
const orb = vi.hoisted(() => ({
  setAlert: vi.fn(), setNoteGlyph: vi.fn(), setEmotion: vi.fn(), pulse: vi.fn(), startTask: vi.fn(), endTask: vi.fn(),
}));
vi.mock('../components/orb/OrbProvider', () => ({ useDojoOrb: () => orb }));

import { ToastProvider } from '../hooks/useToast';
import { Dojo3Notifications } from '../components/Dojo3Notifications';
import { GlobalAlerts } from '../App';

const tree = () => (<ToastProvider><GlobalAlerts /><Dojo3Notifications /></ToastProvider>);
const BUDGET = 'Budget alert: 50% of your daily budget is used ($5.10 of $10.00 in the last 24 hours).';

beforeEach(() => {
  server.cards = [{ words: BUDGET, severity: 'notice', cardKey: 'budget:global_daily' }];
  server.dismissed = []; server.gets = 0;
  ws.status = 'connected'; ws.handlers.clear();
  for (const f of Object.values(orb)) f.mockClear();
});

describe('a reconnect does not restartle the orb', () => {
  it('a standing card already on screen is left alone', async () => {
    const view = render(tree());
    await waitFor(() => expect(server.gets).toBe(1));
    await screen.findByText(BUDGET);
    await waitFor(() => expect(orb.setEmotion).toHaveBeenCalledWith('startled'));
    orb.setEmotion.mockClear();
    ws.status = 'disconnected'; view.rerender(tree());
    ws.status = 'connected'; view.rerender(tree());
    await waitFor(() => expect(server.gets).toBe(2));
    expect(screen.getAllByText(BUDGET)).toHaveLength(1);
    expect(orb.setEmotion).not.toHaveBeenCalledWith('startled');
  });
});
