// At the end of a checkpoint window (75 steps or 15 minutes) a turn whose job moved takes another
// window; a turn whose job did not, or that has no job, parks once for a continuation. Driven through
// the real pre-call gates on a real migrated database; the job's movement is recorded by the real
// momentum recorder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../../memory/compaction.js', () => ({
  checkAndCompact: vi.fn(async () => ({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 })),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { pendingWakeups } from '../../../../shared-state.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runTurnTimeBudget } from '../turn-budget.js';
import { noteTurnCalls } from '../../../../../work/job-momentum.js';
import type { PreCallGatesContext } from '../index.js';

const AGENT = 'agent-window';
const TASK = 'task-window';

function stateAt(loopCount: number, ageMs = 0): AgentTurnState {
  const s = initState({
    agentId: AGENT, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'm', turnNumber: 1,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null,
    inboundChannel: null, inboundContext: null, pendingTechniqueAck: null,
  });
  return advance(s, { phase: 'preCallGates', loopCount, turnStartMs: Date.now() - ageMs });
}

const ctx = { agentId: AGENT, turnNumber: 1, configuredModelId: 'm', stashContinuationIfHuman: vi.fn() } as unknown as PreCallGatesContext;

function seedClaimedTask(): void {
  const now = Date.now();
  mockDb.current!.prepare(
    `INSERT INTO work (id, agent_id, kind, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, ?, 'task', 'owner', 'tracker', ?, 'claimed', 'action', 1, 0, 'sort the archive', ?, ?)`,
  ).run(TASK, AGENT, TASK, now - 60_000, now - 60_000);
}

const aNewCallSucceeded = (state: AgentTurnState, n: number): void =>
  noteTurnCalls(TASK, [{ name: 'file_read', arguments: { path: `/archive/${state.turnStartMs}-${n}.txt` } }], { startMs: state.turnStartMs, succeeded: () => true });

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Worker', 'working')`).run(AGENT);
  pendingWakeups.clear();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; pendingWakeups.clear(); });

describe('a window renews only while the job moves', () => {
  it('a moving job passes 75 steps and 15 minutes without a park, and a still window after it parks', async () => {
    seedClaimedTask();
    let state = stateAt(76, 16 * 60_000);
    aNewCallSucceeded(state, 1);
    const renewed = await runTurnTimeBudget(state, ctx);
    expect(renewed.directive).toBe('proceed');
    expect(pendingWakeups.has(AGENT)).toBe(false);

    state = advance(renewed.state, { loopCount: 150 });
    expect((await runTurnTimeBudget(state, ctx)).directive, 'inside the new window').toBe('proceed');

    const parked = await runTurnTimeBudget(advance(state, { loopCount: 151 }), ctx);
    expect(parked).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(parked.state.engineCutExit).toBe('iteration_cap');
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });

  it('a turn with no job parks at the window\'s end', async () => {
    const parked = await runTurnTimeBudget(stateAt(76), ctx);
    expect(parked).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(parked.state.engineCutExit).toBe('iteration_cap');
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });
});
