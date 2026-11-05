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
import { effectsFor } from '../../../../tools/registry.js';
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

type RoundResult = { toolCallId: string; name: string; content: string; isError: boolean; errorCode?: string };
/** THIS round's results, the executor's own `turnToolResults`, which it hands the count. */
const roundOf = (calls: Call[], errored: string[] = []): RoundResult[] =>
  calls.map((c) => ({ toolCallId: c.id, name: c.name, content: errored.includes(c.id) ? 'Error: 404' : 'ok', isError: errored.includes(c.id) }));

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
    countTrackerWorkThisIteration(stateWith(CALLS, ['c3']), ctxFor(CALLS), roundOf(CALLS, ['c3']));
    expect(ledger('only')).toEqual(['gmail:msg:ok-1', 'gmail:msg:ok-2']);
  });

  it('REVIEW FOCUS 4: two claimed tasks — the most recently updated one is charged, the same pick as the effort meter', () => {
    seedTrackerTask(mockDb.current!, { id: 'older', agentId: AGENT, status: 'in_progress', updated_at: 1_700_000_000_000 });
    seedTrackerTask(mockDb.current!, { id: 'newer', agentId: AGENT, status: 'in_progress', updated_at: 1_700_000_500_000 });
    countTrackerWorkThisIteration(stateWith(CALLS, ['c3']), ctxFor(CALLS), roundOf(CALLS, ['c3']));
    expect(ledger('newer')).toEqual(['gmail:msg:ok-1', 'gmail:msg:ok-2']);
    expect(ledger('older')).toEqual([]);
    const effort = (id: string) => (mockDb.current!.prepare('SELECT effort_calls AS n FROM work WHERE id = ?').get(id) as { n: number }).n;
    expect(effort('newer')).toBeGreaterThan(0);
    expect(effort('older')).toBe(0);
  });

  it('REVIEW FOCUS 4: the only task is paused — nothing is charged', () => {
    seedTrackerTask(mockDb.current!, { id: 'paused', agentId: AGENT, status: 'paused' });
    countTrackerWorkThisIteration(stateWith(CALLS), ctxFor(CALLS), roundOf(CALLS));
    expect(ledger('paused')).toEqual([]);
    expect((mockDb.current!.prepare('SELECT COUNT(*) AS n FROM work_ledger').get() as { n: number }).n).toBe(0);
  });

  it('fix round 1: a refusal is judged by its flag, never by its words — "Refused: …" with isError is not work done', () => {
    seedTrackerTask(mockDb.current!, { id: 'only', agentId: AGENT, status: 'in_progress' });
    const round = roundOf(CALLS).map((r) => (r.toolCallId === 'c2' ? { ...r, content: 'Refused: that label change changes nothing', isError: true } : r));
    countTrackerWorkThisIteration(stateWith(CALLS), ctxFor(CALLS), round);
    expect(ledger('only')).toEqual(['gmail:msg:failed-1', 'gmail:msg:ok-1']);
  });

  it('fix round 1: a structural errorCode is a failure even when the flag was not set', () => {
    seedTrackerTask(mockDb.current!, { id: 'only', agentId: AGENT, status: 'in_progress' });
    const round = roundOf(CALLS).map((r) => (r.toolCallId === 'c1' ? { ...r, errorCode: 'PERMISSION_DENIED' } : r));
    countTrackerWorkThisIteration(stateWith(CALLS), ctxFor(CALLS), round);
    expect(ledger('only')).toEqual(['gmail:msg:failed-1', 'gmail:msg:ok-2']);
  });

  it('fix round 1: only THIS round\'s results count — a call with no result this round is not charged, and an older round\'s success is not this call\'s', () => {
    seedTrackerTask(mockDb.current!, { id: 'only', agentId: AGENT, status: 'in_progress' });
    // The turn's history holds a SUCCESS under c1's id (an earlier round); this round has c1 failed and no result for c2.
    const state = { ...stateWith(CALLS), toolResults: [{ toolCallId: 'c1', name: 'gmail_label', content: 'ok', isError: false }] } as AgentTurnState;
    const round = roundOf(CALLS, ['c1']).filter((r) => r.toolCallId !== 'c2');
    countTrackerWorkThisIteration(state, ctxFor(CALLS), round);
    expect(ledger('only')).toEqual(['gmail:msg:failed-1']);
  });

  it('fix round 1: a claimed task older than a more recently touched PAUSED one is the one charged', () => {
    seedTrackerTask(mockDb.current!, { id: 'claimed-old', agentId: AGENT, status: 'in_progress', updated_at: 1_700_000_000_000 });
    seedTrackerTask(mockDb.current!, { id: 'paused-new', agentId: AGENT, status: 'paused', updated_at: 1_700_000_900_000 });
    countTrackerWorkThisIteration(stateWith(CALLS), ctxFor(CALLS), roundOf(CALLS));
    expect(ledger('claimed-old')).toEqual(['gmail:msg:failed-1', 'gmail:msg:ok-1', 'gmail:msg:ok-2']);
    expect(ledger('paused-new')).toEqual([]);
  });
});

