// v3.5 DONE IS MEASURED, Task D2 — what the PM's closeout-miss report says about a task's MEASURED
// record (`tracker/pm-agent.ts`, `escalateCloseoutMissToPM`), so the PM decides per task on the
// numbers rather than on the worker's prose.
//
//   - the task's Progress line, the same one its assignee's board shows (`work/measure-view.ts`);
//   - when its last turn end was a STALL (`work/job-momentum.ts`: a turn the engine continued came
//     back with no progress) and nothing new was touched since, the stall and the count.
// A task with no measure and an empty ledger gets neither, so its report is what it was.
import { readMeasureFacts, formatMeasureLine } from '../work/measure-view.js';
import { lastTurnEnd } from '../work/job-momentum.js';
import { ledgerNewItemsSince } from '../work/ledger-store.js';

export interface CloseoutMeasure {
  /** Lines to print under the task's own line (each already indented), or '' when there are none. */
  lines: string;
  /** The count the stall was recorded with, when the task's last turn end is a stall; else null. */
  stalledRemaining: number | null;
}

const n = (x: number): string => x.toLocaleString('en-US');

export function closeoutMeasure(taskId: string): CloseoutMeasure {
  const out: string[] = [];
  const facts = readMeasureFacts(taskId);
  if (facts) out.push(`    ${formatMeasureLine(facts)}`);
  const end = lastTurnEnd(taskId);
  const remaining = end?.kind === 'stalled' && typeof end.payload.remaining === 'number' ? end.payload.remaining : null;
  // A stall the worker has since worked past is not "stopped making progress".
  const stalledRemaining = remaining !== null && ledgerNewItemsSince(taskId, end!.at) === 0 ? remaining : null;
  if (stalledRemaining !== null) {
    out.push(`    Last turn touched 0 items with ${n(stalledRemaining)} remaining: the assignee stopped making progress.`);
  }
  return { lines: out.map((l) => `\n${l}`).join(''), stalledRemaining };
}

/** The retask example for a stalled measured task (the closeout-miss report's verb (a)). */
export function stalledRetaskExample(remaining: number): string {
  return `"you stopped at ${n(remaining)} remaining; continue from the measure's list"`;
}
