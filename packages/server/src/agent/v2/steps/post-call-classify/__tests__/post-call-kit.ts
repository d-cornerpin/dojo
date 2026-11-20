// A terminal reply on a user turn, driven through runPostCallClassify (or the promise floor alone), with the
// decision hook stubbed.
// The calling test file mocks the doors (ws, message store, presence, db connection) itself.
import { vi } from 'vitest';
import { installJudgment } from '../../../../decision-hooks.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runPostCallClassify, POST_CALL_CLASSIFY_PHASE, type PostCallClassifyContext, type PostCallClassifyOutcome, type PostCallScratch } from '../index.js';
import { runPromiseFloor } from '../promise-floor.js';
import type { StepOutcome } from '../../step-outcome.js';
import { askReplyClaims, type ReplyClaim } from '../../../reply-claims.js';
import { FX, FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
export const fakeDb = {
  prepare: () => emptyStmt,
  transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
} as unknown as PostCallClassifyContext['db'];

/** What the decision model says about each question it is asked; null is "no decision model on this box". */
export function modelSays(verdicts: Partial<Record<ReplyClaim, boolean>> | null): void {
  installJudgment(async (_q, ask) => verdicts && Object.fromEntries(Object.entries(verdicts).filter(([name]) => name in ask.questions)));
}

let n = 0;
type ToolResult = AgentTurnState['toolResults'][number];

/** One ending reply after the turn's earlier tool results (and steers already fired); returns the step's outcome. */
export function endTurn(
  reply: string, toolResults: Array<Partial<ToolResult>> = [], steerQueue?: AgentTurnState['steerQueue'], turnCtx: Record<string, unknown> = {},
): Promise<PostCallClassifyOutcome> {
  const base = initState({
    agentId: FXID.n4, contextWindow: 128_000, isAutoRouted: false, configuredModelId: 'test-model', turnNumber: 7,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'what is the answer?', lastUserMessageId: 'msg-user-1',
  } as Parameters<typeof initState>[0]);
  const state = advance(base, {
    phase: POST_CALL_CLASSIFY_PHASE, loopCount: 2, modelId: 'test-model',
    toolResults: toolResults.map((r, i) => ({ toolCallId: `tc-${i}`, content: 'ok', isError: false, ...r })) as ToolResult[],
    ...(steerQueue ? { steerQueue } : {}),
  });
  const ctx = {
    agentId: FXID.n4, turnNumber: 7, db: fakeDb, agent: { id: FXID.n4, name: FX.n4 },
    turnCtx: { agentId: FXID.n4, kind: 'user', convKey: 'ck-1', conversationId: 'conv-1', ...turnCtx },
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' },
    counterpartyIsAgentSender: false, chosenConvKey: 'ck-1', hasUnansweredUser: true, triggerRow: null,
    isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false, mostRecentIsA2A: false,
    mostRecentInbound: undefined, pendingEngineEvent: null, unrepliedAssign: null, a2aReplyContext: null,
    a2aReplyAssignMessageId: null, settledContextWakeTurn: false, waitingConvs: [], inboundChannel: 'dashboard',
    latestUserSource: 'dashboard', lastUserMessageContent: 'what is the answer?', configuredModelId: 'test-model',
    turnStartedAt: new Date().toISOString(), messageId: `msg-${++n}`,
    result: { content: reply, toolCalls: [], inputTokens: 10, outputTokens: 5, stopReason: 'end_turn' },
    reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer: vi.fn(), deliverEngineUserAck: vi.fn(async () => undefined),
    persistAndBroadcastSystemRow: vi.fn(), startAckRepliedNow: () => false,
  } as unknown as PostCallClassifyContext;
  return runPostCallClassify(state, ctx);
}

/** The floors that steered, in order. */
export const steered = (out: PostCallClassifyOutcome): string[] => out.state.steerQueue.fired.map((e) => e.floor);

/** The promise floor alone, on a reply the decision model has judged with `verdicts`. */
export async function judgedFloor(
  state: AgentTurnState, ctx: PostCallClassifyContext, sc: PostCallScratch, verdicts: Partial<Record<ReplyClaim, boolean>>,
): Promise<StepOutcome> {
  modelSays(verdicts);
  const at = { ...ctx, messageId: `msg-${++n}`, result: { toolCalls: [] } } as unknown as PostCallClassifyContext;
  await askReplyClaims(state, at, sc.persistedContent);
  return runPromiseFloor(state, at, sc);
}
