// THE LADDER WHEN WORK STALLS: four engine steps, each derived from the row's own records, taken by one
// sweep (`runLadder`, the scheduler's `ladder` clock). Clocks are the worker's patience bound.
//   1. A Working task with no progress for one bound: one hint to its worker.
//   2. Still nothing one bound after the hint, or a third refused hand-in: the PM's next report names it.
//      A hand-in the PM still decides is put before it again one bound after its last review.
//   3. A hand-in the PM did not decide after two reviews, or a task sent back three times: the main agent
//      is woken to decide another agent's task.
//   4. The owner's card, never a text: for the main agent's own task, for a decision the main agent let
//      sit one more bound, or a Working task one bound past step 2. No sooner than 15 minutes after the
//      hand-in nor in the first hour after the upgrade, at most once per task per day.
// Bounds on the wakes: none to an agent a person is waiting on (`selfWakeStandDown`) or in a live turn, one per
// agent per sweep naming all its due rows, and at most 3 box-wide per 10 minutes; the rest wait for a later sweep.
// Left alone: a pause the owner set or one with a future end (its clock restarts when it lifts), a hold already
// on the row at the upgrade (until the row moves), a Working row whose worker no longer exists, and a Working
// row already idle 14 days when this box first ran the ladder. Every other hold is a stall.
import { DORMANT_MS } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { getPrimaryAgentId, getPMAgentId } from '../../config/platform.js';
import { taskScope, msToUtcText } from '../tracker-view.js';
import { taskMovedAtSql, stallSinceSql, LADDER_ANCHOR_SQL, jobCarriedIds } from '../task-freshness.js';
import { appendAuditEntry, AUDIT_KIND } from '../audit-trail.js';
import { recordValidationEscalation } from '../tracker-store.js';
import { heldExpr, WORKING_STATES } from './hold.js';
import { latestHandIn, workerOf, OWNER_ID } from './record.js';
import { whoDecides, sendBacks, REVIEW_MISS_ENTRY, SEND_BACKS_BEFORE_ESCALATION } from './who-decides.js';
import { agentIsLive } from '../../tracker/liveness.js';
import { patienceBoundMs } from '../../tracker/assignee-patience.js';
import { stallKey, tellOwnerOncePerWindow, wordsOf } from '../../healer/owner-notices.js';
import { selfWakeStandDown } from '../work-reaper.js';

const logger = createLogger('ladder');

export const LADDER_ENTRY = { hint: 'ladder_hint', pm: 'ladder_pm', decider: 'ladder_decider' } as const;
const OWNER_ASK = 'validation_escalated';
const OWNER_FLOOR_MS = 15 * 60_000;
const DAY_MS = 24 * 3_600_000;
const UPGRADE_QUIET_MS = 3_600_000;
const REFUSALS_BEFORE_PM = 3;
const WAKES_PER_WINDOW = 3;
const WAKE_WINDOW_MS = 10 * 60_000;
const LIVE = [...WORKING_STATES, 'handed_in'];

/** Every engine hint the ladder sends, in one table. */
export const LADDER_HINT = {
  stalled: (t: string, since: string) => `"${t}" has not moved since ${since}. If you are still on it, take the next step now. If it is finished, hand it in with work_update(action="hand_in") and its proof; if it cannot be done, hand it in as can't be done with the proof of why.`,
  held: (t: string, since: string, kind: string, reason: string) => `"${t}" has been held ${kind} since ${since}: ${reason}. If that will not change, hand it in as can't be done with the proof of why; once it clears, lift the hold and go on.`,
  undelivered: (t: string) => `a run of "${t}" ended and nothing reached the person it was for. If the message still matters, send it now.`,
  decide: (t: string, worker: string, why: string) => `"${t}" was handed in by ${worker} and is yours to decide: ${why}. Open its proof with work_validate(action="open_proof", task_id, item=N), then work_validate(action="decide", task_id, verdict="approve" or "send_back", reason="<one line>").`,
  sentBack: (t: string, reasons: string[]) => `"${t}" has been sent back ${reasons.length} times and is yours to decide when it is handed in again. The reasons so far: ${reasons.map((r, i) => `(${i + 1}) ${r}`).join(' ')}`,
} as const;

