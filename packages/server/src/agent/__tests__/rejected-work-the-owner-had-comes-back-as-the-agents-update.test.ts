// A helper's work the person already had is sent back and corrected: the corrected work goes back to the person's
// queue as an Update, once per correction. The agent writes it; if the agent stays silent the Dojo relays it once,
// framed "Update:". A correction for a request never answered is not an Update.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { claimAsk, stampClaimingTurn } from '../../work/store.js';
import { newestPutBack, recordPiecesShown, settleAsksAtTurnFinalize } from '../../work/ask-settlement.js';
import { joinOrderFor, resolveJoinsAtBoot, sweepExpiredJoins } from '../a2a-transport.js';
import { deliverDueReplies } from '../v2/channel-sender.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import {
  agentStaysSilent, delegatedTextRequest, helperAnswers, relayed, relayRows, requestState, textsSent, ASK, HELPER, THREAD,
} from './helpers/text-relay.js';
import { turnReplies } from './helpers/turn-reply.js';

const putBackKinds = (): string[] => (testDb().prepare(
  "SELECT json_extract(payload, '$.kind') AS k FROM work_events WHERE work_id = ? AND kind = 'compile_resolved' AND json_extract(payload, '$.kind') IS NOT NULL ORDER BY id",
).all(ASK) as Array<{ k: string }>).map((r) => r.k);

/** The helper's own task for the job, on the delegated thread. */
function helperHoldsTheJob(): void {
  testDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, a2a_thread_id, opened_at, updated_at)
    VALUES ('task-helper-1', 'task', ?, 'agent', 'tracker', 'task-helper-1', 'claimed', 'ASSIGN', 0, 0, 'Check the venue', ?, ?, ?)`).run(HELPER, THREAD, Date.now(), Date.now());
}

/** The manager sends the helper's handed-in job back, a moment after its piece landed. */
function managerSendsItBack(): void {
  vi.setSystemTime(Date.now() + 60_000);
  testDb().prepare("INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES ('task-helper-1', 'decided', ?, 'pm', ?)")
    .run(JSON.stringify({ verdict: 'send_back', reason: 'the date is wrong', to: 'sent_back' }), Date.now());
  vi.setSystemTime(Date.now() + 60_000);
}

/** A turn serves the request, is shown its newest put-back, and answers on the person's channel. */
function agentAnswers(turn: number): void {
  claimAsk(ASK, AGENT);
  stampClaimingTurn(ASK, turn);
  recordPiecesShown(ASK, AGENT, turn, newestPutBack(ASK)!.id);
  turnReplies(turn, 'm-ask');
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn });
}

const repliesOf = (turn: number): number => (testDb().prepare(
  "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND turn_number = ? AND tool = 'imessage_send'",
).get(AGENT, turn) as { n: number }).n;

beforeEach(() => {
  delegatedTextRequest();
  helperHoldsTheJob();
});
// The send-backs move the fake clock ahead of SQLite's own; each case starts again from the real time.
afterEach(() => vi.useRealTimers());

describe('rejected work the person had comes back as the agent\'s Update', () => {
  it('a corrected answer after the first was delivered goes back once, ordered as an Update, and the agent answers it', async () => {
    await helperAnswers('The venue is free on the 12th.');
    agentAnswers(2);
    expect(requestState()).toBe('done');

    managerSendsItBack();
    await helperAnswers('Corrected: the venue is free on the 14th.');
    expect([requestState(), putBackKinds()]).toEqual(['open', ['compile', 'update']]);
    const order = joinOrderFor(ASK)!;
    expect(order.firstLine).toMatch(/^Helper corrected its work after review; .* start your reply with "Update:" and say what changed\.$/);
    expect(order.text).toContain('Corrected: the venue is free on the 14th.');
    expect(order.text).not.toContain('the 12th');

    agentAnswers(3);
    expect([requestState(), repliesOf(3), relayRows()]).toEqual(['done', 1, []]);
  });

  it('a second send-back and correction give a second Update; the same reply sent again without one gives none', async () => {
    await helperAnswers('The venue is free on the 12th.');
    agentAnswers(2);
    managerSendsItBack();
    await helperAnswers('Corrected: the 14th.');
    agentAnswers(3);
    await helperAnswers('Corrected: the 14th.');
    expect([requestState(), putBackKinds()]).toEqual(['done', ['compile', 'update']]);

    managerSendsItBack();
    await helperAnswers('Corrected again: the 15th.');
    expect([requestState(), putBackKinds()]).toEqual(['open', ['compile', 'update', 'update']]);
    expect(joinOrderFor(ASK)!.text).toContain('Corrected again: the 15th.');
    agentAnswers(4);
    expect([requestState(), repliesOf(4), relayRows()]).toEqual(['done', 1, []]);
  });

  it('a silent agent ends in the Dojo\'s one relay framed "Update:", after a first Dojo relay too', async () => {
    await helperAnswers('The venue is free on the 12th.');
    await agentStaysSilent(2);
    await deliverDueReplies(Date.now());
    expect(textsSent()).toEqual([relayed('The venue is free on the 12th.')]);
    expect(requestState()).toBe('done');

    managerSendsItBack();
    await helperAnswers('Corrected: the 14th.');
    await agentStaysSilent(3);
    await deliverDueReplies(Date.now());
    expect(textsSent()).toEqual([relayed('The venue is free on the 12th.'), 'Dojo: Update: Helper corrected its work after review. Corrected: the 14th.']);
    expect(requestState()).toBe('done');
  });

  it('a correction for a request never answered is no Update: the request keeps its first put-back', async () => {
    await helperAnswers('The venue is free on the 12th.');
    managerSendsItBack();
    await helperAnswers('Corrected: the 14th.');
    expect([requestState(), putBackKinds()]).toEqual(['open', ['compile']]);
    expect(joinOrderFor(ASK)!.text).toContain('the 12th');
  });

  it('a stop between the Update landing and its delivery loses nothing and sends nothing twice', async () => {
    await helperAnswers('The venue is free on the 12th.');
    agentAnswers(2);
    managerSendsItBack();
    await helperAnswers('Corrected: the 14th.');
    await resolveJoinsAtBoot();
    await sweepExpiredJoins();
    expect([requestState(), putBackKinds()]).toEqual(['open', ['compile', 'update']]);

    await agentStaysSilent(3);
    await resolveJoinsAtBoot();
    await deliverDueReplies(Date.now());
    await resolveJoinsAtBoot();
    await deliverDueReplies(Date.now());
    expect(textsSent()).toEqual(['Dojo: Update: Helper corrected its work after review. Corrected: the 14th.']);
    expect([requestState(), putBackKinds()]).toEqual(['done', ['compile', 'update']]);
  });
});
