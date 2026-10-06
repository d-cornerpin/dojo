// ════════════════════════════════════════════════════════════════════════════════════════
// THE OWNER'S COLLAPSING COMPLAINT — AN ANSWER THAT RODE WITH A TOOL CALL IS NOT A NOTE.
//
// Backlog: *"message collapsing hides important messages … seen live in [an agent's] chat (his
// actual reply to "you good now?" rendered collapsed/greyed as if it were noise)."*
//
// ── THE DEFECT THESE CLAUSES HOLD ──
// `terminal-text.ts` demoted assistant text to a dimmed `[working-note]` purely on
// CO-OCCURRENCE with a tool call, and `shared/visibility.ts` stated the premise as a
// definition: *"Assistant text that rides in the same model response as tool calls is process
// narration, never a message to the user."* False whenever the model answers and acts in one
// response — and when it is false, the person's only answer is filed as process narration.
//
// ── THE FIXTURE CORPUS IS THE INVESTIGATION'S OWN ROW CLASSIFICATION ──
// Of 146 turns whose only utterance was demoted, the investigation classified:
//   · **7** genuine, human-triggered, non-service (of 204 such turns, 3.4%) → MUST NOT END
//     SILENT. Two verbatim rows, same human ask, two consecutive turns on one long task:
//       seq 76946 turn 61 — ASK "Go through the last 2 weeks of email … and get it organized."
//                           DEMOTED "[working-note] I'm continuing the Gmail organization work …"
//       seq 76953 turn 62 — same ask, DEMOTED "[working-note] I'll continue the organization …"
//     Both substantive status the owner asked for; both grey; neither turn produced a bubble.
//     Both are CONTINUATION-shaped — a long human task the engine re-continues — which is the
//     turn class this file's carve-out serves and the only one where NO existing arm can speak.
//   · **45** service-agent scheduler cycles (34 dreamer, 11 healer) running
//     `═══ DREAM CYCLE ═══` / `═══ DOJO DAILY DIAGNOSTIC ═══` → MUST STAY DEMOTED. Demotion
//     there is CORRECT: no human is watching a service agent's chat for an answer. The
//     investigation's Correction 2 is why this half is tested at all — `display_kind='user-text'`
//     does NOT mean "a human spoke", because those scheduler notices are stamped `user-text`
//     too, and a fix keyed on the trigger's display kind would have promoted all 45.
//
// ── AND THE THIRD GROUP, WHICH THIS FILE PINS AS **UNCHANGED** ──
// An ordinary waiting-human turn (`hasUnansweredUser`, no continuation). The investigation's
// Option A would have promoted those too; driving it turned five reviewed CONTROL clauses in
// three sibling suites red, because that is the branch owner ruling 2026-07-23 deleted. So the
// last describe below asserts the demotion SURVIVES there — a guard against this file's own
// mechanism being widened later into the ruling it was careful not to touch.
//
// ── AND THE ANTI-REPETITION LAW IS THE THIRD CLAUSE, NOT AN AFTERTHOUGHT ──
// The owner wants both: agents that do not repeat themselves AND important answers visible.
// So a turn that produces a real answer AND narration must show the answer once and note the
// narration. At THIS seam that is the `surfacedReplyThisTurn` gate: the first utterance of a
// silent turn is promoted, and every later text-with-tools line in the same turn is demoted
// exactly as it was. (The converse — narration promoted first, then a better answer — is
// corrected at the turn boundary by `teardown/draft-reclassify.ts`, because the truthful-answer
// key is last-write-wins; that half is its own file's property and is cited, not re-driven.)
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolCall } from '@dojo/shared';

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

const insertMessageIfAbsentSpy = vi.fn();
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: (...a: unknown[]) => insertMessageIfAbsentSpy(...(a as [])),
}));

vi.mock('../../../../../services/imessage-bridge.js', () => ({ stripSystemTags: (s: string) => s }));

const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeDb = {
  prepare: () => emptyStmt,
  transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
} as unknown as PostCallClassifyContext['db'];
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));

