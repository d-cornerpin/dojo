// ════════════════════════════════════════════════════════════════════════════════════════
// T53 (owner ruling 5 of 2026-08-16) — THE SEVEN DOUBLE-WRITERS, CLEANED.
//
// W27's census §5.7 named it "THE BIG ONE": seven steer floors write the SAME text to two
// model-facing channels — the queue (this turn) and the events lane (a later turn). W28
// declared the pairing (`QUEUE_PAIRED_RIDERS`) and handed the design call up. The owner
// ruled: CLEAN UP, with absolute care.
//
// ── WHICH CHANNEL IS THE KEEPER, AND IT IS MEASURED RATHER THAN PREFERRED ────────────────
// The plan's default keeper is the events-lane rider "unless the site's own record argues
// otherwise". It does, at all seven, and so does this suite's own measurement (§0, driven
// against the real assembler and the real DB):
//
//   1. THE RIDER CANNOT DELIVER ON THE TURN THE FLOOR FIRES. `memory/store.ts`'s tail query
//      excludes `role='user'` rows created after the turn boundary, and an events row is
//      `role='user'` by construction (`memory/message-store.ts:engineRow`). The floors that
//      write it return `continueLoop` precisely to spend one more model call on the steer —
//      a call the rider is structurally absent from.
//   2. THE RIDER DELIVERS A TRUNCATED ECHO, NOT THE STEER. `lane.events` renders each row as
//      a ≤400-char gist with the leading bracket stripped and whitespace collapsed
//      (`lane.events.chars.gist`), under a header that frames it as a notice to be AWARE of.
//      Every one of the seven steers is longer than the cap, so the tail of the instruction —
//      the part that names the door — is what the cut removes.
//   3. THE QUEUE DELIVERS THE STEER VERBATIM (`msg.pending-nudge` renders `ctx.pendingSteer`).
//
// So the queue is the channel that carries the pair's information, and the rider is a delayed
// partial copy of it. The keeper is the queue; the events-lane write is what goes.
//
// ── WHAT REPLACES THE REMOVED WRITE, SO NOTHING IS LOST ──────────────────────────────────
// The RC-19 door, `persistEngineSteer`: a durable `role='system'` row carrying the steer's own
// bytes, plus the same queue entry. That is the shape HL3 already gave the OTHER eight steer
// sites, and `packages/shared/src/visibility.ts` classifies both carriers identically
// (`{ tier: 'agent-only', kind: 'engine-note' }`), so the dashboard record is unmoved. What
// changes, and the only thing that changes, is that the model stops receiving a truncated
// echo of an instruction it already received in full.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));

const broadcastSpy = vi.fn();
vi.mock('../../../gateway/ws.js', () => ({ broadcast: (e: unknown) => broadcastSpy(e) }));

import { runMigrations } from '../../../db/migrations.js';
import { assembleContext } from '../../../memory/assembler.js';
import { laneLimit } from '../../../memory/lanes.js';
import { renderMessageEntry } from '../../../prompt/registry/assembler.js';
import type { AssemblyContext } from '../../../prompt/registry/types.js';
import { insertEngineEventIfAbsent } from '../../../memory/message-store.js';
import { turnBoundary } from '../../turn-state.js';
import { initState, type AgentTurnState } from '../state.js';
import { nextSteer } from '../steer-queue.js';
import { runThrashGate } from '../steps/pre-call-gates/thrash-gate.js';
import type { PreCallGatesContext } from '../steps/pre-call-gates/index.js';
import { runHandoffFloors } from '../steps/post-call-classify/handoff-floors.js';
import type { PostCallClassifyContext, PostCallScratch } from '../steps/post-call-classify/index.js';
import { openTrackerTask } from '../../../work/tracker-store.js';

const AGENT = 'second-channel-agent';
const MODEL = 'second-channel-model';
const TURN = 91;

function seed(): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'sc', 'SC', 200000, 4096, '["tools"]')`,
  ).run(MODEL);
  db.prepare(
    "INSERT INTO agents (id, name, status, model_id, config, session_started_at) VALUES (?, 'SC', 'idle', ?, '{}', '1970-01-01')",
  ).run(AGENT, MODEL);
  // A live conversation, so the assembly has a tail to render around the events lane.
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, created_at)
     VALUES ('sc-u1', ?, 'user', 'owner', 'owner', 'what is the plan?', 'user-text', 'user-visible', ?, 'live', 1, 1785000000000)`,
  ).run(AGENT, TURN - 1);
}

