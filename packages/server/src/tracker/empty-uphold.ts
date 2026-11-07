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
// answer, no owner's words, no PM read of THIS row's work since the close was filed: `closeBacking` in
// `looked-at.ts`), the call is refused with the FACTS of the record and what it names to open. It never coaches the PM
// toward either verdict and never threatens anything.
//
// HELD UNTIL THE WORK IS READ (review M3, OR-FIELD3(d) decided: the PM must read the record before
// upholding, and an empty record cannot be upheld). Once refused, an uphold on that row stays refused,
// in this review and later ones, until the PM has read THIS row's work after the refusal: something the
// row's own record names (`readsBoundToRow` in `looked-at.ts`). A read of another row's work backs
// nothing here, and a plain retry is refused again with the same facts.
//
// NO LOOP: the PM can always end it. A read of what the row names lets the next uphold stand; a reject is
// never refused; and an identical repeated call meets the engine's identical-call brake like any other.
// A record that names nothing to read cannot be upheld at all, which is the owner's ruling. A verdict
// outside a live PM turn (the scheduler, the engine's own maintenance adjudication) never reaches this door.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { turnContext } from '../agent/turn-context.js';
import { currentTurnNumber } from '../agent/v2/turn-record.js';
import { taskScope, unvalidatedCloseExpr } from '../work/tracker-view.js';
import { resolveTaskId } from './schema.js';
import { closeBacking, lookedAtThisTurn, readsBoundToRow, readsSince, taskAnswerFor } from './looked-at.js';
import { heldDeliveryLine } from './owed-delivery.js';

const logger = createLogger('empty-uphold');

/** Row id -> when its uphold was refused. Lives exactly as long as the row awaits a verdict (L4):
 *  `forgetSettledRefusals` drops every row that has settled, and a read that releases one drops it. */
const refusedAt = new Map<string, number>();

/** Exported for the suites: forget every refusal. */
export function resetEmptyUpholdRefusals(): void { refusedAt.clear(); }
/** Exported for the suites: how many rows are held. */
export function emptyUpholdRefusalsHeld(): number { return refusedAt.size; }

function forgetSettledRefusals(): void {
  if (refusedAt.size === 0) return;
  const ids = [...refusedAt.keys()];
  const pending = new Set((getDb().prepare(
    `SELECT w.id AS id FROM work w WHERE w.id IN (${ids.map(() => '?').join(',')}) AND ${unvalidatedCloseExpr('w')}`,
  ).all(...ids) as Array<{ id: string }>).map((r) => r.id));
  for (const id of ids) if (!pending.has(id)) refusedAt.delete(id);
}

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
      `SELECT w.evidence_json AS evidence_json, w.measure_json AS measure_json, w.measure_remaining AS measure_remaining
         FROM work w WHERE ${taskScope('w')} AND w.id = ? AND ${unvalidatedCloseExpr('w')}`,
    ).get(taskId) as { evidence_json: string | null; measure_json: string | null; measure_remaining: number | null } | undefined;
    if (!row) return null;   // no close is pending: the validate door says so itself

    forgetSettledRefusals();
    const since = refusedAt.get(taskId);
    if (since !== undefined) {
      // Refused before: only a read of THIS row's work made after that refusal lets the uphold stand.
      if (readsBoundToRow(readsSince(pmAgentId, since), taskId)) { refusedAt.delete(taskId); return null; }
      logger.info('PM uphold refused again: this row\'s work has not been read since the refusal', { taskId, pmAgentId, turn }, pmAgentId);
      return emptyRecordFacts(row, taskId);
    }
    const looked = lookedAtThisTurn(pmAgentId, turn, taskId);
    if (closeBacking(looked, taskId).backed) return null;

    refusedAt.set(taskId, Date.now());
    logger.info('PM uphold refused: nothing on record backs the close', { taskId, pmAgentId, turn }, pmAgentId);
    return emptyRecordFacts(row, taskId);
  } catch (err) {
    // A ruling is never held up by this check's own failure to read.
    logger.warn('empty-uphold check could not read the record; the ruling goes through', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The facts of an empty record, one sentence each. */
function emptyRecordFacts(row: { evidence_json: string | null; measure_json: string | null; measure_remaining: number | null }, taskId: string): string {
  const measure = !row.measure_json ? 'No measure is set.'
    : row.measure_remaining === null ? 'Its measure could not be read.'
      : `Its measure reads ${row.measure_remaining.toLocaleString('en-US')} remaining, with no remainder named.`;
  // The one answer definition (`taskAnswerFor`). A refusal only ever reaches here with none on record, so
  // the sentence states that and nothing that could contradict it (review M2).
  const answer = taskAnswerFor(taskId);
  const delivered = !answer ? 'No delivered answer is on record for it.'
    : `The delivered answer on record (${answer.messageId ? `message ${answer.messageId.slice(0, 8)}` : `delivery ${answer.deliveryId.slice(0, 8)}`}) has not been shown to you in a review.`;
  let pointers: string[] = [];
  try {
    const ev = JSON.parse(row.evidence_json ?? '[]') as Array<{ pointer?: unknown }>;
    pointers = Array.isArray(ev) ? ev.map((e) => (typeof e?.pointer === 'string' ? e.pointer.trim() : '')).filter(Boolean) : [];
  } catch { /* no readable evidence: nothing named */ }
  // C8 (owner ruling (a)): a line the Dojo itself held back is said as that, never as the agent doing nothing.
  const held = heldDeliveryLine(taskId).replace(/^\n\s*/, '');
  return 'Refused: nothing on record shows this work. '
    + 'The ledger for this task is empty (no files written, no commands run, no items touched). '
    + `${measure} ${delivered ? `${delivered} ` : ''}`
    + (held ? `${held} ` : '')
    + 'Nothing of the work itself has been read since the close was filed. '
    + (pointers.length > 0 ? `The worker's evidence names: ${pointers.join(', ')}. ` : '')
    + 'Read the work (the files or the messages it names) before ruling.';
}
