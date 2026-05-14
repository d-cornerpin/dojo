// ════════════════════════════════════════
// Phase 1C — A2A (agent-to-agent) classifiers
//
// Per Part VI #2 + #3 and Part X. v1 enforces A2A intent rules via
// 50+ lines of "CRITICAL: Communicating With Other Agents" in the
// system prompt. Weak models forget. v2 takes the rules out of the
// LLM's hands:
//
//   - a2aReplyEnforcer: when an agent received a reply-needed intent
//     (QUESTION/ASSIGN/BLOCK) and ended its turn with text but no
//     send_to_agent, the engine inserts a nudge telling them to
//     retry through send_to_agent. (Subsumes v1 runtime.ts:1344-1378.)
//
//   - a2aIntentValidator: validates send_to_agent calls before they
//     execute. Rejects calls without an intent, calls to closed
//     threads with non-reopening intents, and calls that would
//     exceed the hop limit (preventing acknowledgment loops).
// ════════════════════════════════════════

import type { ToolCall } from '@dojo/shared';

/** Intents that wake the receiver and expect a reply. */
export const REPLY_NEEDED_INTENTS = new Set(['QUESTION', 'ASSIGN', 'BLOCK']);

/** Intents that close the thread (no further messages expected). */
export const TERMINAL_INTENTS = new Set(['ANSWER', 'DELIVERABLE', 'COMPLETE', 'FAIL', 'FYI']);

/** Intents allowed to reopen a closed thread. */
export const REOPEN_INTENTS = new Set(['QUESTION', 'BLOCK', 'ASSIGN']);

/** Maximum hop depth for a single A2A exchange chain. */
export const A2A_HOP_LIMIT = 5;

// ── Reply enforcer ──

export interface A2AReplyEnforcerInput {
  /** Did this turn receive a reply-needed A2A intent (QUESTION/ASSIGN/BLOCK)? */
  triggeredByReplyNeededIntent: boolean;
  /** Did the agent call send_to_agent at any point in this turn? */
  sentToAgentThisTurn: boolean;
  /** Was the missed-reply nudge already injected this turn? (Fire at most once.) */
  alreadyNudgedForMissedReply: boolean;
  /** Did the agent produce any text this turn? */
  agentProducedText: boolean;
  /** Context for the nudge text. */
  intent?: string;
  threadShort?: string;
  fromName?: string;
  /**
   * v2.5.31 — true when a2a_replies has any prior reply from this agent on
   * the same thread. Switches the nudge text from "the receiver got
   * nothing" (which is a lie when the agent already replied earlier) to
   * "you replied earlier; if you're done, end your turn." Avoids the
   * spiral where the agent reads "got nothing", knows it sent the
   * message, and writes another summary trying to clarify.
   */
  priorReplyOnSameThread?: boolean;
}

export type A2AReplyDecision =
  | { decision: 'no_action'; reason: string }
  | { decision: 'nudge'; reason: string; nudgeText: string };

/**
 * Decide whether to inject a missed-reply nudge.
 *
 * Original behavior (v1 runtime.ts:1344-1378) was a single nudge text. v2.5.31
 * adds two-flavor nudge: "fresh miss" (the agent never replied) keeps the
 * urgent original text; "stale miss" (the agent replied earlier on this same
 * thread but is now writing trailing text) gets a softer "you're done — just
 * end your turn" message that doesn't lie about delivery.
 */