// v3.5 FIELD FIX 3 (#6a): on the owner's box a file-creation task was upheld on the worker's word,
// because the ledger only knew mailbox items. The worker's file and command work now lands on the
// SAME ledger, at the SAME seam, from the tools' own declared effects (`fs_write`, `proc`, `shell`).
describe('v3.5 field fix 3 (#6a): the ledger learns the worker\'s file and command work', () => {
  const detailOf = (taskId: string, key: string): string | null =>
    (mockDb.current!.prepare('SELECT detail FROM work_ledger WHERE work_id = ? AND item_key = ?').get(taskId, key) as { detail: string | null } | undefined)?.detail ?? null;
  const WORK: Call[] = [
    { id: 'f1', name: 'file_write', arguments: { path: '/tmp/out/summary.md', content: 'x' } },
    { id: 'f2', name: 'file_append', arguments: { path: '/tmp/out/log.md', content: 'y' } },
    { id: 'f3', name: 'file_read', arguments: { path: '/tmp/out/summary.md' } },
    { id: 'x1', name: 'exec', arguments: { argv: ['mkdir', '-p', '/tmp/out'] } },
    { id: 'x2', name: 'shell', arguments: { script: 'ls /tmp/out | wc -l' } },
    { id: 'x3', name: 'exec', arguments: { argv: ['false'] } },
  ];
  const round = (over: Record<string, Partial<RoundResult>> = {}): RoundResult[] =>
    roundOf(WORK).map((r) => ({ ...r, ...(over[r.toolCallId] ?? {}) }));

  it('files written are recorded by path, commands by their text with the exit status; a read is not', () => {
    seedTrackerTask(mockDb.current!, { id: 'only', agentId: AGENT, status: 'in_progress' });
    countTrackerWorkThisIteration(stateWith(WORK), ctxFor(WORK), round({
      x1: { content: '(command completed with no output)' },
      x2: { content: 'stdout:\n3' },
      x3: { content: 'command_failed: exit 1' },
    }), effectsFor);
    expect(ledger('only')).toEqual([
      'cmd:false', 'cmd:ls /tmp/out | wc -l', 'cmd:mkdir -p /tmp/out',
      'file:/tmp/out/log.md', 'file:/tmp/out/summary.md',
    ]);
    expect(detailOf('only', 'cmd:mkdir -p /tmp/out')).toBe('exit 0');
    expect(detailOf('only', 'cmd:ls /tmp/out | wc -l')).toBe('exit 0');
    expect(detailOf('only', 'cmd:false')).toBe('exit 1');
    expect(detailOf('only', 'file:/tmp/out/summary.md')).toBeNull();
  });

  it('a refused command (nothing ran) and a failed write are not work done', () => {
    seedTrackerTask(mockDb.current!, { id: 'only', agentId: AGENT, status: 'in_progress' });
    countTrackerWorkThisIteration(stateWith(WORK), ctxFor(WORK), round({
      f1: { content: 'Error: permission denied', isError: true },
      x1: { content: 'Error: exec takes an argv ARRAY', isError: true },
      x2: { content: 'denied', errorCode: 'PERMISSION_DENIED' },
      x3: { content: 'command_failed: exit 1' },
    }), effectsFor);
    expect(ledger('only')).toEqual(['cmd:false', 'file:/tmp/out/log.md']);
  });

  it('a re-run keeps one entry and its latest exit status', () => {
    seedTrackerTask(mockDb.current!, { id: 'only', agentId: AGENT, status: 'in_progress' });
    const once: Call[] = [{ id: 'r1', name: 'exec', arguments: { argv: ['make', 'report'] } }];
    countTrackerWorkThisIteration(stateWith(once), ctxFor(once), [{ toolCallId: 'r1', name: 'exec', content: 'command_failed: exit 2', isError: false }], effectsFor);
    const again: Call[] = [{ id: 'r2', name: 'exec', arguments: { argv: ['make', 'report'] } }];
    countTrackerWorkThisIteration(stateWith(again), ctxFor(again), [{ toolCallId: 'r2', name: 'exec', content: 'stdout:\nbuilt', isError: false }], effectsFor);
    expect(ledger('only')).toEqual(['cmd:make report']);
    expect(detailOf('only', 'cmd:make report')).toBe('exit 0');
  });
});

