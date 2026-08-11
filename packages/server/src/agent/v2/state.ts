// ════════════════════════════════════════
// v2 AgentTurnState, single source of truth for turn state
//
// Per Part VIII of the v2 implementation plan. Replaces the ~20
// scattered `let X = false` flags in v1's runAgentLoop with one
// atomically-updated object. Every `state =` is a complete replacement,
// not a field mutation. validate() runs after every transition to
// catch inconsistent state at dev time.
// ════════════════════════════════════════

import type Anthropic from '@anthropic-ai/sdk';
import type { ToolCall } from '@dojo/shared';
import { emptySteerQueue, type SteerQueue } from './steer-queue.js';

// ── Types ──

export type TurnPhase =
  // ⚠ PHASE-6 T2 (CUT 9) — THE ONE MEMBER NO CALL SITE ADVANCES INTO, and the ninth
  // member's own note below already leaned on that fact ("`'preflight'` is seeded by
  // `initState` and runs before the main `try` opens"). It is stated here rather than
  // left implicit, because it is the one place the phase discipline every other tranche
  // asserts — the driver advances INTO a step's phase ahead of the call, so `validate()`
  // runs on the transition — is met by CONSTRUCTION instead of by a call site. There is
  // no transition to validate: `initState` below SEEDS this value, and it validates the
  // state it built. The step still never writes `phase` (its contract test holds a
  // comment-stripped census over the whole package at ZERO), so the rule the property
  // exists to protect is unchanged; only the reason it holds is different, and a reader
  // looking for the missing `advance` should find this instead of a gap.
  | 'preflight'        // initial: read agent, build trigger context
  | 'preCallGates'     // compaction gate, time budget, stop/preempt checks
  | 'assemble'         // build messages + system prompt
  | 'callLLM'          // single model call
  | 'postCallClassify' // empty? truncated? loop? exit-tool?
  | 'execute'          // partition + run tool calls
  | 'postExecution'    // permission denials, progress, tracker enforcement
  | 'finalize'         // iMessage routing, status, hooks
  | 'done'             // terminal: the value the `while` head tests, and the ONLY
                       // member anything READS. It is a loop-exit sentinel rather
                       // than a phase, which is worth knowing before adding to this
                       // union.
  // PHASE-6 T9b — THE NINTH MEMBER, and the decision the plan's §A owed.
  //
  // `teardown` is the turn's exit path: the `catch` and the `finally` of
  // `runV2TurnBody`, extracted to `agent/v2/steps/teardown/`. The driver advances
  // into it at the top of the `finally`, which is the block that runs on EVERY
  // exit path — clean reply, decline, MAX_TOOL_LOOPS, a mid-loop break, an early
  // return inside the main try, or a throw. That is what makes the member worth
  // having: with it, the union spans the whole turn instead of stopping at the
  // loop.
  //
  // The alternative the plan offered — "record that the ninth module owns the
  // `finally` outside the union" — was refused on a measurement rather than a
  // preference: `'preflight'` is seeded by `initialState` and runs BEFORE the
  // main try opens, so this union already had a member outside the loop, and an
  // exception for the ninth step would have been an exception to a rule that does
  // not exist. Two further measurements said the addition is safe: `state.phase`
  // has exactly ONE production read (the `while` head, which has already finished
  // by then), and a phase-only `advance` re-validates fields unchanged since their
  // own last valid write, so it cannot newly throw — which matters here and
  // nowhere else, because this transition also happens on the throw path, where a
  // new throw would replace the error the turn was already handling.
  //
  // ⚠ WHAT IT DOES NOT DO: it does not make `TurnPhase` "load-bearing" in T13's
  // sense (*a per-turn transition record exists AND at least one decision other
  // than the loop head reads it*). The record half is met by `turns.exit_reason` +
  // `turns.answered`, written and then read one statement later inside the
  // teardown step itself; the `state.phase` half is not, and inventing a reader
  // during a relocation would be a behaviour change the tranche did not admit to.
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