// The owed-compile spine read is stubbed OFF: these clauses are about the third carve-out, and
// a turn that also holds an owed compile is T52's arm and has its own file.
vi.mock('../../../compile-owed-gate.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stillCompileOwed: () => [],
}));

vi.mock('../../../../../prompt/registry/assembler.js', () => ({ injectRegistryMessage: () => true }));

import { initState, advance, type AgentTurnState } from '../../../state.js';
import { runTerminalText } from '../terminal-text.js';
import { answersALiveAsk } from '../answer-to-a-live-ask.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'agent-one';

/** seq 76946's own text, as the investigation quoted it. */
const THE_STATUS = "I'm continuing the Gmail organization work — the project is already on the "
  + "board, so I won't create a duplicate. The label tool works when I pass the label id rather "
  + 'than its name, so the remaining threads can be filed without another round trip.';
/** seq 76953's, the next turn on the same ask. */
const THE_NEXT_STATUS = "I'll continue the organization — this is genuinely multi-step work "
  + 'already tracked on the board, so I resume the existing project rather than opening another.';
/** The 45's own shape: a service agent's scheduler cycle, stamped `user-text` like a human ask. */
const DREAM_CYCLE_TRIGGER = '═══ DREAM CYCLE ═══';
const DIAGNOSTIC_TRIGGER = '═══ DOJO DAILY DIAGNOSTIC ═══';

interface Bag { [k: string]: unknown }

const turnCtxFor = (over: Record<string, unknown> = {}): Bag => ({
  agentId: AGENT, kind: null, convKey: 'owner', conversationId: '7e111152-2026-4a1b-9c8d-0e1f2a3b4c5d',
  root: undefined, servedWork: undefined,
  deferredUserReplyWithTools: null, deferredDeliveredByAck: false,
  engineStartAckDeliveredThisTurn: false,
  startAckSteerArmedThisTurn: false, startAckSteerRequested: false,
  startAckSteersInjected: 0, startAckSteerInjectedAtLoop: null,
  ...over,
});

const modelResult = (
  content: string, over: Partial<{ toolCalls: ToolCall[] }> = {},
): PostCallClassifyContext['result'] => ({
  content,
  // The measured pairing: substantive text, and a board/label tool in the same round.
  toolCalls: [{ id: 'call_00_gmailOrganize', name: 'work_update', input: {} }] as ToolCall[],
  inputTokens: 10, outputTokens: 5, stopReason: 'tool_use', ...over,
} as unknown as PostCallClassifyContext['result']);

const deliverAckSpy = vi.fn(async () => undefined);
const noteTerminalAnswerSpy = vi.fn();

function ctxFor(turnCtx: Bag, over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT, turnCtx: turnCtx as never, turnNumber: 61, db: fakeDb,
    agent: { id: AGENT, name: 'a probe agent' } as never,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false } as never,
    counterpartyIsAgentSender: false,
    chosenConvKey: 'owner',
    hasUnansweredUser: false,
    triggerRow: null, isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false,
    mostRecentIsA2A: false, mostRecentInbound: undefined, pendingEngineEvent: null,
    unrepliedAssign: null, a2aReplyContext: null, a2aReplyAssignMessageId: null,
    settledContextWakeTurn: false, waitingConvs: [], inboundChannel: null,
    latestUserSource: null,
    lastUserMessageContent: 'Go through the last 2 weeks of email in my mailbox and get it organized.',
    configuredModelId: 'deepseek-v4-flash', turnStartedAt: new Date().toISOString(), messageId: 'msg-76947',
    result: modelResult(THE_STATUS), maxToolLoops: 20,
    reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer: noteTerminalAnswerSpy,
    deliverEngineUserAck: deliverAckSpy,
    persistAndBroadcastSystemRow: vi.fn(),
    startAckRepliedNow: () => false,
    ...over,
  } as unknown as PostCallClassifyContext;
}

