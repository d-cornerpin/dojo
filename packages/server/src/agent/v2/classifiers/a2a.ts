// A2A intent rules live in engine code, not prompt prose: weak models forget
// prompt rules. The missed-reply nudge and the trigger parser.

import { A2A_ENVELOPE_RE, REPLY_NEEDED_INTENTS } from '@dojo/shared';

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
  /** A reply from this agent on the thread since the request arrived, read from the asker's store. */
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
