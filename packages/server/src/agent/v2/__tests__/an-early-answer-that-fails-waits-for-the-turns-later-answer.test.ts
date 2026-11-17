// An answer given early in a turn that fails for good does not end the request while the turn still runs: a later
// answer of the same turn that goes closes it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { deliverDueReplies } from '../channel-sender.js';
import { queueReply } from '../deliveries.js';
import { freshReplyDb, imessage, replyRows, testDb, AGENT, PERSON } from './helpers/reply-sender.js';
import { claimedAsk } from './helpers/owner-stop.js';
import { CONV, askRow, endTurn, turnRow } from './helpers/text-request.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

/** An answer given early in turn 1, while the turn still runs, that fails all five tries. */
async function earlyAnswerFailsForGood(): Promise<void> {
  await queueReply({ agentId: AGENT, turnNumber: 1, root: { kind: 'ask', id: 'ask-1', sourceMessageId: null, conversationId: CONV }, text: 'the table is booked', address: { channel: 'imessage', to: PERSON } });
  imessage.send.mockResolvedValue(false);
  let now = Date.now();
  for (const wait of [30_000, 120_000, 600_000, 1_800_000, 0]) {
    await deliverDueReplies(now);
    now += wait;
  }
  imessage.send.mockResolvedValue(true);
  vi.setSystemTime(now);
}

const endTurnRecord = (): void => { testDb().prepare("UPDATE turns SET ended_at = datetime('now'), exit_reason = 'answered', answered = 1 WHERE turn_number = 1").run(); };

describe('an early answer that fails waits for the turn\'s later answer', () => {
  it('the request stays claimed while the turn runs, and closes on the later answer', async () => {
    const ask = claimedAsk('msg-1', CONV, 1);
    turnRow(1, false);
    await earlyAnswerFailsForGood();
    expect(replyRows()[0].outcome).toBe('failed');
    expect(askRow(ask).state).toBe('claimed');

    endTurnRecord();
    await endTurn(1, 'the table is booked for eight, and they have a high chair');
    await deliverDueReplies(Date.now());
    expect(replyRows()[1].outcome).toBe('delivered');
    expect(askRow(ask).state).toBe('done');
  });
});
