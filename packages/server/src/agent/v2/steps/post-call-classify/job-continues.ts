// ════════════════════════════════════════
// v3.5 DONE IS MEASURED, Task D1 — A TURN THAT ENDS MID-JOB IS PARKED AND CONTINUED.
//
// The turn end used to put a menu with "complete" on it in front of a worker whose job still had
// items left, or (when it had already said "500 done so far") just end, leaving the job to the PM's
// check-in. A reply is not a stop signal while items remain. Evaluated once per turn end by the
// going-idle detector (`going-idle.ts`), for the worker's most recently updated claimed, unpaused
// task, and never on a turn a human is waiting on (the caller's guard: the close-out gate's own
// `triggerRow` predicate), where today's behaviour stands.
//
// MOMENTUM (owner, 2026-10-19): the turn touched at least one item it had not touched before (the
// ledger, `work_ledger`; re-touching the same items is a loop, not progress) OR
// made at least one call this task had never made before (the effort meter's own novel-vs-repeat
// rule, `tracker/effort-ledger.ts`: a new search page or a new message read is new; the same search
// or the same read again is a repeat). Time plays no part.
//
//   items left (or no measure) and momentum  → park on the timer and record `continued`;
//   items left, no momentum, and this turn WAS the engine's continuation → record `stalled`, park
//     nothing, close nothing: the task stays in progress and unmoved, so the PM's check-in ladder
//     takes it with the count (`tracker/pm-agent.ts`, the closeout-miss report);
//   anything else → null: the detector's existing branches decide (the menu, or the turn ends).
//
// THE LOOP CANNOT RUN WITHOUT PROGRESS: every continued turn must itself show momentum to be
// continued again, and the first continued turn that does not is the stall. Nothing to reset: when
// the worker works again the next turn end re-arms the continuation on its own.
// ════════════════════════════════════════

import { taskScope } from '../../../../work/tracker-view.js';
import { countMeasure, parseMeasure, type Measure } from '../../../../work/measure.js';
import { ledgerNewItemsSince, recordMeasured } from '../../../../work/ledger-store.js';
import { lastTurnEnd, recordContinued, recordStalled } from '../../../../work/job-momentum.js';
import { parkJob } from '../../../../work/job-continuation.js';
import { runCarriesJob } from '../../../../work/task-freshness.js';
import { deliverPendingCirclingVerdict, noteEngineCheckpoint } from '../../../../work/engine-checkpoint-note.js';
import { novelCallsInTurn } from '../../../../tracker/effort-ledger.js';
import { createLogger } from '../../../../logger.js';
import type { AgentTurnState } from '../../state.js';
import type { PostCallClassifyContext } from './index.js';

const logger = createLogger('v2-loop');

export type JobTurnEnd = 'continued' | 'stalled';

function measureOf(json: string | null): Measure | null {
  if (!json) return null;
  try { const p = parseMeasure(JSON.parse(json)); return p.ok ? p.measure : null; } catch { return null; }
}

/** The D1 rule at a turn end (the caller has already ruled out a turn that moved a task's status).
 *  Returns what it did, or null when the detector's other branches decide. */
export async function continueTheJob(state: AgentTurnState, ctx: PostCallClassifyContext): Promise<JobTurnEnd | null> {
  const { agentId, db, turnNumber } = ctx;
  // Step 1: a human waiting on the agent (the close-out gate's own predicate, `triggerRow`) keeps today's
  // behaviour, and so does a turn whose close-out gate armed and was not answered (its escalation runs next).
  if (ctx.triggerRow || (state.danglingTaskIds.length > 0 && !state.closeOutGateSatisfied)) return null;
  if (ctx.turnCtx.jobParked) return null;   // this turn already queued its continuation (another park)
  // The detector's own task set, and the effort meter's pick within it (most recently updated wins).
  const task = db.prepare(`
    SELECT w.id AS id, w.measure_json AS measureJson, w.measure_remaining AS stored FROM work w
    WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed' AND w.is_paused = 0
    ORDER BY w.updated_at DESC, w.rowid DESC LIMIT 1
  `).get(agentId) as { id: string; measureJson: string | null; stored: number | null } | undefined;
  if (!task) return null;

  // The turn-end re-measure. A count that cannot be read keeps the last stored one (and says so on the record).
  const measure = measureOf(task.measureJson);
  let remaining: number | null = null;
  if (measure) {
    const count = await countMeasure(measure, agentId, ctx.agent.name ?? agentId);
    recordMeasured(task.id, count, Date.now());
    remaining = count.ok ? count.count : task.stored;
  }

  const touchedThisTurn = ledgerNewItemsSince(task.id, state.turnStartMs);   // NEW items: a re-touch is not progress
  const novelCallsThisTurn = novelCallsInTurn(task.id, state.turnStartMs);
  const momentum = touchedThisTurn > 0 || novelCallsThisTurn > 0;
  // A measure that reads 0 is a finished job; one never read is treated as no measure.
  if (!(remaining === null ? momentum : remaining > 0)) return null;

  if (momentum) {
    // The park, as the engine's other checkpoints do it: a pending PM verdict rides to the agent,
    // the job's own task is marked in flight (the activity line) and carried, then the one park door.
    deliverPendingCirclingVerdict(agentId);
    try { noteEngineCheckpoint(agentId, 'job-continues', [task.id]); } catch (err) {
      logger.warn('v2: job-continues checkpoint note failed (non-fatal)', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
    }
    parkJob(agentId, remaining === null ? 'job continues' : `job continues: ${remaining} remain`, 'timer');
    recordContinued(task.id, { remaining, touchedThisTurn, novelCallsThisTurn, turnNumber });
    logger.info('v2 job continues: turn ended mid-job with momentum, parked', { agentId, taskId: task.id, remaining, touchedThisTurn, novelCallsThisTurn }, agentId);
    return 'continued';
  }
  // Only the run the park's own wake started is "the turn the engine continued": an unrelated run
  // that happens to end first is not the continuation, and is never recorded as a stall.
  if (lastTurnEnd(task.id)?.kind === 'continued' && runCarriesJob(agentId)) {
    recordStalled(task.id, { remaining, turnNumber });
    logger.info('v2 job stalled: a continued turn made no progress; left in progress for the PM', { agentId, taskId: task.id, remaining }, agentId);
    return 'stalled';
  }
  return null;
}
