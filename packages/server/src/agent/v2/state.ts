// One turn's state, replaced whole through advance() and validated on every transition.

import type { ToolCall } from '@dojo/shared';
import { emptySteerQueue, type SteerQueue } from './steer-queue.js';
// Type-only, so this module stays a leaf and turn-record.ts's database handle never becomes an edge.
import type { TurnExitReason } from './turn-record.js';

export type TurnPhase =
  // Seeded by initState and never advanced into, so no transition validates it.
  | 'preflight'        // initial: read agent, build trigger context
  | 'preCallGates'     // compaction gate, time budget, stop/preempt checks
  | 'assemble'         // build messages + system prompt
  | 'callLLM'          // single model call
  | 'postCallClassify' // empty? truncated? loop? exit-tool?
  | 'execute'          // partition + run tool calls
  | 'postExecution'    // permission denials, progress, tracker enforcement
  | 'finalize'         // iMessage routing, status, hooks
  | 'done'             // terminal: the loop-exit sentinel the `while` head tests
  // Entered at the top of finally, so on the throw path too: a phase-only advance cannot newly throw.
  | 'teardown';        // the exit path: the turn's own catch + finally

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
  arguments?: Record<string, unknown>;   // the producing call's arguments, for the turn-ending floors
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

// Where a non-dashboard inbound came from, so the model's terminal text can be auto-routed back to it.
export interface ChannelInboundContext {
  recipientAddress?: string;
  chatId?: string;
  chatType?: 'dm' | 'group';
  teamsAccount?: string;
  emailMessageId?: string;
  emailService?: 'outlook' | 'gmail';
  emailSubject?: string;
  // The mailbox that received it: with 2+ accounts connected the auto-reply must name the same account.
  emailAccount?: string;
  smsFromNumber?: string;
  smsToNumber?: string;
  phoneCallSid?: string;
  phoneFromNumber?: string;
}

/** What the owed-interrupt seam recorded when it granted a round: identity only, no text. */
export interface OwedInterruptGrant {
  /** `loopCount` when the round was granted. A later loop IS the granted round. */
  readonly atLoop: number;
  readonly messageIds: readonly string[];
  /** A reply had landed before the round: the round may only be a second bubble, which is held.
   *  Before any reply the round IS the turn's reply and is never held. */
  readonly afterReply: boolean;
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

  phase: TurnPhase;

  loopCount: number;
  toolCallsExecutedThisTurn: number;
  /** Successful effectful calls; re-arm guards key on this: a duplicate send is worse than a stranded ask. */
  nonIdempotentCallsThisTurn: number;

  modelId: string;
  routerTier: string | null;
  lockedModelId: string | null;
  lockedTier: string | null;

  lastResponse: ModelCallResult | null;
  toolCalls: ToolCall[];
  toolResults: ToolResultRecord[];
  /** Steers for the model, drained into the assembled array as synthetic user messages, never persisted. */
  steerQueue: SteerQueue;

  /** What the owed-interrupt round was granted for, so later steps never read the model's words.
   *  Written once, never cleared in the turn: the hold that reads it runs after the round. */
  owedInterruptGrant: OwedInterruptGrant | null;

  /** The owed-interrupt settlement record is written, only once a reply exists: a deliveries.rowid high water
   *  taken before the answer would let that answer close an ask it never addressed. */
  owedInterruptSubjectsRecorded: boolean;

  recoveryStreak: RecoveryStreak | null;
  outputTokensEscalated: number;          // the extra output room asked of the NEXT call, in tokens; 0 = none
  truncationRetryCount: number;
  deadEndPasses: number;                  // passes in a row whose every call came back empty or refused
  retriedEmptyResponse: boolean;          // the silent empty-response retry has fired this turn

  /** The checkpoint window the turn is in: its last pass before it, its clock and the job's mark; null is the first. */
  checkpointWindow: { readonly atLoop: number; readonly atMs: number; readonly mark: number } | null;
  // ── Trigger context (read once at preflight) ──
  readonly triggeredByIMessage: boolean;
  readonly triggeredByA2AReplyIntent: A2AReplyContext | null;
  readonly lastUserMessageContent: string | null;
  readonly lastUserMessageId: string | null;
  // Channel the turn came in on (null for dashboard); terminal text is auto-routed back to it.
  readonly inboundChannel: 'imessage' | 'teams' | 'email' | 'sms' | 'phone' | 'voice' | 'dashboard' | null;
  readonly inboundContext: ChannelInboundContext | null;

  sentToAgentThisTurn: boolean;
  // A user-facing reply surfaced this turn: silence floors stand down, later text is not promoted to answer.
  surfacedReplyThisTurn: boolean;
  lastAssistantTextForIM: string | null;
  explicitSendThisTurn: { imessage?: boolean; teams?: boolean; email?: boolean; sms?: boolean; phone?: boolean };
  /** Channels where an explicit send went to THIS turn's counterparty. The end-of-turn auto-reply is
   *  suppressed on this, not on any send: a relay to someone else must not swallow the reply. */
  repliedToCounterpartyThisTurn: { imessage?: boolean; teams?: boolean; email?: boolean; sms?: boolean; phone?: boolean };
  trackerToolCalledThisTurn: boolean;
  /** Tracker work opened or advanced (DISARMING_WORK_OPS, advancing status); reads, closes never disarm. */
  trackerWriteThisTurn: boolean;
  /** A work row came into existence this turn by any path; distinct from the wider trackerWriteThisTurn. */
  workRowOpenedThisTurn: boolean;
  /** Real-work tool calls: not tracker calls and not TRIVIAL_TOOLS (steps/execute/tool-sets.ts). */
  nonTrackerToolCalls: number;
  trackerStatusUpdatedThisTurn: boolean;
  /** Results of at least LOADING_RESULT_MIN_TOKENS; drives the advisory, which never refuses a read. */
  heavyLoadsThisTurn: number;
  /** A structuring tool was dispatched (isStructuringTool); satisfies anti-hoarding for the turn. */
  structuringToolCalledThisTurn: boolean;
  /** Context fill (wanted / room) as a ratio, not a percent, from the latest pre-call gate. */
  lastContextRatio: number;
  /** msg.relevant-memory reached the provider's array; a recorded marker fact, never a veto. */
  recallLaneReachedModelThisTurn: boolean;
  /** Asks owed a compiled reply; while non-empty the dispatcher allows only COMPILE_OWED_ALLOWED_OPS.
   *  Empty on a turn a human is waiting on (steps/preflight/compile-gate.ts). */
  compileOwedAskIds: readonly string[];
  /** A user-facing reply was persisted this turn, which discharges the owed compile until next turn. */
  compileGateSatisfied: boolean;
  /** The compile order reached the model whole this iteration, so the gate may refuse. Not latched. */
  compileOrderReachedModel: boolean;

