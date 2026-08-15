// ════════════════════════════════════════════════════════════════════════════════
// HL4 STEP 2 (2a) — ONE AUTHORITY: THE TURN-ENDING FAMILY IS DERIVED FROM THE TABLE.
//
// W27's census (finding 2) found the thing HL4 step 2 was written to name. The engine
// carries TWO orderings over the same floors and they disagree:
//
//   · `STEER_PRECEDENCE` (`agent/v2/steer-queue.ts`) — declared, argued in five bands,
//     tested, and it decides which PENDING steer is DELIVERED first;
//   · the step sequence in `no-tool-calls.ts` — undeclared, and it decides which
//     detector gets to FIRE AT ALL, because inside this family the first floor that
//     fires `return`s and none of the others run that pass.
//
// The sequence ran `going-idle-in-progress` SECOND while the table ranks it NINTH, so on
// a turn where both qualify the two OWED-PERSON floors above it — `owed-interrupt` (27)
// and `promise-floor` (28) — never ran, despite outranking it in the table the engine
// itself declares. Nothing anywhere recorded that as intentional: the file's own header
// explains its two detectors and its reconciliation branch and says nothing about its
// position, and the one collision it HAS recorded (the weak model's double reply) was
// patched inside the floor rather than in the ordering.
//
// THE FIX IS NOT A NEW ORDER. It is the removal of a second one: the family's runtime
// sequence is now SORTED BY THE TABLE at module load, so there is exactly one authority
// and the chain is derived from it. Re-ranking a floor in `steer-queue.ts` moves the
// chain with it, and a divergence between the two is no longer expressible.
//
// §1 drives the starvation. §2 pins the derivation. §3 is the control that keeps §1
// from being a coincidence of fixture.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-hl4-2a-order', 'dojo.db'),
  };
});

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

const engineEventSpy = vi.fn();
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertEngineEventIfAbsent: (...a: unknown[]) => engineEventSpy(...(a as [])),
}));

const owedArrivals: { current: Array<{ id: string; content: string }> } = { current: [] };
vi.mock('../../../counterparty.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwedMidTurnArrivals: () => owedArrivals.current,
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { initState, type AgentTurnState } from '../../../state.js';
import { STEER_PRECEDENCE, steerPriority } from '../../../steer-queue.js';
import { TURN_ENDING_FAMILY, runNoToolCalls } from '../no-tool-calls.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'kevin';
const CONV = 'conv-1';
const TURN = 5100;

const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`).run(AGENT);
  d.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')`).run(AGENT);
  broadcastSpy.mockClear();
  engineEventSpy.mockClear();
  owedArrivals.current = [];
});

/** An in_progress task assigned to this agent — what `going-idle-in-progress` fires on. */
function seedClaimedTask(title = 'Draft the quarterly note'): string {
  const id = `task-${Math.random().toString(36).slice(2, 10)}`;
  db().prepare(`
    INSERT INTO work (id, kind, agent_id, assignee_agent, requester, root_kind, root_id,
                      state, intent, wakes, closes_thread, title, is_paused, opened_at, updated_at)
    VALUES (?, 'task', ?, ?, 'owner', 'tracker', ?, 'claimed', 'task', 0, 0, ?, 0, ?, ?)
  `).run(id, AGENT, AGENT, id, title, Date.now() - 120_000, Date.now() - 60_000);
  return id;
}

function freshState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const s = initState({
    agentId: AGENT, contextWindow: 100_000, isAutoRouted: false,
    configuredModelId: 'floor', turnNumber: TURN,
  } as never);
  return { ...s, ...over } as AgentTurnState;
}