/** Everything the model would receive, as one string. */
async function whatTheModelReceives(): Promise<string> {
  const ctx = await assembleContext(AGENT, MODEL);
  return ctx.messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n---\n');
}

/** The EVENTS & NOTICES line for a given intent, or null when the lane does not carry it. */
async function riderLine(intent: string): Promise<string | null> {
  const seen = await whatTheModelReceives();
  const line = seen.split('\n').find((l) => l.includes(`[${intent}]`));
  return line ?? null;
}

function baseState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  return {
    ...initState({
      agentId: AGENT, contextWindow: 200000, isAutoRouted: false,
      configuredModelId: MODEL, turnNumber: TURN, triggeredByIMessage: false,
      triggeredByA2AReplyIntent: null, imFlagSetAtRunStart: false, lastUserMessageContent: null,
    }),
    ...over,
  };
}

function gatesCtx(over: Partial<PreCallGatesContext> = {}): PreCallGatesContext {
  return {
    agentId: AGENT,
    turnNumber: TURN,
    contextWindow: 200000,
    contextModelId: MODEL,
    configuredModelId: MODEL,
    isAutoRouted: false,
    counterparty: { kind: 'user' } as PreCallGatesContext['counterparty'],
    assemblerOverheadTokens: 0,
    engineBlockEscapeHatch: 'If this looks wrong, say so.',
    broadcast: broadcastSpy,
    setAgentStatus: () => {},
    stashContinuationIfHuman: () => {},
    detectTaskThrashing: () => ({ thrashing: false }),
    ...over,
  } as PreCallGatesContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  turnBoundary.delete(AGENT);
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  seed();
});

