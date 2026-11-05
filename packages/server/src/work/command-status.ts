// The words a command's ledger row carries for its exit status (the task ledger, `work/ledger-store.ts`).
// A leaf, shared by the ledger writer and the background hand-off (`agent/background-commands.ts`).
// The two ledger settles live here, inside work/, because the work spine has one writer
// (`work/__tests__/single-writer-conformance.test.ts`); the hand-off calls them.
import type Database from 'better-sqlite3';

/** While a command handed to the background runs (re-review 4, N4). */
export const STILL_RUNNING = 'still running';
/** A command a Dojo restart ended before it reported (re-review 5, P1a): after a restart nothing runs. */
export const ENDED_BY_RESTART = 'ended by a Dojo restart, no result';
/** A command whose outcome rejected: a failure with no reported status, never a clean exit. */
export const NO_RESULT_FAILURE = 'command_failed: ended without reporting a result';

/** A command's exit status, from the head of its result: the process runner (`agent/tools/process-run.ts`)
 *  leads a failed run with "command_failed: <reason>" and writes nothing of the kind on a clean exit. */
export function exitStatusOf(content: string): string {
  const m = /^command_failed: ([^\n]+)/.exec(content);
  return m ? m[1].trim() : 'exit 0';
}

/** A backgrounded command ended: the ledger row its call wrote, still running, takes `status`. A row
 *  written since by another call (the same command run again) keeps its newer status. */
export function settleLedgerCommandByCall(db: Database.Database, callId: string, status: string): void {
  db.prepare('UPDATE work_ledger SET detail = ? WHERE call_id = ? AND detail = ?').run(status, callId, STILL_RUNNING);
}

/** Has the call written a ledger row? */
export function ledgerHasCall(db: Database.Database, callId: string): boolean {
  return !!db.prepare('SELECT 1 FROM work_ledger WHERE call_id = ? LIMIT 1').get(callId);
}

/** At boot: no command the toolbox started survives a restart, so no ledger row is still running. */
export function settleEveryStillRunningAsRestart(db: Database.Database): void {
  db.prepare('UPDATE work_ledger SET detail = ? WHERE detail = ?').run(ENDED_BY_RESTART, STILL_RUNNING);
}
