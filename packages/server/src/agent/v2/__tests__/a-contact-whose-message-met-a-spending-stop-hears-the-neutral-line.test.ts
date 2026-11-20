// The spending stop meets a contact's message while the turn still holds it claimed (the hand-back waits for
// finalize): the contact still hears the one neutral line, and the owner's dashboard keeps the cause.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({ ...(await import('./helpers/reply-sender.js')).bridgeMock(await orig()), sendAlert: async () => true }));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { claimAsk } from '../../../work/store.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, PERSON, AGENT, T0 } from './helpers/reply-sender.js';
import { overBudget, textFrom, stopOn, parkNotes } from './helpers/parked-agent.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 });
  freshReplyDb(runMigrations);
  overBudget();
});

describe('a contact whose message met a spending stop hears the neutral line', () => {
  it('the claimed message is told once, on the contact\'s channel', async () => {
    textFrom('m-1', PERSON, { relation: 'known_contact' });
    claimAsk('ask:m-1', AGENT);
    expect(await stopOn('m-1')).toBe(true);
    await deliverDueReplies(T0);
    expect(imessage.send.mock.calls).toEqual([[PERSON, 'Dojo: the agent cannot reply right now. The owner can see this.']]);
    expect(parkNotes().map((n) => n.id)).toEqual(['park-note:m-1']);
  });
});
