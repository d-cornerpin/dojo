// Structured inter-agent envelope. Terminal intents close a thread; whether the receiver is woken is
// separate (agent/a2a-transport.ts forces requires_response to false only for its no-wake intents).

export type A2AIntent =
  | 'QUESTION'      // Needs an answer
  | 'ASSIGN'        // Handing off work
  | 'ANSWER'        // Response to a prior question
  | 'DELIVERABLE'   // Here's the thing you asked for
  | 'FYI'           // Awareness, no action needed
  | 'STATUS'        // Progress update
  | 'COMPLETE'      // I'm done with my part
  | 'FAIL'          // I couldn't do it
  | 'BLOCK';        // I'm stuck, need input

export interface A2AEnvelope {
  intent: A2AIntent;
  threadId: string;
  requiresResponse: boolean;
  payload: string;
  toAgent: string;
  fromAgent: string;
  attachPaths?: string[];
  /** The platform itself originates this (not a peer): stamped origin_kind='engine'. Never for a peer. */
  origin?: 'engine';
}

// Not read by the wake rule: agent/a2a-transport.ts keeps its own set (FYI, STATUS); COMPLETE and FAIL wake.
export const NO_WAKE_INTENTS: ReadonlySet<A2AIntent> = new Set([
  'FYI', 'STATUS', 'COMPLETE', 'FAIL',
]);

export const REOPENING_INTENTS: ReadonlySet<A2AIntent> = new Set([
  'QUESTION', 'BLOCK', 'ASSIGN',
]);

export const DEDUP_SIMILARITY_THRESHOLD = 0.85;
export const DEDUP_LOOKBACK = 3;

export function isReopeningIntent(intent: A2AIntent): boolean {
  return REOPENING_INTENTS.has(intent);
}

export type A2ADropReason =
  | 'TERMINAL_THREAD_CLOSED'
  | 'SEMANTIC_DUPLICATE'
  | 'HOP_LIMIT_EXCEEDED'
  | 'MALFORMED_ENVELOPE'
  | 'AGENT_NOT_FOUND'
  // The receiver's row is the only delivery vehicle, so an INSERT that wrote nothing is a drop.
  | 'PERSIST_SKIPPED';
