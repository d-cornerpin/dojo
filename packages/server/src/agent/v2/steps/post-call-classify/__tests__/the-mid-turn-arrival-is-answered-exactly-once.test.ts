// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 7.5 T31 — THE MID-TURN ARRIVAL IS ANSWERED EXACTLY ONCE.
//
// THE RED, my own driven replay against the dev server at `e0b5804` (agent 57b52025,
// 2026-08-11), floor model, W11's never-mind shape:
//
//   01:57:39  ask A  "Compare budget noise-cancelling earbuds for flights…"   claimed, turn 4690
//   01:58:00  ask B  "Never mind, forget the earbuds — just tell me one good podcast…"
//   01:59:07  turn 4690's terminal reply:  "Darknet Diaries — …"        (delivery 1abcc63e)
//   01:59:07  owed_interrupt recorded on ask B, water 15887 — above that very delivery
//   01:59:07  the seam's steer, HEAD's wording: "Reply ONLY to it, in one or two sentences"
//   01:59:11  ask B re-serves; turn 4691 answers it AGAIN: "Hardcore History by Dan Carlin…"
//
//   PODCAST-answering bubbles: 2   turns [4690, 4691]   — contradictory picks, one question.
//
// THE RULING (T31, orchestrator): the arrival's ONE answering turn is its own. T25's record
// keeps this turn's earlier delivery off that ask — correctly — so the follow-up turn always
// comes; anything this turn writes about the arrival is therefore the SECOND answer, whatever
// order the person happens to see them in.
//
// TWO CHANGES, ONE DISCRIMINATOR:
//   * the steer stops asking for an answer and asks the model to stop-or-adjust its own work;
//   * whatever the granted round writes is HELD as a working note — keyed on the seam's own
//     record of the round it granted (`state.owedInterruptGrant`), never on one character of
//     the reply. A wording verdict in the suppression direction is the swallow P4b deleted
//     from `closeout-floors.ts`; its tombstone is still there and says the worst case of
//     removing it is "a visible duplicate paragraph". This is that worst case, measured.
//
// AND ONE THING THAT WAS BUILT, DRIVEN, AND DISPROVED — kept as a clause so it is not tried
// again: honouring `[no-reply]` in the granted round as "my earlier reply already answered
// it". Driven 2026-08-11 (luggage/podcast replay): the turn answered its own subject only and
// the model returned the sentinel anyway; acting on it closed the podcast ask on the LUGGAGE
// delivery. Owner priority decides the direction of error — toward answering, never closing.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { WORKING_NOTE_PREFIX } from '@dojo/shared';

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t31-arrival-once', 'dojo.db'),
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

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { runMigrations } from '../../../../../db/migrations.js';
import { initState, type AgentTurnState, type OwedInterruptGrant } from '../../../state.js';
import { runOwedInterrupt } from '../owed-interrupt.js';
import { runCloseoutFloors } from '../closeout-floors.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'kevin';
const CONV = 'conv-1';
const TURN = 4690;

const db = (): Database.Database => mockDb.current!;
const here = path.dirname(url.fileURLToPath(import.meta.url));
const sourceOf = (rel: string): string => fs.readFileSync(path.resolve(here, rel), 'utf8');

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

// ════════════════════════════════════════════════════════════════════
// §1 — THE SEAM WRITES DOWN WHAT THE ROUND IS FOR
// ════════════════════════════════════════════════════════════════════