const scratchFor = (over: Partial<PostCallScratch> = {}): PostCallScratch => ({
  persistedContent: null, interAgentTurn: false, deliberateSurfaceTurn: false,
  deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'deepseek-v4-flash',
  ...over,
});

const notesWritten = (): string[] => insertMessageIfAbsentSpy.mock.calls
  .map((c) => (c[0] as { role?: string; content?: string }))
  .filter((m) => m.role === 'system')
  .map((m) => m.content ?? '');

const workingNoteFrames = (): unknown[] => broadcastSpy.mock.calls
  .map((c) => c[0] as { type?: string })
  .filter((f) => f.type === 'chat:workingnote');

let state: AgentTurnState;
beforeEach(() => {
  broadcastSpy.mockClear(); insertMessageIfAbsentSpy.mockClear(); deliverAckSpy.mockClear();
  noteTerminalAnswerSpy.mockClear();
  state = initState({ agentId: AGENT, maxToolLoops: 20 } as Parameters<typeof initState>[0]);
});

// ── THE 7: THE MEASURED CLASS, BOTH OF ITS PREDICATES ──────────────────────────────────

describe('the 7 measured instances: a human is waiting and this text is the turn\'s only utterance', () => {
  it('a CONTINUED human task: the status is delivered as the answer, and no note is written', async () => {
    // Turn 61. The ask was stamped served at the ORIGINAL pickup, so `hasUnansweredUser` is
    // false, no ack is owed and no compile is owed — every other promotion arm is shut and the
    // turn would end with the owner shown nothing but grey.
    const sc = scratchFor();
    const out = await runTerminalText(state, ctxFor(turnCtxFor(), { isHumanContinuation: true }), sc);

    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    const [text, originIntent, id, displayKind] = deliverAckSpy.mock.calls[0] as unknown as
      [string, string | null, string | null, string];
    expect(text).toBe(THE_STATUS);
    expect(displayKind).toBe('agent-text');
    expect(typeof id).toBe('string');
    // NOT the ack lane: `engine-ack` is excluded from every settlement by name, so an ask
    // cannot close on one and the ladder would still be running.
    expect(originIntent).toBeNull();
    // seq 76946 never happens — neither the row nor the dimming frame.
    expect(notesWritten()).toEqual([]);
    expect(workingNoteFrames()).toEqual([]);
    // and the turn now knows it spoke, so the respond-once floor is armed.
    expect(out.state.surfacedReplyThisTurn).toBe(true);
    expect(out.state.lastAssistantTextForIM).toBe(THE_STATUS);
  });

  it('and again on the very next turn — the measured shape is TWO consecutive silent turns', async () => {
    // seq 76953, turn 62: the same ask, the same class, a fresh continuation turn. The
    // investigation quoted both rows precisely because the second one proves the first was not
    // a one-off — a long task re-continues until it finishes, and every one of those turns had
    // the same structural gap.
    const sc = scratchFor();
    const out = await runTerminalText(
      state,
      ctxFor(turnCtxFor(), {
        hasUnansweredUser: false, isHumanContinuation: true, turnNumber: 62,
        result: modelResult(THE_NEXT_STATUS),
      }),
      sc,
    );

    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    expect((deliverAckSpy.mock.calls[0] as unknown as [string])[0]).toBe(THE_NEXT_STATUS);
    expect(notesWritten()).toEqual([]);
    expect(out.state.surfacedReplyThisTurn).toBe(true);
  });

  it('the truthful-answer key names the promoted row — the superseded-bubble narrowing needs it', async () => {
    await runTerminalText(state, ctxFor(turnCtxFor(), { isHumanContinuation: true }), scratchFor());
    expect(noteTerminalAnswerSpy).toHaveBeenCalledTimes(1);
    const deliveredId = (deliverAckSpy.mock.calls[0] as unknown as [string, unknown, string])[2];
    expect((noteTerminalAnswerSpy.mock.calls[0] as unknown as [string])[0]).toBe(deliveredId);
  });

  it('the words are CONSUMED, so the finalize recovery cannot deliver the same status twice', async () => {
    const turnCtx = turnCtxFor();
    await runTerminalText(state, ctxFor(turnCtx, { isHumanContinuation: true }), scratchFor());
    expect(turnCtx.deferredUserReplyWithTools).toBeNull();
  });
});

