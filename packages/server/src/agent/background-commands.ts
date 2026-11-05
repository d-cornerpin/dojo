// ════════════════════════════════════════════════════════════════════════════
// COMMANDS HANDED TO THE BACKGROUND, ON RECORD (field fix 3, re-review 3 M2; re-review 4).
//
// When a person's message arrives during a long command, the exec door hands the call back and the
// command keeps running as the agent's background job (`effects/proc-tree.ts` handToBackground). The
// hand-back text promises the agent the result. A Dojo restart ends every command the toolbox started
// (`proc-tree.ts` endToolboxGroups on exit, `toolbox-ledger.ts` at the next boot), so that promise
// cannot be kept. Each hand-off is therefore a row of `background_commands` (migration 213) while it
// runs, removed only after its result is saved for the agent; whatever is still there at boot was cut
// by the restart, and its agent is told that fact on its next turn.
//
// Re-review 4: this was a JSON file in the data folder. SQLite is the only datastore (architecture
// rule 5), and a row write is atomic where a file rewrite was not. A file left by the build before is
// read once at boot, told, and deleted (after its notices are saved, re-review 5).
//
// Re-review 5 (P1): the row is also the task ledger's link (migration 214). It carries the call id
// that was handed back; the ledger writes that call's command "still running", and when the command
// ends the row's own completion settles the ledger row by call id. A command that ended before the
// ledger write keeps its status here until that write takes it. At boot, every ledger row still
// running is settled as ended by the restart, in the same transaction as its notice.
// ════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { dojoDir } from '../home.js';
import { createLogger } from '../logger.js';
import { ENDED_BY_RESTART, settleLedgerCommandByCall, ledgerHasCall, settleEveryStillRunningAsRestart } from '../work/command-status.js';

const logger = createLogger('background-commands');
/** The file the record used to be (re-review 3); read once at boot if a box still has it. */
export const LEGACY_BACKGROUND_COMMANDS_FILE = 'background-commands.json';

export interface HandedOff { agentId: string; pid: number; what: string; startedAt: number; callId?: string | null }

