// The task's asker, by the engine's own record: an agent asker is the task's `requester_id` (another agent
// than the worker); a person asker is the sender of the message the task or its project exists for, and
// when that is the owner, his own outside channels count too (`isOwnerOn`), and the dashboard or voice when he asked there.
// Anything else is not the asker, so "the worker's own message to the asker" stays true.
import { getDb } from '../../db/connection.js';
import { ownerWords } from '../../tracker/owner-words.js';
import { isOwnerOn } from '../../services/owner-on.js';
import { addressesMatch } from '../../services/safe-senders.js';

export type Asker =
  | { kind: 'agent'; id: string | null; sourceMessageId: string | null }
  | { kind: 'person'; owner: boolean; sourceMessageId: string | null; conversationId: string | null; channel: string | null; senderId: string | null };

interface SourceRow {
  id: string; content: string; lane: string; channel: string; source_agent_id: string | null; a2a_thread_id: string | null;
  a2a_intent: string | null; a2a_requires_response: number | null; inbound_meta: string | null; origin_intent: string | null;
  conversation_id: string | null; sender_id: string | null; sent_at: number;
}

/** The task's asker. */
export function askerOf(taskId: string): Asker {
  const db = getDb();
  const w = db.prepare(
    `SELECT w.agent_id, w.requester, w.requester_id, COALESCE(w.source_message_id, p.source_message_id) AS src
       FROM work w LEFT JOIN work p ON p.id = w.parent_id WHERE w.id = ?`,
  ).get(taskId) as { agent_id: string; requester: string; requester_id: string | null; src: string | null } | undefined;
  if (!w) return { kind: 'agent', id: null, sourceMessageId: null };
  const requester = w.requester === 'agent' ? agentIdOf(w.requester_id) : null;
  // A task an agent opened for itself was asked for by whoever sent the message it exists for.
  if (requester && requester !== w.agent_id) return { kind: 'agent', id: requester, sourceMessageId: w.src };
  const m = w.src ? db.prepare(
    `SELECT id, content, lane, channel, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta,
            origin_intent, conversation_id, sender_id, sent_at
       FROM messages WHERE id = ? AND role = 'user'`,
  ).get(w.src) as SourceRow | undefined : undefined;
  if (m?.source_agent_id && m.source_agent_id !== w.agent_id) return { kind: 'agent', id: m.source_agent_id, sourceMessageId: m.id };
  if (!m || m.source_agent_id) return { kind: 'person', owner: true, sourceMessageId: w.src, conversationId: null, channel: null, senderId: null };
  return {
    kind: 'person', owner: ownerWords(m, m.sent_at) !== null, sourceMessageId: m.id,
    conversationId: m.conversation_id, channel: m.channel, senderId: m.sender_id,
  };
}

/** An agent reference (id or name) to the agent's id; the reference itself when unknown. */
function agentIdOf(ref: string | null): string | null {
  if (!ref) return null;
  const r = getDb().prepare('SELECT id FROM agents WHERE id = ? OR name = ? COLLATE NOCASE ORDER BY (id = ?) DESC LIMIT 1')
    .get(ref, ref, ref) as { id: string } | undefined;
  return r?.id ?? ref;
}

/** Is this delivery addressed to the asker? */
export function deliveredToAsker(
  a: Asker, d: { channel: string; recipient_id: string | null; conversation_id: string | null },
): boolean {
  if (a.kind === 'agent') return d.channel === 'a2a' && a.id !== null && agentIdOf(d.recipient_id) === a.id;
  if (d.channel === 'a2a' || d.channel === 'none') return false;
  if (a.conversationId && d.conversation_id === a.conversationId) return true;
  if (a.senderId && d.recipient_id && d.channel === a.channel && addressesMatch(a.senderId, d.recipient_id)) return true;
  if (!a.owner) return false;
  // Asked from off the dashboard, he is owed a send on one of his own outside channels; a dashboard line does not reach him.
  if (d.channel === 'dashboard' || d.channel === 'voice') return a.channel === null || a.channel === 'dashboard' || a.channel === 'voice';
  return !!d.recipient_id && isOwnerOn(d.channel, d.recipient_id);
}

/** Does a send to these agents (ids or names) reach the asker? Every recipient must be the asker. */
export function sendReachesAsker(taskId: string, recipients: readonly string[]): boolean {
  const a = askerOf(taskId);
  return a.kind === 'agent' && a.id !== null && recipients.length > 0 && recipients.every((r) => agentIdOf(r) === a.id);
}
