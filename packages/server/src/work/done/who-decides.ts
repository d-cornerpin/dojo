// WHO DECIDES a handed-in task: the PM, until two verdictless reviews or three send-backs; then the main agent
// (another agent's task) or the owner (the main agent's own). A task the PM worked starts with the main agent.
// Never a worker of the task (`workersOf`): then the owner. An open PM question keeps a hand-in out of the PM's reviews,
// so none counts against it (`pmQuestions`); it delays the escalation and never reverses one.
import { REPLY_NEEDED_INTENTS, a2aThreadTokenMatchesSql } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { getPMAgentId, getPrimaryAgentId } from '../../config/platform.js';
import { turnContext } from '../../agent/turn-context.js';
import { repliesSince, type ThreadReply } from '../../memory/message-store.js';
import { patienceBoundMs } from '../../tracker/assignee-patience.js';
import { AUDIT_KIND } from '../audit-trail.js';
import { taskScope } from '../tracker-view.js';
import { workerOf, workersOf } from './record.js';

export type Decider = { kind: 'agent'; agentId: string } | { kind: 'owner' };

const PM_ASKS_BEFORE_ESCALATION = 2;
export const SEND_BACKS_BEFORE_ESCALATION = 3;
export const REVIEW_MISS_ENTRY = 'review_miss';
export const QUEUED_TURN_BOUND_MS = 30 * 60_000;   // the wait for an agent turn that never runs: a queued review, an answer

/** The PM's reviews of this row since its newest hand-in that gave no verdict. */
function pmMissesSinceHandIn(workId: string): number {
  return (getDb().prepare(
    `SELECT COUNT(*) AS n FROM work_events e
      WHERE e.work_id = ? AND e.kind = '${AUDIT_KIND}' AND json_extract(e.payload, '$.entry_kind') = '${REVIEW_MISS_ENTRY}'
        AND e.id > COALESCE((SELECT MAX(h.id) FROM work_events h WHERE h.work_id = e.work_id AND h.kind = 'handed_in'), 0)`,
  ).get(workId) as { n: number }).n;
}

/** Every send-back on this row, oldest first: its reason and when. */
export function sendBacks(workId: string): Array<{ reason: string; at: number }> {
  return (getDb().prepare(
    `SELECT COALESCE(json_extract(payload, '$.reason'), '') AS reason, created_at AS at FROM work_events
      WHERE work_id = ? AND kind = 'decided' AND json_extract(payload, '$.verdict') = 'send_back' ORDER BY id`,
  ).all(workId) as Array<{ reason: string; at: number }>);
}

export interface PMQuestion {
  at: number;
  thread: string;
  /** The recipient as the model typed it; `asked` is the agent the question was delivered to. */
  typed: string;
  asked: string | null;
  text: string;
  /** The replies on its thread from its sending until the next question on that thread. */
  answers: ThreadReply[];
  until: number;
}

/** The PM's questions tied to this row since its newest hand-in (or ever), oldest first. Who was asked and who
 *  answered are read from the thread itself, never from a name. */
export function pmQuestions(workId: string, everAsked = false): PMQuestion[] {
  const pm = getPMAgentId();
  const rows = getDb().prepare(`
    SELECT unixepoch(r.created_at) * 1000 AS at,
           r.thread_id AS thread,
           COALESCE(r.recipient, '') AS typed,
           COALESCE(r.sent_text, '') AS text,
           COALESCE(json_extract(r.detail, '$.intent'), '') AS intent,
           (SELECT d.agent_id FROM messages d
             WHERE d.a2a_thread_id = r.thread_id AND d.source_agent_id = r.agent_id AND d.agent_id <> r.agent_id
             ORDER BY d.seq LIMIT 1) AS asked
      FROM tool_receipts r
     WHERE r.task_id = ? AND r.agent_id = ? AND r.thread_id IS NOT NULL
       AND (? OR unixepoch(r.created_at) >= (
             SELECT COALESCE(MAX(created_at), 0) / 1000 FROM work_events WHERE work_id = r.task_id AND kind = 'handed_in'))
     ORDER BY r.created_at, r.rowid
  `).all(workId, pm, everAsked ? 1 : 0) as Array<Omit<PMQuestion, 'answers' | 'until'> & { intent: string }>;
  const asks = rows.filter((q) => REPLY_NEEDED_INTENTS.has(q.intent));
  return asks.map(({ intent: _intent, ...q }) => {
    const next = asks.find((o) => o.thread === q.thread && o.at > q.at)?.at ?? Infinity;
    const answers = repliesSince(pm, q.thread, q.at).filter((a) => a.at < next);
    return { ...q, answers, until: holdEnd(q.asked, q.at, answers[0]?.at ?? null) };
  });
}

