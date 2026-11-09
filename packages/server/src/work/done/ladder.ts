// THE LADDER WHEN WORK STALLS: four engine steps, each derived from the row's own records, taken by one
// sweep (`runLadder`, the scheduler's `ladder` clock). Clocks are the worker's patience bound.
//   1. A Working task with no progress for one bound: one hint to its worker.
//   2. Still nothing one bound after the hint, or a third refused hand-in: the PM's next report names it.
//      A hand-in the PM still decides is put before it again one bound after its last review.
//   3. A hand-in the PM did not decide after two reviews, or a task sent back three times: the main agent
//      is woken to decide another agent's task.
//   4. The owner's card, never a text: for the main agent's own task, for a decision the main agent let
//      sit one more bound, or a Working task one bound past step 2. No sooner than 15 minutes after the
//      hand-in, at most once per task per day.
// Left alone: an owner-paused task (its clock restarts when the pause lifts), a row whose worker no
// longer exists, a Working row already idle 14 days when this box first ran the ladder, and a worker
// (or main agent) in a live turn, which gets its step on a later sweep. A blocked hold is a stall.
import { DORMANT_MS } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { getPrimaryAgentId, getPMAgentId } from '../../config/platform.js';
import { taskScope, msToUtcText } from '../tracker-view.js';
import { taskMovedAtSql, stallSinceSql, LADDER_ANCHOR_SQL, jobCarriedIds } from '../task-freshness.js';
import { appendAuditEntry, AUDIT_KIND } from '../audit-trail.js';
import { recordValidationEscalation } from '../tracker-store.js';
import { heldExpr } from './hold.js';
import { latestHandIn, workerOf } from './record.js';
import { whoDecides, sendBacks, REVIEW_MISS_ENTRY, SEND_BACKS_BEFORE_ESCALATION } from './who-decides.js';
import { agentIsLive } from '../../tracker/liveness.js';
import { patienceBoundMs } from '../../tracker/assignee-patience.js';
import { stallKey, tellOwnerOncePerWindow, wordsOf } from '../../healer/owner-notices.js';

const logger = createLogger('ladder');

export const LADDER_ENTRY = { hint: 'ladder_hint', pm: 'ladder_pm', decider: 'ladder_decider' } as const;
const OWNER_ASK = 'validation_escalated';
const OWNER_FLOOR_MS = 15 * 60_000;
const DAY_MS = 24 * 3_600_000;
const REFUSALS_BEFORE_PM = 3;

/** Every engine hint the ladder sends, in one table. */
export const LADDER_HINT = {
  stalled: (t: string, since: string) => `"${t}" has not moved since ${since}. If you are still on it, take the next step now. If it is finished, hand it in with work_update(action="hand_in") and its proof; if it cannot be done, hand it in as can't be done with the proof of why.`,
  blocked: (t: string, since: string, reason: string) => `"${t}" has been held blocked since ${since}: ${reason}. If that will not change, hand it in as can't be done with the proof of why; once it clears, lift the hold and go on.`,
  undelivered: (t: string) => `a run of "${t}" ended and nothing reached the person it was for. If the message still matters, send it now.`,
  decide: (t: string, worker: string, why: string) => `"${t}" was handed in by ${worker} and is yours to decide: ${why}. Open its proof with work_validate(action="open_proof", task_id, item=N), then work_validate(action="decide", task_id, verdict="approve" or "send_back", reason="<one line>").`,
  sentBack: (t: string, reasons: string[]) => `"${t}" has been sent back ${reasons.length} times and is yours to decide when it is handed in again. The reasons so far: ${reasons.map((r, i) => `(${i + 1}) ${r}`).join(' ')}`,
} as const;

type LadderAction = 'hint' | 'pm' | 'decider' | 'owner';
interface LadderStep { reached: 0 | 1 | 2 | 3 | 4; due: LadderAction | null }

interface Ev { id: number; kind: string; entry: string | null; at: number }

