// ════════════════════════════════════════
// A2A Protocol — Structured Inter-Agent Messaging
//
// Every agent-to-agent message goes through a structured envelope with
// explicit intent and response requirements. This eliminates
// acknowledgement loops at the protocol level: terminal intents
// (DELIVERABLE, FYI, COMPLETE, FAIL, ANSWER) force requires_response
// to false, which means the receiver is NOT woken — the message is
// read-only context on their next natural turn.
// ════════════════════════════════════════

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
}

// Terminal intents ALWAYS force requires_response to false.
// After a terminal intent, the thread is closed to non-reopening intents.
export const TERMINAL_INTENTS: ReadonlySet<A2AIntent> = new Set([
  'DELIVERABLE', 'FYI', 'COMPLETE', 'FAIL', 'ANSWER',
]);

// Only these intents can reopen a terminated thread.
export const REOPENING_INTENTS: ReadonlySet<A2AIntent> = new Set([
  'QUESTION', 'BLOCK', 'ASSIGN',
]);

// Max delivered messages per thread before silent halt.
export const MAX_HOPS_PER_THREAD = 8;

// Semantic dedup: cosine similarity threshold and lookback window.
export const DEDUP_SIMILARITY_THRESHOLD = 0.85;
export const DEDUP_LOOKBACK = 3;

export function isTerminalIntent(intent: A2AIntent): boolean {
  return TERMINAL_INTENTS.has(intent);
}

export function isReopeningIntent(intent: A2AIntent): boolean {
  return REOPENING_INTENTS.has(intent);
}

// Delivery result codes for logging
export type A2ADropReason =
  | 'TERMINAL_THREAD_CLOSED'
  | 'SEMANTIC_DUPLICATE'
  | 'HOP_LIMIT_EXCEEDED'
  | 'MALFORMED_ENVELOPE'
  | 'AGENT_NOT_FOUND';
