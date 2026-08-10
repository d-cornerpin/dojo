// UX-REPAIR ROUND 5 / T22 — THE PROMISE FLOOR RECOGNIZES SCHEDULED WORK.
//
// ── THE INCIDENT (round-5 S1, on the wire) ──
// "In 15 minutes, look up whether the Mariners played today and message me the score."
// The turn did exactly the right thing: `work_open(kind="task", title="Mariners score check",
// scheduled_start="2026-08-10T21:06:00Z")` — fifteen minutes out — and then told the user
// "On it — I'll check the Mariners score at 2:06 and message you either way."
//
// `work_open` classifies as BOOKKEEPING, so the floor's work-done predicate (successful
// `effectful-action` results, or a CLOSING_WORK_OP) read the turn as a promise with nothing
// behind it and steered: "Do the work NOW with tool calls and deliver the result" — against
// the user's explicit timing. The model's own thinking shows it nearly obeyed in the worst
// way (do the lookup now, deliver now, cancel the scheduled task); the timed job survived on
// model judgment, at the visible cost of a stray 15-minutes-early `web_search` chip.
//
// The floor's own header records what it is for: the 2026-07-08 "On it. Let me pull up all
// your calendars." with NOTHING behind it. That case is pinned red below and is the bound on
// this exemption — the difference is a tracked row with a future fire on it, read from the
// ROW rather than from what the reply or the tool result said.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-promise-floor-test', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {} }));

const insertEngineEventIfAbsentSpy = vi.fn();
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertEngineEventIfAbsent: (...a: unknown[]) => insertEngineEventIfAbsentSpy(...(a as [])),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { openTrackerTask } from '../../../../../work/tracker-store.js';
import { patchWork } from '../../../../../work/tracker-store.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runPromiseFloor } from '../promise-floor.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'behaviorbot';
const TURN = 4632;

/** The S1 reply, verbatim from the round-5 catalog. */
const S1_PROMISE = "On it — I'll check the Mariners score at 2:06 and message you either way.";
/** The 2026-07-08 case the floor was BUILT for, verbatim from its own header. */
const EMPTY_PROMISE = 'On it. Let me pull up all your calendars.';

function stateWith(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const base = initState({
    agentId: AGENT, contextWindow: 128_000, isAutoRouted: false,
    configuredModelId: 'test-model', turnNumber: TURN, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: 'In 15 minutes, look up the score',
    lastUserMessageId: 'msg-user-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, { loopCount: 2, modelId: 'test-model', ...over });
}

/** The S1 turn's tool traffic: one successful `work_open`, nothing else. */
function withWorkOpen(state: AgentTurnState, opts: { isError?: boolean } = {}): AgentTurnState {
  const call = {
    id: 'tc-1', name: 'work_open',
    arguments: { kind: 'task', title: 'Mariners score check', scheduled_start: '2026-08-10T21:06:00Z' },
  } as ToolCall;
  return advance(state, {
    toolCalls: [call],
    toolResults: [{
      toolCallId: 'tc-1', name: 'work_open', isError: opts.isError ?? false,
      content: 'Task opened: 92fba53b (scheduled)',
    } as AgentTurnState['toolResults'][number]],
  });
}

function ctxFor(over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT,
    turnNumber: TURN,
    db: mockDb.current,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as PostCallClassifyContext['counterparty'],
    chosenConvKey: 'ck-1',
    isEngineTurn: false,
    maxToolLoops: 75,
    ...over,
  } as unknown as PostCallClassifyContext;
}

const scratch = (persistedContent: string): PostCallScratch => ({
  persistedContent, interAgentTurn: false, deliberateSurfaceTurn: false,
  deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'test-model',
});

/** A tracker row opened BY THIS TURN, with the schedule the caller names. */
function seedOpenedThisTurn(o: { scheduledStartMs?: number | null; nextRunAtMs?: number | null; turn?: number }): string {
  const id = openTrackerTask({
    title: 'Mariners score check', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: o.turn ?? TURN, convKey: 'ck-1' },
  });
  patchWork(id, {
    ...(o.scheduledStartMs !== undefined ? { scheduled_start: o.scheduledStartMs } : {}),
    ...(o.nextRunAtMs !== undefined ? { next_run_at: o.nextRunAtMs } : {}),
  });
  return id;
}

