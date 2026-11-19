// Six untracked work calls open an engine task whenever the request the turn serves has no task linked,
// whatever other tasks the agent holds; the request's own open task is never doubled.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));

import { runMigrations } from '../../../../../db/migrations.js';
import { openTurnContext, endTurnContext } from '../../../../turn-context.js';
import { untrackedWorkAcrossTurns } from '../../../../turn-state.js';
import { initState } from '../../../state.js';
import { countTrackerWorkThisIteration } from '../tracker-counting.js';
import { runTrackerFloors } from '../tracker-floors.js';
import type { ExecuteContext } from '../index.js';

let agent = '';
const db = (): Database.Database => mockDb.current!;

/** One turn serving the owner's message `msg-job` that makes six untracked work calls. */
async function sixUntrackedCalls(): Promise<void> {
  const turnCtx = openTurnContext(agent);
  turnCtx.convKey = 'human:owner';
  turnCtx.turnNumber = 1;
  db().prepare("INSERT INTO turns (agent_id, turn_number, started_at, conv_key, answered) VALUES (?, 1, datetime('now'), 'human:owner', 0)").run(agent);
  const result = { toolCalls: Array.from({ length: 6 }, (_, i) => ({ id: `tc-${i}`, name: 'write_file', arguments: { path: `/tmp/f${i}.txt`, content: 'x' } })) };
  const state = initState({
    agentId: agent, contextWindow: 100_000, isAutoRouted: false, configuredModelId: 'm', turnNumber: 1, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: 'Sort the mailbox.', lastUserMessageId: 'msg-job',
    inboundChannel: 'dashboard', inboundContext: null,
  });
  const ectx = {
    agentId: agent, turnCtx, turnNumber: 1, db: db(), agent: { name: 'Agent' },
    counterparty: { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: 'owner', threadId: null, senderIsAgent: false },
    counterpartyIsAgentSender: false, chosenConvKey: 'human:owner', engineStartAckDeliveredThisTurn: false, staleTaskWindowMinutes: 45, result,
  } as unknown as ExecuteContext;
  await runTrackerFloors(countTrackerWorkThisIteration(state, ectx), ectx);
  endTurnContext(agent);
}

/** A working task of the agent, linked to `sourceMessageId`. */
const task = (sourceMessageId: string): void => {
  db().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, source_message_id, opened_at, updated_at)
    VALUES (?, 'task', ?, 'owner', 'tracker', 'r', 'claimed', 'task', 1, 0, 'Earlier work', ?, ?, ?)`).run(randomUUID(), agent, sourceMessageId, Date.now(), Date.now());
};
const scaffolds = (): number => (db().prepare("SELECT COUNT(*) AS n FROM work WHERE root_kind = 'engine_scaffold' AND agent_id = ?").get(agent) as { n: number }).n;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  agent = randomUUID();
  db().prepare("INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Agent', 'idle', '1970-01-01')").run(agent);
  untrackedWorkAcrossTurns.clear();
});
afterEach(() => { endTurnContext(agent); untrackedWorkAcrossTurns.clear(); });

describe('a long job gets a task even when another is in progress', () => {
  it('a task in progress for another request: the floor opens one for this request', async () => {
    task('msg-earlier');
    await sixUntrackedCalls();
    expect(scaffolds()).toBe(1);
  });

  it('a task already linked to this request: the floor opens none', async () => {
    task('msg-job');
    await sixUntrackedCalls();
    expect(scaffolds()).toBe(0);
  });
});