afterEach(() => {
  turnBoundary.delete(AGENT);
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §0 · THE MEASUREMENT — what each channel actually delivers, driven end to end.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * A REAL steer, taken from a real floor rather than transcribed: the thrash gate's, because
 * it is the longest of the seven and the one whose old comment claimed the loudest that the
 * events row was the model-visible half.
 */
function aRealSteer(): string {
  const out = runThrashGate(baseState({ loopCount: 5 }), gatesCtx({
    detectTaskThrashing: () => ({ thrashing: true, toolName: 'file_read', signature: 'file_read:{"path":"/a"}', count: 4 }),
  }));
  const queued = nextSteer(out.state.steerQueue);
  expect(queued, 'the gate must file a steer, or every measurement below is vacuous').toBeTruthy();
  return queued!.content;
}

/** Put a steer on the second channel, exactly as the seven sites used to. */
function onTheEventsLane(content: string): void {
  insertEngineEventIfAbsent({
    work: null, id: 'sc-rider', agentId: AGENT, content,
    sourceAgentId: null, originIntent: 'thrash_gate', turnNumber: TURN,
  });
}

describe('§0 the two channels, measured against the real assembler', () => {
  it('the thrash gate fires: the queue carries the steer VERBATIM', () => {
    const out = runThrashGate(baseState({ loopCount: 5 }), gatesCtx({
      detectTaskThrashing: () => ({ thrashing: true, toolName: 'file_read', signature: 'file_read:{"path":"/a"}', count: 4 }),
    }));
    const queued = nextSteer(out.state.steerQueue);
    expect(queued, 'the gate must file a steer, or this measurement is vacuous').toBeTruthy();

    // The exact bytes the model receives from channel 1 — `msg.pending-nudge` renders the
    // steer with nothing added and nothing cut.
    const msg = renderMessageEntry('msg.pending-nudge', { pendingSteer: queued!.content } as unknown as AssemblyContext);
    expect(msg!.role).toBe('user');
    expect(msg!.content).toBe(queued!.content);
    expect(queued!.content).toContain('[Engine thrash gate]');
    expect(queued!.content).toContain('Your next action MUST be one of');
    expect(queued!.content).toContain('(e) Send the user a specific question');
  });

  it('the rider is INVISIBLE on the turn it is written — the tail cutoff excludes it', async () => {
    // The turn's own boundary: rows written after it are not in this turn's tail. This is
    // the fact that decides the keeper — the second channel cannot reach the extra model
    // call a floor's own `continueLoop` was spent to buy.
    turnBoundary.set(AGENT, new Date(Date.now() - 1000).toISOString());
    onTheEventsLane(aRealSteer());
    expect(await riderLine('thrash_gate')).toBeNull();
  });

  it('the rider delivers a TRUNCATED ECHO on a later turn, never the steer', async () => {
    const steer = aRealSteer();
    onTheEventsLane(steer);

    // A later turn: no boundary of its own yet, so the row is in the tail.
    const line = await riderLine('thrash_gate');
    expect(line, 'the events lane must carry the row, or this measurement is vacuous').not.toBeNull();

    const cap = laneLimit('lane.events', 'chars', 'gist');
    const gist = line!.slice(line!.indexOf('[thrash_gate] ') + '[thrash_gate] '.length);
    const body = steer.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();

    // It is the steer's own bytes, cut at the lane's declared cap: a strict prefix, so the
    // rider can never carry information the queue's verbatim delivery does not.
    expect(body.startsWith(gist)).toBe(true);
    expect(gist.length).toBeLessThanOrEqual(cap);
    expect(body.length).toBeGreaterThan(gist.length);
    // And what the cut removes is the instruction's operative tail.
    expect(body).toContain('Your next action MUST be one of');
    expect(gist).not.toContain('(e) Send the user a specific question');
  });

  it('the lane FRAMES whatever it carries as a notice, not as an order', async () => {
    // The removal argument is not only about the cut. A steer that arrives here arrives
    // under a header telling the model these are things it is merely AWARE of.
    onTheEventsLane(aRealSteer());
    const seen = await whatTheModelReceives();
    expect(seen).toContain('EVENTS & NOTICES (things that happened');
    expect(seen).toContain('Surface one to the owner only if it genuinely matters');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 · SITE BY SITE — the second channel is gone, and the first one is untouched.
//
// Each clause drives its floor for real and asks the two questions T53 asks: does the model
// still receive exactly what the pair delivered (the queue's verbatim steer), and does it
// stop receiving the second copy (nothing in a later turn's assembly carries the text)?
// The durable record is checked in the same breath, because a removal that took the row with
// it would trade a duplicate for a blind spot.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Every row this agent owns except the seeded conversation. */
function rows(): Array<{ role: string; lane: string; origin_intent: string | null; content: string }> {
  return mockDb.current!
    .prepare("SELECT role, lane, origin_intent, content FROM messages WHERE agent_id = ? AND id != 'sc-u1'")
    .all(AGENT) as Array<{ role: string; lane: string; origin_intent: string | null; content: string }>;
}

describe('§1 thrash-drift', () => {
  const drift = (): ReturnType<typeof runThrashGate> => runThrashGate(
    baseState({ loopCount: 12, thrashGateActivatedAtLoopCount: 0 }),
    gatesCtx(),
  );

  it('the queue still delivers the drift nudge, verbatim and unchanged', () => {
    const queued = nextSteer(drift().state.steerQueue);
    expect(queued!.floor).toBe('thrash-drift');
    expect(queued!.content).toContain('[Engine hint] The engine thrash gate has been active for 12 iterations');
    expect(queued!.content).toContain('work_update(action="status")');
    expect(renderMessageEntry('msg.pending-nudge', { pendingSteer: queued!.content } as unknown as AssemblyContext)!.content)
      .toBe(queued!.content);
  });

  it('the model receives NOTHING from the second channel on a later turn', async () => {
    const steer = nextSteer(drift().state.steerQueue)!.content;
    const body = steer.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
    expect(await riderLine('thrash_drift')).toBeNull();
    // Not merely un-labelled: the text itself is absent from everything the model is handed.
    expect(await whatTheModelReceives()).not.toContain(body.slice(0, 120));
  });

  it('the record survives the removal: a role=system row carries the steer\'s own bytes', () => {
    const steer = nextSteer(drift().state.steerQueue)!.content;
    const written = rows();
    expect(written.filter((r) => r.origin_intent === 'thrash_drift')).toEqual([]);
    const durable = written.filter((r) => r.role === 'system' && r.content === steer);
    expect(durable.length, 'the steer must still leave a durable row — a removal is not a blind spot').toBe(1);
  });
});

describe('§1 thrash-gate', () => {
  const SIG = 'file_read:{"path":"/a"}';
  const gate = (): ReturnType<typeof runThrashGate> => runThrashGate(
    baseState({ loopCount: 5 }),
    gatesCtx({ detectTaskThrashing: () => ({ thrashing: true, toolName: 'file_read', signature: SIG, count: 4 }) }),
  );

  it('the queue still delivers the gate steer, verbatim and still KEYED on the signature', () => {
    const out = gate();
    const queued = nextSteer(out.state.steerQueue);
    expect(queued!.floor).toBe('thrash-gate');
    // The key is the whole bound at this site — a second gated signature is a second fact.
    expect(queued!.key).toBe(SIG);
    expect(queued!.content).toContain('[Engine thrash gate]');
    expect(queued!.content).toContain('(e) Send the user a specific question');
    expect(renderMessageEntry('msg.pending-nudge', { pendingSteer: queued!.content } as unknown as AssemblyContext)!.content)
      .toBe(queued!.content);
    // …and the gate's own state still latches, which is what stops the second fire.
    expect(out.state.thrashGatedSignatures).toEqual([SIG]);
    expect(out.state.thrashGateActivatedAtLoopCount).toBe(5);
  });

  it('the model receives NOTHING from the second channel on a later turn', async () => {
    const steer = nextSteer(gate().state.steerQueue)!.content;
    const body = steer.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
    expect(await riderLine('thrash_gate')).toBeNull();
    expect(await whatTheModelReceives()).not.toContain(body.slice(0, 120));
  });

  it('the record survives the removal: a role=system row carries the steer\'s own bytes', () => {
    const steer = nextSteer(gate().state.steerQueue)!.content;
    const written = rows();
    expect(written.filter((r) => r.origin_intent === 'thrash_gate')).toEqual([]);
    expect(written.filter((r) => r.role === 'system' && r.content === steer).length).toBe(1);
  });
});

// ── The two delegation-and-delivery floors, driven ────────────────────────────────────────
// Neither had a driven harness of its own, so one is built here rather than asserted from
// source: both are one-more-round floors whose whole point is the extra model call, and that
// is precisely the call the second channel could never reach.

function classifyCtx(over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT,
    turnNumber: TURN,
    db: mockDb.current,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as PostCallClassifyContext['counterparty'],
    counterpartyIsAgentSender: false,
    chosenConvKey: 'ck-1',
    isEngineTurn: false,
    maxToolLoops: 75,
    triggerRow: { id: 'trigger-1' },
    turnCtx: { conversationId: 'conv-1', servedWork: null, root: null },
    ...over,
  } as unknown as PostCallClassifyContext;
}

const emptyReply = (): PostCallScratch => ({
  persistedContent: '', interAgentTurn: false, deliberateSurfaceTurn: false,
  deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: MODEL,
} as unknown as PostCallScratch);

/** A turn that handed work to a peer and is about to end saying nothing. */
function handoffState(): AgentTurnState {
  return baseState({
    loopCount: 3,
    toolCalls: [{ id: 'tc-1', name: 'send_to_agent', arguments: {} }],
    toolResults: [{ toolCallId: 'tc-1', name: 'send_to_agent', isError: false, content: 'sent' }],
  } as unknown as Partial<AgentTurnState>);
}

describe('§1 a2a-handoff-floor', () => {
  it('the queue still delivers the handoff steer, and the floor still buys its extra round', async () => {
    const out = await runHandoffFloors(handoffState(), classifyCtx(), emptyReply());
    expect(out.directive, 'the floor exists to re-enter the loop').toBe('continue');
    const queued = nextSteer(out.state.steerQueue);
    expect(queued!.floor).toBe('a2a-handoff-floor');
    expect(queued!.key, 'rung 1 of the ladder').toBe('');
    expect(queued!.content).toContain('You handed work to another agent');
    expect(queued!.content).toContain('do NOT call imessage_send or any send tool');
    expect(renderMessageEntry('msg.pending-nudge', { pendingSteer: queued!.content } as unknown as AssemblyContext)!.content)
      .toBe(queued!.content);
  });

  it('the model receives NOTHING from the second channel on a later turn', async () => {
    const out = await runHandoffFloors(handoffState(), classifyCtx(), emptyReply());
    const body = nextSteer(out.state.steerQueue)!.content
      .replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
    expect(await riderLine('a2a_handoff_floor')).toBeNull();
    expect(await whatTheModelReceives()).not.toContain(body.slice(0, 120));
  });

  it('the record survives the removal, and the SECOND rung is still a second fact', async () => {
    const first = await runHandoffFloors(handoffState(), classifyCtx(), emptyReply());
    expect(rows().filter((r) => r.origin_intent === 'a2a_handoff_floor')).toEqual([]);
    expect(rows().filter((r) => r.role === 'system' && r.content === nextSteer(first.state.steerQueue)!.content).length).toBe(1);

    // The ladder's own bound: rung 2 is keyed 'retry', so the counter still climbs to the cap.
    const second = await runHandoffFloors(
      { ...handoffState(), steerQueue: first.state.steerQueue } as AgentTurnState,
      classifyCtx(), emptyReply(),
    );
    const fired = second.state.steerQueue.fired.filter((e) => e.floor === 'a2a-handoff-floor');
    expect(fired.map((e) => e.key)).toEqual(['', 'retry']);
  });
});

describe('§1 reminder-silence', () => {
  /** An everyday reminder: long enough that the lane's 400-char cut reaches it, which is
   *  the point — this steer puts the reminder's own words LAST. */
  const REMINDER =
    "Call the vet about Luna's follow-up and ask whether the antibiotics need refilling";

  function reminderTurn(text: string = REMINDER): { state: AgentTurnState; ctx: PostCallClassifyContext } {
    const taskId = openTrackerTask({
      title: 'Reminder', description: text, status: 'in_progress',
      assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'agent', sourceMessageId: null, turn: TURN, convKey: 'ck-1' },
    });
    return {
      state: baseState({ loopCount: 3 }),
      ctx: classifyCtx({
        turnCtx: {
          conversationId: 'conv-1', root: null,
          servedWork: { taskKind: 'reminder', taskId },
        },
      } as unknown as Partial<PostCallClassifyContext>),
    };
  }

  it('the queue still delivers the reminder steer WITH the reminder in it', async () => {
    const { state, ctx } = reminderTurn();
    const out = await runHandoffFloors(state, ctx, emptyReply());
    expect(out.directive, 'the floor exists to re-enter the loop').toBe('continue');
    const queued = nextSteer(out.state.steerQueue);
    expect(queued!.floor).toBe('reminder-silence');
    expect(queued!.content).toContain('This turn is delivering a reminder');
    expect(queued!.content).toContain(`The reminder is: ${REMINDER}`);
    expect(renderMessageEntry('msg.pending-nudge', { pendingSteer: queued!.content } as unknown as AssemblyContext)!.content)
      .toBe(queued!.content);
  });

  it('THE SECOND CHANNEL\'S COST, MEASURED AT ITS OWN BOUNDARY, not asserted in general', async () => {
    // This site is where truncation stops being merely lossy. The steer ends with the
    // reminder's OWN WORDS, so the ≤400-char gist keeps the instruction and drops the thing
    // the turn exists to say — but only past a boundary, and the honest clause names it:
    // the steer's fixed prefix is 251 characters, so a reminder longer than that remainder
    // is cut, and a short one is not. Both arms are driven, so neither the claim nor its
    // limit is inherited.
    const cap = laneLimit('lane.events', 'chars', 'gist');
    const gistOf = (steer: string): string =>
      steer.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, cap);

    const short = await runHandoffFloors(...(() => {
      const t = reminderTurn(REMINDER);
      return [t.state, t.ctx, emptyReply()] as const;
    })());
    const shortSteer = nextSteer(short.state.steerQueue)!.content;
    expect(gistOf(shortSteer), 'an 81-char reminder still fits inside the cap').toContain(REMINDER);

    const LONG_REMINDER = REMINDER
      + ', and check whether the Thursday 4pm slot still works before you confirm it with Dad';
    const long = await runHandoffFloors(...(() => {
      const t = reminderTurn(LONG_REMINDER);
      return [t.state, t.ctx, emptyReply()] as const;
    })());
    const longSteer = nextSteer(long.state.steerQueue)!.content;
    expect(longSteer).toContain(LONG_REMINDER);
    expect(gistOf(longSteer), 'the second channel would deliver a reminder with the reminder cut off')
      .not.toContain(LONG_REMINDER);
  });

  it('the model receives NOTHING from the second channel, and the record survives', async () => {
    const { state, ctx } = reminderTurn();
    const out = await runHandoffFloors(state, ctx, emptyReply());
    const steer = nextSteer(out.state.steerQueue)!.content;
    expect(await riderLine('reminder_silence_floor')).toBeNull();
    expect(await whatTheModelReceives()).not.toContain(steer.slice(10, 120));
    expect(rows().filter((r) => r.origin_intent === 'reminder_silence_floor')).toEqual([]);
    expect(rows().filter((r) => r.role === 'system' && r.content === steer).length).toBe(1);
  });
});