const FIFTEEN_MIN = 15 * 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'BehaviorBot', 'idle', '1970-01-01')`).run(AGENT);
});

describe('T22: a promise backed by a future-scheduled row is not an empty promise', () => {
  it('THE S1 REPLAY: the timed job is opened for 15 minutes out — no steer', () => {
    seedOpenedThisTurn({ scheduledStartMs: Date.now() + FIFTEEN_MIN });
    const out = runPromiseFloor(withWorkOpen(stateWith()), ctxFor(), scratch(S1_PROMISE));
    expect(out.directive, 'the user said "in 15 minutes"; the floor must not order the work done NOW').toBe('proceed');
    expect(insertEngineEventIfAbsentSpy).not.toHaveBeenCalled();
  });

  it('a recurring row whose next fire is in the future counts the same', () => {
    seedOpenedThisTurn({ scheduledStartMs: null, nextRunAtMs: Date.now() + FIFTEEN_MIN });
    const out = runPromiseFloor(withWorkOpen(stateWith()), ctxFor(), scratch(S1_PROMISE));
    expect(out.directive).toBe('proceed');
  });
});

describe('T22 controls: the 2026-07-08 case this floor was built for stays red', () => {
  it('THE PIN: a promise with NO tool work at all is still steered', () => {
    const out = runPromiseFloor(stateWith(), ctxFor(), scratch(EMPTY_PROMISE));
    expect(out.directive).toBe('continue');
    expect(insertEngineEventIfAbsentSpy).toHaveBeenCalledTimes(1);
    expect((insertEngineEventIfAbsentSpy.mock.calls[0][0] as { originIntent: string }).originIntent)
      .toBe('promise_floor');
    // the steer text is byte-identical for the cases that still deserve it
    expect((insertEngineEventIfAbsentSpy.mock.calls[0][0] as { content: string }).content)
      .toContain('Do the work NOW with tool calls and deliver the result.');
  });

  it('a promise beside a PAST-scheduled row is still steered', () => {
    seedOpenedThisTurn({ scheduledStartMs: Date.now() - FIFTEEN_MIN });
    const out = runPromiseFloor(withWorkOpen(stateWith()), ctxFor(), scratch(S1_PROMISE));
    expect(out.directive, 'a row whose fire is already past is not a bounded future').toBe('continue');
  });

  it('a promise beside a row with NO schedule at all is still steered', () => {
    seedOpenedThisTurn({});
    const out = runPromiseFloor(withWorkOpen(stateWith()), ctxFor(), scratch(S1_PROMISE));
    expect(out.directive).toBe('continue');
  });

  it('a FAILED work_open leaves no row, so the floor still fires', () => {
    // Nothing seeded: the failed call created nothing, which is exactly what the ROW-side
    // predicate reads. A tool-result-text predicate would have had to guess.
    const out = runPromiseFloor(withWorkOpen(stateWith(), { isError: true }), ctxFor(), scratch(S1_PROMISE));
    expect(out.directive).toBe('continue');
  });

  it("another agent's future-scheduled row on the same turn number does not exempt this turn", () => {
    mockDb.current!.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES ('other', 'Other', 'idle', '1970-01-01')`).run();
    const id = openTrackerTask({
      title: 'someone else\'s timed job', status: 'in_progress', assignedTo: 'other', createdBy: 'other',
      origin: { kind: 'agent', sourceMessageId: null, turn: TURN, convKey: 'ck-other' },
    });
    patchWork(id, { scheduled_start: Date.now() + FIFTEEN_MIN });
    const out = runPromiseFloor(withWorkOpen(stateWith()), ctxFor(), scratch(S1_PROMISE));
    expect(out.directive).toBe('continue');
  });

  it('a row this agent opened on an EARLIER turn does not exempt this one', () => {
    seedOpenedThisTurn({ scheduledStartMs: Date.now() + FIFTEEN_MIN, turn: TURN - 1 });
    const out = runPromiseFloor(withWorkOpen(stateWith()), ctxFor(), scratch(S1_PROMISE));
    expect(out.directive).toBe('continue');
  });
});

describe('T22 controls: the untouched guards still bound the floor', () => {
  it('the effectful-work exemption is unchanged', () => {
    const call = { id: 'tc-2', name: 'send_email', arguments: { to: 'a@b.c' } } as ToolCall;
    const st = advance(stateWith(), {
      toolCalls: [call],
      toolResults: [{ toolCallId: 'tc-2', name: 'send_email', isError: false, content: 'sent' } as AgentTurnState['toolResults'][number]],
    });
    expect(runPromiseFloor(st, ctxFor(), scratch(EMPTY_PROMISE)).directive).toBe('proceed');
  });

  it('the MAX_TOOL_LOOPS proximity skip is unchanged', () => {
    const out = runPromiseFloor(stateWith({ loopCount: 75 }), ctxFor({ maxToolLoops: 75 }), scratch(EMPTY_PROMISE));
    expect(out.directive).toBe('proceed');
  });

  it('an engine turn is never steered by this floor', () => {
    const out = runPromiseFloor(stateWith(), ctxFor({ isEngineTurn: true }), scratch(EMPTY_PROMISE));
    expect(out.directive).toBe('proceed');
  });

  it('a reply that is not a forward promise is never steered', () => {
    const out = runPromiseFloor(stateWith(), ctxFor(), scratch('The Mariners lost 4-2 to the Angels.'));
    expect(out.directive).toBe('proceed');
  });
});
