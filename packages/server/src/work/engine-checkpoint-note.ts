// T79a (SLOW-INFERENCE PLAN) — AN ENGINE CHECKPOINT SQUARES THE TRACKER IT INTERRUPTS.
//
// THE DEFECT (owner transcript, 12:16–12:35 and 5:52–6:20). Two engine mechanisms PARK a
// turn mid-work and queue a self-wake continuation, on purpose, as the correct response to a
// turn that has run long on a slow local model: the 15-minute turn-time budget
// (`agent/v2/steps/pre-call-gates/turn-budget.ts`) and the 75-tool-loop cap
// (`agent/v2/loop.ts`). Neither ever touched the tracker. So the very next turn,
// `agent/v2/steps/preflight/closeout-gate.ts`'s dangler queries — which key on
// `work.updated_at` going stale (`CLOSE_OUT_IDLE_MINUTES = 10` for a claimed task; 30 minutes
// for the stranded on_deck family) — read "checkpointed ten minutes ago" as "abandoned ten
// minutes ago". The gate ARMS, REFUSES every non-tracker tool call the continuation makes,
// and a slow model re-pays a whole inference round for work it never stopped doing.
//
// THE FIX is one call at each checkpoint site, made just before it schedules its own
// self-continuation: for the task(s) the parked job is serving, record that the checkpoint fired
// and touch `updated_at`. (Until t143 round 2 this was EVERY dangler of the agent — see below.)
//
// THE TWO QUERIES BELOW ARE THE GATE'S OWN TWO DANGLER PREDICATES
// (`closeout-gate.ts` ~63-103), copied in SHAPE — table, join, state, `is_paused`, schedule
// and project clauses all verbatim — with ONE deliberate subtraction: the wall-clock
// staleness clause each carries (`w.updated_at < ?` / `t.updated_at < ?`). The gate's
// question is "has this gone stale"; the checkpoint's question is "is this interrupted", and
// every one of the agent's in-flight claimed tasks is interrupted the instant the turn parks
// — not only the ones that happen to have already crossed the gate's own staleness line. A
// fresh `updated_at` on a task the agent touched thirty seconds ago is a no-op the gate would
// have accepted anyway, so dropping the clause costs nothing and closes the race where a
// second task goes stale one tick after the first was checked.
//
// TOUCHING `updated_at` IS HONEST, not a workaround: the task IS being worked, by the very
// turn that is about to continue on a fresh wakeup. It is precisely what disarms both the
// gate's staleness predicate and the PM's idle clock — the same signal every ordinary tracker
// tool call already sends when the model is fast enough to make one before the checkpoint
// fires.
//
// THE WIDE-LOOP RISK THIS CREATES — "the engine now keeps its own claim alive forever, even
// on a task nobody is really advancing" — is real and deliberately OUT OF SCOPE here. It is
// exactly what T79c/T79d (this same plan) exist to catch. The two mechanisms are
// COMPLEMENTARY: this task stops an honestly in-flight task from being read as an abandoned
// one; T79c/T79d stop a checkpoint from being used to keep a genuinely stuck task alive
// indefinitely.
//
// THE INSERT PATH is the tree's existing one for this exact shape of record —
// `tracker/task-log.ts`'s `writeTaskLog`, which seven engine-authored call sites already use
// with `entryKind: 'observation'` / `fromEntity: 'engine'` (`thrash-gate.ts`,
// `finalize-record.ts`, `counterparty.ts`, `agent/spawner.ts`, `agent/tools/cat/agents.ts`).
// It resolves to a real `work_events` row of the declared kind `'audit'`
// (`work/audit-trail.ts`'s `AUDIT_KIND`) carrying `entry_kind: 'observation'` in its payload —
// NOT a bare `kind='observation'` column value, which `work/event-kinds.ts`'s declared list
// deliberately does not carry (`work-event-kinds-conformance.test.ts` pins `'observation'` as
// a refused near-miss). Using the existing seam means no new event kind, no migration, and no
// second insert idiom for the same fact.

import { getDb } from '../db/connection.js';
import { writeTaskLog } from '../tracker/task-log.js';
import { pendingCirclingVerdict, EFFORT_REVIEW_DELTA_CALLS } from '../tracker/effort-governor.js';
import { recordPoke } from './poke-ladder.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { taskScope } from './tracker-view.js';
import { turnContext } from '../agent/turn-context.js';
import { turnWorkIds, carryJobWork } from './task-freshness.js';

