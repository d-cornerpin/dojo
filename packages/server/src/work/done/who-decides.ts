// WHO DECIDES a handed-in task: the PM, until two verdictless reviews or three send-backs; then the main agent
// (another agent's task) or the owner (the main agent's own). A task the PM worked starts with the main agent.
// Never a worker of the task (`workersOf`): then the owner. An open PM question about the hand-in holds it (`pmQuestions`).
import { a2aThreadTokenMatchesSql } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { getPMAgentId, getPrimaryAgentId } from '../../config/platform.js';
import { turnContext } from '../../agent/turn-context.js';
import { firstReplySince } from '../../memory/message-store.js';
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

/** The PM's questions tied to this row since its newest hand-in (or ever), oldest first. Each holds the hand-in until its answer;
 *  else one patience bound after the asked agent's next finished turn (of its newest 20); else `QUEUED_TURN_BOUND_MS`. */
export function pmQuestions(workId: string, everAsked = false): Array<{ at: number; thread: string; asked: string; text: string; answeredAt: number | null; until: number }> {
  const pm = getPMAgentId();
  return (getDb().prepare(
    `SELECT unixepoch(r.created_at) * 1000 AS at, r.thread_id AS thread, COALESCE(r.sent_text, '') AS text, COALESCE((SELECT id FROM agents WHERE id = r.recipient),
       (SELECT id FROM agents WHERE lower(name) = lower(r.recipient) ORDER BY created_at DESC LIMIT 1), r.recipient) AS asked
       FROM tool_receipts r WHERE r.task_id = ? AND r.agent_id = ? AND r.thread_id IS NOT NULL AND json_extract(r.detail, '$.intent') IN ('QUESTION', 'BLOCK')
        AND (? OR unixepoch(r.created_at) >= (SELECT COALESCE(MAX(created_at), 0) FROM work_events WHERE work_id = r.task_id AND kind = 'handed_in') / 1000) ORDER BY r.rowid`,
  ).all(workId, pm, everAsked ? 1 : 0) as Array<{ at: number; thread: string; text: string; asked: string }>).map((q) => {
    const answeredAt = firstReplySince(pm, q.asked, q.thread, q.at);
    const ended = answeredAt ?? (getDb().prepare('SELECT MIN(t) AS t FROM (SELECT unixepoch(ended_at) * 1000 AS t FROM turns WHERE agent_id = ? ORDER BY turn_number DESC LIMIT 20) WHERE t >= ?')
      .get(q.asked, q.at) as { t: number | null }).t;
    return { ...q, answeredAt, until: answeredAt ?? (ended !== null ? ended + patienceBoundMs(q.asked) : q.at + QUEUED_TURN_BOUND_MS) };
  });
}

/** Until when the PM's questions hold this hand-in (0 when it asked none); it holds while this is in the future. */
export const questionsHoldUntil = (workId: string): number => Math.max(0, ...pmQuestions(workId).map((q) => q.until));

/** The decider for this row now; null when there is no such row. */
export function whoDecides(workId: string): Decider | null {
  if (!workerOf(workId)) return null;
  const worked = workersOf(workId);
  const pm = getPMAgentId();
  const pmStill = (pmMissesSinceHandIn(workId) < PM_ASKS_BEFORE_ESCALATION || questionsHoldUntil(workId) > Date.now())
    && sendBacks(workId).length < SEND_BACKS_BEFORE_ESCALATION;
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
