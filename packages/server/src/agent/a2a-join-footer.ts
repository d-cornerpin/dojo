// Footer for a woken delegating agent when the engine owns delivery of a single-piece answer.
// The woken turn cannot see the relay row, so the footer itself states what was or will be sent;
// otherwise the agent tells the user the same news a second time. Null keeps the ordinary footer.
import { FINAL_REPLY_INTENTS, type A2AIntent } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { joinState } from '../work/store.js';
import { priorEngineJoinRelay } from '../work/ask-settlement.js';
import { readCounterparty } from '../memory/relay-facts.js';
import { renderInstant } from '../memory/message-stamp.js';

export function joinWakeFooter(p: {
  agentId: string; parentId: string; replyConversationId: string | null; intent: A2AIntent; threadShort: string;
}): string | null {
  if (!FINAL_REPLY_INTENTS.has(p.intent)) return null;
  try {
    const join = joinState(p.parentId);
    if (!join?.complete || join.total !== 1) return null;
    const who = readCounterparty(p.replyConversationId)?.replace(/[\[\]\r\n]+/g, ' ') ?? 'the person who asked';
    const restart = ' To restart a new conversation with the sender, omit thread_id and pick QUESTION/ASSIGN/BLOCK.]';
    const relay = priorEngineJoinRelay(p.parentId);
    const receipt = relay
      ? getDb().prepare('SELECT channel, created_at FROM deliveries WHERE id = ?').get(relay.id) as { channel: string | null; created_at: string } | undefined
      : undefined;
    const at = receipt ? renderInstant(receipt.created_at) : null;
    if (receipt && at) {
      return `\n\n[Thread ${p.threadShort} | Closed. This answer was already sent to ${who} on ${receipt.channel ?? 'dashboard'} at ${at} by the engine; `
        + `do not tell them again; update your tracker only.${restart}`;
    }
    if (p.intent === 'FAIL') return null;
    return `\n\n[Thread ${p.threadShort} | Closed. The engine delivers this answer to ${who} itself, once your current turn ends; `
      + `do not send it yourself; update your tracker only.${restart}`;
  } catch {
    return null;   // best-effort: the ordinary footer stands
  }
}
