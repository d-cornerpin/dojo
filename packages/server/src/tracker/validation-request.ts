// v3.5 done-is-measured E1: the text of the PM's UNVALIDATED_COMPLETE request. It carries the record the
// close is judged on (measure, ledger, any remainder the worker named), never a lean toward either verdict.
import { validationMeasureLines } from './job-loop-facts.js';
import { readLaterMessages } from '../memory/task-list-words.js';

const OWNER_WORDS_EXCERPT_CHARS = 400;   // a display excerpt; history_get returns the whole message

/** The owner's later words the engine recorded against this task (the newer-instruction link): the
 *  record a decision-type close is judged on. Never the agent's own notes quoting the owner. */
export function ownerWordsLines(taskId: string): string {
  const laters = readLaterMessages(taskId);
  if (laters.length === 0) return '\n  Owner words recorded on this task: none';
  const shown = laters.map((m) => {
    const id = (m.messageId ?? '').slice(0, 8);
    if (m.words === null) return `    message ${id}: no longer stored`;
    const flat = m.words.replace(/\s+/g, ' ').trim();
    const cut = flat.length > OWNER_WORDS_EXCERPT_CHARS ? `${flat.slice(0, OWNER_WORDS_EXCERPT_CHARS)}… (history_get(id="${m.messageId}") returns it whole)` : flat;
    return `    message ${id}: "${cut}"`;
  });
  return `\n  Owner words recorded on this task (sent while it was open; the turn that answered them touched it):\n${shown.join('\n')}`;
}

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
    + `  Evidence:\n${p.evidenceBlock}${validationMeasureLines(taskId)}${ownerWordsLines(taskId)}\n`
    + `  Priority=${p.priority}, revert_count=${p.revertCount}.\n`
    + `  Read the file/audit log/output referenced in evidence BEFORE validating (skepticism rule). `
    + `Call work_validate(action="validate", kind="complete", task_id="${taskId}", valid=true) when the work demonstrably matches the goal. `
    + `Call work_validate(action="validate", kind="complete", task_id="${taskId}", valid=false, reject_reason="...", target_status="in_progress") when it does not. `
    + `A measured task: validate when the measure reads 0, or when the named remainder's reason holds against the goal; reject and state the count when it does not; `
    + `when you cannot tell whether the owner would want those items left, ask the owner through the main agent: send_to_agent to the main agent with the count and the worker's reason. `
    + `An unmeasured task: judge the ledger and receipts above, not the result text. `
    + `A task whose job is a decision (nothing to file or send) is delivered when the owner's recorded words or the recorded answer above settle it; the agent's own notes quoting the owner do not count.`;
  // v3.5 field fix 3 (#6b): "With no such record and nothing touched, reject it." stood here, a
  // prompt-only rule the PM broke on the owner's box. The engine enforces it now, at the PM's door
  // (`tracker/empty-uphold.ts`), so the sentence is gone rather than kept beside the gate.
}
