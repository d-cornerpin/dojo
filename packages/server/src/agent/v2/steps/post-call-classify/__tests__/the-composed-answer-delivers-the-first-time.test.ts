// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 12 T52 — THE COMPOSED ANSWER DELIVERS THE FIRST TIME (owner ruling 4:
// the dimmed-note double-render is to be fixed at the ROOT, not suppressed).
//
// ── THE INCIDENT, READ OFF THE BODY RATHER THAN OFF THE REPORT ──
// Round-12 S5 (`round12/S5-catalog.md` §8.5/§8.11): the owner asked for one combined day
// plan; two helpers came back at T+2m07.5s; the plan reached him at T+16m41.5s. Fourteen
// seconds BEFORE that, at T+16m27.5s, the same plan was already stored — as a dimmed,
// collapsed `[working-note]`. Two presentations of one answer, 14 s apart.
//
// The rows, on the dev body (`messages` seq / `deliveries`), which is what this file is
// built from and what makes the shape below the incident's own and not a sketch:
//
//   seq 65933  system     turn 4902  working-note  user-visible  3878 chars  "[working-note] Here's the combined day plan …"
//   seq 65934  assistant  turn 4902  tool-turn     agent-only    3798 chars  [{"type":"tool_use", … "work_update" …}]
//   seq 65939  assistant  turn 4902  agent-text    user-visible  3835 chars  "Both helpers are back — here's the combined day plan."
//   delivery c83a1e79  tool `dashboard`  -> message 65934   (a CHIP: excluded from every settlement)
//   delivery 34dca9df  tool `dashboard`  -> message 65939   (the receipt the ask closed on)
//
// 65933 and 65934 are ONE model response: the model composed the whole plan and reached for
// `work_update` in the same round. `post-call-classify/terminal-text.ts`'s text-with-tools
// arm therefore ran, and on turn 4902 all three of its openers were false —
// `hasUnansweredUser` was false (the ack had been paid at T+0m09.5s and the turn carried no
// trigger row), it was no deliverable-owing run, and there was no owed ack — so the text
// fell through to the demotion and became 65933.
//
// ── AND THE DEMOTION IS WHY THE SECOND COMPOSE HAPPENED, WHICH IS THE ROOT ──
// The demotion writes `role='system'`, and that row's own contract is that it NEVER ENTERS
// MODEL CONTEXT. `persistedContent` is then nulled, so the assistant row 65934 carries the
// `tool_use` blocks and NOT the text. The model's own 3878-character answer was erased from
// the only record the model reads — while the compile order ("Compose ONE reply to the owner
// now") was still standing in front of it. It composed again, because from where it was
// sitting it had never composed at all. The double render is not a rendering bug and not a
// presentation residual: it is the demotion, and the recompose is its consequence.
//
// ── THE SOLVE (the W20-option-B owed-window promotion family, one window wider) ──
// When the turn holds an OWED COMPILE — T47's own armed state, `compileOwedAskIds`,
// re-validated on the spine at the instant it matters — the model's person-addressed compose
// is PROMOTED and delivered as the ANSWER instead of demoted. Not as an ack: the ack lane is
// excluded from every settlement by name ("a start-ack is not an answer"), so promoting it
// there would leave the ask open and the ladder still running. As an ordinary `agent-text`
// answer row, through the same door the model's own reply goes through, stamped with the
// truthful-answer key — which is what lets the settlement authority close the ask on it and
// disarm T48's relay by the one predicate every road out of the compile duty already uses.
//
// The collisions this file pins alongside the fix: T31's arrival-once demotion (untouched —
// a different opener, a different flag), the superseded-bubble narrowing (which is why
// `noteTerminalAnswer` is not optional here), and T48's relay disarm (pinned end to end in
// `work/__tests__/a-promoted-compose-disarms-the-relay.test.ts`, because the disarm is a READ
// of the delivery ledger and this file cannot see the ledger).
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

// THE SPINE READ, STUBBED AT ITS DECLARED SEAM. `stillCompileOwed` is T47's own
// "is it STILL owed?" question and it is a database read; the clauses here are about what
// the terminal-text arm does with the ANSWER, so the answer is stated directly and the
// query keeps its own suite (`work/__tests__/`).
const stillCompileOwedSpy = vi.fn((ids: readonly string[]) => [...ids]);
vi.mock('../../../compile-owed-gate.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stillCompileOwed: (ids: readonly string[]) => stillCompileOwedSpy(ids),
}));

