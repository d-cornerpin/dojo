// THE TURN'S OWN BAG: one object per turn, opened at the top and cleared in its `finally`.
// ONE clear point covers every exit: clean end, mid-loop break, early return, throw.
// A field left `undefined` = the old maps' "no entry"; an explicit `null` = the maps' explicit null.
// Facts wider than a turn live in turn-state.ts and MUST NOT move here.

// The type import is erased at compile time, so no runtime cycle.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentTurnState } from './v2/state.js';
import type { PendingAttachment } from './pending-attachments.js';
import { StreamingSpeechBuffer } from '../voice/text-sanitize.js';

// Origin of the turn; the kind vocabulary must match migration 112.
export interface TurnRoot {
  kind: 'ask' | 'occurrence' | 'a2a' | 'engine';
  id: string;
  sourceMessageId: string | null;
  conversationId?: string | null;
}

// The work an engine turn serves; the bag's field is null when the referent names a missing row.
export interface ServedWork {
  taskId: string | null;
  runId: string | null;
  taskKind: string | null;
  originConvKey: string | null;
}

export interface TurnContext {
  readonly agentId: string;

  kind: 'user' | 'a2a' | undefined;

  // Scopes recall to this turn's conversation; an engine/A2A turn's explicit null must not latch.
  convKey: string | null | undefined;

  // The same fact as convKey in another unit; BOTH are load-bearing: four other tables still
  // key on conv_key (two JOIN on it). Keep both until those columns are rekeyed. Same 3-state.
  conversationId: string | null | undefined;

  address: import('./v2/turn-address.js').TurnAddress | undefined;

  modelRequestId: string | undefined;

  turnNumber: number | undefined;

  root: TurnRoot | null | undefined;
  servedWork: ServedWork | null | undefined;

  triggerMessageId: string | null | undefined;

  startAckTimer: ReturnType<typeof setTimeout> | null;

  // Written from the streaming TTS callback; only the bag carries the write to its readers.
  phoneStreamBuffer: StreamingSpeechBuffer;

  phoneStreamFlushedAny: boolean;

  phoneStreamCallSid: string | null;

  // execute latches the flag, callLLM reads it and writes the grace: one mechanism across two spans.
  toolPhaseEndedBySpinBrake: boolean;
  spinBrakeGraceCalls: number;
  mediaWordsStepOwed: boolean;
  jobParked: boolean;


  ownerAffinityConversationId: string | null;
  ownerAffinityDestination: 'imessage' | null;

  deferredUserReplyWithTools: string | null;

  deferredNoteId: string | null;

  // Stamped by assemble, read by teardown to claim in-window rows; null is legal, so a lost write is silent.
  lastAssembledAtIso: string | null;
  pickupSeq: number | null;
  freshTailDropWarned: boolean;

  startAckSteerRequested: boolean;
  startAckSteerArmedThisTurn: boolean;
  startAckSteersInjected: number;
  startAckSteerInjectedAtLoop: number;

  // The start-ack timer reads this AT FIRE TIME: by value the timer stays quiet forever on a working turn.
  anyToolStartedThisTurn: boolean;

  inboundClassifiedAsWork: boolean;

  // The start-ack timer reads the first at fire time and later iterations read the second: copies would double-send.
  engineStartAckDeliveredThisTurn: boolean;
  deferredDeliveredByAck: boolean;

  startAckPromotedRowId: string | null;
  /** The queued row of an answer delivered mid-turn; while set, the turn's end does not queue the same words. */
  earlyAnswerRowId: string | null;
  /** Files shown with this turn's reply; finalize puts the real files (not chips) on the reply's row. */
  replyFiles: PendingAttachment[];

  // Latches that cross loop iterations: reset each round, the filler and the idle nudge would repeat.
  voiceFillerFired: boolean;

  goingIdleDetectorRanThisTurn: boolean;

  // Timer closures read it at fire time, so it lives on the bag; no driver let beside it.
  state: AgentTurnState | null;
}

// Keyed by agentId: peers read each other's bag (send_to_agent's busy check).
const openContexts = new Map<string, TurnContext>();

