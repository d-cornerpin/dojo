// ════════════════════════════════════════════════════════════════════════════
// COMMANDS HANDED TO THE BACKGROUND, ON DISK (field fix 3, re-review 3, M2).
//
// When a person's message arrives during a long command, the exec door hands the call back and the
// command keeps running as the agent's background job (`effects/proc-tree.ts` handToBackground). The
// hand-back text promises the agent the result. A Dojo restart ends every command the toolbox started
// (`proc-tree.ts` endToolboxGroups on exit, `toolbox-ledger.ts` at the next boot), so that promise
// cannot be kept, and the agent would wait for a result that never comes. Each hand-off is therefore
// written here while it runs and removed when its result is handed over; whatever this file still
// names at boot was cut by the restart, and its agent is told that fact on its next turn.
// ════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { dojoDir } from '../home.js';
import { createLogger } from '../logger.js';

const logger = createLogger('background-commands');
export const BACKGROUND_COMMANDS_FILE = 'background-commands.json';

export interface HandedOff { agentId: string; pid: number; what: string; startedAt: number }

const file = (): string => dojoDir('data', BACKGROUND_COMMANDS_FILE);

function readAll(): HandedOff[] {
  try {
    const rows = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown;
    return Array.isArray(rows) ? rows.filter((r): r is HandedOff => !!r && typeof (r as HandedOff).agentId === 'string' && typeof (r as HandedOff).pid === 'number') : [];
  } catch { return []; }
}

function writeAll(rows: HandedOff[]): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(rows));
  } catch (err) {
    logger.warn('the background-command record could not be written', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** A command was handed to the background: remember it until its result is handed over. */
export function recordHandOff(entry: HandedOff): void {
  writeAll([...readAll().filter((r) => r.pid !== entry.pid), entry]);
}

/** Its result was handed over (or it ended some other way the agent was told of): forget it. */
export function endHandOff(pid: number): void {
  const rows = readAll();
  if (rows.some((r) => r.pid === pid)) writeAll(rows.filter((r) => r.pid !== pid));
}

/** The words the agent is told about a hand-off a restart cut. */
export function cutByRestartText(r: HandedOff): string {
  return `Dojo: the command you handed to the background at ${new Date(r.startedAt).toISOString()} (pid ${r.pid}), ${r.what}, `
    + 'was ended by a Dojo restart before it finished. Its result will not come. If the work still matters, run it again.';
}

/** At boot: every hand-off still on record was cut by the restart. Tell each agent, then clear the record. */
export async function tellAgentsOfCommandsCutByRestart(): Promise<number> {
  const rows = readAll();
  if (rows.length === 0) return 0;
  const { postAgentNotice } = await import('./agent-notice.js');
  for (const r of rows) {
    try {
      postAgentNotice({ toAgentId: r.agentId, fromName: 'Dojo restart', brief: cutByRestartText(r), selfIntro: false });
    } catch (err) {
      logger.warn('could not tell an agent its background command was cut', { agentId: r.agentId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  writeAll([]);
  return rows.length;
}
