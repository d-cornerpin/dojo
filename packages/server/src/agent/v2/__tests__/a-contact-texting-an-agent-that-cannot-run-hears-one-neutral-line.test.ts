// A person other than the owner who texts an agent that cannot run hears one neutral line on their own channel,
// once for the park: no money figure and no provider word. The owner's dashboard line keeps the full cause.
// The engine writes no line of its own by email.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({ ...(await import('./helpers/reply-sender.js')).bridgeMock(await orig()), sendAlert: async () => true }));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, testDb, PERSON, OTHER, T0 } from './helpers/reply-sender.js';
import { overBudget, textFrom, stopOn, sentRows, parkNotes } from './helpers/parked-agent.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 });
  freshReplyDb(runMigrations);
  overBudget();
});

describe('a contact texting an agent that cannot run hears one neutral line', () => {
  it('one line per person on iMessage, with no money figure or provider word', async () => {
    textFrom('m-1', PERSON, { relation: 'known_contact' });
    expect(await stopOn('m-1')).toBe(true);
    await stopOn('m-1');   // woken again on the same message
    await deliverDueReplies(T0);

    expect(imessage.send).toHaveBeenCalledTimes(1);
    expect(imessage.send.mock.calls[0]).toEqual([PERSON, 'Dojo: the agent cannot reply right now. The owner can see this.']);
    expect(parkNotes()[0].content, 'the dashboard keeps the full cause').toContain('$');
    expect(sentRows().map((r) => [r.tool, r.outcome])).toEqual([['cannot-run', 'delivered']]);
    const ask = testDb().prepare("SELECT state FROM work WHERE kind = 'ask' AND root_id = 'm-1'").get() as { state: string };
    expect(ask.state, 'the line is not an answer: the message stays queued').toBe('open');

    textFrom('m-2', PERSON, { relation: 'known_contact' });
    textFrom('m-3', OTHER, { relation: 'known_contact' });
    await stopOn('m-3');
    await deliverDueReplies(T0);
    expect(parkNotes().map((n) => n.id).sort(), 'each message keeps its dashboard line').toEqual(['park-note:m-1', 'park-note:m-2', 'park-note:m-3']);
    expect(imessage.send.mock.calls.map(([to]) => to), 'the same person is not told twice; another person is').toEqual([PERSON, OTHER]);
  });

  it('a contact who emailed gets no line; the dashboard row is written', async () => {
    textFrom('m-1', 'ann@example.com', { relation: 'known_contact', emailMessageId: 'mail-1', emailService: 'gmail' }, 'email');
    await stopOn('m-1');
    await deliverDueReplies(T0);

    expect(sentRows()).toEqual([]);
    expect(parkNotes().map((n) => n.id)).toEqual(['park-note:m-1']);
  });
});
