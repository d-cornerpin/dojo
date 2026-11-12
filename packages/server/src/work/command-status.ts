// Exit-status words for a command's ledger row; the settles live in work/ because the spine has one writer.
import type Database from 'better-sqlite3';

export const STILL_RUNNING = 'still running';
/** A command a Dojo restart ended before it reported: after a restart nothing runs. */
export const ENDED_BY_RESTART = 'ended by a Dojo restart, no result';
/** A command whose outcome rejected: a failure with no reported status, never a clean exit. */
export const NO_RESULT_FAILURE = 'command_failed: ended without reporting a result';

/** Exit status from the head of a result: a failed run leads with `command_failed: <reason>`. */
export function exitStatusOf(content: string): string {
  const m = /^command_failed: ([^\n]+)/.exec(content);
  return m ? m[1].trim() : 'exit 0';
}

/** A row written since by another call (the same command run again) keeps its newer status. */
export function settleLedgerCommandByCall(db: Database.Database, callId: string, status: string): void {
  db.prepare('UPDATE work_ledger SET detail = ? WHERE call_id = ? AND detail = ?').run(status, callId, STILL_RUNNING);
}

export function ledgerHasCall(db: Database.Database, callId: string): boolean {
  return !!db.prepare('SELECT 1 FROM work_ledger WHERE call_id = ? LIMIT 1').get(callId);
}

/** At boot: no command the toolbox started survives a restart, so no ledger row is still running. */
export function settleEveryStillRunningAsRestart(db: Database.Database): void {
  db.prepare('UPDATE work_ledger SET detail = ? WHERE detail = ?').run(ENDED_BY_RESTART, STILL_RUNNING);
}