const injectRegistryMessageSpy = vi.fn(() => true);
vi.mock('../../../../../prompt/registry/assembler.js', () => ({
  injectRegistryMessage: (...a: unknown[]) => injectRegistryMessageSpy(...(a as [])),
}));

import { initState, advance, type AgentTurnState } from '../../../state.js';
import { runTerminalText } from '../terminal-text.js';
import { START_ACK_ORIGIN_INTENT } from '../../../../../memory/message-store.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = '57b52025-0b0f-40a6-b916-9efdb9a642a3';
const ASK = 'ask:351d9670-4af7-4f22-802d-34f239b24f18';
/** The incident's own text, opening line for opening line (S5 §8.11). */
const THE_PLAN = "Here's the combined day plan — both research pieces merged:\n\n"
  + '# Saturday Day Plan — Seattle ↔ Leavenworth with the Dog (September 2026)\n\n'
  + '**~7:00–7:30 AM — Leave Seattle.** Take I-90 E → Snoqualmie Pass → US-2 W into Leavenworth.';

interface Bag { [k: string]: unknown }

const turnCtxFor = (over: Record<string, unknown> = {}): Bag => ({
  // Turn 4902's own shape: `kind` null, `subject_kind` 'none' — a bare engine wake, not
  // attached to the ask or to a thread — on the owner's conversation.
  agentId: AGENT, kind: null, convKey: 'owner', conversationId: '616f857b-2026-44f3-b64e-943032f913ec',
  root: undefined, servedWork: undefined,
  deferredUserReplyWithTools: null, deferredDeliveredByAck: false,
  engineStartAckDeliveredThisTurn: false,
  startAckSteerArmedThisTurn: false, startAckSteerRequested: false,
  startAckSteersInjected: 0, startAckSteerInjectedAtLoop: null,
  ...over,
});

const modelResult = (over: Partial<{ content: string; toolCalls: ToolCall[] }> = {}): PostCallClassifyContext['result'] => ({
  content: THE_PLAN,
  // The incident's own pairing: the whole answer, and `work_update` in the same round.
  toolCalls: [{ id: 'call_00_wPufybMRgPOvILAavOPS8077', name: 'work_update', input: {} }] as ToolCall[],
  inputTokens: 10, outputTokens: 5, stopReason: 'tool_use', ...over,
} as unknown as PostCallClassifyContext['result']);

const deliverAckSpy = vi.fn(async () => undefined);
const noteTerminalAnswerSpy = vi.fn();

function ctxFor(turnCtx: Bag, over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT, turnCtx: turnCtx as never, turnNumber: 4902, db: fakeDb,
    agent: { id: AGENT, name: 'BehaviorBot' } as never,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false } as never,
    counterpartyIsAgentSender: false,
    chosenConvKey: 'owner',
    // Turn 4902 carried NO waiting chat row: the owner's ask was acknowledged sixteen
    // minutes earlier. This is the flag that made all of T19's openers false.
    hasUnansweredUser: false,
    triggerRow: null, isA2ATurn: false, isEngineTurn: true, isHumanContinuation: false,
    mostRecentIsA2A: false, mostRecentInbound: undefined, pendingEngineEvent: null,
    unrepliedAssign: null, a2aReplyContext: null, a2aReplyAssignMessageId: null,
    settledContextWakeTurn: false, waitingConvs: [], inboundChannel: null,
    latestUserSource: null, lastUserMessageContent: 'plan me a Saturday in Leavenworth with the dog',
    configuredModelId: 'deepseek-v4-flash', turnStartedAt: new Date().toISOString(), messageId: 'msg-65934',
    result: modelResult(), maxToolLoops: 20,
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

/** The turn as the compile gate armed it (T47, `preflight/compile-gate.ts`). */
const owedState = (base: AgentTurnState, ids: string[] = [ASK]): AgentTurnState =>
  advance(base, { compileOwedAskIds: ids });