export function a2aReplyEnforcer(input: A2AReplyEnforcerInput): A2AReplyDecision {
  if (!input.triggeredByReplyNeededIntent) {
    return { decision: 'no_action', reason: 'turn not triggered by reply-needed A2A intent' };
  }
  if (input.sentToAgentThisTurn) {
    return { decision: 'no_action', reason: 'agent already replied via send_to_agent' };
  }
  if (input.alreadyNudgedForMissedReply) {
    return { decision: 'no_action', reason: 'already nudged this turn (fire-once policy)' };
  }
  if (!input.agentProducedText) {
    return { decision: 'no_action', reason: 'agent produced no text — no missed reply to nudge about' };
  }
  const intent = input.intent ?? 'QUESTION';
  const fromName = input.fromName ?? 'the sender';
  const threadShort = input.threadShort ?? 'unknown';

  let nudgeText: string;
  if (input.priorReplyOnSameThread) {
    // The agent already sent send_to_agent on this thread in a prior
    // handleMessage invocation. They handled the inbound — they're now
    // just writing a trailing summary which the user can see but the
    // sender doesn't need. Don't lie about delivery; tell them to stop.
    nudgeText = (
      `[System: You already replied to ${fromName}'s [A2A:${intent}] on thread ${threadShort} ` +
      `via send_to_agent in an earlier turn — ${fromName} has the message. ` +
      `The text you just wrote is going to your own chat (only the user sees it), not to ${fromName}. ` +
      `If you're done with this thread, just END YOUR TURN — do nothing further. ` +
      `Only call send_to_agent again if you have NEW information for ${fromName} (use the same thread_id, intent STATUS or ANSWER as appropriate).]`
    );
  } else {
    // The agent has never replied on this thread. Original urgent framing.
    nudgeText = (
      `[System: You received an [A2A:${intent}] message from ${fromName} on thread ${threadShort} ` +
      `but you wrote your reply as text in your own chat instead of calling send_to_agent. ` +
      `Other agents CANNOT see your chat — only the user can. ${fromName} got nothing. ` +
      `Retry your reply now using send_to_agent with the same thread_id from the message you received. ` +
      `Choose an intent that matches your response (ANSWER if you're answering a QUESTION, ` +
      `COMPLETE/STATUS/FAIL if you finished or are still working, ASSIGN if delegating further). ` +
      `Then end your turn.]`
    );
  }
  return { decision: 'nudge', reason: 'agent received reply-needed intent but did not send_to_agent', nudgeText };
}

// ── Intent validator ──

export interface A2AIntentValidatorInput {
  call: ToolCall;
  /** Thread state lookup result. null if thread doesn't exist or this is a new thread. */
  threadIsClosed: boolean;
  /** How many hops deep is this A2A chain? (sender count along the chain.) */
  hopCount: number;
}

export type A2AIntentValidatorResult =
  | { decision: 'ok' }
  | { decision: 'reject'; reason: string };

/**
 * Validate a send_to_agent call before it executes. Returns ok or
 * a rejection reason that the engine surfaces as a synthetic tool
 * result (so the agent sees the failure in the same shape as a real
 * tool error).
 */
export function a2aIntentValidator(input: A2AIntentValidatorInput): A2AIntentValidatorResult {
  if (input.call.name !== 'send_to_agent' && input.call.name !== 'broadcast_to_group') {
    return { decision: 'ok' }; // not an A2A call
  }
  const args = (input.call.arguments ?? {}) as Record<string, unknown>;
  const intent = args.intent;

  // Rule 1: intent is required
  if (typeof intent !== 'string' || intent.length === 0) {
    return {
      decision: 'reject',
      reason:
        'send_to_agent requires an `intent` parameter. Pick one: QUESTION, ASSIGN, BLOCK, ' +
        'ANSWER, DELIVERABLE, COMPLETE, FAIL, FYI, STATUS. See your tool index for guidance ' +
        'on which intent applies.',
    };
  }

  // Rule 2: closed-thread protection
  const threadId = args.thread_id;
  if (typeof threadId === 'string' && threadId.length > 0 && input.threadIsClosed) {
    if (!REOPEN_INTENTS.has(intent)) {
      return {
        decision: 'reject',
        reason:
          `Thread ${threadId} is closed (a terminal intent was sent earlier). ` +
          `Only QUESTION, BLOCK, or ASSIGN can reopen a closed thread. ` +
          `Use one of those if you need to re-engage, or omit thread_id to start a fresh thread.`,
      };
    }
  }

  // Rule 3: hop limit
  if (input.hopCount >= A2A_HOP_LIMIT) {
    return {
      decision: 'reject',
      reason:
        `A2A hop limit reached (${A2A_HOP_LIMIT}). This exchange chain is too deep — ` +
        `end the conversation here, summarize via complete_task or vault_remember if you need ` +
        `to preserve findings. Continued back-and-forth is almost always an acknowledgment loop.`,
    };
  }

  return { decision: 'ok' };
}

/** Parse an A2A trigger tag from a user message body. Verbatim from v1 runtime.ts:817. */
export function parseA2ATrigger(content: string | null): {
  intent: string;
  threadShort: string;
  fromName: string;
} | null {
  if (!content) return null;
  const match = content.match(/^\[A2A:([A-Z]+)\s+thread:([0-9a-f]{8})\s+from:([^\]]+)\]/);
  if (!match) return null;
  const intent = match[1];
  // Only return non-null for reply-needed intents — terminal intents
  // (ANSWER, DELIVERABLE, FYI, COMPLETE, FAIL) don't expect a reply.
  if (!REPLY_NEEDED_INTENTS.has(intent)) return null;
  return { intent, threadShort: match[2], fromName: match[3].trim() };
}