// ── THE 45: THE CORRECTLY-DEMOTED HALF, WHICH MUST NOT MOVE ────────────────────────────

describe('the 45 service-agent scheduler cycles stay demoted — no human is watching that chat', () => {
  for (const trigger of [DREAM_CYCLE_TRIGGER, DIAGNOSTIC_TRIGGER]) {
    it(`an engine cycle turn (${trigger}) is still demoted to a working note, not promoted`, async () => {
      const sc = scratchFor();
      const out = await runTerminalText(
        state,
        ctxFor(turnCtxFor(), {
          // The investigation's Correction 2: these notices are stamped `user-text` too, so the
          // trigger row looks exactly like a human ask. What separates them is the ASK LEDGER —
          // an engine event never makes `hasUnansweredUser` true — and the continuation stash,
          // which a scheduler cycle never sets.
          hasUnansweredUser: false, isHumanContinuation: false, isEngineTurn: true,
          triggerRow: { rowid: 1, content: trigger },
          result: modelResult('Two issues to address in tonight\'s cycle, taking the first now.'),
        }),
        sc,
      );

      expect(deliverAckSpy).not.toHaveBeenCalled();
      expect(notesWritten()).toHaveLength(1);
      expect(notesWritten()[0]).toContain('[working-note] ');
      expect(out.state.surfacedReplyThisTurn).toBe(false);
    });
  }

  it('the predicate itself refuses a scheduler turn, with no delivery performed at all', () => {
    expect(answersALiveAsk({
      interAgentTurn: false, isHumanContinuation: false,
      surfacedReplyThisTurn: false, startAckRepliedNow: () => false,
    })).toBe(false);
  });

  it('an inter-agent turn is refused even when a human ask is open — A2A narration never streamed', () => {
    expect(answersALiveAsk({
      interAgentTurn: true, isHumanContinuation: true,
      surfacedReplyThisTurn: false, startAckRepliedNow: () => false,
    })).toBe(false);
  });
});

// ── THE ANTI-REPETITION LAW: ONE ANSWER, AND NARRATION IS STILL A NOTE ─────────────────

describe('a turn with both a real answer and narration: the answer is delivered once, the narration noted', () => {
  it('the second text-with-tools line of the same turn is DEMOTED — the turn has already spoken', async () => {
    // Round 1: the silent turn's first utterance is promoted.
    const first = await runTerminalText(
      state, ctxFor(turnCtxFor(), { isHumanContinuation: true }), scratchFor(),
    );
    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    expect(notesWritten()).toEqual([]);

    // Round 2, same turn, carrying the state round 1 produced: genuine mid-work narration now.
    const sc = scratchFor();
    await runTerminalText(
      first.state,
      ctxFor(turnCtxFor(), {
        isHumanContinuation: true,
        result: modelResult('Let me check the remaining threads before I file them.'),
      }),
      sc,
    );
    // Still exactly one delivery — the answer — and the narration became a note.
    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    expect(notesWritten()).toHaveLength(1);
    expect(notesWritten()[0]).toContain('Let me check the remaining threads');
    expect(workingNoteFrames()).toHaveLength(1);
  });

  it('a turn that already spoke on the LEDGER is refused too, not only one that spoke in state', async () => {
    // `startAckRepliedNow()` is the ledger-backed "have they heard the model this turn" question
    // the ack family owns. It is the other half of `surfacedReplyThisTurn`, and it is asked
    // because a promotion that trusted turn-local state alone would double-speak across a
    // boundary the state does not cross.
    const sc = scratchFor();
    await runTerminalText(
      state,
      ctxFor(turnCtxFor(), { isHumanContinuation: true, startAckRepliedNow: () => true }),
      sc,
    );
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toHaveLength(1);
  });

  it('the promoted answer never becomes a second copy: exactly one row leaves this seam', async () => {
    await runTerminalText(state, ctxFor(turnCtxFor(), { isHumanContinuation: true }), scratchFor());
    // One delivery, zero system rows, zero dimming frames. The demotion wrote `role='system'`
    // and nulled the text, which is the mechanism that erased the answer from the only record
    // the MODEL reads and let it compose again; promotion-in-place is what removes both copies.
    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    expect(notesWritten()).toEqual([]);
  });
});