// v2.7.23, Channel-routing context. When an inbound message arrives via
// a non-dashboard channel (iMessage, Teams, email), the watcher/bridge
// populates this so the reply-destination resolver can route the model's
// terminal text back to the same channel without requiring an explicit
// tool call from the model.
//   - recipientAddress: email/phone for iMessage replies, or sender's
//     address for email auto-reply identity checks.
//   - chatId: Teams chat id (per the [Chat ID: ...] line in the Teams
//     notification envelope).
//   - chatType: 'dm' | 'group', group chats default to message_tool
//     mode per OpenClaw pattern to avoid auto-replying to every group
//     ping the agent is mentioned in.
//   - emailMessageId: original message id for email reply tools
//     (outlook_reply / gmail_reply require this).
//   - emailService: which mailbox handler to use ('outlook' | 'gmail').
//   - emailSubject: thread subject (used for the destination tag and
//     for the dashboard rendering).
export interface ChannelInboundContext {
  recipientAddress?: string;
  chatId?: string;
  chatType?: 'dm' | 'group';
  emailMessageId?: string;
  emailService?: 'outlook' | 'gmail';
  emailSubject?: string;
  // B-1 (comms-audit): which connected mailbox received this message (the
  // account email). Multi-account (Path B): the auto-reply MUST go out from the
  // SAME account, so this is threaded into the gmail_reply/outlook_reply `account`
  // param. Without it, resolveGoogle/MicrosoftAccount(undefined) returns null when
  // 2+ agent accounts are connected and the reply silently fails.
  emailAccount?: string;
  // v2.9.18: Twilio SMS reply context. Set when inboundChannel is
  // 'sms' so the terminal-text auto-route knows which number to
  // send to (the original sender) and which of our Twilio numbers
  // to send from (whichever one received the inbound).
  smsFromNumber?: string;
  smsToNumber?: string;
  // v2.9.18: Twilio Voice call reply context. Set when inboundChannel
  // is 'phone' so the terminal-text auto-route can queue the agent's
  // reply text into the active CallSession's TTS pipeline.
  phoneCallSid?: string;
  phoneFromNumber?: string;
}

/**
 * UX-REPAIR ROUND 7.5 T31 — what the owed-interrupt seam wrote down when it bought a round.
 * Identity only: which arrival, which ask, which loop, and whether the person already had a
 * reply when the round was bought. No text travels in here on purpose.
 */
export interface OwedInterruptGrant {
  /** `loopCount` when the round was granted. A later loop IS the granted round. */
  readonly atLoop: number;
  /** The mid-turn arrival rows the round was bought for. */
  readonly messageIds: readonly string[];
  /**
   * TRUE when a user-facing reply had already landed this turn before the round was bought.
   * The two cases are different behaviours, not degrees: after a reply the granted round can
   * only be a SECOND bubble about the arrival (T31 holds it, the arrival's own turn serves
   * it); before any reply the granted round IS the turn's one reply and must never be held.
   */
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

  // ── Phase machine ──
  phase: TurnPhase;

  // ── Loop counters ──
  loopCount: number;
  toolCallsExecutedThisTurn: number;
  /** P6b abort-revert refinement: successful NON-IDEMPOTENT executions this
   *  turn (channel sends, fire-and-forget generators, effectful actions). The
   *  re-arm/revert guards key on THIS, not on any-tools-at-all, so a read-only
   *  aborted turn re-arms its stranded ask while a turn that performed a real
   *  side effect still never re-fires (a duplicate send is worse than a
   *  stranded ask; the direction of error is preserved). */
  nonIdempotentCallsThisTurn: number;

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
  /**
   * PHASE-4 T3: the ORDERED STEER QUEUE replaces the single `pendingNudge` slot.
   *
   * requirement preserved: an engine directive that expects the model to ACT must reach
   * the model — drained into the assembled array as a synthetic user message, never
   * persisted. What is GONE is the single slot's "last writer wins", which destroyed
   * every other steer written in the same beat (23 of the 26 setting sites overwrote it
   * unconditionally), and the ~20 scattered per-site `nudgedForX` booleans that latched
   * those sites — the latch is the queue ENTRY now, one per floor, never shared.
   */
  steerQueue: SteerQueue;

