// ════════════════════════════════════════════════════════════════════════════════════════
// t173 / t173b — WHAT A JOB'S CONTINUATION IS A CONTINUATION OF.
//
// A park hands the running job to a trigger-less continuation turn (`work/job-continuation.ts`). That
// turn is woken by nothing, so it used to record no kind, subject `none` and no root, and the request
// the job started from was served to nobody: the served message (`memory/served-ask.ts`) belongs
// to a turn whose own kind is a2a or owner. Its view could empty (run 10, S1; run 11, S1 variant B).
//
// THE ORIGIN IS READ AT THE PARK, from the job's task, and rides the job record (`task-freshness.ts`)
// with the ids and asks, so it holds across a chain of parks and across a parking turn that was not the
// job's own (an engine notice, a retry on another thread). `parkJob` is the one door every park goes
// through, so it is the one place that reads it (`parkOrigin`). The tasks tried, in order:
//   1. the work the parking turn NAMES (`turnWorkIds`), in the order it names them;
//   2. else the task the agent is MOST RECENTLY working: its newest-moving claimed task. Run 11's
//      parking turn named none (the task was opened on an earlier turn, on another turn's thread), so
//      nothing was carried and no job existed at all. This is read for the ORIGIN only: it is never
//      carried as the job's work, because a park that shields every task the agent holds hides an
//      abandoned one from the PM and the close-out gate for a whole long job (t143 round 2).
// For each task, the first tie that names an origin:
//   * `a2a_thread_id`: the task the engine opens for an ASSIGN, tied to the thread;
//   * `source_message_id`: the message the task answers. An A2A message names a thread; a person's
//     message is an owner ask;
//   * `origin_turn`: a task the agent opened itself, on a turn whose rows are stamped with its thread.
// Only the run launched from the park's own wake carries the job (`runCarriesJob`), so any other
// trigger-less run resolves nothing and is unchanged.
// ════════════════════════════════════════════════════════════════════════════════════════

import { A2A_THREAD_SHORT_LENGTH } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { runCarriesJob, jobCarriedOrigin, taskMovedAtSql } from './task-freshness.js';
import { taskScope } from './tracker-view.js';

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

/** THE PARK'S READ (`parkJob`): where the job being parked started. `named`: the work the parking turn names. */
export function parkOrigin(agentId: string, named: string[]): JobOrigin | null {
  try {
    const fromNamed = originOfTasks(agentId, named);
    if (fromNamed) return fromNamed;
    const held = getDb().prepare(
      `SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed'
        ORDER BY ${taskMovedAtSql('w')} DESC LIMIT 1`,
    ).get(agentId) as { id: string } | undefined;
    return held ? originOfTasks(agentId, [held.id]) : null;
  } catch {
    return null;
  }
}

/** Where the job this run is carrying started; `null` when the run carries no job or the park found no origin. */
export function jobOrigin(agentId: string): JobOrigin | null {
  return runCarriesJob(agentId) ? jobCarriedOrigin(agentId) : null;
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