/** A command was handed to the background: on record until its result is saved. Returns the row id. */
export function recordHandOff(entry: HandedOff): string | null {
  try {
    const id = uuidv4();
    getDb().prepare('INSERT INTO background_commands (id, agent_id, pid, what, started_at, call_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, entry.agentId, entry.pid, entry.what, entry.startedAt, entry.callId ?? null);
    return id;
  } catch (err) {
    logger.warn('the background-command record could not be written', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The command ended with `exitStatus` (already redacted): its ledger row, if written, takes it now;
 *  otherwise the hand-off keeps it for the ledger write to take. One transaction. */
export function settleHandOff(id: string, exitStatus: string): void {
  try {
    const db = getDb();
    db.transaction(() => {
      const row = db.prepare('SELECT call_id AS callId FROM background_commands WHERE id = ?').get(id) as { callId: string | null } | undefined;
      if (row?.callId) settleLedgerCommandByCall(db, row.callId, exitStatus);
      db.prepare('UPDATE background_commands SET exit_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(exitStatus, id);
    })();
  } catch (err) {
    logger.warn('a background command\'s status could not be settled', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Its result was saved for the agent. Off the record, unless a ledger write may still come for a
 *  command that ended before it: then kept (result saved) until that write takes it, or the next boot. */
export function endHandOff(id: string): void {
  try {
    const db = getDb();
    db.transaction(() => {
      const row = db.prepare('SELECT call_id AS callId FROM background_commands WHERE id = ?').get(id) as { callId: string | null } | undefined;
      const ledgerHasIt = !row?.callId || ledgerHasCall(db, row.callId);
      if (ledgerHasIt) db.prepare('DELETE FROM background_commands WHERE id = ?').run(id);
      else db.prepare('UPDATE background_commands SET result_saved = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    })();
  } catch { /* the boot notice then over-tells, never under-tells */ }
}

/** The hand-off of tool call `callId`, for the ledger write (`work/ledger-store.ts`): its exit status
 *  (null while it runs). Null when the call was not handed back. */
export function handOffForCall(callId: string): { id: string; exitStatus: string | null } | null {
  try {
    const r = getDb().prepare('SELECT id, exit_status AS exitStatus FROM background_commands WHERE call_id = ? LIMIT 1').get(callId) as { id: string; exitStatus: string | null } | undefined;
    return r ?? null;
  } catch { return null; }
}

/** The ledger wrote an ended hand-off's status: off the record once its result is also saved. */
export function ledgerTookHandOff(id: string): void {
  try { getDb().prepare('DELETE FROM background_commands WHERE id = ? AND result_saved = 1').run(id); } catch { /* cleared at the next boot */ }
}

/** The words the agent is told about a hand-off a restart cut. */
export function cutByRestartText(r: HandedOff): string {
  return `Dojo: the command you handed to the background at ${new Date(r.startedAt).toISOString()}${r.pid > 0 ? ` (pid ${r.pid})` : ''}, ${r.what}, `
    + 'was ended by a Dojo restart before it finished. Its result will not come. If the work still matters, run it again.';
}

/** The file the build before kept, read once. Deleted by the caller only after its notices are saved. */
function legacyRows(): { rows: HandedOff[]; remove(): void } {
  const file = dojoDir('data', LEGACY_BACKGROUND_COMMANDS_FILE);
  const none = { rows: [], remove: () => {} };
  if (!fs.existsSync(file)) return none;
  let rows: HandedOff[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    rows = Array.isArray(parsed) ? parsed.filter((r): r is HandedOff => !!r && typeof (r as HandedOff).agentId === 'string' && typeof (r as HandedOff).pid === 'number') : [];
  } catch { rows = []; }
  return { rows, remove: () => { try { fs.rmSync(file, { force: true }); } catch { /* read again next boot */ } } };
}

/** At boot: every hand-off still running on record was cut by the restart. Tell each agent, settle its
 *  ledger row as ended by the restart, and clear it, in one transaction. Then no ledger row is left
 *  "still running": after a restart, no command the toolbox started is. */
export async function tellAgentsOfCommandsCutByRestart(): Promise<number> {
  const db = getDb();
  const rows = db.prepare(`SELECT id, agent_id AS agentId, pid, what, started_at AS startedAt, call_id AS callId,
                                  exit_status AS exitStatus, result_saved AS resultSaved
                           FROM background_commands ORDER BY started_at`)
    .all() as Array<HandedOff & { id: string; exitStatus: string | null; resultSaved: number }>;
  const legacy = legacyRows();
  if (rows.length === 0 && legacy.rows.length === 0) {
    settleEveryStillRunningAsRestart(db);
    return 0;
  }
  const { postAgentNotice } = await import('./agent-notice.js');
  const tell = db.transaction((r: HandedOff & { id?: string; exitStatus?: string | null; resultSaved?: number }) => {
    // Ended before the restart and its result saved: only a ledger write was still to come. Nothing to tell.
    const ended = r.exitStatus !== null && r.exitStatus !== undefined;
    if (!(ended && r.resultSaved)) {
      const brief = ended
        ? `Dojo: the command you handed to the background, ${r.what}, ended (${r.exitStatus}) just before a Dojo restart, and its result could not be handed to you. If the work still matters, run it again.`
        : cutByRestartText(r);
      if (!postAgentNotice({ toAgentId: r.agentId, fromName: 'Dojo restart', brief, selfIntro: false })) throw new Error('the notice was not saved');
    }
    if (r.callId && !ended) settleLedgerCommandByCall(db, r.callId, ENDED_BY_RESTART);
    if (r.id) db.prepare('DELETE FROM background_commands WHERE id = ?').run(r.id);   // cleared only with its notice saved
  });
  let told = 0;
  let legacyAllTold = true;
  for (const r of rows) {
    try { tell(r); if (!(r.exitStatus !== null && r.resultSaved)) told++; } catch (err) {
      logger.warn('could not tell an agent its background command was cut', { agentId: r.agentId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const r of legacy.rows) {
    try { tell(r); told++; } catch (err) {
      legacyAllTold = false;
      logger.warn('could not tell an agent its background command was cut', { agentId: r.agentId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Re-review 5 (LOW): the old file goes only once every one of its notices is saved.
  if (legacyAllTold) legacy.remove();
  // Any ledger row still running has no hand-off left to settle it (its record failed, or the file era).
  settleEveryStillRunningAsRestart(db);
  return told;
}
