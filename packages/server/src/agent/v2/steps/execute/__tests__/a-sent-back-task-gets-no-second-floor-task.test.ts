// A worker redoing a sent-back task linked to the request its turn serves: six untracked work calls open no engine task beside it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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

const AGENT = 'agent-sent-back-floor';
const db = (): Database.Database => mockDb.current!;

async function sixUntrackedCalls(turnNumber: number): Promise<void> {
  const turnCtx = openTurnContext(AGENT);
  turnCtx.convKey = 'human:owner';
  turnCtx.turnNumber = turnNumber;
  db().prepare("INSERT OR IGNORE INTO turns (agent_id, turn_number, started_at, conv_key, answered) VALUES (?, ?, datetime('now'), 'human:owner', 0)").run(AGENT, turnNumber);
  const result = { toolCalls: Array.from({ length: 6 }, (_, i) => ({ id: `tc-${turnNumber}-${i}`, name: 'write_file', arguments: { path: `/tmp/f${i}.txt`, content: 'x' } })) };
  let state = initState({
    agentId: AGENT, contextWindow: 100_000, isAutoRouted: false, configuredModelId: 'm', turnNumber, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: 'Fix the totals page.', lastUserMessageId: `msg-${turnNumber}`,
    inboundChannel: 'dashboard', inboundContext: null,
  });
  const ectx = {
    agentId: AGENT, turnCtx, turnNumber, db: db(), agent: { name: 'Agent' },
    counterparty: { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: 'owner', threadId: null, senderIsAgent: false },
    counterpartyIsAgentSender: false, chosenConvKey: 'human:owner', hasUnansweredUser: false, triggerRow: null, triggerWorkId: null,
    triggerConversationId: null, turnStartedAt: new Date().toISOString(), persistRoutingMarker: () => undefined,
    engineStartAckDeliveredThisTurn: false, deferredDeliveredByAck: false, refusedOnceSigs: new Set<string>(),
    startAckArmed: false, startAckArmedAtMs: 0, fireStartAckIfOwed: async () => undefined, result, messageId: `resp-${turnNumber}`,
    persistedContent: null, interAgentTurn: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'm',
    staleTaskWindowMinutes: 45, engineBlockEscapeHatch: '', engineStartAckAfterMs: 30_000,
  } as unknown as ExecuteContext;
  state = countTrackerWorkThisIteration(state, ectx);
  await runTrackerFloors(state, ectx);
  endTurnContext(AGENT);
}

const scaffolds = (): number => (db().prepare("SELECT COUNT(*) AS n FROM work WHERE root_kind = 'engine_scaffold' AND agent_id = ?").get(AGENT) as { n: number }).n;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO agents (id, name, status, session_started_at) VALUES (?, ?, 'idle', '1970-01-01')").run(AGENT, AGENT);
  untrackedWorkAcrossTurns.clear();
});
afterEach(() => { endTurnContext(AGENT); untrackedWorkAcrossTurns.clear(); });

describe('a sent-back task gets no second floor task', () => {
  it('with no task the floor opens one', async () => {
    await sixUntrackedCalls(1);
    expect(scaffolds()).toBe(1);
  });

  it('with a sent-back task linked to the request it opens none', async () => {
    db().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, source_message_id, opened_at, updated_at)
      VALUES ('task-sent-back', 'task', ?, 'owner', 'tracker', 'task-sent-back', 'sent_back', 'task', 1, 0, 'Fix the totals page', 'msg-2', ?, ?)`).run(AGENT, Date.now(), Date.now());
    await sixUntrackedCalls(2);
    expect(scaffolds()).toBe(0);
  });
});