function ctxFor(over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT,
    turnCtx: { lastAssembledAtIso: new Date().toISOString(), conversationId: CONV, root: undefined },
    turnNumber: TURN,
    db: db(),
    agent: { id: AGENT, name: 'Kevin' },
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' },
    counterpartyIsAgentSender: false,
    chosenConvKey: 'ck-1',
    hasUnansweredUser: true,
    triggerRow: null,
    isA2ATurn: false,
    isEngineTurn: false,
    isHumanContinuation: false,
    mostRecentIsA2A: false,
    mostRecentInbound: undefined,
    pendingEngineEvent: null,
    unrepliedAssign: null,
    a2aReplyContext: null,
    a2aReplyAssignMessageId: null,
    settledContextWakeTurn: false,
    waitingConvs: [],
    inboundChannel: 'dashboard',
    latestUserSource: null,
    lastUserMessageContent: null,
    configuredModelId: 'floor',
    turnStartedAt: new Date(Date.now() - 60_000).toISOString(),
    messageId: 'msg-live',
    result: { content: null, toolCalls: [], inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' },
    maxToolLoops: 20,
    reArmIfStrandedNoAnswer: vi.fn(),
    noteTerminalAnswer: vi.fn(),
    deliverEngineUserAck: vi.fn(async () => undefined),
    persistAndBroadcastSystemRow: vi.fn(),
    startAckRepliedNow: () => false,
    ...over,
  } as unknown as PostCallClassifyContext;
}

function scratchFor(over: Partial<PostCallScratch> = {}): PostCallScratch {
  return {
    persistedContent: null,
    interAgentTurn: false,
    deliberateSurfaceTurn: false,
    deliveredAsStartLine: false,
    hasXmlFallbackTools: false,
    effectiveModelIdForPersist: 'floor',
    ...over,
  };
}

/**
 * THE COLLISION, staged honestly rather than stubbed.
 *
 * Both floors' real gates are met by real state: a `claimed`, unpaused task assigned to
 * this agent and a `work_note` in the turn's ledger (so `going-idle-in-progress` sees
 * open work on a turn that worked a task), plus a human message that arrived mid-turn
 * (so `owed-interrupt` sees somebody waiting). Nothing surfaced, so the turn really is
 * ending with the person hearing nothing — which is the shape both floors exist for.
 *
 * `silent-closeout` (22) runs first in BOTH orders and is deliberately held down: no
 * work row closes this turn, so it stands down and the pass reaches the pair under test.
 */
function collisionState(): AgentTurnState {
  seedClaimedTask();
  return freshState({
    loopCount: 3,
    // `work_note` counts as task work (`going-idle.ts`'s `countsAsTaskWork`), and it is
    // NOT last, so `add-notes-stop` — which fires only on a work_note TAIL — stays out
    // of this measurement. One floor at a time.
    toolResults: [
      { toolCallId: 'tc-1', name: 'work_note', content: 'noted', isError: false },
      { toolCallId: 'tc-2', name: 'file_read', content: 'body', isError: false },
    ],
    toolCalls: [
      { id: 'tc-1', name: 'work_note', arguments: {} },
      { id: 'tc-2', name: 'file_read', arguments: { path: '/tmp/x' } },
    ],
  } as never);
}

// ════════════════════════════════════════════════════════════════════
// §1 — THE STARVATION, DRIVEN
// ════════════════════════════════════════════════════════════════════

