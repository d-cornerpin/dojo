// WHO DECIDES a handed-in task: the PM, until two verdictless reviews or three send-backs; then the main agent
// (another agent's task) or the owner (the main agent's own). A task the PM worked starts with the main agent.
// Never a worker of the task (`workersOf`): then the owner. An open PM question keeps a hand-in out of the PM's
// reviews, so none counts against it (`pmQuestions`): it delays the escalation and never reverses one.
import { REPLY_NEEDED_INTENTS, a2aThreadTokenMatchesSql } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { getPMAgentId, getPrimaryAgentId } from '../../config/platform.js';
import { turnContext } from '../../agent/turn-context.js';
import { repliesSince, type ThreadReply } from '../../memory/message-store.js';
import { AUDIT_KIND } from '../audit-trail.js';
import { taskScope } from '../tracker-view.js';
import { workingExpr } from '../terminal-states.js';
import { latestHandIn, workerOf, workersOf } from './record.js';

export type Decider = { kind: 'agent'; agentId: string } | { kind: 'owner' };

const PM_ASKS_BEFORE_ESCALATION = 2;
export const SEND_BACKS_BEFORE_ESCALATION = 3;
export const REVIEW_MISS_ENTRY = 'review_miss';
/** The wait for an agent's turn that never runs: a queued review, or the turn that answers a question. */
export const QUEUED_TURN_BOUND_MS = 30 * 60_000;

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
  /** The recipient as the model typed it. */
  typed: string;
  text: string;
  /** The replies on its thread from its sending until the next question on that thread. */
  answers: ThreadReply[];
  /** It holds its hand-in until its first answer, or `QUEUED_TURN_BOUND_MS` after it was asked. */
  until: number;
}

/** The PM's questions tied to this row, oldest first; the answers are read from each question's own thread. */
export function pmQuestions(workId: string): PMQuestion[] {
  const pm = getPMAgentId();
  const rows = getDb().prepare(`
    SELECT unixepoch(created_at) * 1000 AS at,
           thread_id AS thread,
           COALESCE(recipient, '') AS typed,
           COALESCE(sent_text, '') AS text,
           COALESCE(json_extract(detail, '$.intent'), '') AS intent
      FROM tool_receipts
     WHERE task_id = ? AND agent_id = ? AND thread_id IS NOT NULL
     ORDER BY created_at, rowid
  `).all(workId, pm) as Array<Omit<PMQuestion, 'answers' | 'until'> & { intent: string }>;
  const asks = rows.filter((q) => REPLY_NEEDED_INTENTS.has(q.intent));
  return asks.map(({ intent: _intent, ...q }) => {
    const next = asks.find((o) => o.thread === q.thread && o.at > q.at)?.at ?? Infinity;
    const answers = repliesSince(pm, q.thread, q.at).filter((a) => a.at < next);
    return { ...q, answers, until: answers[0]?.at ?? q.at + QUEUED_TURN_BOUND_MS };
  });
}

/** The questions that hold this hand-in: those asked within `QUEUED_TURN_BOUND_MS` of its reaching the PM, so a
 *  PM that keeps asking still lets it escalate within twice that bound. */
export function holdingQuestions(workId: string): PMQuestion[] {
  const handAt = Math.floor((latestHandIn(workId)?.at ?? 0) / 1000) * 1000;   // receipts are stamped to the second
  return pmQuestions(workId).filter((q) => q.at >= handAt && q.at < handAt + QUEUED_TURN_BOUND_MS);
}

/** The request a card was opened for (by its message, or by its piece's id, which keeps its first thread through a
 *  hand-off; the newest), of the card's requester (`owed`: an answer is coming, not stood down), its message `root`, its answer. */
export const requestOf = (id: string) => getDb().prepare(`SELECT a.state IN ('open', 'claimed') OR (a.state = 'blocked' AND (a.remaining_children > 0
  OR a.compile_pending = 1)) AS owed, a.root_id AS root, d.id, d.recipient_display AS who, d.created_at AS at FROM work w JOIN work a ON a.kind = 'ask'
  AND (a.root_id = w.source_message_id OR EXISTS (SELECT 1 FROM work p WHERE p.id = 'piece:' || a.id || ':' || w.a2a_thread_id))
  AND a.agent_id = w.requester_id LEFT JOIN deliveries d ON d.id = a.result_delivery_id WHERE w.id = ? ORDER BY a.opened_at DESC LIMIT 1`)
  .get(id) as { owed: number; root: string; id: string | null; who: string | null; at: string | null } | undefined;
/** The working task another agent holds for `requesterId`'s request `messageId`, with its holder's name, or null. */
export function delegatedTaskOf(requesterId: string, messageId: string | null): { id: string; holder: string } | null {
  const held = messageId ? getDb().prepare(`SELECT w.id, COALESCE(g.name, w.agent_id) AS holder FROM work w LEFT JOIN agents g ON g.id = w.agent_id
    WHERE ${taskScope('w')} AND w.requester_id = ? AND w.agent_id <> w.requester_id AND ${workingExpr('w', true)}`).all(requesterId) as Array<{ id: string; holder: string }> : [];
  return held.find((t) => requestOf(t.id)?.root === messageId) ?? null;
}
/** Until when this hand-in is held (0 when nothing holds it): the PM's questions, or for good while its request is owed. */
export function questionsHoldUntil(workId: string): number {
  if (requestOf(workId)?.owed) return Infinity;
  return Math.max(0, ...holdingQuestions(workId).map((q) => q.until));
}

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
  const rows = getDb().prepare(
    `SELECT w.id FROM work w WHERE ${taskScope('w')} AND w.state = 'handed_in' ORDER BY w.updated_at`,
  ).all() as Array<{ id: string }>;
  return rows.map((r) => r.id).filter((id) => {
    const d = whoDecides(id);
    return d?.kind === 'agent' && d.agentId === agentId;
  });
}

/** The hand-in a send is about, from records only: the one its thread, or the thread the turn answers, is tied to;
 *  else, of the hand-ins the sender decides now, the only one, the one the recipient works, or the one it names. */
export function askedAbout(agentId: string, recipientId: string, payload: string, threadId: string): string | null {
  const tied = tiedTask(agentId, threadId) ?? tiedTask(agentId, answeredThread(agentId));
  if (tied) return tied;
  const mine = decidedBy(agentId);
  if (mine.length === 1) return mine[0];
  return mine.find((id) => workersOf(id).has(recipientId))
    ?? mine.find((id) => payload.includes(id.slice(0, 8)))
    ?? null;
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
