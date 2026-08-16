// UX-REPAIR ROUND 8 / T33 — A STANDING PROMISE IS RECORDED OR NOT MADE.
//
// ── THE INCIDENT (round-8 S5, on the wire) ──
// The user: "From now on, if a reminder fires and I don't respond here within a few minutes,
// text my phone as a backup. Can you do that?"
// The agent: "Yes, I can. From now on, when a reminder fires I'll post it here first — and if
// you haven't replied within a few minutes, I'll text it to your phone as a backup."
//
// ZERO tool calls. ZERO writes of any kind — the recorder snapshotted every durable surface
// before and after the turn: work rows 10 → 10, future-fire rows 2 → 2, vault_entries 78 → 78,
// config keys 485 → 485, files byte-identical, no receipts, no summaries. The promise covers a
// monitoring mechanism the platform does not have (nothing on this box triggers on the ABSENCE
// of an owner reply) and an SMS send this agent cannot perform (`sms_send` refuses a non-primary
// agent by identity — `agent/tools/cat/comms.ts`). It will silently never happen, and it does
// not even survive a session reset: it exists only as one assistant message.
//
// The promise floor is the mechanism for exactly this class — a promise with nothing behind it,
// its own header's 2026-07-08 case. Its recognizer covers IMMEDIATE forward promises ("I'll go
// pull up your calendars"), not STANDING ones ("from now on … I'll"), so no steer fired.
// Verified at HEAD before this suite was written: `isForwardPromiseReply(<the S5 reply>)` is
// `false`, and the floor returns `proceed`.
//
// ── WHAT THIS SUITE PINS ──
//   * the S5 reply with nothing durable written → ONE steer, naming the durable doors;
//   * the exemption is a RECEIPT, never prose: a vault write or a tracked row this turn exempts
//     it, and the model SAYING it recorded something does not;
//   * every bound of the floor the plan marks UNTOUCHED still bounds it: one-shot/no-spin, the
//     MAX_TOOL_LOOPS proximity skip, engine turns, non-user counterparties, and T22's
//     scheduled-work exemption (whose own suite stays green, unchanged);
//   * the FORWARD class keeps precedence and keeps its byte-identical steer text, so the
//     2026-07-08 pin cannot be re-worded by this task.

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-standing-promise-test', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {} }));

// T53 (owner ruling 5): the observation point moved with the carrier. The floor used to
// write its steer to the events lane as well as the queue, and these clauses watched that
// events-lane write to read what the model was told. The floor now steers through the RC-19
// door, so the durable record is a `role='system'` row and the model-facing delivery is the
// queue entry — both carrying the SAME bytes. Watching the row keeps every assertion below
// about the steer's WORDS exactly as it was; the clause that pins the two together against
// drift is in `agent/v2/__tests__/the-second-channel-stops-double-writing.test.ts`.
const steerRowSpy = vi.fn();
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: (...a: unknown[]) => steerRowSpy(...(a as [])),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { openTrackerTask, patchWork } from '../../../../../work/tracker-store.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { enqueueSteer, nextSteer } from '../../../steer-queue.js';
import { runPromiseFloor } from '../promise-floor.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'behaviorbot';
const TURN = 4712; // the S5 turn

/** The S5 reply, verbatim from the round-8 catalog (§9.1, row aa027e6c, seq 61093). */
const S5_STANDING_PROMISE =
  "Yes, I can. From now on, when a reminder fires I'll post it here first — and if you haven't "
  + "replied within a few minutes, I'll text it to your phone as a backup.";
/** The 2026-07-08 case the floor was BUILT for, verbatim from its own header. */
const EMPTY_PROMISE = 'On it. Let me pull up all your calendars.';

