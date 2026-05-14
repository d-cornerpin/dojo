// ════════════════════════════════════════
// v2 AgentTurnState — single source of truth for turn state
//
// Per Part VIII of the v2 implementation plan. Replaces the ~20
// scattered `let X = false` flags in v1's runAgentLoop with one
// atomically-updated object. Every `state =` is a complete replacement,
// not a field mutation. validate() runs after every transition to
// catch inconsistent state at dev time.
// ════════════════════════════════════════

import type Anthropic from '@anthropic-ai/sdk';
import type { ToolCall } from '@dojo/shared';

// ── Types ──

export type TurnPhase =
  | 'preflight'        // initial: read agent, build trigger context
  | 'preCallGates'     // compaction gate, time budget, stop/preempt checks
  | 'assemble'         // build messages + system prompt
  | 'callLLM'          // single model call
  | 'postCallClassify' // empty? truncated? loop? exit-tool?
  | 'execute'          // partition + run tool calls
  | 'postExecution'    // permission denials, progress, tracker enforcement
  | 'finalize'         // iMessage routing, status, hooks
  | 'done';            // terminal

export interface ModelCallResult {
  content: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface ToolResultRecord {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
  contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
}

export interface RecoveryStreak {
  kind: string;
  count: number;
}

export interface A2AReplyContext {
  intent: string;
  threadShort: string;
  fromName: string;
}

export interface AgentTurnState {
  // ── Identity & config (immutable across turn) ──
  readonly agentId: string;
  readonly contextWindow: number;
  readonly isAutoRouted: boolean;
  readonly configuredModelId: string;
  readonly turnStartedAt: string;
  readonly turnStartMs: number;
  readonly turnNumber: number;            // session-scoped, increments per outer turn

  // ── Phase machine ──
  phase: TurnPhase;

  // ── Loop counters ──
  loopCount: number;
  toolCallsExecutedThisTurn: number;

  // ── Model selection ──
  modelId: string;
  routerTier: string | null;
  lockedModelId: string | null;
  lockedTier: string | null;
  excludedModels: string[];

  // ── Last call results ──
  lastResponse: ModelCallResult | null;
  toolCalls: ToolCall[];
  toolResults: ToolResultRecord[];
  pendingNudge: string | null;            // injected as synthetic user msg next assemble; never persisted

  // ── Loop break / repetition ──
  recentToolSignatures: string[];

  // ── Recovery & escalation ──
  recoveryStreak: RecoveryStreak | null;
  outputTokensEscalated: number;          // 8000, 16000, 32000, 64000
  consecutivePermissionDenials: number;
  truncationRetryCount: number;
  spinningNudgeCount: number;             // Part XVIII §F — consecutive ignored spinning nudges
  consecutiveNoResultTools: number;       // tracks "No results found" / "not in memory" returns
  nudgedForNoResults: boolean;            // fire-once per turn for the no-results nudge
  lastResponseSig: string | null;         // canonical signature of last model response (for repetition detection)
  nudgedForRepetition: boolean;           // fire-once per turn for the repetition nudge
  retriedEmptyResponse: boolean;          // v1 phase 1 — silent retry has fired this turn (#38)
  nudgedForEmptyResponse: boolean;        // v1 phase 2 — explicit nudge has fired this turn (#38)

  // ── Trigger context (read once at preflight) ──
  readonly triggeredByIMessage: boolean;
  readonly triggeredByA2AReplyIntent: A2AReplyContext | null;
  readonly imFlagSetAtRunStart: boolean;
  readonly lastUserMessageContent: string | null;

  // ── Engine-tracked turn flags ──
  sentToAgentThisTurn: boolean;
  lastAssistantTextForIM: string | null;
  trackerToolCalledThisTurn: boolean;
  nonTrackerToolCalls: number;
  /**
   * v2.5.31 — message id of the most recent inbound ASSIGN/QUESTION/BLOCK
   * the missed-reply enforcer has already nudged about this handleMessage
   * invocation. Real fire-once: if the next iteration produces text-no-tool
   * for the same assign id, the loop hard-stops instead of nudging again.
   * Set to null at turn start; updated when the enforcer fires.
   */
  nudgedForMissedReplyOnAssignId: string | null;

  // ── Pre-flight enforcement decisions ──
  readonly shouldNudgeTracker: boolean;