  /**
   * UX-REPAIR ROUND 7.5 T31 — THE OWED-INTERRUPT SEAM'S OWN RECORD OF THE ROUND IT GRANTED.
   *
   * The queue entry already says a round was bought and at which loop; it does not say WHAT
   * FOR. T31's enforcement may not read the model's words to find out — a wording verdict in
   * the suppression direction is exactly the swallow P4b deleted from `closeout-floors.ts`
   * (its tombstone is still there) — so the seam writes down its own subject at the moment it
   * decides, and every later step asks THIS instead of asking the text.
   *
   * Null until the seam grants a round; written once (the queue's latch is one steer per
   * turn), never cleared inside the turn — the record of a round that was granted outlives
   * the round itself, because the enforcement runs after it.
   */
  owedInterruptGrant: OwedInterruptGrant | null;

  // ── Loop break / repetition ──
  recentToolSignatures: string[];

  // ── Recovery & escalation ──
  recoveryStreak: RecoveryStreak | null;
  outputTokensEscalated: number;          // 8000, 16000, 32000, 64000
  consecutivePermissionDenials: number;
  truncationRetryCount: number;
  consecutiveNoResultTools: number;       // tracks "No results found" / "not in memory" returns
  lastResponseSig: string | null;         // canonical signature of last model response (for repetition detection)
  retriedEmptyResponse: boolean;          // v1 phase 1, silent retry has fired this turn (#38)

  // ── Per-signature thrash gate ──
  // When the task-thrash detector trips on a specific canonical tool
  // signature, that signature gets added here and any further tool call
  // matching it is refused with a structured steer. Cleared on
  // work_update(action="status") (any transition counts as progress). Distinct
  // from recentToolSignatures (which is the loopDetector's rolling
  // window).
  thrashGatedSignatures: string[];
  // How many times the gate has had to refuse since the last transition.
  // After THRASH_GATE_BREAKER_LIMIT refusals without progress, the engine
  // auto-blocks the task with a clean reason so it reaches a terminal
  // state instead of looping forever.
  thrashGateRefusalCount: number;
  // loopCount when the thrash gate first activated this turn. Lets the
  // "drift" detector escalate: if the gate has been on for N iterations
  // and the agent still hasn't called work_update(action="status") (just varied
  // its non-gated calls to dodge the refusal), engine auto-blocks too.
  thrashGateActivatedAtLoopCount: number | null;

  // ── Trigger context (read once at preflight) ──
  readonly triggeredByIMessage: boolean;
  readonly triggeredByA2AReplyIntent: A2AReplyContext | null;
  readonly lastUserMessageContent: string | null;
  // P1 lineage spine: the row id of the inbound ask this turn serves (null on
  // engine/A2A turns). Scaffold writers stamp it as source_message_id.
  readonly lastUserMessageId: string | null;
  // v2.7.23, structural inbound channel binding (OpenClaw-inspired). Set
  // once at preflight by inspecting the last user message. Read at end-
  // of-turn by the reply-destination resolver so terminal assistant text
  // can be auto-routed back to the source channel. `null` means the turn
  // came in via dashboard (or no clear inbound source). Replaces the
  // 2.7.22 "model must call imessage_send for every reply" pattern,
  // which the model couldn't follow reliably for short conversational
  // replies (per imessage_not_working.txt investigation).
  readonly inboundChannel: 'imessage' | 'teams' | 'email' | 'sms' | 'phone' | 'voice' | 'dashboard' | null;
  readonly inboundContext: ChannelInboundContext | null;

