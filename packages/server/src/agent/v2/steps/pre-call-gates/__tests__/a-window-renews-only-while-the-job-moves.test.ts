// At the end of a checkpoint window (75 steps or 15 minutes) a turn whose job moved takes another
// window; a turn whose job did not, that has no job, or that a person is waiting behind parks once (its job's
// task gets a due time), as does any turn past 200 tool calls or 500 passes. A job's own turn whose window
// moved nothing does not park again: its task records the stall. Driven through the real pre-call gates on a
// real migrated database; the job's movement is recorded by the real repeat rule.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../context-gates.js', () => ({ runContextGates: async (state: unknown) => ({ directive: 'proceed', state }) }));
vi.mock('../../../../../memory/compaction.js', () => ({
  checkAndCompact: vi.fn(async () => ({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 })),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { endTurnContext, turnContext } from '../../../../turn-context.js';
import { liveTurn } from '../../../__tests__/helpers/live-turn.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runPreCallGates, type PreCallGatesContext } from '../index.js';
import { liftRepeatStops, noteRepeatResult } from '../../../../v2/repeat-rule.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { getWaitingHumanConversations } from '../../../counterparty.js';

const AGENT = 'agent-window';
const TASK = 'task-window';

function stateAt(loopCount: number, ageMs = 0): AgentTurnState {
  const s = initState({
    agentId: AGENT, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'm', turnNumber: 1,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null,
    inboundChannel: null, inboundContext: null,
  });
  return advance(s, { phase: 'preCallGates', loopCount, turnStartMs: Date.now() - ageMs });
}

const ctx = { agentId: AGENT, turnNumber: 1, configuredModelId: 'm' } as unknown as PreCallGatesContext;
/** The running turn serves the owner's request, so a park has a request to open its task for. */
const OWNER_ASK = { kind: 'ask', id: 'owner-ask', sourceMessageId: 'owner-ask' } as const;
const bag = () => turnContext(AGENT) ?? liveTurn(AGENT, { turnNumber: 1, root: OWNER_ASK });
const gate = (state: AgentTurnState) => { bag(); return runPreCallGates(state, ctx); };
/** A park dates the job's task: that is the continuation. */
const jobParked = (): boolean => !!mockDb.current!.prepare('SELECT 1 FROM work WHERE agent_id = ? AND next_attempt_at IS NOT NULL').get(AGENT);
const clearParks = (): void => { mockDb.current!.prepare('UPDATE work SET next_attempt_at = NULL').run(); endTurnContext(AGENT); };
/** The next turn is the job's own, started from its task row. */
const asJobTurn = (): void => { liveTurn(AGENT, { turnNumber: 1, root: OWNER_ASK, servedJob: TASK }); };

function seedClaimedTask(): void {
  const now = Date.now();
  mockDb.current!.prepare(
    `INSERT INTO work (id, agent_id, kind, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, ?, 'task', 'owner', 'tracker', ?, 'claimed', 'action', 1, 0, 'sort the archive', ?, ?)`,
  ).run(TASK, AGENT, TASK, now - 60_000, now - 60_000);
}

/** A work call this turn whose result the window has not seen: the job moved. */
const aNewCallSucceeded = (state: AgentTurnState, n: number): void => {
  const turn = bag();
  noteRepeatResult(AGENT, turn, 'file_read', { path: `/archive/${state.turnStartMs}-${n}.txt` }, 'new batch', true);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, 'Worker', 'working', datetime('now', '-1 day'))`).run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; endTurnContext(AGENT); });

describe('a window renews only while the job moves and nobody waits', () => {
  it('a moving job passes 75 steps and 15 minutes without a park, and a still window after it parks', async () => {
    seedClaimedTask();
    let state = stateAt(76, 16 * 60_000);
    aNewCallSucceeded(state, 1);
    const renewed = await gate(state);
    expect(renewed.directive).toBe('proceed');
    expect(jobParked()).toBe(false);

    state = advance(renewed.state, { loopCount: 150 });
    expect((await gate(state)).directive, 'inside the new window').toBe('proceed');

    const parked = await gate(advance(state, { loopCount: 151 }));
    expect(parked).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(parked.state.engineCutExit).toBe('iteration_cap');
    expect(jobParked()).toBe(true);
  });

  it('a turn with no job parks at the window\'s end', async () => {
    const parked = await gate(stateAt(76));
    expect(parked).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(parked.state.engineCutExit).toBe('iteration_cap');
    expect(jobParked()).toBe(true);
  });

  it('a person who writes mid-turn waits at most one window: the moving job checkpoints at its end', async () => {
    seedClaimedTask();
    bag().pickupSeq = 0;   // the turn began before any message
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', channel: 'dashboard', senderId: 'owner', content: 'stop, wrong folder', turnNumber: 2 });
    expect(getWaitingHumanConversations(AGENT), 'precondition: the person is waiting').toHaveLength(1);
    const state = stateAt(76);
    aNewCallSucceeded(state, 1);
    const parked = await gate(state);
    expect(parked).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(jobParked()).toBe(true);
  });

  it('a person already waiting in another conversation at pickup ends the window; the served one does not', async () => {
    seedClaimedTask();
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', channel: 'dashboard', senderId: 'owner', content: 'sort the archive', turnNumber: 1 });
    const [served] = getWaitingHumanConversations(AGENT);
    const turn = bag();
    turn.pickupSeq = served.latest.rowid;
    turn.convKey = served.key;
    const state = stateAt(76);
    aNewCallSucceeded(state, 1);
    expect((await gate(state)).directive, 'only the served person waits: the window renews').toBe('proceed');

    const other = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', channel: 'imessage', senderId: '+15550001111',
      authorized: true, inboundMeta: JSON.stringify({ channel: 'imessage', sender: '+15550001111', authorized: true }), content: 'are you free?', turnNumber: 1 });
    turn.pickupSeq = other.seq;   // the second person was already waiting when the turn began
    expect(getWaitingHumanConversations(AGENT), 'precondition: two people wait').toHaveLength(2);
    const next = stateAt(76);
    aNewCallSucceeded(next, 2);
    const parked = await gate(next);
    expect(parked).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(jobParked()).toBe(true);
  });

  it('a moving job checkpoints at 200 tool calls or 500 passes, inside its window too', async () => {
    seedClaimedTask();
    for (const at of [{ loopCount: 10, toolCallsExecutedThisTurn: 200 }, { loopCount: 501 }]) {
      clearParks();
      const state = advance(stateAt(1), { ...at, checkpointWindow: { atLoop: at.loopCount - 1, atMs: Date.now(), mark: 0 } });
      aNewCallSucceeded(state, at.loopCount);
      expect(await gate(state)).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
      expect(jobParked()).toBe(true);
    }
  });

  it('a job turn whose window moved nothing ends without parking, and its task records the stall', async () => {
    seedClaimedTask();
    expect((await gate(stateAt(76))).directive, 'the first still window parks').toBe('exit');
    clearParks();
    asJobTurn();
    const ended = await gate(stateAt(76));
    expect(ended).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(jobParked(), 'no further continuation').toBe(false);
    expect(mockDb.current!.prepare("SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'stalled'").get(TASK)).toBeTruthy();
  });

  it('a job turn whose window moved parks for the next one', async () => {
    seedClaimedTask();
    await gate(stateAt(76));
    clearParks();
    asJobTurn();
    const state = advance(stateAt(10), { toolCallsExecutedThisTurn: 200, checkpointWindow: { atLoop: 9, atMs: Date.now(), mark: 0 } });
    aNewCallSucceeded(state, 1);
    expect(await gate(state)).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(jobParked()).toBe(true);
  });


  /** A job turn of a job whose every batch honestly prints the same line: the last turn ran it three times. */
  async function repeatingContinuation(): Promise<AgentTurnState> {
    seedClaimedTask();
    await gate(stateAt(76));
    clearParks();
    const archive = { argv: ['archive', '--next', '50'] };
    const last = liveTurn(AGENT, { turnNumber: 1, root: OWNER_ASK });
    for (let i = 0; i < 3; i++) noteRepeatResult(AGENT, last, 'exec', archive, 'Archived 50 messages.', true);
    const turn = liveTurn(AGENT, { turnNumber: 2, root: OWNER_ASK, servedJob: TASK });
    expect(noteRepeatResult(AGENT, turn, 'exec', archive, 'Archived 50 messages.', true), 'stopped at the 4th').toBeTruthy();
    return stateAt(76);
  }

  it('a job turn whose results honestly repeat keeps going when the agent chose to continue in the window', async () => {
    const state = await repeatingContinuation();
    expect(liftRepeatStops(AGENT, 'each run archives the next fifty').content).toMatch(/^Continuing/);
    expect((await gate(state)).directive, 'the lift is the job moving').toBe('proceed');
  });

  it('the same continuation with no lift in the window ends and records the stall', async () => {
    const state = await repeatingContinuation();
    expect(await gate(state)).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(jobParked()).toBe(false);
    expect(mockDb.current!.prepare("SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'stalled'").get(TASK)).toBeTruthy();
  });

});