function stateWith(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const base = initState({
    agentId: AGENT, contextWindow: 128_000, isAutoRouted: false,
    configuredModelId: 'test-model', turnNumber: TURN, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    lastUserMessageContent: "From now on, if a reminder fires and I don't respond here within a few minutes, text my phone as a backup. Can you do that?",
    lastUserMessageId: 'msg-user-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, { loopCount: 2, modelId: 'test-model', ...over });
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

/** A successful tool result for `name`, the way the loop records one. */
function withToolCall(state: AgentTurnState, name: string, args: Record<string, unknown> = {}, opts: { isError?: boolean } = {}): AgentTurnState {
  const call = { id: `tc-${name}`, name, arguments: args } as ToolCall;
  return advance(state, {
    toolCalls: [call],
    toolResults: [{
      toolCallId: `tc-${name}`, name, isError: opts.isError ?? false, content: 'ok',
    } as AgentTurnState['toolResults'][number]],
  });
}

/** A tracker row stamped with this turn — the DB-side receipt. */
function seedRowOpenedThisTurn(o: { scheduledStartMs?: number | null; turn?: number } = {}): string {
  const id = openTrackerTask({
    title: 'backup text for unresponded reminders', status: 'in_progress',
    assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: o.turn ?? TURN, convKey: 'ck-1' },
  });
  if (o.scheduledStartMs !== undefined) patchWork(id, { scheduled_start: o.scheduledStartMs });
  return id;
}

const steerText = () => (steerRowSpy.mock.calls[0][0] as { content: string }).content;

beforeEach(() => {
  vi.clearAllMocks();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'BehaviorBot', 'idle', '1970-01-01')`).run(AGENT);
});

describe('T33: a standing promise with nothing behind it is steered once', () => {
  it('THE S5 REPLAY: zero tool calls, zero durable writes → one steer', () => {
    const out = runPromiseFloor(stateWith(), ctxFor(), scratch(S5_STANDING_PROMISE));
    expect(out.directive, 'a standing promise backed by nothing must not end the turn unchallenged').toBe('continue');
    expect(steerRowSpy).toHaveBeenCalledTimes(1);
    expect((steerRowSpy.mock.calls[0][0] as { role: string }).role).toBe('system');
  });

  it('the steer names the durable doors that exist, and never speaks to the user', () => {
    runPromiseFloor(stateWith(), ctxFor(), scratch(S5_STANDING_PROMISE));
    const text = steerText();
    expect(text.startsWith('[System]'), 'the floor steers the MODEL (OR2)').toBe(true);
    expect(text).toContain('vault_remember');
    expect(text).toContain('work_open');
    expect(text).toMatch(/tell the user honestly|say honestly/i);
    // It must NOT reuse the immediate class's order, which would be wrong advice here:
    // there is no "work" to do now for a promise about future occasions.
    expect(text).not.toContain('Do the work NOW with tool calls and deliver the result.');
  });

  // ── T53 (owner ruling 5): the floor speaks ONCE, on the channel that carries it ──
  it('T53: the steer reaches the model on the QUEUE only — no events-lane second copy', () => {
    const out = runPromiseFloor(stateWith(), ctxFor(), scratch(S5_STANDING_PROMISE));
    const queued = nextSteer(out.state.steerQueue);
    // CHANNEL 1, the delivery: the whole steer, on the very next iteration.
    expect(queued!.floor).toBe('promise-floor');
    expect(queued!.content).toContain('vault_remember');
    expect(queued!.content).toContain('Do not repeat the promise without recording it.');
    // …and the durable record carries the SAME bytes, so the two cannot drift.
    expect((steerRowSpy.mock.calls[0][0] as { content: string }).content).toBe(queued!.content);
    // CHANNEL 2, gone: nothing is written to the events lane for this floor.
    const riders = mockDb.current!.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND origin_intent = 'promise_floor'`,
    ).get(AGENT) as { n: number };
    expect(riders.n, 'the steer must not reach the model a second time next turn').toBe(0);
  });

  it('the standing promise is quoted back to the model so the steer is about THIS reply', () => {
    runPromiseFloor(stateWith(), ctxFor(), scratch(S5_STANDING_PROMISE));
    expect(steerText()).toContain('From now on, when a reminder fires');
  });
});