function eventsOf(workId: string): Ev[] {
  return getDb().prepare(
    `SELECT id, kind, json_extract(payload, '$.entry_kind') AS entry, created_at AS at FROM work_events
      WHERE work_id = ? AND (kind IN ('handed_in', 'decided', 'hand_in_refused', '${OWNER_ASK}')
        OR (kind = '${AUDIT_KIND}' AND json_extract(payload, '$.entry_kind') IN (?, ?, ?, ?))) ORDER BY id`,
  ).all(workId, LADDER_ENTRY.hint, LADDER_ENTRY.pm, LADDER_ENTRY.decider, REVIEW_MISS_ENTRY) as Ev[];
}

const newest = (evs: Ev[], test: (e: Ev) => boolean, since = 0): Ev | undefined => [...evs].reverse().find((e) => e.at >= since && test(e));
const isEntry = (entry: string) => (e: Ev): boolean => e.entry === entry;
const isKind = (kind: string) => (e: Ev): boolean => e.kind === kind;

/** Where the row stands on the ladder and the step now due, from its own records. */
function ladderStep(workId: string, now: number): LadderStep {
  const row = getDb().prepare(`SELECT w.state, w.updated_at, ${stallSinceSql('w')} AS since FROM work w WHERE w.id = ?`).get(workId) as { state: string; updated_at: number; since: number } | undefined;
  if (!row || !['claimed', 'sent_back', 'handed_in'].includes(row.state)) return { reached: 0, due: null };
  const evs = eventsOf(workId);
  const asked = (since: number): boolean => !!newest(evs, isKind(OWNER_ASK), Math.min(since, now - DAY_MS));   // one owner card a day
  const decider = whoDecides(workId);
  if (row.state === 'handed_in') {
    const handAt = newest(evs, isKind('handed_in'))?.at ?? row.updated_at;
    const old = now - handAt >= OWNER_FLOOR_MS;
    if (decider?.kind === 'owner') return asked(handAt) ? { reached: 4, due: null } : { reached: 3, due: old ? 'owner' : null };
    if (decider?.agentId === getPMAgentId()) {
      const last = Math.max(handAt, newest(evs, isEntry(REVIEW_MISS_ENTRY), handAt)?.at ?? 0);
      return { reached: 2, due: now - last >= patienceBoundMs(decider.agentId) ? 'pm' : null };
    }
    const told = newest(evs, isEntry(LADDER_ENTRY.decider), handAt);
    if (!told) return { reached: 2, due: 'decider' };
    if (asked(handAt)) return { reached: 4, due: null };
    return { reached: 3, due: old && now - told.at >= patienceBoundMs(getPrimaryAgentId()) ? 'owner' : null };
  }
  const backs = sendBacks(workId);
  if (backs.length >= SEND_BACKS_BEFORE_ESCALATION) {
    const third = backs[SEND_BACKS_BEFORE_ESCALATION - 1].at;
    const handAt = newest(evs, isKind('handed_in'))?.at ?? third;
    if (!newest(evs, isEntry(LADDER_ENTRY.decider), third) && !asked(third)) {
      if (decider?.kind !== 'owner') return { reached: 2, due: 'decider' };
      return { reached: 3, due: now - handAt >= OWNER_FLOOR_MS ? 'owner' : null };
    }
  }
  const lastTurnIn = newest(evs, (e) => e.kind === 'handed_in' || e.kind === 'decided')?.at ?? 0;
  const refusals = evs.filter((e) => e.kind === 'hand_in_refused' && e.at >= lastTurnIn);
  if (refusals.length >= REFUSALS_BEFORE_PM && !newest(evs, isEntry(LADDER_ENTRY.pm), refusals[REFUSALS_BEFORE_PM - 1].at)) return { reached: 1, due: 'pm' };
  const since = row.since;
  const bound = patienceBoundMs(workerOf(workId));
  const hint = newest(evs, isEntry(LADDER_ENTRY.hint), since);
  const pm = newest(evs, isEntry(LADDER_ENTRY.pm), since);
  if (asked(since)) return { reached: 4, due: null };
  if (pm) return { reached: 2, due: now - pm.at >= bound && now - since >= OWNER_FLOOR_MS ? 'owner' : null };
  if (hint) return { reached: 1, due: now - hint.at >= bound ? 'pm' : null };
  return { reached: 0, due: now - since >= bound ? 'hint' : null };
}