  // ── Engine-tracked turn flags ──
  sentToAgentThisTurn: boolean;
  /**
   * Count of send_to_agent / broadcast_to_group calls per recipient
   * (normalized/lowercased) THIS turn. Inter-agent replies are async, the
   * recipient answers on its own LATER turn, so an agent that doesn't get an
   * instant reply re-sends the same ask, reworded (which defeats the content-
   * signature dedup), and spams them (observed: 29 sends to one agent in a turn).
   * The loop caps it at A2A_SEND_CAP_PER_RECIPIENT per recipient per turn. The
   * cap is set well ABOVE any genuine case (two distinct messages to one agent,
   * a retry after a transient failure) so it can only catch a pathological
   * re-send loop, never a real multi-send, genuine and pathological behavior
   * are far apart here, unlike the anti-hoarding gate's overlap.
   */
  sendsPerAgentThisTurn: Record<string, number>;
  // True once a user-facing reply has surfaced earlier THIS turn. Used by the
  // engine to suppress a redundant trailing closeout ("Done." / "All set.") on
  // a later continuation iteration, the deterministic floor for "respond once
  // per request" so a weak model that forgets [no-reply] can't spam closeouts.
  // The first reply is never touched (this is false until one lands).
  surfacedReplyThisTurn: boolean;
  lastAssistantTextForIM: string | null;
  // v2.7.23, set when the agent calls a channel-specific send tool
  // (imessage_send, teams_send_message) successfully this turn. The
  // reply-destination resolver reads this at end-of-turn to skip
  // auto-routing for the same channel (otherwise terminal text would
  // get delivered twice, once via the tool call, once via the auto-
  // route). Multiple channels can be tracked if the agent crosses
  // them in one turn (rare).
  explicitSendThisTurn: { imessage?: boolean; teams?: boolean; email?: boolean; sms?: boolean; phone?: boolean };
  /**
   * D16, set per channel ONLY when an explicit send this turn was addressed to
   * THIS turn's counterparty (not a relayed 3rd party). The end-of-turn
   * auto-reply is suppressed on `repliedToCounterpartyThisTurn`, NOT on
   * `explicitSendThisTurn` (any send): relaying to a different recipient on the
   * same channel must not swallow the reply to the person who actually wrote in.
   */
  repliedToCounterpartyThisTurn: { imessage?: boolean; teams?: boolean; email?: boolean; sms?: boolean; phone?: boolean };
  trackerToolCalledThisTurn: boolean;
  /**
   * v3.1.11 (FN-9) + FA-T2, set when the agent (or the engine floor) OPENS or
   * ADVANCES its own tracker work this turn (create / add-notes / edit /
   * advance-a-step, or update_status to an active state, see
   * TRACKER_DISARMING_MUTATION_TOOLS in loop.ts). Distinct from
   * trackerToolCalledThisTurn, which fires on ANY tracker-family call INCLUDING
   * reads (work_update(action="get") / work_update(action="list")). The multi-step
   * enforcement gate keys on THIS field: a bare status peek must not disarm
   * enforcement, and neither may CLOSING / abandoning / handing off a task
   * (that removes what the PM watches, FA-T2), only actually opening or
   * advancing the work does.
   */
  trackerWriteThisTurn: boolean;
  /**
   * A work ROW came into existence this turn, by any path — the agent's own `work_open`, the
   * engine floor's, or anything else that opens one.
   *
   * PHASE-2 T8c item 3 (DECIDED D4). Distinct from `trackerWriteThisTurn`, which is the wider
   * "did the agent tend its work" question and is true for notes, edits and step advances too.
   * D4's requirement is about EXISTENCE, and the difference is the whole of the contradiction
   * D4 identified: the >=6 floor was disarmed by the >3 nudge's own success, so the two tiers
   * could never both be satisfied in one turn and the scenario asking for both could never
   * pass. Keyed on existence, the honest question — "does a work row exist at turn end" — has
   * one answer whichever tier produced it.
   */
  workRowOpenedThisTurn: boolean;
  /**
   * FA-T3: count of NON-TRACKER, NON-TRIVIAL (real work) tool calls this turn.
   * Trivial read-only reconnaissance / utility / bookkeeping (see TRIVIAL_TOOLS
   * in loop.ts) does NOT count, so a pure lookup turn can't trip the multi-step
   * floor.
   */
  nonTrackerToolCalls: number;
  /**
   * v2.5.40, set when the agent calls work_update(action="status") or
   * work_update(action="complete_step") in this turn. Different from
   * trackerToolCalledThisTurn (which fires on ANY tracker-family call,
   * including work_open(kind="project")). Used by the end-of-turn close-out
   * check to distinguish "agent is engaging with tracker" (broad) from
   * "agent advanced or closed a task in this turn" (specific).
   */
  trackerStatusUpdatedThisTurn: boolean;
  /**
   * Running count of HEAVY LOADS this turn: successful tool results whose text
   * payload was at least LOADING_RESULT_MIN_TOKENS (2026-07-08 rewrite, was a
   * count of calls to the curated LOADING_TOOLS name-set). Measured by result
   * size, tool-agnostic, so a new/unknown reader that returns real corpus counts
   * by construction and a small/empty read (time lookup, empty search) does not.
   * D3: used by the anti-hoarding ADVISORY, once this crosses
   * LOADING_GATE_THRESHOLD with no structuring AND context is near compaction,
   * the engine nudges ONCE to write sources down. It never REFUSES a read.
   * Per-turn only; resets each turn.
   */
  heavyLoadsThisTurn: number;
  /**
   * v2.5.43, flips true the moment the agent calls any structuring
   * tool (work_open(kind="project"), work_open(kind="task"),
   * work_update(action="status"), work_update(action="complete_step"),
   * work_note, work_update(action="edit"),
   * file_write, file_append, file_patch) THIS turn. Once true, the
   * anti-hoarding gate is permanently satisfied for the remainder of
   * this turn.
   *
   * v2.5.46, scratchpad_set was REMOVED from this set after a tracker-
   * adoption audit showed it was the cheapest escape and being used as
   * a substitute for the durable plan. Scratchpad is now only an
   * in-flight helper inside tracker steps.
   */
  structuringToolCalledThisTurn: boolean;
  /**
   * D3, the assembled-context utilization ratio (0..1) from the most recent
   * per-iteration compaction gate. The anti-hoarding advisory reads this so it
   * only nudges when context is genuinely near compaction (real confabulation
   * risk), instead of refusing reads by raw call-count. Updated each iteration.
   */
  lastContextRatio: number;
  /**
   * v2.5.46, pre-turn close-out gate. At preflight we look up the
   * agent's in_progress tasks that were NOT touched in the previous
   * turn. If any exist, this list is populated. Until at least one of
   * them is resolved (work_update(action="status") / work_update(action="complete_step")),
   * the tool dispatcher refuses non-tracker tool calls.
   */
  danglingTaskIds: readonly string[];
  /**
   * v2.5.46, flips true the moment the agent closes (status updated)
   * any in_progress task this turn. Disengages the close-out gate for
   * the remainder of the turn (further close-outs encouraged but not
   * forced; the gate fires fresh next turn if there are still danglers).
   */
  closeOutGateSatisfied: boolean;
  /**
   * v2.5.46, fire-once flag for the loud system message that
   * accompanies the first close-out gate refusal in a turn. Set true
   * in preflight when the gate is armed; used by enforcement code to
   * tell "gate is armed for this turn" from "no danglers."
   */
  nudgedForCloseOutThisTurn: boolean;