type LadderAction = 'hint' | 'pm' | 'decider' | 'owner';
interface LadderStep { reached: 0 | 1 | 2 | 3 | 4; due: LadderAction | null }
interface Due { id: string; due: LadderAction }

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
  const row = getDb().prepare(`SELECT w.state, w.updated_at, ${stallSinceSql('w')} AS since, ${LADDER_ANCHOR_SQL} AS anchor FROM work w WHERE w.id = ?`)
    .get(workId) as { state: string; updated_at: number; since: number; anchor: number } | undefined;
  if (!row || !LIVE.includes(row.state)) return { reached: 0, due: null };
  const evs = eventsOf(workId);
  // `asked` ends the owner step for the stall or hand-in his card was raised for; the day window in `owner` serves a
  // task that moved or was handed in again after its card, so a new stall that day is not carded twice.
  const asked = (since: number): boolean => !!newest(evs, isKind(OWNER_ASK), since);
  const owner = (due: boolean): 'owner' | null =>
    (due && now - row.anchor >= UPGRADE_QUIET_MS && !newest(evs, isKind(OWNER_ASK), now - DAY_MS) ? 'owner' : null);
  const decider = whoDecides(workId);
  if (row.state === 'handed_in') {
    const handAt = newest(evs, isKind('handed_in'))?.at ?? row.updated_at;
    const old = now - handAt >= OWNER_FLOOR_MS;
    if (decider?.kind === 'owner') return asked(handAt) ? { reached: 4, due: null } : { reached: 3, due: owner(old) };
    if (decider?.agentId === getPMAgentId()) {
      const last = Math.max(handAt, newest(evs, isEntry(REVIEW_MISS_ENTRY), handAt)?.at ?? 0);
      return { reached: 2, due: now - last >= patienceBoundMs(decider.agentId) ? 'pm' : null };
    }
    const told = newest(evs, isEntry(LADDER_ENTRY.decider), handAt);
    if (!told) return { reached: 2, due: 'decider' };
    if (asked(handAt)) return { reached: 4, due: null };
    return { reached: 3, due: owner(old && now - told.at >= patienceBoundMs(getPrimaryAgentId())) };
  }
  const backs = sendBacks(workId);
  if (backs.length >= SEND_BACKS_BEFORE_ESCALATION) {
    const third = backs[SEND_BACKS_BEFORE_ESCALATION - 1].at;
    const handAt = newest(evs, isKind('handed_in'))?.at ?? third;
    if (!newest(evs, isEntry(LADDER_ENTRY.decider), third) && !asked(third)) {
      if (decider?.kind !== 'owner') return { reached: 2, due: 'decider' };
      return { reached: 3, due: owner(now - handAt >= OWNER_FLOOR_MS) };
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
  if (pm) return { reached: 2, due: owner(now - pm.at >= bound && now - since >= OWNER_FLOOR_MS) };
  if (hint) return { reached: 1, due: now - hint.at >= bound ? 'pm' : null };
  return { reached: 0, due: now - since >= bound ? 'hint' : null };
}

/** The rows the ladder looks at: board tasks Working or handed in, minus the ones it leaves alone. */
function candidates(now: number): string[] {
  const holdSetBy = `(SELECT e.actor FROM work_events e WHERE e.work_id = w.id AND e.kind = '${AUDIT_KIND}'
    AND json_extract(e.payload, '$.entry_kind') = 'hold_set' ORDER BY e.id DESC LIMIT 1)`;
  return (getDb().prepare(
    `SELECT w.id FROM work w LEFT JOIN agents a ON a.id = COALESCE(w.assignee_agent, w.agent_id)
      WHERE ${taskScope('w')} AND w.state IN (${LIVE.map((st) => `'${st}'`).join(', ')}) AND (w.state = 'handed_in' OR a.status != 'terminated')
        AND NOT (${heldExpr('w', 'paused')} AND (COALESCE(w.paused_until, 0) > ? OR ${holdSetBy} IN ('owner', '${OWNER_ID}')))
        AND COALESCE(w.hold_at >= ${LADDER_ANCHOR_SQL}, 1)
        AND w.is_paused = 0 AND (w.scheduled_start IS NULL OR w.scheduled_start <= ?)
        AND (w.state = 'handed_in' OR ${taskMovedAtSql('w')} >= ${LADDER_ANCHOR_SQL} - ?)`,
  ).all(now, now, DORMANT_MS) as Array<{ id: string }>).map((r) => r.id);
}

/** Ladder wakes since `from`, box-wide: one per distinct text, as a hint naming several rows writes its text on each. */
const wakesSince = (from: number): number => (getDb().prepare(
  `SELECT COUNT(DISTINCT json_extract(e.payload, '$.reason')) AS n FROM work_events e
    WHERE e.work_id IN (SELECT w.id FROM work w WHERE ${taskScope('w')}) AND e.kind = '${AUDIT_KIND}' AND e.created_at >= ?
      AND json_extract(e.payload, '$.entry_kind') IN (?, ?, ?)`,
).get(from, LADDER_ENTRY.hint, LADDER_ENTRY.pm, LADDER_ENTRY.decider) as { n: number }).n;

/** One engine hint to `agentId` naming each row, as an events-lane re-drive that owes no reply, recorded on every
 *  row it names so it is never sent twice for the same step. `key` names a one-row hint that is not a stall step. */
export async function hintOnce(agentId: string, rows: Array<{ workId: string; text: string }>, key?: string): Promise<boolean> {
  if (key && getDb().prepare(`SELECT 1 FROM work_events WHERE work_id = ? AND kind = '${AUDIT_KIND}' AND json_extract(payload, '$.entry_kind') = ? AND json_extract(payload, '$.action_taken') = ?`).get(rows[0].workId, LADDER_ENTRY.hint, key)) return false;
  const { redriveWithoutReply } = await import('../../agent/agent-notice.js');
  const mine = (workId: string): boolean => agentId === workerOf(workId);
  const content = `[Engine hint: ${rows.map((r) => `${r.text} [${r.workId}]`).join(' ')}]`;
  const sent = await redriveWithoutReply({ toAgentId: agentId, fromAgentId: null, content, taskId: rows.find((r) => mine(r.workId))?.workId ?? null });
  if (sent) for (const r of rows) appendAuditEntry(r.workId, 'engine', { entryKind: mine(r.workId) ? LADDER_ENTRY.hint : LADDER_ENTRY.decider, actionTaken: key ?? null, reason: content });
  return sent;
}

/** Step 4: the owner's card (once a day per task), and the ask on record his own words decide by. */
function tellOwner(workId: string): void {
  const key = stallKey(workId);
  if (!tellOwnerOncePerWindow(key, wordsOf(key), DAY_MS)) return;
  recordValidationEscalation(workId, 'engine', null);
}

const rowOf = (workId: string) => getDb().prepare(`SELECT w.title, w.state, w.hold_kind, w.hold_reason, ${taskMovedAtSql('w')} AS moved FROM work w WHERE w.id = ?`)
  .get(workId) as { title: string | null; state: string; hold_kind: string | null; hold_reason: string | null; moved: number };

/** The words of a hint step (to the worker) or a decider step (to the main agent). */
function hintText({ id, due }: Due): string {
  const row = rowOf(id), title = row.title ?? id;
  if (due === 'hint') {
    const since = msToUtcText(row.moved);
    return row.hold_kind ? LADDER_HINT.held(title, since, row.hold_kind, row.hold_reason ?? '') : LADDER_HINT.stalled(title, since);
  }
  const reasons = sendBacks(id).map((b) => b.reason);
  return row.state === 'handed_in'
    ? LADDER_HINT.decide(title, latestHandIn(id)?.filedBy ?? workerOf(id), reasons.length >= SEND_BACKS_BEFORE_ESCALATION ? `it has been sent back ${reasons.length} times (${reasons.join('; ')})` : 'the project manager gave no verdict after two reviews')
    : LADDER_HINT.sentBack(title, reasons);
}

/** One wake of `agentId` for its due steps: the PM's next report, or one hint naming every row. False when not woken. */
async function wake(agentId: string, steps: Due[]): Promise<boolean> {
  if (selfWakeStandDown(agentId).standDown) return false;
  const pm = steps.filter((s) => s.due === 'pm');
  for (const s of pm) if (rowOf(s.id).state !== 'handed_in') appendAuditEntry(s.id, 'engine', { entryKind: LADDER_ENTRY.pm, reason: 'no progress past the patience bound after a hint' });
  if (pm.length > 0) (await import('../../tracker/pm-agent.js')).armDebouncedReview(pm[0].id, 'ladder');
  const hints = steps.filter((s) => s.due !== 'pm' && !jobCarriedIds(agentId).includes(s.id));
  if (hints.length === 0 || agentIsLive(agentId)) return pm.length > 0;
  return (await hintOnce(agentId, hints.map((s) => ({ workId: s.id, text: hintText(s) })))) || pm.length > 0;
}

/** THE SWEEP: per row, at most one step; the wakes are grouped by the agent they wake and bounded (header). */
export async function runLadder(now = Date.now()): Promise<void> {
  const byAgent = new Map<string, Due[]>();
  for (const id of candidates(now)) {
    try {
      const { due } = ladderStep(id, now);
      if (due === 'owner') tellOwner(id);
      else if (due) {
        const to = due === 'pm' ? getPMAgentId() : due === 'decider' ? getPrimaryAgentId() : workerOf(id);
        byAgent.set(to, [...(byAgent.get(to) ?? []), { id, due }]);
      }
    } catch (err) {
      logger.warn('ladder: one row could not be judged', { workId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  let room = WAKES_PER_WINDOW - wakesSince(now - WAKE_WINDOW_MS);
  for (const [agentId, steps] of byAgent) {
    if (room <= 0) return;
    try {
      if (await wake(agentId, steps)) room -= 1;
    } catch (err) {
      logger.warn('ladder: one agent could not be woken', { agentId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

