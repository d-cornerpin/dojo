// ════════════════════════════════════════════════════════════════════════════════════════
// t173 — WHAT A JOB'S CONTINUATION IS A CONTINUATION OF.
//
// A park hands the running job to a trigger-less continuation turn (`work/job-continuation.ts`). That
// turn is woken by nothing, so it used to record no kind, subject `none` and no root, and the request
// the job started from was served to it by nobody: the served message (`memory/served-ask.ts`) belongs
// to a turn whose own kind is a2a or owner. Its view could empty (run 10, S1).
//
// THE ORIGIN IS READ FROM THE JOB'S TASK, NOT FROM THE TURN BEFORE. The turn that parked is not always
// the job's own turn (in the measured case it was an engine notice about the task), and a chain of
// continuations (park, park, park) has no turn record that names the request. The job's task does:
// t143's job record already carries its ids across every park (`task-freshness.ts`), and the task row
// holds where it came from. In order, for the oldest task of the job that names one:
//   * `a2a_thread_id`: the task the engine opens for an ASSIGN, tied to the thread;
//   * `source_message_id`: the message the task answers. An A2A message names a thread; a person's
//     message is an owner ask;
//   * `origin_turn`: a task the agent opened itself, on a turn whose rows are stamped with its thread.
// Only the run launched from the park's own wake carries the job (`runCarriesJob`), so any other
// trigger-less run resolves nothing and is unchanged. A job with no task and no served ask is not a
// job (t143): nothing was carried, there is no origin to find.
// ════════════════════════════════════════════════════════════════════════════════════════

import { A2A_THREAD_SHORT_LENGTH } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { jobCarriedIds, runCarriesJob } from './task-freshness.js';

/** The request a job started from. */
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

/** Where the job this run is carrying started; `null` when the run carries no job or its tasks name no origin. Never throws. */
export function jobOrigin(agentId: string): JobOrigin | null {
  try {
    if (!runCarriesJob(agentId)) return null;
    const ids = jobCarriedIds(agentId);
    if (ids.length === 0) return null;
    const db = getDb();
    const tasks = db.prepare(
      `SELECT a2a_thread_id, source_message_id, origin_turn FROM work WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY opened_at ASC`,
    ).all(...ids) as TaskOrigin[];
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

/** The A2A origin of the job this run carries, for the turn classifier: a trigger-less continuation whose job began on an A2A
 *  thread is the turn of that thread's request. It is deliberately NOT a reply-needed turn (the classifier leaves
 *  `a2aReplyContext` null: the missed-reply enforcer is for the turn that answers the request, and the job's reply is owed
 *  when the job ends), and it is not counted as a dedicated A2A attempt (`lastTurnWasA2A` is the wake turn's). A job that
 *  began with a person's ask keeps its owner framing (the human continuation restores it); only its request is served
 *  (`servedOwnerMessageIds`). Its fields are the counterparty identity (`intent`, `threadShort`, `fromName`) as well. */
export function a2aJobOrigin(agentId: string): Extract<JobOrigin, { kind: 'a2a' }> | null {
  const origin = jobOrigin(agentId);
  return origin?.kind === 'a2a' ? origin : null;
}