let state: AgentTurnState;
beforeEach(() => {
  broadcastSpy.mockClear(); insertMessageIfAbsentSpy.mockClear(); deliverAckSpy.mockClear();
  noteTerminalAnswerSpy.mockClear(); injectRegistryMessageSpy.mockClear();
  stillCompileOwedSpy.mockClear();
  stillCompileOwedSpy.mockImplementation((ids: readonly string[]) => [...ids]);
  state = initState({ agentId: AGENT, maxToolLoops: 20 } as Parameters<typeof initState>[0]);
});

describe('the S5 shape: an owed compile composed with a tool call reaches the owner NOW', () => {
  it('RED→GREEN: the plan is delivered as the answer, and no working note is written at all', async () => {
    const turnCtx = turnCtxFor();
    const sc = scratchFor();
    await runTerminalText(owedState(state), ctxFor(turnCtx), sc);

    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    const [text, originIntent, id, displayKind] = deliverAckSpy.mock.calls[0] as unknown as
      [string, string | null, string | null, string];
    expect(text).toBe(THE_PLAN);
    expect(displayKind).toBe('agent-text');
    expect(typeof id).toBe('string');
    // NOT the ack lane, and this is the load-bearing difference. `engine-ack` is excluded
    // from every settlement by name ("a start-ack is not an answer"), so an ask cannot close
    // on one — the ladder would still be running and T48's relay would still ship.
    expect(originIntent).toBeNull();
    expect(originIntent).not.toBe(START_ACK_ORIGIN_INTENT);
    // seq 65933 never happens.
    expect(notesWritten()).toEqual([]);
  });

  it('the truthful-answer key names the promoted row — the superseded-bubble narrowing needs it', async () => {
    await runTerminalText(owedState(state), ctxFor(turnCtxFor()), scratchFor());
    expect(noteTerminalAnswerSpy).toHaveBeenCalledTimes(1);
    const deliveredId = (deliverAckSpy.mock.calls[0] as unknown as [string, unknown, string])[2];
    expect((noteTerminalAnswerSpy.mock.calls[0] as unknown as [string])[0]).toBe(deliveredId);
  });

  it('the turn now knows it answered: the routing text, the compile duty and the respond-once floor all move together', async () => {
    const out = await runTerminalText(owedState(state), ctxFor(turnCtxFor()), scratchFor());
    expect(out.state.lastAssistantTextForIM).toBe(THE_PLAN);
    // T47's own disarm, reached the way `persist-assistant.ts` reaches it: the owed compile
    // is discharged BY the reply, so the gate stops refusing for the rest of the turn.
    expect(out.state.compileGateSatisfied).toBe(true);
    // and the redundant-closeout floor is armed, so a short sign-off after this is dropped
    // against the delivery receipt rather than shown as a second bubble.
    expect(out.state.surfacedReplyThisTurn).toBe(true);
  });

  it('the words are CONSUMED, so the finalize recovery cannot deliver the same plan a second time', async () => {
    const turnCtx = turnCtxFor();
    const sc = scratchFor();
    await runTerminalText(owedState(state), ctxFor(turnCtx), sc);
    expect(turnCtx.deferredUserReplyWithTools).toBeNull();
    expect(sc.persistedContent).toBeNull();
    expect(sc.deliveredAsStartLine).toBe(false);
  });

  it('the spine is re-read at the moment it matters, and only when something is armed', async () => {
    await runTerminalText(owedState(state), ctxFor(turnCtxFor()), scratchFor());
    expect(stillCompileOwedSpy).toHaveBeenCalledWith([ASK]);

    // A turn with no owed compile asks the database nothing — `compileOwedGateDecision`'s
    // own discipline, kept at the second reader.
    stillCompileOwedSpy.mockClear(); deliverAckSpy.mockClear();
    await runTerminalText(state, ctxFor(turnCtxFor()), scratchFor());
    expect(stillCompileOwedSpy).not.toHaveBeenCalled();
    expect(deliverAckSpy).not.toHaveBeenCalled();
  });

  it('THE DISARM IS A READ: a row that resolved underneath the turn promotes nothing', async () => {
    // T47's words, at its own predicate: "a gate that refuses the agent's live tool calls on
    // the strength of a row that no longer exists is a trap." The same is true of a door that
    // DELIVERS on one — the compile landed some other way, so this text is just narration.
    stillCompileOwedSpy.mockImplementation(() => []);
    const turnCtx = turnCtxFor();
    await runTerminalText(owedState(state), ctxFor(turnCtx), scratchFor());
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toHaveLength(1);
    expect(notesWritten()[0]).toContain('[working-note]');
  });
});