/** Why the checkpoint fired — one member per checkpoint site. (t137: the third member,
 *  `unattended-budget`, went with the continuation-cap trip that was its only call site.) */
export type EngineCheckpointReason = 'turn-budget' | 'tool-loop';

const REASON_TEXT: Record<EngineCheckpointReason, string> = {
  'turn-budget': 'the 15-minute turn-time budget parked this turn for a fresh continuation',
  'tool-loop': 'the 75-tool-call loop cap parked this turn for a fresh continuation',
};

// t143 ROUND 2 (orchestrator ruling) — A PARK TOUCHES ONLY THE JOB'S OWN WORK.
// This used to touch EVERY claimed task of the agent (and every stranded step of its projects)
// at every park. With no total cap that kept a genuinely abandoned second task fresh for a whole
// long job, so neither the close-out gate nor the PM ever saw it (t137 review M3). A task's
// freshness may only be refreshed by activity that structurally NAMES it: here, the work the
// parked turn's trigger names — the owner's ask that opened it (`source_message_id`), the A2A
// thread that assigned it, the engine event that served it, a task born in this turn, and steps
// of a project so named. A continuation fires with an empty trigger, so the checkpoint CARRIES
// that set to the one continuation it queues (the next turn of this agent, and only if that turn
// has no trigger of its own). The T79a guarantee — the job's own task is never read as abandoned
// across a park — is kept, now for exactly that task.

/**
 * Call immediately before an engine-forced checkpoint schedules its self-continuation.
 *
 * Touches the job's own in-flight work — an in_progress (claimed) task this turn serves, and a
 * stranded on_deck step of a project it serves (the close-out gate's two dangler families) — and
 * carries the job's work to the continuation. Returns the number of tasks touched.
 */