  /** Set at preflight after an unrecalled compaction; the dispatcher only clears it, injecting nothing. */
  awaitingPostCompactRecall: boolean;
  nudgedForPostCompactRecall: boolean;
  /** A sub-agent's complete_task came with wrap-up text: the while head ends the turn after these tools. */
  taskClosedWithTextThisTurn: boolean;

  /** Why the engine or owner cut this turn, or null. Written via latchEngineCut, first writer wins;
   *  it rides the state each step returns, so no step can drop it before the turn is recorded. */
  engineCutExit: TurnExitReason | null;

  /** The repeat rule refused a call. Derived after the batch in steps/execute/index.ts
   *  because parallel runOne callbacks clobber each other's state writes. */
  repeatRefusedThisTurn: boolean;

  currentMessageId: string | null;        // active message ID for chat:chunk events
}

export interface InitStateParams {
  agentId: string;
  contextWindow: number;
  isAutoRouted: boolean;
  configuredModelId: string;
  turnNumber: number;
  triggeredByIMessage: boolean;
  triggeredByA2AReplyIntent: A2AReplyContext | null;
  lastUserMessageContent: string | null;
  lastUserMessageId: string | null;
  inboundChannel: 'imessage' | 'teams' | 'email' | 'sms' | 'phone' | 'voice' | 'dashboard' | null;
  inboundContext: ChannelInboundContext | null;
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
    nonIdempotentCallsThisTurn: 0,

    modelId: params.isAutoRouted ? '__auto__' : params.configuredModelId,
    routerTier: null,
    lockedModelId: null,
    lockedTier: null,

    lastResponse: null,
    toolCalls: [],
    toolResults: [],
    steerQueue: emptySteerQueue(),
    owedInterruptGrant: null,
    owedInterruptSubjectsRecorded: false,

    recoveryStreak: null,
    outputTokensEscalated: 0,
    truncationRetryCount: 0,
    deadEndPasses: 0,
    retriedEmptyResponse: false,

    checkpointWindow: null,

    triggeredByIMessage: params.triggeredByIMessage,
    triggeredByA2AReplyIntent: params.triggeredByA2AReplyIntent,
    lastUserMessageContent: params.lastUserMessageContent,
    lastUserMessageId: params.lastUserMessageId,
    inboundChannel: params.inboundChannel,
    inboundContext: params.inboundContext,

    sentToAgentThisTurn: false,
    surfacedReplyThisTurn: false,
    lastAssistantTextForIM: null,
    explicitSendThisTurn: {},
    repliedToCounterpartyThisTurn: {},
    trackerToolCalledThisTurn: false,
    trackerWriteThisTurn: false,
    workRowOpenedThisTurn: false,
    nonTrackerToolCalls: 0,
    trackerStatusUpdatedThisTurn: false,
    heavyLoadsThisTurn: 0,
    structuringToolCalledThisTurn: false,
    lastContextRatio: 0,
    recallLaneReachedModelThisTurn: false,
    compileOwedAskIds: [],
    compileGateSatisfied: false,
    compileOrderReachedModel: false,

    awaitingPostCompactRecall: false,
    nudgedForPostCompactRecall: false,
    taskClosedWithTextThisTurn: false,
    engineCutExit: null,
    repeatRefusedThisTurn: false,

    currentMessageId: null,
  };
}

/** Replace state atomically and validate it; a direct field assignment skips validation. */
export function advance(state: AgentTurnState, partial: Partial<AgentTurnState>): AgentTurnState {
  const next: AgentTurnState = { ...state, ...partial };
  validate(next);
  return next;
}

export class StateValidationError extends Error {
  constructor(message: string) {
    super(`AgentTurnState invariant violated: ${message}`);
    this.name = 'StateValidationError';
  }
}

export function validate(state: AgentTurnState): void {
  // outputTokensEscalated is bounded where it is spent (the model call); here it need only be a sane count.
  if (!Number.isFinite(state.outputTokensEscalated) || state.outputTokensEscalated < 0) {
    throw new StateValidationError(`outputTokensEscalated invalid: ${state.outputTokensEscalated}`);
  }
  if (state.recoveryStreak && state.recoveryStreak.count > 10) {
    throw new StateValidationError(`recovery streak runaway: ${state.recoveryStreak.kind} count=${state.recoveryStreak.count}`);
  }
  // Guards the whole steer queue, so any floor storming trips it.
  if (state.steerQueue.fired.length > 40) {
    throw new StateValidationError(`steer runaway: ${state.steerQueue.fired.length} steers this turn`);
  }
  if (state.toolCalls.length > 100) {
    throw new StateValidationError(`unreasonable tool call batch: ${state.toolCalls.length}`);
  }
}