describe('exactly one delivery, whichever windows are open', () => {
  it('the ANSWER wins over the ack when both windows are open — and there is still only one send', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await runTerminalText(owedState(state), ctxFor(turnCtx), scratchFor());
    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    const [, originIntent] = deliverAckSpy.mock.calls[0] as unknown as [string, string | null];
    expect(originIntent).toBeNull();
    // the ack latch is NOT taken by the answer: an answer is not an acknowledgment, and the
    // start-ack machinery keeps its own book.
    expect(turnCtx.engineStartAckDeliveredThisTurn).toBe(false);
  });

  it('an ack already delivered this turn does not cancel the compile — an ack is not an answer', async () => {
    const turnCtx = turnCtxFor({ engineStartAckDeliveredThisTurn: true });
    await runTerminalText(owedState(state), ctxFor(turnCtx), scratchFor());
    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    expect(notesWritten()).toEqual([]);
  });

  it('CONTROL — the person has ALREADY heard the model this turn: nothing is promoted', async () => {
    // `startAckRepliedNow()` is the ledger-backed "have they heard something" question the
    // start-ack family already asks. It is also what makes the promotion exactly-once inside
    // a turn: the promoted row IS an assistant row with no origin stamp, so a second
    // text-with-tools round on the same turn finds this true and stands down.
    const turnCtx = turnCtxFor();
    await runTerminalText(owedState(state), ctxFor(turnCtx, { startAckRepliedNow: () => true }), scratchFor());
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toHaveLength(1);
  });
});

describe('everything outside the owed compile is byte-identical', () => {
  it('CONTROL — non-owed narration on a normal turn is still a working note (the 2026-07-23 ruling)', async () => {
    const turnCtx = turnCtxFor();
    const sc = scratchFor();
    await runTerminalText(state, ctxFor(turnCtx), sc);
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toHaveLength(1);
    expect(notesWritten()[0]).toContain('[working-note]');
    expect(notesWritten()[0]).toContain(THE_PLAN);
    expect(sc.persistedContent).toBeNull();
  });

  it('CONTROL — an A2A turn keeps its hard suppression, owed compile or not', async () => {
    // The 2026-07-23 lane rule at its own arm: inter-agent narration never streamed to the
    // person, so there is nothing to demote and nothing to promote.
    const turnCtx = turnCtxFor();
    await runTerminalText(owedState(state), ctxFor(turnCtx), scratchFor({ interAgentTurn: true }));
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toEqual([]);
    expect(stillCompileOwedSpy).not.toHaveBeenCalled();
  });

  it('CONTROL — a normal tool-less answer is untouched, owed compile or not', async () => {
    const sc = scratchFor();
    await runTerminalText(
      owedState(state),
      ctxFor(turnCtxFor(), { result: modelResult({ toolCalls: [] as ToolCall[] }) }),
      sc,
    );
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toEqual([]);
    // the text IS the reply and flows on to the ordinary persist, exactly as it always did
    expect(sc.persistedContent).toBe(THE_PLAN);
  });

  it('CONTROL — the owed-ACK window still promotes as an ack when no compile is owed (W20 option B, unchanged)', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    const sc = scratchFor();
    await runTerminalText(state, ctxFor(turnCtx, { hasUnansweredUser: true }), sc);
    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    expect(deliverAckSpy.mock.calls[0]).toEqual([THE_PLAN, START_ACK_ORIGIN_INTENT, null, 'agent-text']);
    expect(turnCtx.engineStartAckDeliveredThisTurn).toBe(true);
    expect(sc.deliveredAsStartLine).toBe(true);
    expect(noteTerminalAnswerSpy).not.toHaveBeenCalled();
  });

  it('CONTROL — a waiting human with no owed compile keeps G-SUP-2\'s capture, untouched', async () => {
    const turnCtx = turnCtxFor();
    await runTerminalText(state, ctxFor(turnCtx, { hasUnansweredUser: true }), scratchFor());
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(turnCtx.deferredUserReplyWithTools).toBe(THE_PLAN);
    expect(notesWritten()).toHaveLength(1);
  });
});
