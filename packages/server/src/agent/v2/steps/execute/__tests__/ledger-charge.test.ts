// v3.5 DONE IS MEASURED, Task A3 — the ledger is written by the engine from the calls themselves,
// at the same seam and to the same task as the effort charge.
//
// Shape copied from effort-meter-charges-trivial-tool-loops.test.ts: a turn state carrying this
// iteration's tool calls and their results, the agent's claimed task(s) in a fixture db.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { countTrackerWorkThisIteration } from '../tracker-counting.js';
import { initState, type AgentTurnState } from '../../../state.js';
import type { TurnCounterparty } from '../../../counterparty.js';
import type { ExecuteContext } from '../index.js';
import { createWorkTable, seedTrackerTask } from '../../../../../work/__tests__/work-fixture.js';

const AGENT = 'agent-ledger';

const USER: TurnCounterparty = {
  kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard',
  senderId: 'owner', threadId: null, senderIsAgent: false,
};

type Call = { id: string; name: string; arguments: Record<string, unknown> };

/** A state whose toolResults carry this iteration's outcomes (the executor appends them before the count runs). */
function stateWith(calls: Call[], errored: string[] = []): AgentTurnState {
  const s = initState({
    agentId: AGENT, contextWindow: 100_000, isAutoRouted: false,
    configuredModelId: 'floor-model', turnNumber: 1, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: null,
    lastUserMessageId: null, inboundChannel: 'dashboard', inboundContext: null,
    pendingTechniqueAck: null,
  });
  return {
    ...s,
    toolCalls: calls,
    toolResults: calls.map((c) => ({ toolCallId: c.id, name: c.name, content: errored.includes(c.id) ? 'Error: 404' : 'ok', isError: errored.includes(c.id) })),
  } as AgentTurnState;
}

function ctxFor(calls: Call[]): ExecuteContext {
  return {
    agentId: AGENT,
    turnCtx: { convKey: 'human:owner', startAckSteerArmedThisTurn: false, startAckSteerRequested: false },
    counterparty: USER,
    counterpartyIsAgentSender: false,
    engineStartAckDeliveredThisTurn: true,
    result: { toolCalls: calls } as unknown as ExecuteContext['result'],
  } as unknown as ExecuteContext;
}

const ledger = (taskId: string): string[] =>
  (mockDb.current!.prepare('SELECT item_key FROM work_ledger WHERE work_id = ? ORDER BY item_key').all(taskId) as Array<{ item_key: string }>).map((r) => r.item_key);

const CALLS: Call[] = [
  { id: 'c1', name: 'gmail_label', arguments: { message_id: 'ok-1', add_labels: ['Done'] } },
  { id: 'c2', name: 'gmail_label', arguments: { message_id: 'ok-2', add_labels: ['Done'] } },
  { id: 'c3', name: 'gmail_label', arguments: { message_id: 'failed-1', add_labels: ['Done'] } },
  { id: 'c4', name: 'gmail_search', arguments: { query: 'in:inbox' } },
];

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  createWorkTable(mockDb.current);
});

describe('the ledger charge', () => {
  it('records the items the SUCCESSFUL mutation calls touched, never a failed call\'s, never a read', () => {
    seedTrackerTask(mockDb.current!, { id: 'only', agentId: AGENT, status: 'in_progress' });
    countTrackerWorkThisIteration(stateWith(CALLS, ['c3']), ctxFor(CALLS));
    expect(ledger('only')).toEqual(['gmail:msg:ok-1', 'gmail:msg:ok-2']);
  });

  it('REVIEW FOCUS 4: two claimed tasks — the most recently updated one is charged, the same pick as the effort meter', () => {
    seedTrackerTask(mockDb.current!, { id: 'older', agentId: AGENT, status: 'in_progress', updated_at: 1_700_000_000_000 });
    seedTrackerTask(mockDb.current!, { id: 'newer', agentId: AGENT, status: 'in_progress', updated_at: 1_700_000_500_000 });
    countTrackerWorkThisIteration(stateWith(CALLS, ['c3']), ctxFor(CALLS));
    expect(ledger('newer')).toEqual(['gmail:msg:ok-1', 'gmail:msg:ok-2']);
    expect(ledger('older')).toEqual([]);
    const effort = (id: string) => (mockDb.current!.prepare('SELECT effort_calls AS n FROM work WHERE id = ?').get(id) as { n: number }).n;
    expect(effort('newer')).toBeGreaterThan(0);
    expect(effort('older')).toBe(0);
  });

  it('REVIEW FOCUS 4: the only task is paused — nothing is charged', () => {
    seedTrackerTask(mockDb.current!, { id: 'paused', agentId: AGENT, status: 'paused' });
    countTrackerWorkThisIteration(stateWith(CALLS), ctxFor(CALLS));
    expect(ledger('paused')).toEqual([]);
    expect((mockDb.current!.prepare('SELECT COUNT(*) AS n FROM work_ledger').get() as { n: number }).n).toBe(0);
  });
});
