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
// read once at boot, told, and deleted.
// ════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { dojoDir } from '../home.js';
import { createLogger } from '../logger.js';

const logger = createLogger('background-commands');
/** The file the record used to be (re-review 3); read once at boot if a box still has it. */
export const LEGACY_BACKGROUND_COMMANDS_FILE = 'background-commands.json';

export interface HandedOff { agentId: string; pid: number; what: string; startedAt: number }

/** A command was handed to the background: on record until its result is saved. Returns the row id. */
export function recordHandOff(entry: HandedOff): string | null {
  try {
    const id = uuidv4();
    getDb().prepare('INSERT INTO background_commands (id, agent_id, pid, what, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, entry.agentId, entry.pid, entry.what, entry.startedAt);
    return id;
  } catch (err) {
    logger.warn('the background-command record could not be written', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Its result was saved for the agent: off the record. */
export function endHandOff(id: string): void {
  try { getDb().prepare('DELETE FROM background_commands WHERE id = ?').run(id); } catch { /* the boot notice then over-tells, never under-tells */ }
}

/** The words the agent is told about a hand-off a restart cut. */
export function cutByRestartText(r: HandedOff): string {
  return `Dojo: the command you handed to the background at ${new Date(r.startedAt).toISOString()} (pid ${r.pid}), ${r.what}, `
    + 'was ended by a Dojo restart before it finished. Its result will not come. If the work still matters, run it again.';
}

function legacyRows(): HandedOff[] {
  const file = dojoDir('data', LEGACY_BACKGROUND_COMMANDS_FILE);
  if (!fs.existsSync(file)) return [];
  let rows: HandedOff[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    rows = Array.isArray(parsed) ? parsed.filter((r): r is HandedOff => !!r && typeof (r as HandedOff).agentId === 'string' && typeof (r as HandedOff).pid === 'number') : [];
  } catch { rows = []; }
  try { fs.rmSync(file, { force: true }); } catch { /* told once is enough; a leftover file is read again next boot */ }
  return rows;
}

/** At boot: every hand-off still on record was cut by the restart. Tell each agent, then clear it. */
export async function tellAgentsOfCommandsCutByRestart(): Promise<number> {
  const db = getDb();
  const rows = db.prepare('SELECT id, agent_id AS agentId, pid, what, started_at AS startedAt FROM background_commands ORDER BY started_at')
    .all() as Array<HandedOff & { id: string }>;
  const legacy = legacyRows();
  if (rows.length === 0 && legacy.length === 0) return 0;
  const { postAgentNotice } = await import('./agent-notice.js');
  const tell = db.transaction((r: HandedOff & { id?: string }) => {
    if (!postAgentNotice({ toAgentId: r.agentId, fromName: 'Dojo restart', brief: cutByRestartText(r), selfIntro: false })) throw new Error('the notice was not saved');
    if (r.id) db.prepare('DELETE FROM background_commands WHERE id = ?').run(r.id);   // cleared only with its notice saved
  });
  let told = 0;
  for (const r of [...rows, ...legacy]) {
    try { tell(r); told++; } catch (err) {
      logger.warn('could not tell an agent its background command was cut', { agentId: r.agentId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return told;
}