  /*
   * UX-REPAIR T1: `autoScaffoldedTaskIdThisTurn` LIVED HERE and is deleted. It fed exactly
   * one mechanism — `closeEngineScaffoldSameTurn`, the engine's same-turn close of its own
   * scaffold — which `d00f270` removed on purpose as "the ONLY engine path allowed to write
   * `status='complete'` on a task", the thing the two-key contract exists to prevent. From
   * that commit the field had one write and ZERO readers, while this doc block went on
   * describing the deleted close as live. A write-only field with a comment promising
   * behaviour is worse than no field: it is the next reader's wrong mental model.
   */
  /**
   * Set true at preflight when there is an unacknowledged compaction
   * recall nudge in the message log (i.e. compaction fired and the
   * agent has not yet called recall_recent_thread since). Used by the
   * tool dispatcher to inject a one-shot warning on the first
   * non-recall / non-tracker tool call, then cleared.
   *
   * Catches the failure shape from the Presenton run: agent gets
   * compacted, ignores the recall hint, and unknowingly recreates a
   * project that fell out of the fresh tail.
   */
  awaitingPostCompactRecall: boolean;
  /** Fire-once flag for the post-compaction recall warning. */
  nudgedForPostCompactRecall: boolean;
  /**
   * v2.7.2, set true the first time an assistant block in this turn pairs
   * non-trivial wrap-up text (≥ ~10 chars after trim) with a tracker
   * close-out tool call (work_update(action="status") complete/blocked/paused,
   * work_update(action="complete_step"), work_update(action="close_project")). Suppresses any later
   * text-only assistant block in the same turn, the model has already
   * given the user their response, and any further "Done." / "Read it."
   * follow-up is the duplicate-final-answer failure shape.
   */
  taskClosedWithTextThisTurn: boolean;