export function openTurnContext(agentId: string): TurnContext {
  const ctx: TurnContext = {
    agentId,
    kind: undefined,
    convKey: undefined,
    conversationId: undefined,
    address: undefined,
    modelRequestId: undefined,
    turnNumber: undefined,
    root: undefined,
    servedWork: undefined,
    triggerMessageId: undefined,
    startAckTimer: null,
    phoneStreamBuffer: new StreamingSpeechBuffer(),
    phoneStreamFlushedAny: false,
    phoneStreamCallSid: null,
    toolPhaseEndedBySpinBrake: false,
    mediaWordsStepOwed: false,
    jobParked: false,
    spinBrakeGraceCalls: 2,
    ownerAffinityConversationId: null,
    ownerAffinityDestination: null,
    deferredUserReplyWithTools: null,
    deferredNoteId: null,
    lastAssembledAtIso: null,
    pickupSeq: null,
    freshTailDropWarned: false,
    startAckSteerRequested: false,
    startAckSteerArmedThisTurn: false,
    startAckSteersInjected: 0,
    startAckSteerInjectedAtLoop: 0,
    anyToolStartedThisTurn: false,
    inboundClassifiedAsWork: false,
    engineStartAckDeliveredThisTurn: false,
    deferredDeliveredByAck: false,
    startAckPromotedRowId: null,
    earlyAnswerRowId: null,
    replyFiles: [],
    voiceFillerFired: false,
    goingIdleDetectorRanThisTurn: false,
    state: null,
  };
  openContexts.set(agentId, ctx);
  return ctx;
}

export function turnContext(agentId: string): TurnContext | undefined {
  return openContexts.get(agentId);
}

// Close the bag: called from runV2Turn's own `finally`, the ONE clear point on every exit.
// Not the loop's teardown block: it READS root and served work; the wrapper orders the clear after them.
export function endTurnContext(agentId: string): void {
  openContexts.delete(agentId);
}

/** The turn a record is stamped with. */
export interface TurnStamp {
  readonly turnNumber: number | null;
  readonly root: TurnRoot | null;
  readonly convKey: string | null;
}

// A send outside its own turn (a queued reply's retry) declares that turn; a declared "no turn" stays no turn.
const declaredStamp = new AsyncLocalStorage<{ agentId: string; stamp: TurnStamp }>();

export function asTurn<T>(agentId: string, stamp: TurnStamp, fn: () => T): T {
  return declaredStamp.run({ agentId, stamp }, fn);
}

/** Every writer that stamps a turn asks here: the declared turn first, the agent's live turn only without one. */
export function turnStamp(agentId: string): TurnStamp {
  const declared = declaredStamp.getStore();
  if (declared?.agentId === agentId) return declared.stamp;
  const ctx = openContexts.get(agentId);
  return { turnNumber: ctx?.turnNumber ?? null, root: ctx?.root ?? null, convKey: ctx?.convKey ?? null };
}

// The three states ARE the contract; a reader that flattens them re-opens the bleed:
// `undefined` = outside a turn (legacy fallback), `null` = engine/A2A,
// a string = scope to that conversation.
export function turnConversationScope(agentId: string): string | null | undefined {
  const ctx = openContexts.get(agentId);
  if (!ctx || ctx.conversationId === undefined) return undefined;
  return ctx.conversationId;
}

export interface WorkOrigin {
  kind: 'user_ask' | 'engine_scaffold' | 'a2a_assign' | 'model' | 'reminder' | 'user_direct' | 'system' | null;
  sourceMessageId: string | null;
  turn: number | null;
  convKey: string | null;
}

export function getWorkOriginForAgent(agentId: string, kind: WorkOrigin['kind']): WorkOrigin {
  const ctx = openContexts.get(agentId);
  return {
    kind,
    sourceMessageId: ctx?.root?.sourceMessageId ?? null,
    turn: ctx?.turnNumber ?? null,
    convKey: ctx?.convKey ?? null,
  };
}

export function openTurnContextAgents(): string[] {
  return [...openContexts.keys()];
}
