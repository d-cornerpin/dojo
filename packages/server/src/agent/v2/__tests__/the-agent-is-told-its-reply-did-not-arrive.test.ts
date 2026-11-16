// When a reply ends failed, the agent that wrote it is told plainly, by a notice that never starts a turn, that it
// did not arrive and will not be sent later. The other person is told nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
const grant = vi.hoisted(() => ({ held: true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => grant.held, engineRouteRefusalReason: () => 'withheld: this agent holds no imessage channel grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies } from '../channel-sender.js';
import { ENGINE_RIDER_INTENTS } from '../engine-riders.js';
import { freshReplyDb, imessage, personTurn, setApproved, testDb, AGENT, OWNER, PERSON, T0 } from './helpers/reply-sender.js';

const MIN = 60_000;
const notices = () => testDb().prepare(
  "SELECT agent_id, lane, origin_intent, content FROM messages WHERE content LIKE '[SOURCE: AGENT NOTICE%'",
).all() as Array<{ agent_id: string; lane: string; origin_intent: string; content: string }>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  grant.held = true;
  imessage.send.mockResolvedValue(false);
  await routeTerminalReply(...personTurn('the table is booked for eight', { channel: 'imessage' }));
});

describe('the agent is told its reply did not arrive', () => {
  it('after five failed tries: one notice that it did NOT reach them and will not be sent later', async () => {
    let now = T0;
    for (const wait of [30_000, 2 * MIN, 10 * MIN, 30 * MIN, 0]) {
      expect(notices()).toEqual([]);
      await deliverDueReplies(now);
      now += wait;
    }
    const [n, ...more] = notices();
    expect(more).toEqual([]);
    expect(n.agent_id).toBe(AGENT);
    expect(n.lane).toBe('events');
    expect(ENGINE_RIDER_INTENTS as readonly string[]).toContain(n.origin_intent);
    expect(n.content).toContain(`Your reply (iMessage to ${PERSON}) did NOT reach them after 5 tries: Messages could not send it.`);
    expect(n.content).toContain('It will not be sent later. Do not say it arrived; if they must hear it, reach them another way in your own words.');
    expect(imessage.send.mock.calls.map(([to]) => to)).toEqual([PERSON, PERSON, PERSON, PERSON, PERSON]);
  });

  it('a refusal that will not change is told at once, in plain words', async () => {
    setApproved([OWNER]);
    await deliverDueReplies(T0);
    expect(imessage.send).not.toHaveBeenCalled();
    const [n] = notices();
    expect(n.content).toContain(`did NOT reach them after 1 try: they are no longer on the approved list.`);
  });

  it('a channel the agent may no longer use is told without engine words', async () => {
    grant.held = false;
    await deliverDueReplies(T0);
    const [n] = notices();
    expect(n.content).toContain('did NOT reach them after 1 try: this agent is not allowed to use that channel.');
    expect(n.content).not.toContain('withheld');
  });
});
