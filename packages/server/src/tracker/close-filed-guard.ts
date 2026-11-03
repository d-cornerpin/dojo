/**
 * A block or pause VERDICT must never be the thing that answers a worker's filed close.
 *
 * `throwBackClaim` (a reject) writes `claim_rejected`, which `pendingCloseRequestExpr` reads as
 * the answer to "is this job finished?", and a bless of the stale wait/obstacle note answers a
 * question the row has moved past. The queues no longer select such a row for the block or
 * pause lens, so only a stale id reaches these doors; the refusal points at the door that IS
 * open so the validator's next call is the right one.
 */
export function closeFiledRefusal(
  task: { title: string; close_request_filed: number }, taskId: string, noun: 'pause' | 'block',
): string | null {
  if (task.close_request_filed !== 1) return null;
  return (
    `Error: task "${task.title}" (${taskId.slice(0, 8)}) has filed a CLOSE REQUEST — its worker says the ${noun === 'pause' ? 'wait' : 'obstacle'} is over and the work is done. ` +
    `A ${noun} verdict (bless or reject) would answer a question this row has moved past and drop the close unjudged. ` +
    `Judge the close instead: work_validate(action="validate", kind="complete", task_id="${taskId}", valid=true|false, reject_reason="..." if false).`
  );
}
