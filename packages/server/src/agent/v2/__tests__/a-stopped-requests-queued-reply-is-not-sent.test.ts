// With a run live, Stop drops only the queued reply of the request it ends; an earlier request's reply still
// waiting to go is sent as usual.
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
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import { stopByOwner } from '../../runtime.js';
import { freshReplyDb, imessage, personTurn, replyRows, testDb, AGENT, PERSON, T0 } from './helpers/reply-sender.js';
import { lastRunEndedAt } from '../../shared-state.js';
import { askState, claimedAsk } from './helpers/owner-stop.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  freshReplyDb(runMigrations);
  lastRunEndedAt.clear();
});

describe("a stopped request's queued reply is not sent", () => {
  it('only the stopped request loses its reply; the earlier one goes out', async () => {
    const earlier = claimedAsk('ask-1', `conv-${PERSON}`, 1);
    await routeTerminalReply(...personTurn('the venue is booked', { channel: 'imessage' }, 1));
    const stopped = claimedAsk('ask-2', `conv-${PERSON}`, 2);
    await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }, 2));
    const bag = openTurnContext(AGENT);
    Object.assign(bag, { turnNumber: 2, root: { kind: 'ask', id: 'ask-2', sourceMessageId: 'ask-2' } });
    expect(stopByOwner(AGENT)).toEqual({ ended: 1, repliesNotSent: 1 });
    endTurnContext(AGENT);

    expect(replyRows().map((r) => r.outcome)).toEqual(['pending', 'suppressed']);
    expect([askState(earlier), askState(stopped)]).toEqual(['claimed', 'abandoned']);
    await deliverDueReplies(T0 + 60 * 60_000);
    expect(imessage.send.mock.calls.map((c) => c[1])).toEqual(['the venue is booked']);
  });

  it('in the tail of a run that just ended, only the stopped request loses its reply', async () => {
    claimedAsk('ask-1', `conv-${PERSON}`, 1);
    await routeTerminalReply(...personTurn('the venue is booked', { channel: 'imessage' }, 1));
    const stopped = claimedAsk('ask-2', `conv-${PERSON}`, 2);
    await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }, 2));
    testDb().prepare(`INSERT INTO turns (agent_id, turn_number, root_kind, root_id, answered, effectful_calls)
      VALUES (?, 2, 'ask', 'ask-2', 0, 0)`).run(AGENT);
    lastRunEndedAt.set(AGENT, Date.now());
    expect(stopByOwner(AGENT)).toEqual({ ended: 1, repliesNotSent: 1 });
    expect(replyRows().map((r) => r.outcome)).toEqual(['pending', 'suppressed']);
    expect(askState(stopped)).toBe('abandoned');
  });
});