/** The rows the ladder looks at: board tasks Working or handed in, minus the ones it leaves alone. */
function candidates(now: number): string[] {
  return (getDb().prepare(
    `SELECT w.id FROM work w JOIN agents a ON a.id = COALESCE(w.assignee_agent, w.agent_id) AND a.status != 'terminated'
      WHERE ${taskScope('w')} AND w.state IN ('claimed', 'sent_back', 'handed_in')
        AND NOT ${heldExpr('w', 'paused')} AND w.is_paused = 0 AND (w.scheduled_start IS NULL OR w.scheduled_start <= ?)
        AND (w.state = 'handed_in' OR ${taskMovedAtSql('w')} >= ${LADDER_ANCHOR_SQL} - ?)`,
  ).all(now, DORMANT_MS) as Array<{ id: string }>).map((r) => r.id);
}

const busy = (agentId: string, workId: string): boolean => agentIsLive(agentId) || jobCarriedIds(agentId).includes(workId);

/** One engine hint to `agentId`, as an events-lane re-drive that owes no reply, recorded on the row so it
 *  is never sent twice for the same step. `key` names a hint that is not a stall step (one per key). */
export async function hintOnce(workId: string, agentId: string, text: string, key?: string): Promise<boolean> {
  if (key && getDb().prepare(`SELECT 1 FROM work_events WHERE work_id = ? AND kind = '${AUDIT_KIND}' AND json_extract(payload, '$.entry_kind') = ? AND json_extract(payload, '$.action_taken') = ?`).get(workId, LADDER_ENTRY.hint, key)) return false;
  const { redriveWithoutReply } = await import('../../agent/agent-notice.js');
  const mine = agentId === workerOf(workId);
  const sent = await redriveWithoutReply({ toAgentId: agentId, fromAgentId: null, content: `[Engine hint: ${text} [${workId}]]`, taskId: mine ? workId : null });
  if (sent) appendAuditEntry(workId, 'engine', { entryKind: mine ? LADDER_ENTRY.hint : LADDER_ENTRY.decider, actionTaken: key ?? null, reason: text });
  return sent;
}

/** Step 4: the owner's card (once a day per task), and the ask on record his own words decide by. */
function tellOwner(workId: string): void {
  const key = stallKey(workId);
  if (!tellOwnerOncePerWindow(key, wordsOf(key), DAY_MS)) return;
  recordValidationEscalation(workId, 'engine', null);
}

async function take(workId: string, due: LadderAction): Promise<void> {
  const row = getDb().prepare(`SELECT w.title, w.state, w.hold_kind, w.hold_reason, ${taskMovedAtSql('w')} AS moved FROM work w WHERE w.id = ?`).get(workId) as
    { title: string | null; state: string; hold_kind: string | null; hold_reason: string | null; moved: number };
  const title = row.title ?? workId, worker = workerOf(workId);
  if (due === 'owner') { tellOwner(workId); return; }
  if (due === 'pm') {
    if (row.state !== 'handed_in') appendAuditEntry(workId, 'engine', { entryKind: LADDER_ENTRY.pm, reason: 'no progress past the patience bound after a hint' });
    (await import('../../tracker/pm-agent.js')).armDebouncedReview(workId, 'ladder');
    return;
  }
  if (due === 'hint') {
    if (busy(worker, workId)) return;
    const since = msToUtcText(row.moved);
    await hintOnce(workId, worker, row.hold_kind === 'blocked' ? LADDER_HINT.blocked(title, since, row.hold_reason ?? '') : LADDER_HINT.stalled(title, since));
    return;
  }
  const main = getPrimaryAgentId();
  if (busy(main, workId)) return;
  const reasons = sendBacks(workId).map((b) => b.reason);
  await hintOnce(workId, main, row.state === 'handed_in'
    ? LADDER_HINT.decide(title, latestHandIn(workId)?.filedBy ?? worker, reasons.length >= SEND_BACKS_BEFORE_ESCALATION ? `it has been sent back ${reasons.length} times (${reasons.join('; ')})` : 'the project manager gave no verdict after two reviews')
    : LADDER_HINT.sentBack(title, reasons));
}

/** THE SWEEP: per row, exactly one step or nothing. */
export async function runLadder(now = Date.now()): Promise<void> {
  for (const id of candidates(now)) {
    try {
      const { due } = ladderStep(id, now);
      if (due) await take(id, due);
    } catch (err) {
      logger.warn('ladder: one row could not be judged', { workId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