/** The fixed end of a question's hold: its answer; else one patience bound after the asked agent's first turn that
 *  ended within `QUEUED_TURN_BOUND_MS` of it; else that bound. Never later than both together, and never moved. */
function holdEnd(asked: string | null, at: number, answeredAt: number | null): number {
  const latest = at + QUEUED_TURN_BOUND_MS + patienceBoundMs(asked);
  if (answeredAt !== null) return Math.min(answeredAt, latest);
  const ended = (getDb().prepare(`
    SELECT MIN(unixepoch(ended_at)) * 1000 AS t
      FROM turns
     WHERE agent_id = ? AND ended_at IS NOT NULL AND unixepoch(ended_at) * 1000 BETWEEN ? AND ?
  `).get(asked, at, at + QUEUED_TURN_BOUND_MS) as { t: number | null }).t;
  return ended === null ? at + QUEUED_TURN_BOUND_MS : ended + patienceBoundMs(asked);
}

/** Until when the PM's questions hold this hand-in (0 when it asked none); it holds while this is in the future. */
export const questionsHoldUntil = (workId: string): number => Math.max(0, ...pmQuestions(workId).map((q) => q.until));

/** The decider for this row now; null when there is no such row. */
export function whoDecides(workId: string): Decider | null {
  if (!workerOf(workId)) return null;
  const worked = workersOf(workId);
  const pm = getPMAgentId();
  const pmStill = pmMissesSinceHandIn(workId) < PM_ASKS_BEFORE_ESCALATION && sendBacks(workId).length < SEND_BACKS_BEFORE_ESCALATION;
  if (!worked.has(pm) && pmStill) return { kind: 'agent', agentId: pm };
  const main = getPrimaryAgentId();
  return worked.has(main) ? { kind: 'owner' } : { kind: 'agent', agentId: main };
}

/** The hand-ins `agentId` decides now, oldest first. */
export function decidedBy(agentId: string): string[] {
  const rows = getDb().prepare(`SELECT w.id FROM work w WHERE ${taskScope('w')} AND w.state = 'handed_in' ORDER BY w.updated_at`).all() as Array<{ id: string }>;
  return rows.map((r) => r.id).filter((id) => { const d = whoDecides(id); return d?.kind === 'agent' && d.agentId === agentId; });
}

/** The hand-in a send is about, from records only: the one its thread, or the thread the turn answers, is tied to;
 *  else, of the hand-ins the sender decides now, the only one, the one the recipient works, or the one it names. */
export function askedAbout(agentId: string, recipientId: string, payload: string, threadId: string): string | null {
  const tied = tiedTask(agentId, threadId) ?? tiedTask(agentId, answeredThread(agentId));
  if (tied) return tied;
  const mine = decidedBy(agentId);
  return mine.length === 1 ? mine[0] : mine.find((id) => workersOf(id).has(recipientId)) ?? mine.find((id) => payload.includes(id.slice(0, 8))) ?? null;
}

/** The thread the agent's live turn answers: the root's full id, else the address's short token. */
export function answeredThread(agentId: string): string | null {
  const ctx = turnContext(agentId);
  if (ctx?.root?.kind === 'a2a') return ctx.root.id;
  return ctx?.address?.kind === 'agent' ? ctx.address.threadId : null;
}

/** The task the newest send of `agentId` on `thread` (a full id or its short token) was tied to. */
export function tiedTask(agentId: string, thread: string | null): string | null {
  if (!thread) return null;
  const row = getDb().prepare(`
    SELECT task_id FROM tool_receipts
     WHERE task_id IS NOT NULL AND agent_id = ? AND (thread_id = ? OR ${a2aThreadTokenMatchesSql('thread_id')})
     ORDER BY created_at DESC LIMIT 1
  `).get(agentId, thread, thread, thread) as { task_id: string } | undefined;
  return row?.task_id ?? null;
}
