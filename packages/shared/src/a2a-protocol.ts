// Structured inter-agent envelope types. The wake and reopen rules live in agent/a2a-transport.ts.

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

/** Intents that put the receiver on the hook for a reply; they also reopen a closed thread. */
export const REPLY_NEEDED_INTENTS: ReadonlySet<string> = new Set(['QUESTION', 'ASSIGN', 'BLOCK']);

export type A2ADropReason =
  | 'SEMANTIC_DUPLICATE'
  | 'HOP_LIMIT_EXCEEDED'
  | 'MALFORMED_ENVELOPE'
  | 'AGENT_NOT_FOUND'
  // The receiver's row is the only delivery vehicle, so an INSERT that wrote nothing is a drop.
  | 'PERSIST_SKIPPED';