describe('§1 the owed-interrupt seam records the round it granted, by identity', () => {
  it('the grant names the arrival rows, the loop, and that a reply had already landed', async () => {
    owedArrivals.current = [{ id: 'm-b', content: 'Never mind, forget the earbuds — one good podcast?' }];
    const out = await runOwedInterrupt(
      freshState({ loopCount: 3 }), ctxFor(),
      scratchFor({ persistedContent: 'Darknet Diaries — true stories from the dark side of the internet.' }),
    );
    const grant = out.state.owedInterruptGrant as OwedInterruptGrant;
    expect(grant).not.toBeNull();
    expect(grant.atLoop).toBe(3);
    expect(grant.messageIds).toEqual(['m-b']);
    expect(grant.afterReply).toBe(true);
    expect(out.directive).toBe('continue');   // the round really was bought
  });

  it('nothing owed → no grant at all (the record is never speculative)', async () => {
    owedArrivals.current = [];
    const out = await runOwedInterrupt(
      freshState({ loopCount: 3 }), ctxFor(), scratchFor({ persistedContent: 'Here you go.' }),
    );
    expect(out.state.owedInterruptGrant).toBeNull();
    expect(out.directive).toBe('proceed');
  });

  it('CONTROL — one steer per turn: a latched seam grants nothing and writes nothing', async () => {
    owedArrivals.current = [{ id: 'm-b', content: 'and a podcast?' }];
    const first = await runOwedInterrupt(
      freshState({ loopCount: 3 }), ctxFor(), scratchFor({ persistedContent: 'Answer.' }),
    );
    engineEventSpy.mockClear();
    const second = await runOwedInterrupt(
      { ...first.state, loopCount: 4 } as AgentTurnState, ctxFor(), scratchFor({ persistedContent: 'More.' }),
    );
    expect(second.directive).toBe('proceed');
    expect(engineEventSpy).not.toHaveBeenCalled();
    expect((second.state.owedInterruptGrant as OwedInterruptGrant).atLoop).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════════
// §2 — THE STEER STOPS ASKING FOR A SECOND ANSWER
// ════════════════════════════════════════════════════════════════════

describe('§2 the steer text', () => {
  const steer = async (): Promise<string> => {
    owedArrivals.current = [{ id: 'm-b', content: 'Never mind, forget the earbuds — one good podcast?' }];
    await runOwedInterrupt(freshState({ loopCount: 3 }), ctxFor(), scratchFor({ persistedContent: 'Answer.' }));
    return (engineEventSpy.mock.calls[0][0] as { content: string }).content;
  };

  it('no longer asks the model to reply to the arrival — that sentence bought the duplicate', async () => {
    const t = await steer();
    expect(t).not.toContain('Reply ONLY to');
    expect(t).toContain('Do NOT answer it in this turn');
  });

  it('says WHY, in the terms the person experiences: a second answer is a duplicate', async () => {
    expect(await steer()).toContain('duplicate');
  });

  it('IT RELEASES ITSELF ON A LATER TURN — the row outlives its turn and must say when it stops', async () => {
    // Driven 2026-08-11 02:32 without this clause: the arrival's OWN turn read "do not answer
    // it here" out of the persisted row and spent its whole budget not answering.
    expect(await steer()).toContain('If you are reading this on a LATER turn, that turn IS its turn — answer it normally.');
  });

  it('says what the round IS for: stop or change work the arrival affects', async () => {
    const t = await steer();
    expect(t).toContain('CANCELS or CHANGES work you are still doing');
    expect(t).toContain('stop that work now and record it');
  });

  it('the [no-reply] escape is GONE — it was driven and disproved, not merely unused', async () => {
    expect(await steer()).not.toContain('[no-reply]');
  });

  it('CONTROL — the two clauses that were never the problem are carried verbatim', async () => {
    const t = await steer();
    expect(t).toContain('Do not re-run the tools you used for the main task; that work is done and delivered.');
    expect(t).toContain('Do NOT repeat, summarize, or re-deliver ANY part of your earlier reply; the user already has it.');
  });

  it('it still QUOTES the arrival so the model knows what is being talked about', async () => {
    expect(await steer()).toContain('Never mind, forget the earbuds');
  });

  it('the seam still records its subjects for T25 — the eighth narrowing is not weakened', async () => {
    // The ask row does not exist in this fixture, so the recorder no-ops; what is asserted is
    // that the call still happens on the granting pass and the step still buys the round.
    owedArrivals.current = [{ id: 'm-b', content: 'and a podcast?' }];
    const out = await runOwedInterrupt(
      freshState({ loopCount: 3 }), ctxFor(), scratchFor({ persistedContent: 'Answer.' }),
    );
    expect(out.directive).toBe('continue');
    expect(sourceOf('../owed-interrupt.ts')).toContain('recordOwedInterruptSubjects(agentId, owed.map((m) => m.id), turnNumber)');
  });
});

// ════════════════════════════════════════════════════════════════════
// §3 — WHATEVER THE GRANTED ROUND WRITES IS HELD
// ════════════════════════════════════════════════════════════════════

const grantedAfterReply = (atLoop = 3): OwedInterruptGrant =>
  ({ atLoop, messageIds: ['m-b'], afterReply: true });

describe('§3 a second bubble about the arrival never reaches the person', () => {
  it('RED-turned-GREEN: the granted round\'s reply is not persisted as a user bubble', () => {
    const sc = scratchFor({ persistedContent: 'Hardcore History by Dan Carlin — start with Blueprint for Armageddon.' });
    const out = runCloseoutFloors(
      freshState({ loopCount: 4, owedInterruptGrant: grantedAfterReply(), surfacedReplyThisTurn: true }),
      ctxFor(), sc,
    );
    expect(out.directive).toBe('proceed');
    expect(sc.persistedContent).toBeNull();
  });

  it('DEMOTE, DON\'T DISCARD: the words are written and the streamed bubble converts in place', () => {
    const text = 'Hardcore History by Dan Carlin — start with Blueprint for Armageddon.';
    runCloseoutFloors(
      freshState({ loopCount: 4, owedInterruptGrant: grantedAfterReply(), surfacedReplyThisTurn: true }),
      ctxFor(), scratchFor({ persistedContent: text }),
    );
    const note = db().prepare(
      `SELECT content FROM messages WHERE agent_id = ? AND role = 'system' ORDER BY seq DESC LIMIT 1`,
    ).get(AGENT) as { content: string } | undefined;
    expect(note?.content).toBe(`${WORKING_NOTE_PREFIX}${text}`);
    expect(broadcastSpy.mock.calls.some(([e]) => (e as { type: string }).type === 'chat:workingnote')).toBe(true);
  });

  it('a held note is not a reply: the surfaced-reply latch is not armed by it', () => {
    const out = runCloseoutFloors(
      freshState({ loopCount: 4, owedInterruptGrant: grantedAfterReply() }),
      ctxFor(), scratchFor({ persistedContent: 'A different podcast entirely.' }),
    );
    expect(out.state.surfacedReplyThisTurn).toBe(false);
  });

  it('CONTENT IS NEVER READ: two texts with nothing in common are treated identically', () => {
    const a = scratchFor({ persistedContent: 'Hardcore History by Dan Carlin.' });
    const b = scratchFor({ persistedContent: 'The capital of Peru is Lima.' });
    for (const sc of [a, b]) {
      runCloseoutFloors(freshState({ loopCount: 4, owedInterruptGrant: grantedAfterReply() }), ctxFor(), sc);
    }
    expect(a.persistedContent).toBeNull();
    expect(b.persistedContent).toBeNull();
  });

  it('CONTROL — no grant, no hold: an ordinary reply is untouched', () => {
    const sc = scratchFor({ persistedContent: 'Here is the answer.' });
    runCloseoutFloors(freshState({ loopCount: 4 }), ctxFor(), sc);
    expect(sc.persistedContent).toBe('Here is the answer.');
  });

  it('CONTROL — the pass that GRANTED the round is not the granted round', () => {
    const sc = scratchFor({ persistedContent: 'Darknet Diaries — the turn\'s own reply.' });
    runCloseoutFloors(freshState({ loopCount: 3, owedInterruptGrant: grantedAfterReply(3) }), ctxFor(), sc);
    expect(sc.persistedContent).toBe('Darknet Diaries — the turn\'s own reply.');
  });

  it('CONTROL, AND IT IS THE ONE THAT MATTERS — an IN-FLIGHT grant is never held', () => {
    // T30 leg B's shape: the round was bought BEFORE anything reached the person, so the text
    // it produces is the turn's ONE reply. Holding it is silence, which this tree refuses
    // harder than it refuses duplication (owner priority, `ask-settlement.ts:19-26`).
    const sc = scratchFor({ persistedContent: 'Dropped the earbuds research as you asked.' });
    runCloseoutFloors(
      freshState({ loopCount: 4, owedInterruptGrant: { atLoop: 3, messageIds: ['m-b'], afterReply: false } }),
      ctxFor(), sc,
    );
    expect(sc.persistedContent).toBe('Dropped the earbuds research as you asked.');
  });

  it('CONTROL — the redundant-closeout floor above it is untouched and still first', () => {
    const src = sourceOf('../closeout-floors.ts');
    expect(src.indexOf('REDUNDANT_CLOSEOUT_MAX_CHARS &&')).toBeLessThan(src.indexOf('grant.afterReply &&'));
    expect(src).toContain('persistedContent.trim().length <= REDUNDANT_CLOSEOUT_MAX_CHARS');
  });

  it('ONE demotion rule in this file, not two — the helper is shared with the RC-5.3 arm', () => {
    const src = sourceOf('../closeout-floors.ts');
    expect((src.match(/type: 'chat:workingnote'/g) ?? []).length).toBe(1);
    expect((src.match(/demoteToWorkingNote\(/g) ?? []).length).toBe(3);  // 1 declaration + 2 calls
  });
});

// ════════════════════════════════════════════════════════════════════
// §4 — THE DISPROVED DISCRIMINATOR STAYS OUT
// ════════════════════════════════════════════════════════════════════

describe('§4 nothing reads the granted round\'s outcome to decide the ask\'s state', () => {
  it('the seam does not settle, revoke or re-point anything on the granted round', () => {
    const src = sourceOf('../owed-interrupt.ts');
    expect(src).not.toContain('revokeOwedInterruptSubjects');
    expect(src).not.toContain('settleAsk');
    // the ONE spine write this step makes is still T25's record, on the granting pass
    expect((src.match(/ask-settlement\.js/g) ?? []).length).toBe(1);
  });

  it('the failure is written down where the next reader will look', () => {
    const src = sourceOf('../owed-interrupt.ts');
    expect(src).toContain('DISCRIMINATOR THAT WAS TRIED HERE AND FAILED');
    expect(src).toContain('closed the podcast ask on the LUGGAGE delivery');
  });
});
