// THE LADDER WHEN WORK STALLS: four engine steps, each derived from the row's own records, taken by one
// sweep (`runLadder`, the scheduler's `ladder` clock). Clocks are the worker's patience bound.
//   1. A Working task, or an Open delegated one, with no progress for one bound: one hint to its worker.
//   2. Still nothing one bound after the hint, or a third refused hand-in: the PM's next report names it.
//      A hand-in the PM still decides is put before it again one bound after its last review, or after its
//      questions stop holding it.
//   3. A hand-in the PM did not decide after two reviews, or a task sent back three times: the main agent
//      is woken to decide another agent's task.
//   4. The owner's card, never a text: for the main agent's own task, for a decision the main agent let
//      sit one more bound, or a stalled task once a PM review that began after step 2 has ended (at once when
//      the PM cannot run). No sooner than 15 minutes after the stall nor in the first hour after the upgrade,
//      at most once per task per day. Steps 1 to 4 of a stall wait while its worker is busy (`workerBusy`).
// Bounds on the wakes: none to an agent a person is waiting on (`selfWakeStandDown`), one per
// agent per sweep naming all its due rows, and at most 3 box-wide per 10 minutes; the rest wait for a later sweep.
// Each wake marks one of its entries; the PM is not armed again until a PM turn finishes after its last arm.
// Left alone: a hold the owner set (its clock restarts when it lifts), a hold already on the row at the upgrade
// (until the row moves), a Working row whose worker no longer exists, and a Working row already idle 14 days when
// this box first ran the ladder. Every other hold, dated or not, is a stall.
import { DORMANT_MS } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { getPrimaryAgentId, getPMAgentId } from '../../config/platform.js';
import { taskScope, msToUtcText, heldByOwnerSql, holdWordsSql } from '../tracker-view.js';
import { taskMovedAtSql, stallSinceSql, cardedSinceStallSql, LADDER_ANCHOR_SQL } from '../task-freshness.js';
import { appendAuditEntry, AUDIT_KIND } from '../audit-trail.js';
import { recordValidationEscalation } from '../tracker-store.js';
import { WORKING_STATES } from './hold.js';
import { latestHandIn, workerOf } from './record.js';
import { whoDecides, sendBacks, questionsHoldUntil, REVIEW_MISS_ENTRY, SEND_BACKS_BEFORE_ESCALATION } from './who-decides.js';
import { workerBusy } from '../../tracker/liveness.js';
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
/** The mark one entry of each wake carries (in its evidence field, which the trail does not show). */
const WAKE = '{"wake":1}';
const SAID: Record<string, string> = { [LADDER_ENTRY.hint]: 'Reminded the worker.', [LADDER_ENTRY.pm]: 'Told the project manager.', [LADDER_ENTRY.decider]: 'Asked the main agent to decide.' };
const UNDELIVERED_SAID = 'Reminded the worker that this run\'s result was not delivered.';