  // ── Streaming state ──
  currentMessageId: string | null;        // active message ID for chat:chunk events
}

// ── Initialization ──

export interface InitStateParams {
  agentId: string;
  contextWindow: number;
  isAutoRouted: boolean;
  configuredModelId: string;
  turnNumber: number;
  triggeredByIMessage: boolean;
  triggeredByA2AReplyIntent: A2AReplyContext | null;
  imFlagSetAtRunStart: boolean;
  lastUserMessageContent: string | null;
  shouldNudgeTracker: boolean;
}

export function initState(params: InitStateParams): AgentTurnState {
  const now = new Date();
  return {
    agentId: params.agentId,
    contextWindow: params.contextWindow,
    isAutoRouted: params.isAutoRouted,
    configuredModelId: params.configuredModelId,
    turnStartedAt: now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
    turnStartMs: now.getTime(),
    turnNumber: params.turnNumber,

    phase: 'preflight',

    loopCount: 0,
    toolCallsExecutedThisTurn: 0,

    modelId: params.isAutoRouted ? '__auto__' : params.configuredModelId,
    routerTier: null,
    lockedModelId: null,
    lockedTier: null,
    excludedModels: [],

    lastResponse: null,
    toolCalls: [],
    toolResults: [],
    pendingNudge: null,

    recentToolSignatures: [],

    recoveryStreak: null,
    outputTokensEscalated: 0,
    consecutivePermissionDenials: 0,
    truncationRetryCount: 0,
    spinningNudgeCount: 0,
    consecutiveNoResultTools: 0,
    nudgedForNoResults: false,
    lastResponseSig: null,
    nudgedForRepetition: false,
    retriedEmptyResponse: false,
    nudgedForEmptyResponse: false,

    triggeredByIMessage: params.triggeredByIMessage,
    triggeredByA2AReplyIntent: params.triggeredByA2AReplyIntent,
    imFlagSetAtRunStart: params.imFlagSetAtRunStart,
    lastUserMessageContent: params.lastUserMessageContent,

    sentToAgentThisTurn: false,
    lastAssistantTextForIM: null,
    trackerToolCalledThisTurn: false,
    nonTrackerToolCalls: 0,
    nudgedForMissedReplyOnAssignId: null,

    shouldNudgeTracker: params.shouldNudgeTracker,

    currentMessageId: null,
  };
}

// ── Atomic transitions ──

/**
 * Replace state atomically and validate the result. Use this for every
 * state mutation. Direct field assignment (state.x = y) is forbidden in
 * v2 — it bypasses validation and breaks the no-partial-corruption guarantee.
 */
export function advance(state: AgentTurnState, partial: Partial<AgentTurnState>): AgentTurnState {
  const next: AgentTurnState = { ...state, ...partial };
  validate(next);
  return next;
}

// ── Validation ──

export class StateValidationError extends Error {
  constructor(message: string) {
    super(`AgentTurnState invariant violated: ${message}`);
    this.name = 'StateValidationError';
  }
}

export function validate(state: AgentTurnState): void {
  if (state.outputTokensEscalated > 64000) {
    throw new StateValidationError(`outputTokensEscalated overflow: ${state.outputTokensEscalated}`);
  }
  if (state.toolCallsExecutedThisTurn > 200) {
    throw new StateValidationError(`runaway tool count: ${state.toolCallsExecutedThisTurn}`);
  }
  if (state.loopCount > 500) {
    throw new StateValidationError(`runaway loop count: ${state.loopCount}`);
  }
  if (state.consecutivePermissionDenials > 20) {
    throw new StateValidationError(`runaway permission denials: ${state.consecutivePermissionDenials}`);
  }
  if (state.recoveryStreak && state.recoveryStreak.count > 10) {
    throw new StateValidationError(`recovery streak runaway: ${state.recoveryStreak.kind} count=${state.recoveryStreak.count}`);
  }
  if (state.spinningNudgeCount > 10) {
    throw new StateValidationError(`spinning nudge runaway: ${state.spinningNudgeCount}`);
  }
  if (state.toolCalls.length > 100) {
    throw new StateValidationError(`unreasonable tool call batch: ${state.toolCalls.length}`);
  }
  if (state.recentToolSignatures.length > 50) {
    throw new StateValidationError(`recentToolSignatures overflow (should be windowed): ${state.recentToolSignatures.length}`);
  }
}

// ── Helpers ──

export function bumpRecoveryStreak(
  current: RecoveryStreak | null,
  kind: string,
): RecoveryStreak {
  if (!current || current.kind !== kind) return { kind, count: 1 };
  return { kind, count: current.count + 1 };
}

export function clearRecoveryStreak(): null {
  return null;
}

export function bumpLoopSignature(
  signatures: string[],
  newSignature: string,
  windowSize: number,
): string[] {
  const next = [...signatures, newSignature];
  if (next.length > windowSize) {
    return next.slice(-windowSize);
  }
  return next;
}

/**
 * Output token escalation chain — Part IX recovery cascade.
 * Returns the next budget level, or null if exhausted.
 */
const OUTPUT_ESCALATION_CHAIN = [8000, 16000, 32000, 64000] as const;

export function nextOutputEscalation(current: number): number | null {
  const idx = OUTPUT_ESCALATION_CHAIN.indexOf(current as typeof OUTPUT_ESCALATION_CHAIN[number]);
  if (idx < 0) return OUTPUT_ESCALATION_CHAIN[0]; // not yet escalated → start at 8K
  if (idx >= OUTPUT_ESCALATION_CHAIN.length - 1) return null; // exhausted
  return OUTPUT_ESCALATION_CHAIN[idx + 1];
}
