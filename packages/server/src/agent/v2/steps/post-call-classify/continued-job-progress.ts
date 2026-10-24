// v3.5 D1, PRE-REVIEW RULING 2 — WHILE A CONTINUED JOB IS STILL GOING, ITS TURNS' TEXT IS PROGRESS.
//
// A measured job the engine continues (`job-continues.ts`) runs turn after turn with nobody
// waiting. Each of those turns would otherwise end with a line the owner's chat shows ("labelled
// 500 more, 9,551 to go"), and a long job would ping him with dozens. Progress stays on the record
// instead: the line is kept as a working note (`closeout-floors.ts`'s demote-don't-discard row:
// visible on the dashboard, never a ping, never re-entering the model's context).
//
// The owner hears from a continued job when:
//   (a) it is FINISHED — the measure's last reading is 0, so this predicate is false and the
//       turn's text goes out as any engine turn's does;
//   (b) it STALLS — the `stalled` record hands it to the PM, whose existing ladder decides what
//       reaches him;
//   (c) the agent ASKS him something or reports a BLOCKER through the tracker's own doors
//       (status "paused" waiting on him, or "blocked"): a turn that moved the task's status is not
//       "still going", and its text goes out under the platform's existing rules for an engine
//       turn (the proactive-send budget among them). A send tool the agent calls is untouched.
// Structural only: not one character of the text is read.
import { taskScope } from '../../../../work/tracker-view.js';
import { runCarriesJob } from '../../../../work/task-freshness.js';
import { lastTurnEnd } from '../../../../work/job-momentum.js';
import type { AgentTurnState } from '../../state.js';
import type { PostCallClassifyContext } from './index.js';

/** Is this turn the engine's continuation of a measured job that still has items left? */
export function continuedJobStillGoing(state: AgentTurnState, ctx: Pick<PostCallClassifyContext, 'agentId' | 'db'>): boolean {
  if (state.trackerStatusUpdatedThisTurn) return false;   // (c): the agent moved the task this turn
  if (!runCarriesJob(ctx.agentId)) return false;          // only the run the park's own wake started
  // The same task the continuation rule judges: the most recently updated claimed, unpaused one.
  const task = ctx.db.prepare(`
    SELECT w.id AS id, w.measure_json AS measureJson, w.measure_remaining AS remaining FROM work w
    WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed' AND w.is_paused = 0
    ORDER BY w.updated_at DESC, w.rowid DESC LIMIT 1
  `).get(ctx.agentId) as { id: string; measureJson: string | null; remaining: number | null } | undefined;
  if (!task?.measureJson || task.remaining === null || task.remaining <= 0) return false;   // (a): finished, or no reading
  return lastTurnEnd(task.id)?.kind === 'continued';
}