  /**
   * v2.7.6, reworked by D6: set when a successful technique_read /
   * use_technique call lands. The hard tool-refusal gate is REMOVED (it
   * globally locked tools and could deadlock with the close-out gate);
   * inline injection of the technique text next to the live message is
   * what actually drives compliance. This flag is now in-memory for the
   * current turn only and backs the OPTIONAL technique_acknowledge
   * affordance (clears the flag, records last-acked). Not persisted;
   * expires at turn end.
   */
  pendingTechniqueAck: {
    techniqueId: string;
    techniqueName: string;
    loadedAtIso: string;
    fromTurnNumber: number;
  } | null;

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
  lastUserMessageContent: string | null;
  lastUserMessageId: string | null;
  // v2.7.23, structural inbound channel binding; see AgentTurnState fields
  inboundChannel: 'imessage' | 'teams' | 'email' | 'sms' | 'phone' | 'voice' | 'dashboard' | null;
  inboundContext: ChannelInboundContext | null;
  /**
   * D6: always null at turn start (cross-turn hydration from agents.config
   * removed with the hard gate); in-memory for the current turn only.
   */
  pendingTechniqueAck: AgentTurnState['pendingTechniqueAck'];
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
    excludedModels: [],

    lastResponse: null,
    toolCalls: [],
    toolResults: [],
    steerQueue: emptySteerQueue(),
    owedInterruptGrant: null,

    recentToolSignatures: [],

    recoveryStreak: null,
    outputTokensEscalated: 0,
    consecutivePermissionDenials: 0,
    truncationRetryCount: 0,
    consecutiveNoResultTools: 0,
    lastResponseSig: null,
    retriedEmptyResponse: false,

    thrashGatedSignatures: [],
    thrashGateRefusalCount: 0,
    thrashGateActivatedAtLoopCount: null,

    triggeredByIMessage: params.triggeredByIMessage,
    triggeredByA2AReplyIntent: params.triggeredByA2AReplyIntent,
    lastUserMessageContent: params.lastUserMessageContent,
    lastUserMessageId: params.lastUserMessageId,
    inboundChannel: params.inboundChannel,
    inboundContext: params.inboundContext,

    sentToAgentThisTurn: false,
    sendsPerAgentThisTurn: {},
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
    danglingTaskIds: [],
    closeOutGateSatisfied: false,
    nudgedForCloseOutThisTurn: false,

    awaitingPostCompactRecall: false,
    nudgedForPostCompactRecall: false,
    taskClosedWithTextThisTurn: false,
    pendingTechniqueAck: params.pendingTechniqueAck,

    currentMessageId: null,
  };
}

// ── Atomic transitions ──

/**
 * Replace state atomically and validate the result. Use this for every
 * state mutation. Direct field assignment (state.x = y) is forbidden in
 * v2, it bypasses validation and breaks the no-partial-corruption guarantee.
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
  // PHASE-4 T3: the spinning nudge's own counter became a queue-keyed latch
  // (`steerFireCount(q, 'spinning')`), so the runaway invariant now guards the QUEUE —
  // wider than the field it replaces, because it catches any floor storming, not one.
  if (state.steerQueue.fired.length > 40) {
    throw new StateValidationError(`steer runaway: ${state.steerQueue.fired.length} steers this turn`);
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
 * Output token escalation chain, Part IX recovery cascade.
 * Returns the next budget level, or null if exhausted.
 */
const OUTPUT_ESCALATION_CHAIN = [8000, 16000, 32000, 64000] as const;

export function nextOutputEscalation(current: number): number | null {
  const idx = OUTPUT_ESCALATION_CHAIN.indexOf(current as typeof OUTPUT_ESCALATION_CHAIN[number]);
  if (idx < 0) return OUTPUT_ESCALATION_CHAIN[0]; // not yet escalated → start at 8K
  if (idx >= OUTPUT_ESCALATION_CHAIN.length - 1) return null; // exhausted
  return OUTPUT_ESCALATION_CHAIN[idx + 1];
}
