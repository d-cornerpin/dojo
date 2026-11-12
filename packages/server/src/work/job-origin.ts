// A job's continuation continues the request the job started from: `parkOrigin` reads it at the park and it
// rides the job record (`task-freshness.ts`). Only the run launched from the park's own wake carries the job
// (`runCarriesJob`); any other trigger-less run is unchanged.

import { A2A_THREAD_SHORT_LENGTH } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { runCarriesJob, jobCarriedOrigin } from './task-freshness.js';
import { turnContext } from '../agent/turn-context.js';
import { taskScope } from './tracker-view.js';
import { workingExpr } from './done/hold.js';

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
function originOfTasks(agentId: string, ids: string[]): JobOrigin | null {
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

const sameOrigin = (a: JobOrigin, b: JobOrigin): boolean =>
  a.kind === b.kind && (a.kind === 'a2a' ? a.threadId === (b as typeof a).threadId : a.messageId === (b as typeof a).messageId);

/**
 * THE PARK'S READ (`parkJob`): where the job being parked started. A turn that serves a PERSON hands on that
 * person's ask (`served`); else the work the turn names (`named`); else, for a turn with no person subject, the
 * origin its claimed tasks agree on. That last read is for the ORIGIN only: carrying those tasks as the job's
 * work would hide an abandoned one from the PM and the close-out gate.
 */
export function parkOrigin(agentId: string, named: string[], served: string[]): JobOrigin | null {
  try {
    const bag = turnContext(agentId);
    if (bag?.root?.kind === 'ask' || bag?.conversationId || bag?.convKey) {
      return served.length > 0 ? { kind: 'ask', messageId: served[0] } : null;
    }
    const fromNamed = originOfTasks(agentId, named);
    if (fromNamed) return fromNamed;
    const held = getDb().prepare(
      `SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w')}`,
    ).all(agentId) as Array<{ id: string }>;
    const origins = held.map((h) => originOfTasks(agentId, [h.id])).filter((o): o is JobOrigin => o !== null);
    return origins.length > 0 && origins.every((o) => sameOrigin(o, origins[0])) ? origins[0] : null;
  } catch {
    return null;
  }
}

export function jobOrigin(agentId: string): JobOrigin | null {
  return runCarriesJob(agentId) ? jobCarriedOrigin(agentId) : null;
}

/** The A2A origin of the job this run carries, for the turn classifier. Deliberately NOT a reply-needed turn
 *  (`a2aReplyContext` stays null: the job's reply is owed when the job ends) and not a dedicated A2A attempt.
 *  A job that began with a person's ask keeps its owner framing; only its request is served. */
export function a2aJobOrigin(agentId: string): Extract<JobOrigin, { kind: 'a2a' }> | null {
  const origin = jobOrigin(agentId);
  return origin?.kind === 'a2a' ? origin : null;
}