export function noteEngineCheckpoint(agentId: string, reason: EngineCheckpointReason): number {
  const db = getDb();
  const now = Date.now();
  const tied = turnWorkIds(agentId);
  const turn = turnContext(agentId)?.turnNumber;
  if (turn !== undefined) carryJobWork(agentId, turn, tied);
  if (tied.length === 0) return 0;
  const ids = tied.map(() => '?').join(', ');

  // The gate's in_progress dangler family, limited to the job's own tasks.
  const inProgress = db.prepare(`
    SELECT w.id AS id FROM work w
    WHERE ${taskScope('w')} AND w.agent_id = ?
      AND w.state = 'claimed'
      AND w.is_paused = 0
      AND w.id IN (${ids})
  `).all(agentId, ...tied) as Array<{ id: string }>;

  // The gate's stranded on_deck family, limited to the job's own steps.
  const stranded = db.prepare(`
    SELECT t.id AS id FROM work t
    INNER JOIN work p ON p.id = t.parent_id
    WHERE ${taskScope('t')} AND t.agent_id = ?
      AND t.state = 'on_deck'
      AND t.is_paused = 0
      AND (t.scheduled_start IS NULL OR t.scheduled_start <= ?)
      AND t.schedule_status != 'waiting'
      AND p.requester_id = ?
      AND p.state = 'open'
      AND t.id IN (${ids})
      AND NOT EXISTS (
        SELECT 1 FROM work sib
        WHERE sib.parent_id = p.id AND sib.kind = 'task' AND sib.state = 'claimed'
      )
  `).all(agentId, now, agentId, ...tied) as Array<{ id: string }>;

  // Disjoint by construction (`state = 'claimed'` vs `state = 'on_deck'`), so no id can be
  // double-counted or double-touched.
  const targets = [...inProgress, ...stranded];
  const touch = db.prepare('UPDATE work SET updated_at = ? WHERE id = ?');
  for (const { id } of targets) {
    writeTaskLog({
      taskId: id,
      fromEntity: 'engine',
      entryKind: 'observation',
      reason: `engine checkpoint: ${reason}`,
      actionTaken: REASON_TEXT[reason],
      note: 'turn parked for a continuation; this task is still in flight, not abandoned.',
    });
    touch.run(now, id);
  }

  return targets.length;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// T79 FIX WAVE, FINDING 2 — THE CIRCLING VERDICT IS HANDED OVER AT THE CHECKPOINT.
//
// THE DEFECT: the PM's circling verdict (`tracker/pm-agent.ts`'s `runEffortReview`) had
// exactly ONE delivery path — the guarded poke sweep's fill-in, behind the `assigneeStatus
// === 'working'` guard. A continuously-continuing agent is 'working' except for the ~0.5-2s a
// checkpoint occupies, so the expected delivery latency was measured in HOURS.
//
// t137 ROUND 2 (R-V333-3, OR-LONG-JOBS) — WHERE IT TRAVELS NOW, AND WHY THE OLD CARRIER WENT.
// Finding 2 put the line on the checkpoints' park rows. Those rows were role='system', which
// the tail renderer never emits: the AGENT never read the verdict, the OWNER read it in his
// chat, and the latch below was written anyway — cancelling the sweep's real delivery too. Both
// park rows are deleted (the checkpoints are invisible housekeeping). The verdict now leaves as
// a PM-attributed RIDER notice (`postAgentNotice`, intent `agent_notice` — a declared
// `ENGINE_RIDER_INTENTS` member, so it can never drive a turn of its own): an events-lane row,
// lifted into the agent's NEXT turn (the continuation the checkpoint queues), broadcast on the
// inter-agent lane, never on the owner's chat. Both checkpoints call this one function.
//
// NO DOUBLE DELIVERY, EITHER DIRECTION: `pendingCirclingVerdict` is the SAME read the poke
// sweep's guarded fill-in makes, and the latch (`recordPoke`, rung 2 — the marker
// `circlingPokeAlreadyDelivered` reads) is written ONLY once the notice row exists. A failed
// write leaves the verdict pending for the sweep rather than marking a delivery that did not
// happen.
//
// SCOPE: the agent's own CLAIMED tasks (same predicate as `noteEngineCheckpoint`'s
// `inProgress`), plus the title, to name the task in the notice.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * Hand one undelivered circling verdict on this agent's claimed work to the agent itself, as a
 * PM-attributed rider notice its next turn reads. Returns the notice row id, or `null` when
 * nothing was pending (the common case) or the hand-over failed (verdict left pending). Never
 * throws: a checkpoint is not the place to discover a broken read, and both callers park anyway.
 */
export function deliverPendingCirclingVerdict(agentId: string): string | null {
  try {
    return handOverOneVerdict(agentId);
  } catch {
    return null;
  }
}

function handOverOneVerdict(agentId: string): string | null {
  const db = getDb();
  const claimed = db.prepare(`
    SELECT w.id AS id, w.title AS title FROM work w
    WHERE ${taskScope('w')} AND w.agent_id = ?
      AND w.state = 'claimed'
      AND w.is_paused = 0
  `).all(agentId) as Array<{ id: string; title: string | null }>;

  for (const task of claimed) {
    const circling = pendingCirclingVerdict(task.id);
    if (!circling) continue;
    const title = task.title ?? '(untitled task)';
    const brief = `[PM EFFORT REVIEW — ${EFFORT_REVIEW_DELTA_CALLS}+ calls without advancing on "${title}" (${task.id})] ${circling.reason}`;
    // t137 round 3 (review M4): the ROW is the delivery — it is what the next turn reads. A row
    // already written for THIS verdict (a post whose broadcast threw after the insert answers
    // null) counts as delivered, so the verdict is latched once and never handed over twice.
    const noticeId = noticeRowFor(agentId, brief, circling.sinceEventId)
      ?? postAgentNotice({ toAgentId: agentId, fromName: 'PM', selfIntro: false, intent: 'agent_notice', brief })
      ?? noticeRowFor(agentId, brief, circling.sinceEventId);
    if (!noticeId) return null;
    // `rung: 2` matches the sweep's own urgent rung for a circling verdict; the `poke_type`
    // names this delivery's origin without changing what either reader checks.
    recordPoke(task.id, 'engine', 2, 'checkpoint_circling_verdict', agentId);
    return noticeId;
  }
  return null;
}

/** The rider notice already written for this verdict: same text (as `postAgentNotice` stores it),
 *  on this agent's events lane, written no earlier than the PM's verdict itself (floored to the
 *  second: `messages.created_at` is stored at second precision, `work_events` in ms — measured).
 *  Runs only while a verdict is pending — a checkpoint-time read, never a hot path. */
function noticeRowFor(agentId: string, brief: string, sinceEventId: number): string | null {
  const row = getDb().prepare(
    `SELECT m.id AS id FROM messages m
      WHERE m.agent_id = ? AND m.lane = 'events' AND m.origin_intent = 'agent_notice'
        AND instr(m.content, ?) > 0
        AND m.created_at >= (SELECT (e.created_at / 1000) * 1000 FROM work_events e WHERE e.id = ?)
      LIMIT 1`,
  ).get(agentId, brief.replace(/\s+/g, ' ').trim(), sinceEventId) as { id: string } | undefined;
  return row?.id ?? null;
}
