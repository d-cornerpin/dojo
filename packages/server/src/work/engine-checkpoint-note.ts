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
// self-continuation: for every task the gate would count as THIS agent's dangler on the very
// next turn, record that the checkpoint fired and touch `updated_at`.
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
import { taskScope } from './tracker-view.js';

/** Why the checkpoint fired. `unattended-budget` is declared for a third checkpoint site this
 *  task does not wire (see the T79a brief's file list) — the union is complete even though
 *  only two of its members have a call site today. */
export type EngineCheckpointReason = 'turn-budget' | 'tool-loop' | 'unattended-budget';

const REASON_TEXT: Record<EngineCheckpointReason, string> = {
  'turn-budget': 'the 15-minute turn-time budget parked this turn for a fresh continuation',
  'tool-loop': 'the 75-tool-call loop cap parked this turn for a fresh continuation',
  'unattended-budget': 'the unattended-run budget parked this turn for a fresh continuation',
};

/**
 * Call immediately before an engine-forced checkpoint schedules its self-continuation.
 *
 * Touches every task the close-out gate would otherwise count as this agent's dangler on the
 * very next turn — an in_progress (claimed) task this agent holds, and a stranded on_deck
 * task in a project this agent created that the gate would also flag (see the header above
 * for why both families are in scope: the gate counts both as danglers, so a checkpoint that
 * squared only one would still get refused on the other).
 *
 * Returns the number of tasks touched. 0 is the common case — most checkpoints fire with
 * nothing claimed.
 */
export function noteEngineCheckpoint(agentId: string, reason: EngineCheckpointReason): number {
  const db = getDb();
  const now = Date.now();

  // Mirrors closeout-gate.ts's inProgressDanglers query, minus `AND w.updated_at < ?` and the
  // `ORDER BY … LIMIT 10` (that limit exists to bound a rendered message; this touches ALL of
  // them).
  const inProgress = db.prepare(`
    SELECT w.id AS id FROM work w
    WHERE ${taskScope('w')} AND w.agent_id = ?
      AND w.state = 'claimed'
      AND w.is_paused = 0
  `).all(agentId) as Array<{ id: string }>;

  // Mirrors closeout-gate.ts's strandedRows query, minus `AND t.updated_at < ?` and the same
  // rendering-only LIMIT.
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
      AND NOT EXISTS (
        SELECT 1 FROM work sib
        WHERE sib.parent_id = p.id AND sib.kind = 'task' AND sib.state = 'claimed'
      )
  `).all(agentId, now, agentId) as Array<{ id: string }>;

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
// T79 FIX WAVE, FINDING 2 — THE CIRCLING VERDICT RIDES THE CHECKPOINT PARK MESSAGE.
//
// THE DEFECT: the PM's circling verdict (`tracker/pm-agent.ts`'s `runEffortReview`) had
// exactly ONE delivery path — the guarded poke sweep's fill-in, behind the `assigneeStatus
// === 'working'` guard. A continuously-continuing agent (the exact shape this whole SLOW-
// INFERENCE plan exists for) is 'working' except for the ~0.5-2s a checkpoint like this one
// occupies roughly every 15 minutes, so with the sweep's own 60s tick, the EXPECTED delivery
// latency after the PM had already ruled circling was measured in HOURS, not seconds.
//
// THE FIX (plan owner-orchestrator ruling): surface it here instead — in the tail-side system
// row this checkpoint ALREADY writes as its own park message, at the exact moment the agent's
// next turn is about to read fresh context. This never touches the working guard or the busy-
// deferral (both stay the sweep's own backstop for an agent that DOES go idle); it is a
// second, independent delivery surface for the case the sweep structurally cannot reach in
// good time.
//
// NO DOUBLE DELIVERY, EITHER DIRECTION: `pendingCirclingVerdict` (`tracker/effort-governor.
// ts`) is the SAME read both this function and the poke sweep's own guarded fill-in call, and
// whichever one delivers first marks it via `recordPoke` — a rung>=2 `work_events` row, the
// EXACT marker `pendingCirclingVerdict`'s own `circlingPokeAlreadyDelivered` check reads. The
// other side's next read of the same taskId then sees it as already delivered and does
// nothing. One latch, two writers, no coordination needed between them.
//
// SCOPE: the agent's own CLAIMED (in_progress) tasks — the query mirrors `noteEngineCheckpoint`
// `inProgress` query above (same predicate: `taskScope`, `state = 'claimed'`, `is_paused = 0`)
// plus the task's `title`, needed to name it honestly in the line. Stranded on_deck tasks are
// NOT in scope here: nothing is actively being worked on one (the effort meter only ever
// charges a CLAIMED task, per `tracker-counting.ts`'s `resolveCurrentClaimedTaskId`), so a
// circling verdict against one could not exist in the first place.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * Look up an undelivered circling verdict for the agent's own claimed task(s) and, if one
 * exists, return ONE honest line — naming the task and quoting the PM's reason — to append to
 * the checkpoint's own park message. As a side effect, marks that verdict delivered through
 * the SAME marker the guarded poke sweep checks, so the sweep can never re-deliver what this
 * checkpoint just surfaced.
 *
 * Returns `null` when there is nothing pending — the common case, and the ONLY case in which
 * the caller's park message stays byte-identical to before this fix.
 */
export function pendingCirclingVerdictParkLine(agentId: string): string | null {
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
    // Mark delivered NOW, before returning — the exact marker `circlingPokeAlreadyDelivered`
    // reads, so a poke sweep tick landing a moment later (or a moment earlier, on a different
    // process) cannot also deliver this same verdict. `rung: 2` matches the sweep's own
    // "urgent" rung for a circling verdict; the distinct `poke_type` string makes this
    // delivery's origin readable on the record without changing what either reader checks
    // (`circlingPokeAlreadyDelivered` only inspects `rung`).
    recordPoke(task.id, 'engine', 2, 'checkpoint_circling_verdict', agentId);
    const title = task.title ?? '(untitled task)';
    return `[PM EFFORT REVIEW — ${EFFORT_REVIEW_DELTA_CALLS}+ calls without advancing on "${title}" (${task.id})] ${circling.reason}`;
  }
  return null;
}
