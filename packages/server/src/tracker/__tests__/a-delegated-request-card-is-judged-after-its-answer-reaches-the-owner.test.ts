// A card the main agent opened for the owner's request and handed to a helper waits for the PM while that
// request is still owed; once the main agent's answer is delivered, the PM sees the card and the answer.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).wsMock());
vi.mock('../../agent/runtime.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runPMReview } from '../pm-agent.js';
import { insertMessage } from '../../memory/message-store.js';
import { recordDelivery } from '../../agent/v2/deliveries.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../work/store.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { freshBoard, handedIn, MAIN, PM, TASK } from '../../work/done/__tests__/helpers/decision-world.js';
import { lastReport, pmCanRun, resetLadderWorld } from '../../work/done/__tests__/helpers/ladder-world.js';

const ASK = askIdForMessage('m-ask');

beforeEach(async () => {
  resetLadderWorld();
  freshBoard();
  pmCanRun(PM);
  doneDb().prepare("INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-dash', ?, 'dashboard', 'owner')").run(MAIN);
  insertMessage({
    id: 'm-ask', agentId: MAIN, role: 'user', content: 'Make me a beach packing list', lane: 'owner', channel: 'dashboard',
    senderId: 'owner', authorized: true, conversationId: 'conv-dash', inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as Parameters<typeof insertMessage>[0]);
  claimAsk(ASK, MAIN);
  stampClaimingTurn(ASK, 7);
  await handedIn();
  doneDb().prepare("UPDATE work SET requester = 'agent', requester_id = ?, source_message_id = 'm-ask' WHERE id = ?").run(MAIN, TASK);
});

describe('a delegated request card is judged after its answer reaches the owner', () => {
  it('waits while the request is owed, then is listed with the answer', async () => {
    await runPMReview();
    expect(lastReport(PM), 'no review while the owner has not been answered').toBe('');

    const turn = openTurnContext(MAIN);
    Object.assign(turn, { turnNumber: 7, root: { kind: 'ask', id: ASK, sourceMessageId: 'm-ask', conversationId: 'conv-dash' } });
    const sent = recordDelivery({
      agentId: MAIN, tool: 'dashboard', channel: 'dashboard', outcome: 'delivered', conversationId: 'conv-dash', messageId: 'm-reply', recipientDisplay: 'the owner',
    });
    endTurnContext(MAIN);
    expect(sent.kind).toBe('applied');

    await runPMReview();
    expect(lastReport(PM)).toContain(`[${TASK}]`);
    expect(lastReport(PM)).toMatch(/The request this was opened for: answered to the owner at .+ UTC \(delivery .+\)/);
  });

  it('a card with no owed request of its requester is listed at once', async () => {
    doneDb().prepare("UPDATE work SET requester_id = 'someone-else' WHERE id = ?").run(TASK);
    await runPMReview();
    expect(lastReport(PM)).toContain(`[${TASK}]`);
    expect(lastReport(PM)).not.toContain('The request this was opened for');
  });
});