// ── THE CONTROL: TEXT WITH NO TOOL CALL IS NOT THIS ARM'S BUSINESS ─────────────────────

describe('the control', () => {
  it('a tool-LESS reply is untouched by this arm — it was never demoted in the first place', async () => {
    const sc = scratchFor();
    await runTerminalText(
      state,
      ctxFor(turnCtxFor(), {
        isHumanContinuation: true,
        result: modelResult(THE_STATUS, { toolCalls: [] as ToolCall[] }),
      }),
      sc,
    );
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toEqual([]);
    // It survives as the turn's persisted text, which is `persist-assistant.ts`'s business.
    expect(sc.persistedContent).toBe(THE_STATUS);
  });

  it('a turn with no waiting human and no continuation keeps the 2026-07-10 demotion exactly', async () => {
    const sc = scratchFor();
    await runTerminalText(state, ctxFor(turnCtxFor()), sc);
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toHaveLength(1);
    expect(sc.persistedContent).toBeNull();
  });
});

// ── THE RULING THIS CARVE-OUT DID NOT TOUCH, PINNED FROM THIS SIDE ────────────────────

describe('an ordinary waiting-human turn keeps the 2026-07-23 ruling, byte for byte', () => {
  it('an OPEN ASK alone does NOT promote — it captures and demotes, exactly as before', async () => {
    // This is the five sibling CONTROL clauses' rule, asserted here too so that a later reader
    // widening this file's predicate to `hasUnansweredUser` fails HERE first, beside the
    // argument for why it must not. The text is still REMEMBERED (G-SUP-2's capture), so
    // `finalize/deferred-recovery.ts` can still deliver it if the turn ends with no reply —
    // which is exactly why an ordinary waiting-human turn does not need this carve-out and a
    // continuation turn does.
    const turnCtx = turnCtxFor();
    const sc = scratchFor();
    await runTerminalText(state, ctxFor(turnCtx, { hasUnansweredUser: true }), sc);

    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(turnCtx.deferredUserReplyWithTools).toBe(THE_STATUS);
    expect(notesWritten()).toHaveLength(1);
    expect(notesWritten()[0]).toContain('[working-note] ');
  });

  it('the predicate refuses it on its own, with no delivery performed', () => {
    expect(answersALiveAsk({
      interAgentTurn: false, isHumanContinuation: false,
      surfacedReplyThisTurn: false, startAckRepliedNow: () => false,
    })).toBe(false);
  });

  // ── t113 E (BACKLOG line 35): THE DOUBLE COPY, MEASURED AND PINNED WHERE IT HAPPENS ──
  //
  // The line reads: "the seam writes the note AND deferred-recovery later delivers the same
  // text — one answer stored twice; untouched because fixing it touches the five control
  // clauses." That premise is CONFIRMED at this head, and this clause is the measurement, so
  // the next lane does not have to rediscover it — and so that nobody closes it by accident.
  //
  // WHAT IS TRUE, driven rather than read. After this seam, on an ordinary waiting-human turn:
  //   · ONE `[working-note]` system row carries the text (the 2026-07-23 ruling, above)
  //   · the words are STILL REMEMBERED in `deferredUserReplyWithTools`
  //   · nothing has set `lastAssistantTextForIM`
  // and `finalize/deferred-recovery.ts`'s entire guard is
  // `if (turnCtx.deferredUserReplyWithTools && !state.lastAssistantTextForIM)`. So on this turn
  // class the recovery WILL fire and insert a second row — role `assistant`, a new id, the same
  // characters — and broadcast a fresh `chat:message` bubble beside the dimmed note. On a
  // ROUTED-channel turn the note is marked internal and hidden outside wordy mode, so only the
  // bubble shows; on a DASHBOARD turn the note is visible-dimmed, so the person sees the same
  // sentence twice.
  //
  // WHY IT IS NOT FIXED HERE, and this is a G10/G14 boundary rather than a shrug. The engine
  // already states the governing principle three times in `terminal-text.ts` — "the text went
  // out WHOLE, so a note beside it would be the second copy this task exists to remove" — and
  // acts on it for all THREE promoted cases (`deliveredAsStartLine`,
  // `deliveredAsCompiledAnswer`, `deliveredAsAnswerToLiveAsk`), each of which skips the note.
  // The deferred case cannot: at this seam the turn has not yet decided whether a proper
  // tool-less reply will land, so whether this text ends up an ANSWER or a NOTE is not yet
  // knowable. Resolving it needs one of exactly two mechanisms, and both are the owner's:
  //   1. do not write the note here, and write it from finalize only if recovery did not fire —
  //      which moves the note off this seam and reds the five reviewed control clauses that
  //      pin it here, i.e. it reopens owner ruling 2026-07-23;
  //   2. write it here as now, and RETIRE it when recovery promotes the same text — which is
  //      literally one of the two candidate mechanisms BACKLOG already records as needing the
  //      owner's word ("becoming the first runtime writer of `messages.retired_at`" against "a
  //      Chat.tsx `promoted:true` mirror").
  // Neither is a worker's call (G14), so t113 measured it, pinned it, and handed it back.
  it('⚠ OPEN DEFECT, PINNED: this seam leaves the finalize recovery able to deliver the same text again', async () => {
    const turnCtx = turnCtxFor();
    await runTerminalText(state, ctxFor(turnCtx, { hasUnansweredUser: true }), scratchFor());

    // the note exists — the ruling's half
    expect(notesWritten(), 'one demoted note carries the text').toHaveLength(1);
    expect(notesWritten()[0]).toContain(THE_STATUS);

    // …AND every term of `deferred-recovery.ts`'s guard is satisfied, which is the defect.
    expect(turnCtx.deferredUserReplyWithTools,
      'the words survive this seam, so recovery can still speak them').toBe(THE_STATUS);
    expect(state.lastAssistantTextForIM,
      'and nothing has claimed a reply, so recovery is not stood down').toBeFalsy();

    // Stated as the implication, so this clause says what WILL happen rather than only what is:
    const recoveryWillFire = Boolean(turnCtx.deferredUserReplyWithTools) && !state.lastAssistantTextForIM;
    expect(recoveryWillFire,
      'BACKLOG line 35 is still open: the same text is about to be stored a second time as an '
      + 'assistant row. When it is closed — by ruling, one of the two mechanisms in the comment '
      + 'above — this expectation is the one to invert, and the five control clauses beside it '
      + 'are the ones to re-state honestly.').toBe(true);
  });
});

// ── THE PREDICATE'S OWN TABLE, so each clause of it is named once ──────────────────────

describe('answersALiveAsk, clause by clause', () => {
  const base = {
    interAgentTurn: false, isHumanContinuation: false,
    surfacedReplyThisTurn: false, startAckRepliedNow: () => false,
  };
  it('a continuation turn opens the door', () => {
    expect(answersALiveAsk({ ...base, isHumanContinuation: true })).toBe(true);
  });
  it('an ordinary turn leaves it shut', () => {
    expect(answersALiveAsk(base)).toBe(false);
  });
  it('a turn that already surfaced a reply is shut', () => {
    expect(answersALiveAsk({ ...base, isHumanContinuation: true, surfacedReplyThisTurn: true })).toBe(false);
  });
  it('a turn that already spoke on the LEDGER is shut too', () => {
    expect(answersALiveAsk({ ...base, isHumanContinuation: true, startAckRepliedNow: () => true })).toBe(false);
  });
});