describe('§1 an owed person is not starved by a housekeeping floor that ranks below them', () => {
  it('BOTH floors really do qualify on this turn — neither arm of the comparison is vacuous', async () => {
    // Stated first because §1's verdict is meaningless if only one floor was ever
    // eligible. Each is run ALONE, out of the family, against the same state.
    const { runGoingIdle } = await import('../going-idle.js');
    const { runOwedInterrupt } = await import('../owed-interrupt.js');

    owedArrivals.current = [{ id: 'm-b', content: 'actually, can you also check the invoice?' }];
    const idle = await runGoingIdle(collisionState(), ctxFor(), scratchFor());
    expect(idle.directive).toBe('continue');
    expect(idle.state.steerQueue.fired.map((e) => e.floor)).toContain('going-idle-in-progress');

    owedArrivals.current = [{ id: 'm-b', content: 'actually, can you also check the invoice?' }];
    const owed = await runOwedInterrupt(collisionState(), ctxFor(), scratchFor());
    expect(owed.directive).toBe('continue');
    expect(owed.state.steerQueue.fired.map((e) => e.floor)).toContain('owed-interrupt');
  });

  it('THE RED: the family gives the round to the OWED PERSON (27), not to the dangling task (31)', async () => {
    owedArrivals.current = [{ id: 'm-b', content: 'actually, can you also check the invoice?' }];

    const out = await runNoToolCalls(collisionState(), ctxFor(), scratchFor());

    // The round was bought by the floor the declared table ranks higher. Before this
    // commit `going-idle-in-progress` (31) took it and `owed-interrupt` (27) never ran
    // at all — the person's mid-turn message went unanswered so a task could be nagged
    // about, and the table said the opposite.
    const fired = out.state.steerQueue.fired.map((e) => e.floor);
    expect(fired).toContain('owed-interrupt');
    expect(fired).not.toContain('going-idle-in-progress');
    expect(out.directive).toBe('continue');
  });

  it('the dangling task is DEFERRED, not lost: the very next pass reaches its floor', async () => {
    // A floor that returns hands the model one more round; the family runs again on that
    // round. With `owed-interrupt` latched, the pass below it is reached — which is what
    // makes this a re-ordering and not a suppression.
    owedArrivals.current = [{ id: 'm-b', content: 'actually, can you also check the invoice?' }];
    const first = await runNoToolCalls(collisionState(), ctxFor(), scratchFor());

    owedArrivals.current = [{ id: 'm-b', content: 'actually, can you also check the invoice?' }];
    const second = await runNoToolCalls(
      { ...first.state, loopCount: 4 } as AgentTurnState, ctxFor(), scratchFor(),
    );
    expect(second.state.steerQueue.fired.map((e) => e.floor)).toContain('going-idle-in-progress');
  });
});

// ════════════════════════════════════════════════════════════════════
// §2 — ONE AUTHORITY: THE CHAIN IS DERIVED, NOT COPIED
// ════════════════════════════════════════════════════════════════════

describe('§2 the family order is the declared table, and cannot drift from it', () => {
  it('the runtime order is exactly `STEER_PRECEDENCE`\'s order over this family', () => {
    const running = TURN_ENDING_FAMILY.map((f) => f.floor);
    const byTable = [...TURN_ENDING_FAMILY]
      .map((f) => f.floor)
      .sort((a, b) => steerPriority(a) - steerPriority(b));
    expect(running).toEqual(byTable);
  });

  it('every member names a floor the table declares, and the seven the span ran are all here', () => {
    const declared = new Set(STEER_PRECEDENCE.map((f) => f.id));
    for (const member of TURN_ENDING_FAMILY) expect(declared.has(member.floor)).toBe(true);
    expect(TURN_ENDING_FAMILY.map((f) => f.floor)).toEqual([
      'silent-closeout',        // 22
      'owed-interrupt',         // 27
      'promise-floor',          // 28
      'a2a-handoff-floor',      // 29
      'a2a-missed-reply',       // 30
      'going-idle-in-progress', // 31 — was second, ranks ninth; the inversion this fixes
      'tracker-closeout',       // 72
    ]);
  });

  it('THE PROPERTY, not the list: re-ranking a floor moves the chain with it', () => {
    // The clause above pins today's order; this one pins that the order is DERIVED. If
    // someone re-numbers a floor in `steer-queue.ts` and the chain does not follow, the
    // second ordering is back and this fails.
    const priorities = TURN_ENDING_FAMILY.map((f) => steerPriority(f.floor));
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i], `${TURN_ENDING_FAMILY[i].floor} runs after a floor it outranks`)
        .toBeGreaterThan(priorities[i - 1]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// §3 — CONTROLS
// ════════════════════════════════════════════════════════════════════

describe('§3 nothing else about the family moved', () => {
  it('with nobody owed, the dangling task still gets its floor on the FIRST pass', async () => {
    owedArrivals.current = [];
    const out = await runNoToolCalls(collisionState(), ctxFor(), scratchFor());
    expect(out.state.steerQueue.fired.map((e) => e.floor)).toContain('going-idle-in-progress');
    expect(out.directive).toBe('continue');
  });

  it('with nothing owed and no dangling task, the family ends the turn as it always did', async () => {
    owedArrivals.current = [];
    const out = await runNoToolCalls(freshState({ loopCount: 3 }), ctxFor(), scratchFor());
    expect(out.state.steerQueue.fired).toEqual([]);
    expect(out.directive).toBe('exit');
    expect(out.reason).toBe('no-tool-calls-turn-is-done');
  });
});