/** Every engine hint the ladder sends, in one table. */
export const LADDER_HINT = {
  stalled: (t: string, since: string) => `"${t}" has not moved since ${since}. If you are still on it, take the next step now. If it is finished, hand it in with work_update(action="hand_in") and its proof; if it cannot be done, hand it in as can't be done with the proof of why.`,
  held: (t: string, since: string, hold: string) => `"${t}" has been held since ${since}: ${hold}. If that will not change, hand it in as can't be done with the proof of why; once it clears, lift the hold and go on.`,
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
  const row = getDb().prepare(`SELECT w.state, w.updated_at, w.a2a_thread_id AS thread, ${stallSinceSql('w')} AS since, ${cardedSinceStallSql('w')} AS carded,
      ${LADDER_ANCHOR_SQL} AS anchor FROM work w WHERE w.id = ?`).get(workId) as
    { state: string; updated_at: number; thread: string | null; since: number; carded: number; anchor: number } | undefined;
  if (!row || !(LIVE.includes(row.state) || (row.state === 'open' && row.thread))) return { reached: 0, due: null };
  const evs = eventsOf(workId);
  // `asked` ends the owner step for the hand-in his card was raised for (`carded`, for a stall); the day window in
  // `owner` serves a task that moved or was handed in again after its card, so a new stall that day is not carded twice.
  const asked = (since: number): boolean => !!newest(evs, isKind(OWNER_ASK), since);
  const owner = (due: boolean): 'owner' | null =>
    (due && now - row.anchor >= UPGRADE_QUIET_MS && !newest(evs, isKind(OWNER_ASK), now - DAY_MS) ? 'owner' : null);
  const decider = whoDecides(workId);
  if (row.state === 'handed_in') {
    const handAt = newest(evs, isKind('handed_in'))?.at ?? row.updated_at;
    const old = now - handAt >= OWNER_FLOOR_MS;
    if (decider?.kind === 'owner') return asked(handAt) ? { reached: 4, due: null } : { reached: 3, due: owner(old) };
    if (decider?.agentId === getPMAgentId()) {
      const lastMark = newest(evs, (e) => e.entry === REVIEW_MISS_ENTRY || e.entry === LADDER_ENTRY.pm, handAt)?.at ?? 0;
      const last = Math.max(handAt, lastMark, questionsHoldUntil(workId));
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
  if (workerBusy(workerOf(workId), { taskId: workId, threadId: row.thread })) return { reached: 0, due: null };
  const since = row.since;
  const bound = patienceBoundMs(workerOf(workId));
  const hint = newest(evs, isEntry(LADDER_ENTRY.hint), since);
  const pm = newest(evs, isEntry(LADDER_ENTRY.pm), since);
  const floor = now - since >= OWNER_FLOOR_MS;
  if (row.carded) return { reached: 4, due: null };
  if (pm) return { reached: 2, due: !pmCanRun() || pmReviewed(pm.at) ? owner(floor) : 'pm' };
  if (hint) return { reached: 1, due: !pmCanRun() ? owner(floor) : now - hint.at >= bound ? 'pm' : null };
  return { reached: 0, due: now - since >= bound ? 'hint' : null };
}

/** The rows the ladder looks at: board tasks Working, handed in or Open and delegated, minus the ones it leaves alone. */
function candidates(now: number): Array<{ id: string }> {
  return getDb().prepare(
    `SELECT w.id FROM work w LEFT JOIN agents a ON a.id = COALESCE(w.assignee_agent, w.agent_id)
      WHERE ${taskScope('w')} AND (w.state IN (${LIVE.map((st) => `'${st}'`).join(', ')}) OR (w.state = 'open' AND w.a2a_thread_id IS NOT NULL))
        AND (w.state = 'handed_in' OR a.status != 'terminated')
        AND NOT ${heldByOwnerSql('w')}
        AND COALESCE(w.hold_at >= ${LADDER_ANCHOR_SQL}, 1)
        AND w.is_paused = 0 AND (w.scheduled_start IS NULL OR w.scheduled_start <= ?)
        AND (w.state = 'handed_in' OR ${taskMovedAtSql('w')} >= ${LADDER_ANCHOR_SQL} - ?)`,
  ).all(now, DORMANT_MS) as Array<{ id: string }>;
}

/** Ladder wakes since `from`, box-wide (or of these entry kinds): each wake marks exactly one of its entries. */
const wakesSince = (from: number, kinds: string[] = Object.values(LADDER_ENTRY)): number => (getDb().prepare(
  `SELECT COUNT(*) AS n FROM work_events e
    WHERE e.work_id IN (SELECT w.id FROM work w WHERE ${taskScope('w')}) AND e.kind = '${AUDIT_KIND}' AND e.created_at >= ?
      AND json_extract(e.payload, '$.evidence_json') IS NOT NULL AND json_extract(e.payload, '$.entry_kind') IN (${kinds.map(() => '?').join(', ')})`,
).get(from, ...kinds) as { n: number }).n;

/** A PM wake is pending from its arm until a PM turn finishes after it, or one bound passes (a review that never ran). */
function pmPending(pmId: string, now: number): boolean {
  const done = (getDb().prepare('SELECT MAX(unixepoch(ended_at)) * 1000 AS at FROM turns WHERE agent_id = ? AND ended_at IS NOT NULL').get(pmId) as { at: number | null }).at ?? 0;
  return wakesSince(Math.max(done + 1000, now - patienceBoundMs(pmId)), [LADDER_ENTRY.pm]) > 0;
}

/** The PM can run a review: it has a model and is not ended, paused or in error. */
const pmCanRun = (): boolean => !!getDb().prepare(`SELECT 1 FROM agents WHERE id = ? AND model_id IS NOT NULL
  AND status NOT IN ('terminated', 'paused', 'error')`).get(getPMAgentId());

/** A PM review that listed the stall marked at `markAt` has ended: its report came after the mark (reports are stamped
 *  to the second), and the turn that took it ended. */
const pmReviewed = (markAt: number): boolean => !!getDb().prepare(`SELECT 1 FROM messages m JOIN turns t ON t.agent_id = m.agent_id
  AND t.turn_number = m.served_by_turn WHERE m.agent_id = ? AND m.origin_intent = 'pm_review' AND m.created_at >= ? AND t.ended_at IS NOT NULL`)
  .get(getPMAgentId(), Math.floor(markAt / 1000) * 1000);

/** One engine hint to `agentId` naming each row, as an events-lane re-drive that owes no reply, recorded on every
 *  row it names so it is never sent twice for the same step. `key` names a one-row hint that is not a stall step. */
export async function hintOnce(agentId: string, rows: Array<{ workId: string; text: string }>, key?: string): Promise<boolean> {
  const mark = key ? JSON.stringify({ wake: 1, key }) : WAKE;
  if (key && getDb().prepare(`SELECT 1 FROM work_events WHERE work_id = ? AND kind = '${AUDIT_KIND}' AND json_extract(payload, '$.entry_kind') = ? AND json_extract(payload, '$.evidence_json') = ?`).get(rows[0].workId, LADDER_ENTRY.hint, mark)) return false;
  const { redriveWithoutReply } = await import('../../agent/agent-notice.js');
  const mine = (workId: string): boolean => agentId === workerOf(workId);
  const content = `[Engine hint: ${rows.map((r) => `${r.text} [${r.workId}]`).join(' ')}]`;
  const sent = await redriveWithoutReply({ toAgentId: agentId, fromAgentId: null, content, taskId: rows.find((r) => mine(r.workId))?.workId ?? null });
  const kind = (workId: string): string => (mine(workId) ? LADDER_ENTRY.hint : LADDER_ENTRY.decider);
  if (sent) rows.forEach((r, i) => appendAuditEntry(r.workId, 'engine', { entryKind: kind(r.workId), reason: key ? UNDELIVERED_SAID : SAID[kind(r.workId)], evidenceJson: i === 0 ? mark : null }));
  return sent;
}

/** Step 4: the owner's card (once a day per task), and the ask on record his own words decide by. */
function tellOwner(workId: string): void {
  const key = stallKey(workId);
  if (!tellOwnerOncePerWindow(key, wordsOf(key), DAY_MS)) return;
  recordValidationEscalation(workId, 'engine', null);
  // The card is the decision that this work has stopped: whoever waits on it is told now.
  const thread = (getDb().prepare('SELECT a2a_thread_id AS t FROM work WHERE id = ?').get(workId) as { t: string | null }).t;
  void import('../../agent/a2a-transport.js').then((m) => m.judgeKeptRequests(workerOf(workId), thread));
}

const rowOf = (workId: string) => getDb().prepare(`SELECT w.title, w.state, ${holdWordsSql('w')} AS hold, ${taskMovedAtSql('w')} AS moved FROM work w WHERE w.id = ?`)
  .get(workId) as { title: string | null; state: string; hold: string; moved: number };

/** The words of a hint step (to the worker) or a decider step (to the main agent). */
function hintText({ id, due }: Due): string {
  const row = rowOf(id), title = row.title ?? id;
  if (due === 'hint') {
    const since = msToUtcText(row.moved);
    return row.hold ? LADDER_HINT.held(title, since, row.hold) : LADDER_HINT.stalled(title, since);
  }
  const reasons = sendBacks(id).map((b) => b.reason);
  return row.state === 'handed_in'
    ? LADDER_HINT.decide(title, latestHandIn(id)?.filedBy ?? workerOf(id), reasons.length >= SEND_BACKS_BEFORE_ESCALATION ? `it has been sent back ${reasons.length} times (${reasons.join('; ')})` : 'the project manager gave no verdict after two reviews')
    : LADDER_HINT.sentBack(title, reasons);
}

/** One wake of `agentId` for its due steps, within `room`: the PM's next report and one hint naming every row. Returns
 *  how many wakes it made (the PM holding a Working task of its own can make two). */
async function wake(agentId: string, steps: Due[], now: number, room: number): Promise<number> {
  if (selfWakeStandDown(agentId).standDown) return 0;
  const due = steps.filter((s) => s.due === 'pm');
  const pm = due.length > 0 && !pmPending(agentId, now) ? due : [];
  pm.forEach((s, i) => appendAuditEntry(s.id, 'engine', { entryKind: LADDER_ENTRY.pm, reason: SAID[LADDER_ENTRY.pm], evidenceJson: i === 0 ? WAKE : null }));
  if (pm.length > 0) (await import('../../tracker/pm-agent.js')).armDebouncedReview(pm[0].id, 'ladder');
  const armed = pm.length > 0 ? 1 : 0;
  const hints = steps.filter((s) => s.due !== 'pm');
  if (hints.length === 0 || armed >= room) return armed;
  return armed + ((await hintOnce(agentId, hints.map((s) => ({ workId: s.id, text: hintText(s) })))) ? 1 : 0);
}

/** THE SWEEP: per row, at most one step; the wakes are grouped by the agent they wake and bounded (header). */
export async function runLadder(now = Date.now()): Promise<void> {
  const byAgent = new Map<string, Due[]>();
  for (const { id } of candidates(now)) {
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
      room -= await wake(agentId, steps, now, room);
    } catch (err) {
      logger.warn('ladder: one agent could not be woken', { agentId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

