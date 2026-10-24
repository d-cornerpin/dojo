// v3.5 done-is-measured E1: the text of the PM's UNVALIDATED_COMPLETE request. It carries the record the
// close is judged on (measure, ledger, any remainder the worker named), never a lean toward either verdict.
import { validationMeasureLines } from './job-loop-facts.js';

export interface ValidationRequestParts {
  title: string; agentName: string; goal: string | null; result: string | null;
  priority: string; revertCount: number;
  /** The doorbell, smell, per-run and goal-edit lines that ride on the header. */
  headExtras: string;
  /** The evidence lines, the closer's last note and the delivered-answer pointer. */
  evidenceBlock: string;
}

export function unvalidatedCompleteText(taskId: string, p: ValidationRequestParts): string {
  return `UNVALIDATED_COMPLETE: "${p.title}" (${taskId.slice(0, 8)}) closed by ${p.agentName}, awaiting your validation.${p.headExtras}\n`
    + `  Goal: ${p.goal ?? '(no goal recorded, pre-migration row)'}\n`
    + `  Result: ${p.result ?? '(none)'}\n`
    + `  Evidence:\n${p.evidenceBlock}${validationMeasureLines(taskId)}\n`
    + `  Priority=${p.priority}, revert_count=${p.revertCount}.\n`
    + `  Read the file/audit log/output referenced in evidence BEFORE validating (skepticism rule). `
    + `Call work_validate(action="validate", kind="complete", task_id="${taskId}", valid=true) when the work demonstrably matches the goal. `
    + `Call work_validate(action="validate", kind="complete", task_id="${taskId}", valid=false, reject_reason="...", target_status="in_progress") when it does not. `
    + `A measured task: validate when the measure reads 0, or when the named remainder's reason holds against the goal; reject and state the count when it does not; `
    + `when you cannot tell whether the owner would want those items left, ask the owner through the main agent: send_to_agent to the main agent with the count and the worker's reason. `
    + `An unmeasured task: judge the ledger and receipts above, not the result text.`;
}
