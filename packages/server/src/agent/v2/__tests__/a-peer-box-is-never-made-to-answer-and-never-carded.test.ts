// Another Dojo box writing over a human channel looks like a person, but its message never gets the must-answer
// call and its silence never puts the "could not answer" card in front of the owner; a real person's still does.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../classifiers/inbound-routing.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), inboundAsksNothing: async () => false }));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../../work/store.js';
import { settleAsksAtTurnFinalize } from '../../../work/ask-settlement.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import { advance, initState } from '../state.js';
import { forcedReplyDue } from '../forced-reply.js';
import { freshReplyDb, testDb, AGENT, PERSON } from './helpers/reply-sender.js';

const ASK = askIdForMessage('m-1');
const cards = (): number => (testDb().prepare(`SELECT COUNT(*) AS n FROM work_events WHERE kind = 'floor_ghosted'`).get() as { n: number }).n;

/** A turn that claimed the message and is about to end silent: the decision, then (if armed) an empty answer, then finalize. */
async function silentTurn(counterpartyIsAgentSender: boolean): Promise<boolean> {
  endTurnContext(AGENT);
  const turnCtx = openTurnContext(AGENT);
  turnCtx.state = advance(initState({ agentId: AGENT, turnNumber: 1 } as Parameters<typeof initState>[0]), { phase: 'postCallClassify' });
  const armed = await forcedReplyDue(turnCtx, { agentId: AGENT, turnNumber: 1, latestUserSource: 'text', counterpartyIsAgentSender });
  testDb().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
    VALUES (?, 1, datetime('now'), datetime('now'), 'no_reply_intended', 0)`).run(AGENT);
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 1, forcedEmpty: armed });
  return armed;
}

beforeEach(() => {
  freshReplyDb(runMigrations);
  testDb().prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id)
    VALUES ('conv-text', ?, 'imessage', 'imessage', ?)`).run(AGENT, PERSON);
  insertMessage({ id: 'm-1', agentId: AGENT, role: 'user', content: 'Did the backup finish?',
    conversationId: 'conv-text', channel: 'imessage', senderId: PERSON, lane: 'owner' } as never);
  claimAsk(ASK, AGENT);
  stampClaimingTurn(ASK, 1);
});

describe('a peer box is never made to answer and never carded', () => {
  it('a silent turn on a peer box\'s message makes no must-answer call and no card', async () => {
    expect(await silentTurn(true)).toBe(false);
    expect(cards()).toBe(0);
  });

  it('CONTROL: the same silent turn on a real person\'s message makes the call, and its empty answer is carded', async () => {
    expect(await silentTurn(false)).toBe(true);
    expect(cards()).toBe(1);
  });
});
