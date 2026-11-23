// v3.5 D1, FIX ROUND 2 (ruling 2, review NP2) — THE STALE-TASK STEER READS REAL MOVEMENT.
//
// FN-9's ">3 work calls and the only open task hasn't been updated in a while… open a project" steer
// judged "recently tended" by the task row's raw `updated_at`. The engine's checkpoint used to touch
// that column at every park, which is what kept a long job from being steered. A measured job's
// park no longer touches it (a park is not progress), and the items a job touches land in its ledger,
// not on the row. So the steer reads the platform's one definition of movement, `taskMovedAtSql`
// (which counts ledger touches): a job touching items is tended; a parked job touching nothing is not.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-stale-steer-test', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));

import { runMigrations } from '../../../../../db/migrations.js';
import { openTurnContext, endTurnContext } from '../../../../turn-context.js';
import { initState, advance, type AgentTurnState } from '../../../state.js';
import { runTrackerFloors } from '../tracker-floors.js';
import { recordTouched } from '../../../../../work/ledger-store.js';
import { seedTrackerTask } from '../../../../../work/__tests__/work-fixture.js';
import type { ExecuteContext } from '../index.js';

const AGENT = 'agent-stale-steer';
const TASK = 'task-measured-job';
const db = (): Database.Database => mockDb.current!;
const HOUR = 3_600_000;

function ctxFor(): ExecuteContext {
  const turnCtx = openTurnContext(AGENT);
  turnCtx.convKey = null;
  turnCtx.servedJob = TASK;   // the turn continues the measured job
  return {
    agentId: AGENT, turnCtx, turnNumber: 9, db: db(), agent: { name: 'Worker' },
    counterparty: { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: 'owner', threadId: null, senderIsAgent: false },
    counterpartyIsAgentSender: false, chosenConvKey: null, hasUnansweredUser: false,
    triggerRow: null, triggerWorkId: null, triggerConversationId: null,
    turnStartedAt: new Date().toISOString(), persistRoutingMarker: () => undefined,
    engineStartAckDeliveredThisTurn: false, deferredDeliveredByAck: false,
    startAckArmed: false, startAckArmedAtMs: 0, fireStartAckIfOwed: async () => undefined,
    result: { toolCalls: [] } as unknown as ExecuteContext['result'],
    messageId: 'resp-9', persistedContent: null, interAgentTurn: false, hasXmlFallbackTools: false,
    effectiveModelIdForPersist: 'm', staleTaskWindowMinutes: 30, engineBlockEscapeHatch: '',
    engineStartAckAfterMs: 30_000,
  } as unknown as ExecuteContext;
}

/** A continued turn that has made four work calls: past the steer's threshold, no tracker write. */
const fourCallsIn = (): AgentTurnState => advance(initState({
  agentId: AGENT, contextWindow: 100_000, isAutoRouted: false, configuredModelId: 'm', turnNumber: 9,
  triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null,
  inboundChannel: null, inboundContext: null,
} as unknown as Parameters<typeof initState>[0]), { nonTrackerToolCalls: 4 });

const steered = (s: AgentTurnState): boolean =>
  (s.steerQueue as unknown as { fired: Array<{ floor: string; content: string }> }).fired
    .some((e) => e.floor === 'tracker-stop-directive' && /hasn't been updated in a while/.test(e.content));

beforeEach(() => {
  endTurnContext(AGENT);
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Worker', 'idle')`).run(AGENT);
  // A measured job whose row was last written two hours ago (its parks no longer touch it).
  seedTrackerTask(db(), { id: TASK, agentId: AGENT, status: 'in_progress', title: 'Sort the inbox',
    opened_at: Date.now() - 2 * HOUR, updated_at: Date.now() - 2 * HOUR } as never);
});

describe('fix round 2 (NP2): the stale-task steer reads real movement', () => {
  it('a job touching items is tended: no "hasn\'t been updated" steer', async () => {
    recordTouched(TASK, 'gmail_label', ['gmail:msg:a', 'gmail:msg:b'], Date.now() - 60_000);
    const out = await runTrackerFloors(fourCallsIn(), ctxFor());
    expect(steered(out)).toBe(false);
  });

  it('a parked job touching nothing is not tended: the steer fires as before', async () => {
    const out = await runTrackerFloors(fourCallsIn(), ctxFor());
    expect(steered(out)).toBe(true);
  });
});
