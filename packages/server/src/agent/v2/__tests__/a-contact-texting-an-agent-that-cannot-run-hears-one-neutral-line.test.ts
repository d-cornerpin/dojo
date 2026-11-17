// A person other than the owner who texts an agent that cannot run hears one neutral line on their own channel,
// once per message: no money figure and no provider word. The owner's dashboard line keeps the full cause.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({ ...(await import('./helpers/reply-sender.js')).bridgeMock(await orig()), sendAlert: async () => true }));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, testDb, PERSON, T0 } from './helpers/reply-sender.js';
import { overBudget, textFrom, stopOn, sentRows, parkNotes } from './helpers/parked-agent.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 });
  freshReplyDb(runMigrations);
  overBudget();
});

describe('a contact texting an agent that cannot run hears one neutral line', () => {
  it('one line per message, on iMessage, with no money figure or provider word', async () => {
    textFrom('m-1', PERSON, { relation: 'known_contact' });
    expect(await stopOn('m-1')).toBe(true);
    await stopOn('m-1');   // woken again on the same message
    await deliverDueReplies(T0);

    expect(imessage.send).toHaveBeenCalledTimes(1);
    const [to, text] = imessage.send.mock.calls[0];
    expect(to).toBe(PERSON);
    expect(text).toBe('Dojo: the agent cannot reply right now. The owner has been told.');
    expect(parkNotes()[0].content, 'the dashboard keeps the full cause').toContain('$');
    expect(sentRows().map((r) => [r.tool, r.outcome])).toEqual([['cannot-run', 'delivered']]);
    const ask = testDb().prepare("SELECT state FROM work WHERE kind = 'ask' AND root_id = 'm-1'").get() as { state: string };
    expect(ask.state, 'the line is not an answer: the message stays queued').toBe('open');

    textFrom('m-2', PERSON, { relation: 'known_contact' });
    await stopOn('m-2');
    await deliverDueReplies(T0);
    expect(imessage.send, 'a second message gets its own line').toHaveBeenCalledTimes(2);
  });
});
