// Where a job started: read from its task row, so a parked job's turn continues the request it came from.

import { A2A_THREAD_SHORT_LENGTH } from '@dojo/shared';
import { getDb } from '../db/connection.js';

export type JobOrigin =
  | { kind: 'a2a'; threadId: string; threadShort: string; messageId: string | null; intent: string; fromName: string }
  | { kind: 'ask'; messageId: string };

interface TaskOrigin { a2a_thread_id: string | null; source_message_id: string | null; origin_turn: number | null }
interface MessageRow { id: string; role: string; a2a_thread_id: string | null; conversation_id: string | null; a2a_intent: string | null; source_agent_id: string | null }

const REPLY_NEEDED = ['ASSIGN', 'QUESTION', 'BLOCK'];

/** The thread's request: the message the task names when it is one, else the thread's newest reply-needed message to this agent. */
function a2aOrigin(agentId: string, threadId: string, named: MessageRow | undefined): JobOrigin {
  const db = getDb();
  const request = named?.a2a_thread_id === threadId && named.role === 'user' ? named
    : db.prepare(
      `SELECT id, role, a2a_thread_id, conversation_id, a2a_intent, source_agent_id FROM messages
        WHERE agent_id = ? AND role = 'user' AND lane <> 'events' AND a2a_thread_id = ?
          AND a2a_intent IN (${REPLY_NEEDED.map(() => '?').join(', ')})
        ORDER BY seq DESC LIMIT 1`,
    ).get(agentId, threadId, ...REPLY_NEEDED) as MessageRow | undefined;
  const sender = request?.source_agent_id
    ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(request.source_agent_id) as { name?: string } | undefined)?.name
    : undefined;
  return {
    kind: 'a2a', threadId, threadShort: threadId.slice(0, A2A_THREAD_SHORT_LENGTH), messageId: request?.id ?? null,
    intent: request?.a2a_intent ?? 'ASSIGN', fromName: sender ?? request?.source_agent_id ?? 'another agent',
  };
}

/** The origin of the first of `ids` (in the order given) whose task names one. Never throws. */
export function originOfTasks(agentId: string, ids: string[]): JobOrigin | null {
  if (ids.length === 0) return null;
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, a2a_thread_id, source_message_id, origin_turn FROM work WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ).all(...ids) as Array<TaskOrigin & { id: string }>;
    const tasks = ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is TaskOrigin & { id: string } => !!r);
    const message = db.prepare(
      'SELECT id, role, a2a_thread_id, conversation_id, a2a_intent, source_agent_id FROM messages WHERE id = ? AND agent_id = ?');
    const turnThread = db.prepare(
      `SELECT a2a_thread_id FROM messages WHERE agent_id = ? AND turn_number = ? AND a2a_thread_id IS NOT NULL
        ORDER BY seq ASC LIMIT 1`);
    for (const t of tasks) {
      const named = t.source_message_id ? message.get(t.source_message_id, agentId) as MessageRow | undefined : undefined;
      if (t.a2a_thread_id) return a2aOrigin(agentId, t.a2a_thread_id, named);
      if (named?.a2a_thread_id) return a2aOrigin(agentId, named.a2a_thread_id, named);
      if (named && named.role === 'user' && named.conversation_id) return { kind: 'ask', messageId: named.id };
      if (t.origin_turn != null) {
        const thread = (turnThread.get(agentId, t.origin_turn) as { a2a_thread_id: string } | undefined)?.a2a_thread_id;
        if (thread) return a2aOrigin(agentId, thread, undefined);
      }
    }
    return null;
  } catch {
    return null;
  }
}