// v3.5 field fix 3, audit #5: the ledger records SENDS too (email, iMessage, SMS, phone, Teams), one
// entry per successful send call, from the tool's own declared `send` effect, with the recipient the
// arguments name. A send to another agent (send_to_agent, a group broadcast) is coordination, not
// delivered work, and is not recorded.
describe('audit #5: the ledger learns the worker\'s sends', () => {
  const sendRows = (taskId: string): Array<{ item_key: string; tool: string; detail: string | null }> =>
    mockDb.current!.prepare("SELECT item_key, tool, detail FROM work_ledger WHERE work_id = ? AND item_key LIKE 'send:%' ORDER BY item_key").all(taskId) as never;
  const SENDS: Call[] = [
    { id: 's1', name: 'gmail_send', arguments: { to: 'client@example.com', subject: 'Report', body: 'x' } },
    { id: 's2', name: 'user_outlook_send', arguments: { to: 'boss@example.com', subject: 'y', body: 'z' } },
    { id: 's3', name: 'gmail_reply', arguments: { message_id: 'm-9', body: 'thanks' } },
    { id: 's4', name: 'imessage_send', arguments: { recipient: '+15550100', message: 'on my way' } },
    { id: 's5', name: 'send_to_agent', arguments: { agent: 'pm', message: 'done' } },
  ];

  it('each successful send is one entry, with its recipient; a send to an agent is not delivered work', () => {
    seedTrackerTask(mockDb.current!, { id: 'only', agentId: AGENT, status: 'in_progress' });
    countTrackerWorkThisIteration(stateWith(SENDS), ctxFor(SENDS), roundOf(SENDS), effectsFor);
    expect(sendRows('only')).toEqual([
      { item_key: 'send:s1', tool: 'gmail_send', detail: 'client@example.com' },
      { item_key: 'send:s2', tool: 'user_outlook_send', detail: 'boss@example.com' },
      { item_key: 'send:s3', tool: 'gmail_reply', detail: null },
      { item_key: 'send:s4', tool: 'imessage_send', detail: '+15550100' },
    ]);
  });

  it('a refused or failed send is not recorded', () => {
    seedTrackerTask(mockDb.current!, { id: 'only', agentId: AGENT, status: 'in_progress' });
    countTrackerWorkThisIteration(stateWith(SENDS), ctxFor(SENDS), roundOf(SENDS, ['s1', 's2', 's3', 's4']), effectsFor);
    expect(sendRows('only')).toEqual([]);
  });
});
