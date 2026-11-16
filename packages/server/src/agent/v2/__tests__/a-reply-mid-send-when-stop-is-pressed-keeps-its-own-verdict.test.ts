// A reply already being sent when Stop is pressed cannot be called back: Stop leaves it, and the send's own
// verdict ends the row and settles its request.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, personTurn, replyRows, PERSON, T0 } from './helpers/reply-sender.js';
import { askState, claimedAsk, pills, pressStop } from './helpers/owner-stop.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  freshReplyDb(runMigrations);
});

describe('a reply mid-send when Stop is pressed keeps its own verdict', () => {
  it('Stop drops nothing; the send finishes delivered and its request is not called off', async () => {
    const ask = claimedAsk('msg-1', `conv-${PERSON}`, 1);
    await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }, 1));
    let finish: (ok: boolean) => void = () => {};
    imessage.send.mockImplementationOnce(() => new Promise<boolean>((r) => { finish = r; }));
    const sending = deliverDueReplies(Date.now());
    await vi.waitFor(() => expect(imessage.send).toHaveBeenCalledTimes(1));

    const { body } = await pressStop();
    expect(body.data?.repliesNotSent).toBe(0);
    expect(askState(ask)).toBe('claimed');

    finish(true);
    await sending;
    expect(replyRows()[0].outcome).toBe('delivered');
    expect(askState(ask)).not.toBe('abandoned');
    expect(pills().some((p) => p.includes('not sent'))).toBe(false);
  });
});
