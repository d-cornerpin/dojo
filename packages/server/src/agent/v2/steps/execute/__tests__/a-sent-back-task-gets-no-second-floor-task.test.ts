// A worker redoing a sent-back task linked to the request its turn serves: six untracked work calls open no engine task
// beside it. A redo turn woken by another message (the PM's send-back) has no task linked to that message, so the
// floor opens one engine task, once per turn, and the job's window still ends at the next window with no movement.
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
import { turnWindow } from '../../post-call-classify/job-turn-end.js';
import { advance } from '../../../state.js';
import type { ExecuteContext } from '../index.js';

const AGENT = 'agent-sent-back-floor';
const db = (): Database.Database => mockDb.current!;

async function sixUntrackedCalls(turnNumber: number, keep?: (state: ReturnType<typeof initState>) => void): Promise<void> {
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
  state = await runTrackerFloors(state, ectx);
  state = countTrackerWorkThisIteration(state, ectx);   // six more calls in the same turn
  state = await runTrackerFloors(state, ectx);
  keep?.(state);
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

  it('a redo turn woken by another message: one engine task for that turn, and the window still ends with no movement', async () => {
    db().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, source_message_id, opened_at, updated_at)
      VALUES ('task-sent-back', 'task', ?, 'owner', 'tracker', 'task-sent-back', 'sent_back', 'task', 1, 0, 'Fix the totals page', 'msg-1', ?, ?)`).run(AGENT, Date.now(), Date.now());
    let windows: string[] = [];
    await sixUntrackedCalls(3, (state) => {
      openTurnContext(AGENT).turnNumber = 3;
      const at = advance(state, { loopCount: 76 });
      const renewed = turnWindow(at, AGENT);   // the floor's new task is this window's movement
      const next = advance(at, { loopCount: 152, checkpointWindow: { atLoop: 76, atMs: Date.now(), mark: 1 } });
      windows = [renewed, turnWindow(next, AGENT)];
    });
    expect(scaffolds(), 'one engine task for the turn, though twelve calls ran').toBe(1);
    expect(windows).toEqual(['renew', 'checkpoint']);
  });
});
