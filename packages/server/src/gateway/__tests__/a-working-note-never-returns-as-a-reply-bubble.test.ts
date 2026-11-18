// A demoted working note must never be overtaken by the message it demotes: frames leave in the order they were made.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { WSContext } from 'hono/ws';

vi.mock('../../config/loader.js', async (orig) => ({
  ...(await orig<typeof import('../../config/loader.js')>()),
  getJwtSecret: () => 'test-secret',
}));
vi.mock('../../agent/v2/outbound.js', () => ({ recordDashboardDelivery: () => null }));
vi.mock('../../memory/message-store.js', () => ({ readPersistedRow: () => null }));
vi.mock('../../google/reauth-notice.js', () => ({ flushPendingGoogleReauthToast: () => undefined }));

import { broadcast, verifyAndTrackClient, removeClient } from '../ws.js';

type Frame = Parameters<typeof broadcast>[0];
const sent: string[] = [];
const socket = {
  send: (data: string) => { sent.push((JSON.parse(data) as { type: string }).type); },
  close: () => undefined,
} as unknown as WSContext;
const message = { type: 'chat:message', agentId: 'a1', message: { id: 'm1', role: 'assistant', content: 'Drafting the answer', createdAt: '2026-11-17T00:00:00.000Z' } } as unknown as Frame;
const note = { type: 'chat:workingnote', agentId: 'a1', messageId: 'm1', noteId: 'n1', content: 'Drafting the answer' } as unknown as Frame;

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  expect(verifyAndTrackClient(socket, `/ws?token=${jwt.sign({ userId: 'owner' }, 'test-secret')}`)).toBe(true);
});
afterEach(() => { removeClient(socket); vi.useRealTimers(); });

describe('a working note never returns as a reply bubble', () => {
  it('the message goes out before the note that demotes it', () => {
    broadcast(message);
    broadcast(note);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual(['chat:message', 'chat:workingnote']);
  });
  it('a stream chunk goes out at once, not held back', () => {
    broadcast({ type: 'chat:chunk', agentId: 'a1', messageId: 'm1', content: 'Dra' } as unknown as Frame);
    expect(sent).toEqual(['chat:chunk']);
  });
  it('the stop control frame goes out at once', () => {
    broadcast({ type: 'agent:jobs', agentId: 'a1', turn: 0, background: 0, stoppable: false } as unknown as Frame);
    expect(sent).toEqual(['agent:jobs']);
  });
});
