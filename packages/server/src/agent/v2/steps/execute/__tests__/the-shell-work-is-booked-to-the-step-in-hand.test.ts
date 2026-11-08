// C5 (PM-CANNOT-APPROVE.md, v3.5 field fix 3 evidence round): THE SHELL WORK IS BOOKED TO THE STEP IN HAND.
//
// Measured on the owner's box: the main agent opened a planned project with two steps in one
// millisecond ("Verify both rows and the missing-export claim", step 1; "Reply to ... on thread ...",
// step 2), both claimed, both with the same `updated_at`. It then ran three `exec` commands for step 1
// (find / ls over a fixtures folder). The charge picked "the most recently updated claimed task", and
// on that tie `rowid DESC` picked step 2: all three commands landed on step 2's ledger. Step 1's close
// named those very commands in its evidence, the PM's door read step 1's ledger as empty, and refused
// the uphold three times until the override door went round the check.
//
// The rows below rebuild that pair (same project, same instant, steps 1 and 2) and run the real charge.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { countTrackerWorkThisIteration, taskToCharge } from '../tracker-counting.js';
import { effectsFor } from '../../../../tools/registry.js';
import { initState, type AgentTurnState } from '../../../state.js';
import type { TurnCounterparty } from '../../../counterparty.js';
import type { ExecuteContext } from '../index.js';
import { createWorkTable, seedTrackerProject, seedTrackerTask } from '../../../../../work/__tests__/work-fixture.js';

const AGENT = 'main-agent';
const OPENED = 1_793_923_437_637;   // both steps opened in this one millisecond

const PEER: TurnCounterparty = {
  kind: 'agent', name: 'Manager', relation: 'agent', channel: 'a2a',
  senderId: 'pm-agent', threadId: 'thread-1', senderIsAgent: true,
} as unknown as TurnCounterparty;

type Call = { id: string; name: string; arguments: Record<string, unknown> };

function stateWith(calls: Call[]): AgentTurnState {
  const s = initState({
    agentId: AGENT, contextWindow: 100_000, isAutoRouted: false,
    configuredModelId: 'floor-model', turnNumber: 1804, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: null,
    lastUserMessageId: null, inboundChannel: 'a2a', inboundContext: null,
    pendingTechniqueAck: null,
  });
  return { ...s, toolCalls: calls, toolResults: calls.map((c) => ({ toolCallId: c.id, name: c.name, content: 'stdout:\n(no output)', isError: false })) } as AgentTurnState;
}
function ctxFor(calls: Call[]): ExecuteContext {
  return {
    agentId: AGENT,
    turnCtx: { convKey: null, startAckSteerArmedThisTurn: false, startAckSteerRequested: false },
    counterparty: PEER, counterpartyIsAgentSender: true, engineStartAckDeliveredThisTurn: true,
    result: { toolCalls: calls } as unknown as ExecuteContext['result'],
  } as unknown as ExecuteContext;
}
const run = (calls: Call[]): void => {
  countTrackerWorkThisIteration(stateWith(calls), ctxFor(calls),
    calls.map((c) => ({ toolCallId: c.id, name: c.name, content: 'stdout:\n(no output)', isError: false })), effectsFor);
};
const ledger = (taskId: string): string[] =>
  (mockDb.current!.prepare('SELECT item_key FROM work_ledger WHERE work_id = ? ORDER BY first_at, rowid').all(taskId) as Array<{ item_key: string }>).map((r) => r.item_key);

const EXECS: Call[] = [
  { id: 'x1', name: 'exec', arguments: { argv: ['ls', '-1', '/fixtures'] } },
  { id: 'x2', name: 'exec', arguments: { argv: ['find', '/fixtures', '-iname', '*bank*'] } },
];

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  createWorkTable(mockDb.current);
  seedTrackerProject(mockDb.current, { id: 'project', agentId: AGENT, opened_at: OPENED, updated_at: OPENED });
  seedTrackerTask(mockDb.current, { id: 'step-1', agentId: AGENT, projectId: 'project', title: 'Verify both rows', step_number: 1, total_steps: 2, opened_at: OPENED, updated_at: OPENED });
  seedTrackerTask(mockDb.current, { id: 'step-2', agentId: AGENT, projectId: 'project', title: 'Reply on the thread', step_number: 2, total_steps: 2, opened_at: OPENED, updated_at: OPENED });
});

describe('C5: the commands a turn runs are booked to the task it is working', () => {
  it('THE OWNER\'S BOX: two steps opened in one millisecond; the step-1 commands land on step 1, not step 2', () => {
    run(EXECS);
    expect(ledger('step-1')).toEqual(['cmd:ls -1 /fixtures', 'cmd:find /fixtures -iname *bank*']);
    expect(ledger('step-2')).toEqual([]);
  });

  it('a task handed in and waiting for its decision is not the one being worked: later work goes to the open sibling', () => {
    mockDb.current!.prepare("UPDATE work SET state = 'handed_in', updated_at = ? WHERE id = ?").run(OPENED + 60_000, 'step-1');   // the hand-in touched it last
    expect(taskToCharge(AGENT)).toBe('step-2');
  });

  it('the agent\'s own latest write still wins over step order (most recently updated, as before)', () => {
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(OPENED + 5_000, 'step-2');
    run(EXECS);
    expect(ledger('step-2')).toEqual(['cmd:ls -1 /fixtures', 'cmd:find /fixtures -iname *bank*']);
    expect(ledger('step-1')).toEqual([]);
  });

  it('NEGATIVE CONTROL: a step that ran nothing gets nothing, and a failed command is never booked anywhere', () => {
    const failed: Call[] = [{ id: 'x9', name: 'exec', arguments: { argv: ['cat', '/nope'] } }];
    countTrackerWorkThisIteration(stateWith(failed), ctxFor(failed), [{ toolCallId: 'x9', name: 'exec', content: 'Error: no such file', isError: true }] as never, effectsFor);
    expect(ledger('step-1')).toEqual([]);
    expect(ledger('step-2')).toEqual([]);
  });
});
