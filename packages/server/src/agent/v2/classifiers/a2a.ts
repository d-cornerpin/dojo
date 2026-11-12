// A2A intent rules live in engine code, not prompt prose: weak models forget
// prompt rules. Two classifiers: the missed-reply nudge, the pre-execution validator.

import { A2A_ENVELOPE_RE } from '@dojo/shared';
import type { ToolCall } from '@dojo/shared';

/** Intents that wake the receiver and expect a reply. */
export const REPLY_NEEDED_INTENTS = new Set(['QUESTION', 'ASSIGN', 'BLOCK']);

/** Intents that close the thread (no further messages expected). */
export const TERMINAL_INTENTS = new Set(['ANSWER', 'DELIVERABLE', 'COMPLETE', 'FAIL', 'FYI']);

/** Intents allowed to reopen a closed thread. */
export const REOPEN_INTENTS = new Set(['QUESTION', 'BLOCK', 'ASSIGN']);

/** Maximum hop depth for a single A2A exchange chain. */
export const A2A_HOP_LIMIT = 5;


export interface A2AReplyEnforcerInput {
  triggeredByReplyNeededIntent: boolean;
  sentToAgentThisTurn: boolean;
  /** Was the missed-reply nudge already injected this turn? (Fire at most once.) */
  alreadyNudgedForMissedReply: boolean;
  agentProducedText: boolean;
  intent?: string;
  threadShort?: string;
  fromName?: string;
  /** Prior reply on this thread: avoids the nudge claiming the receiver got nothing. */
  priorReplyOnSameThread?: boolean;
  /** The engine's own verified send receipt: the same fact, for when an
   *  a2a_replies row is missing because the sender omitted thread_id. */
  verifiedSendReceiptOnThread?: boolean;
}

export type A2AReplyDecision =
  | { decision: 'no_action'; reason: string }
  | { decision: 'nudge'; reason: string; nudgeText: string };

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
  // Either record of a reply takes this branch; the fresh-miss text below is
  // reachable only with no record at all, the sole state where "got nothing" is true.
  if (input.priorReplyOnSameThread || input.verifiedSendReceiptOnThread) {
    nudgeText = (
      `[System: You already replied to ${fromName}'s [A2A:${intent}] on thread ${threadShort} ` +
      `via send_to_agent in an earlier turn — ${fromName} has the message. ` +
      `The text you just wrote is going to your own chat (only the user sees it), not to ${fromName}. ` +
      `If you're done with this thread, just END YOUR TURN — do nothing further. ` +
      `Only call send_to_agent again if you have NEW information for ${fromName} (use the same thread_id, intent STATUS or ANSWER as appropriate).]`
    );
  } else {
    // Never replied on this thread: urgent framing.
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

export interface A2AIntentValidatorInput {
  call: ToolCall;
  threadIsClosed: boolean;
  /** How many hops deep is this A2A chain? (sender count along the chain.) */
  hopCount: number;
}

export type A2AIntentValidatorResult =
  | { decision: 'ok' }
  | { decision: 'reject'; reason: string };

// Validates a send_to_agent call pre-execution; a reject surfaces as a synthetic tool result.
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

export function parseA2ATrigger(content: string | null): {
  intent: string;
  threadShort: string;
  fromName: string;
} | null {
  if (!content) return null;
  const match = content.match(A2A_ENVELOPE_RE);
  if (!match) return null;
  const intent = match[1];
  // Non-null only for reply-needed intents: terminal intents expect no reply.
  if (!REPLY_NEEDED_INTENTS.has(intent)) return null;
  return { intent, threadShort: match[2], fromName: match[3].trim() };
}
