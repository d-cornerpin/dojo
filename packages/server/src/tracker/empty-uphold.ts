// ════════════════════════════════════════
// v3.5 FIELD FIX 3 (#6b): THE ENGINE REFUSES AN UPHOLD THAT NOTHING ON RECORD BACKS.
//
// 3.5 meant "done" to be verified through the tracker, but only a measured (mailbox) task carried a
// record the PM could check. On the owner's box the PM upheld a file-creation task whose verdict
// record said "looked at nothing": the request's own rule ("With no such record and nothing touched,
// reject it") was prompt-only, and the model broke it. Architecture rule 1: the engine enforces.
//
// This REPLACES that prompt-only rule (deleted from `validation-request.ts` in the same change). At the
// PM's own door (`work_validate(action="validate", kind="complete", valid=true)`), when nothing
// structural backs the close (no measure at 0 or with a named remainder, no ledger entry, no delivered
// answer, no PM read of the work since the close was filed: `closeBacking` in `looked-at.ts`), the
// call is refused with the FACTS of the record and what it names to open. It never coaches the PM
// toward either verdict and never threatens anything.
//
// NO LOOP, by construction: at most ONE refusal per review (the PM's turn) per row. The PM's next
// ruling on that row in the same review stands, and so does any ruling once the work has been read.
// A reject is never refused. A verdict outside a live PM turn (the scheduler, the engine's own
// maintenance adjudication) never reaches this door.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { turnContext } from '../agent/turn-context.js';
import { currentTurnNumber } from '../agent/v2/turn-record.js';
import { closeRequestDeliveryExpr, taskScope, unvalidatedCloseExpr } from '../work/tracker-view.js';
import { resolveTaskId } from './schema.js';
import { closeBacking, lookedAtThisTurn } from './looked-at.js';

const logger = createLogger('empty-uphold');

/** Row id -> the review (PM id and turn) that already refused an uphold on it. One refusal per review per row. */
const refusedIn = new Map<string, string>();

/** Exported for the suites: forget every refusal (process memory, like the turn it belongs to). */
export function resetEmptyUpholdRefusals(): void { refusedIn.clear(); }

/** The refusal for an uphold nothing backs, or null to let the ruling through. */
export function emptyUpholdRefusal(pmAgentId: string, rawTaskId: string): string | null {
  try {
    const ctx = turnContext(pmAgentId);
    if (!ctx) return null;
    const turn = ctx.turnNumber ?? currentTurnNumber(pmAgentId);
    const resolved = resolveTaskId(rawTaskId);
    if (!resolved.ok) return null;   // the validate door gives its own error for an id it cannot find
    const taskId = resolved.id;
    const row = getDb().prepare(
      `SELECT w.evidence_json AS evidence_json, w.measure_json AS measure_json, w.measure_remaining AS measure_remaining,
              ${closeRequestDeliveryExpr('w')} AS close_delivery
         FROM work w WHERE ${taskScope('w')} AND w.id = ? AND ${unvalidatedCloseExpr('w')}`,
    ).get(taskId) as { evidence_json: string | null; measure_json: string | null; measure_remaining: number | null; close_delivery: string | null } | undefined;
    if (!row) return null;   // no close is pending: the validate door says so itself

    const review = `${pmAgentId}:${turn}`;
    if (refusedIn.get(taskId) === review) return null;   // this review already heard the facts once
    const looked = lookedAtThisTurn(pmAgentId, turn, taskId);
    if (closeBacking(looked, taskId).backed) return null;

    refusedIn.set(taskId, review);
    logger.info('PM uphold refused: nothing on record backs the close', { taskId, pmAgentId, turn }, pmAgentId);
    return emptyRecordFacts(row);
  } catch (err) {
    // A ruling is never held up by this check's own failure to read.
    logger.warn('empty-uphold check could not read the record; the ruling goes through', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The facts of an empty record, one sentence each. */
function emptyRecordFacts(row: { evidence_json: string | null; measure_json: string | null; measure_remaining: number | null; close_delivery: string | null }): string {
  const measure = !row.measure_json ? 'No measure is set.'
    : row.measure_remaining === null ? 'Its measure could not be read.'
      : `Its measure reads ${row.measure_remaining.toLocaleString('en-US')} remaining, with no remainder named.`;
  const delivered = row.close_delivery
    ? `No delivered answer is on record for it; the close points at delivery ${row.close_delivery.slice(0, 8)}.`
    : 'No delivered answer is on record for it.';
  let pointers: string[] = [];
  try {
    const ev = JSON.parse(row.evidence_json ?? '[]') as Array<{ pointer?: unknown }>;
    pointers = Array.isArray(ev) ? ev.map((e) => (typeof e?.pointer === 'string' ? e.pointer.trim() : '')).filter(Boolean) : [];
  } catch { /* no readable evidence: nothing named */ }
  return 'Refused: nothing on record shows this work. '
    + 'The ledger for this task is empty (no files written, no commands run, no items touched). '
    + `${measure} ${delivered} `
    + 'Nothing of the work itself has been read since the close was filed. '
    + (pointers.length > 0 ? `The worker's evidence names: ${pointers.join(', ')}. ` : '')
    + 'Read the work (the files or the messages it names) before ruling.';
}