describe('T33: the exemption is a RECEIPT, never prose', () => {
  it('a successful vault_remember this turn exempts the reply', () => {
    const out = runPromiseFloor(
      withToolCall(stateWith(), 'vault_remember', { verbatim: true, pin: true, content: 'text my phone as a backup' }),
      ctxFor(), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('proceed');
    expect(steerRowSpy).not.toHaveBeenCalled();
  });

  it('a FAILED vault_remember is not a receipt — the floor still fires', () => {
    const out = runPromiseFloor(
      withToolCall(stateWith(), 'vault_remember', { content: 'x' }, { isError: true }),
      ctxFor(), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('continue');
  });

  it('a tracked row this turn opened exempts the reply, schedule or no schedule', () => {
    seedRowOpenedThisTurn();
    const out = runPromiseFloor(withToolCall(stateWith(), 'work_open', { kind: 'task' }), ctxFor(), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('proceed');
  });

  it("a row this agent opened on an EARLIER turn does not exempt this one", () => {
    seedRowOpenedThisTurn({ turn: TURN - 1 });
    const out = runPromiseFloor(withToolCall(stateWith(), 'work_open', { kind: 'task' }), ctxFor(), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('continue');
  });

  it('SAYING the promise was recorded, with no receipt anywhere, does not exempt it', () => {
    const out = runPromiseFloor(stateWith(), ctxFor(),
      scratch("Yes, I can. I've saved that to your preferences — from now on, if you don't reply within a few minutes I'll text your phone."));
    expect(out.directive).toBe('continue');
  });

  it('an updated agent configuration (a standing instruction that survives a reset) is a receipt', () => {
    const out = runPromiseFloor(
      withToolCall(stateWith(), 'update_agent', { agent_id: 'someone', system_prompt: '…' }),
      ctxFor(), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('proceed');
  });

  it('a scratchpad write is NOT durable (it dies on session reset) and does not exempt', () => {
    const out = runPromiseFloor(
      withToolCall(stateWith(), 'scratchpad_set', { content: 'remember to text the phone' }),
      ctxFor(), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('continue');
  });
});

describe('T33 controls: the recognizer stays conservative', () => {
  const quiet = (text: string) => {
    const out = runPromiseFloor(stateWith(), ctxFor(), scratch(text));
    expect(out.directive, `should not steer on: ${text}`).toBe('proceed');
    expect(steerRowSpy).not.toHaveBeenCalled();
  };

  it('a standing scope with no first-person commitment is not a promise', () => {
    quiet('From now on the reminders fire at 7am in your local timezone.');
  });

  it('a question is a legitimate ending, never a promise', () => {
    quiet('From now on, should I text your phone when you have not replied?');
  });

  it('an honest disclosure of what it cannot do is an accepted outcome, not a steer', () => {
    quiet("From now on I'll post reminders here, but I can't text your phone — only the primary agent can send SMS, so you would need to ask Kevin.");
  });

  it('a plain answer with no standing scope is untouched', () => {
    quiet('The Mariners lost 4-2 to the Angels.');
  });

  it('"whenever you like, let me know" is an invitation, not a promise', () => {
    quiet('Your reminder is set for 7pm. Whenever you want to change it, let me know.');
  });
});

describe('T33 controls: every UNTOUCHED bound still bounds the floor', () => {
  it('the forward class keeps precedence and its byte-identical steer text', () => {
    const out = runPromiseFloor(stateWith(), ctxFor(),
      scratch("From now on I'll check that for you. Let me pull up all your calendars."));
    expect(out.directive).toBe('continue');
    expect(steerText()).toContain('Do the work NOW with tool calls and deliver the result.');
  });

  it('the 2026-07-08 pin is untouched: an immediate empty promise gets the original steer', () => {
    const out = runPromiseFloor(stateWith(), ctxFor(), scratch(EMPTY_PROMISE));
    expect(out.directive).toBe('continue');
    expect(steerText()).toContain('Do the work NOW with tool calls and deliver the result.');
  });

  it('ONE STEER PER TURN: a promise-floor steer already fired means no second steer', () => {
    const st = advance(stateWith(), {
      steerQueue: enqueueSteer(stateWith().steerQueue, { floor: 'promise-floor', content: 'earlier steer', atLoop: 1 }),
    });
    const out = runPromiseFloor(st, ctxFor(), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('proceed');
    expect(steerRowSpy).not.toHaveBeenCalled();
  });

  it('the MAX_TOOL_LOOPS proximity skip is unchanged', () => {
    const out = runPromiseFloor(stateWith({ loopCount: 75 }), ctxFor({ maxToolLoops: 75 }), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('proceed');
  });

  it('an engine turn is never steered by this floor', () => {
    const out = runPromiseFloor(stateWith(), ctxFor({ isEngineTurn: true }), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('proceed');
  });

  it('a peer counterparty is never steered by this floor', () => {
    const out = runPromiseFloor(stateWith(), ctxFor({
      counterparty: { kind: 'agent', relation: 'peer' } as unknown as PostCallClassifyContext['counterparty'],
    }), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('proceed');
  });

  it('the engine conv key is never steered by this floor', () => {
    const out = runPromiseFloor(stateWith(), ctxFor({ chosenConvKey: 'engine' }), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('proceed');
  });

  it('an effectful action this turn exempts a standing promise too', () => {
    const out = runPromiseFloor(withToolCall(stateWith(), 'sms_send', { to: '+15550200' }), ctxFor(), scratch(S5_STANDING_PROMISE));
    expect(out.directive).toBe('proceed');
  });
});
