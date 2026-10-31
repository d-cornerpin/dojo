// ════════════════════════════════════════════════════════════════════════════
// THE LEDGER OF PROCESS GROUPS THE TOOLBOX STARTED (v3.5 P6c).
//
// A graceful exit signals every group the toolbox started (`proc-tree.ts`). A hard kill of
// the server runs no exit hook, so a process an agent backgrounded kept running with nobody
// holding it. The groups are therefore written to a small file as they start, and the next
// boot ends whatever that file still names and is still alive.
//
// A group id can be reused by an unrelated process once the machine has rebooted, so the file
// carries the machine's boot time and is ignored when that differs. It holds no `child_process`
// import: it only signals groups somebody else was authorized to start.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identityOfPid } from '../../process-identity.js';
import { homeDir } from '../../home.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('toolbox-ledger');

const FILE = 'toolbox-groups.json';
/** Boot times read at two moments differ by clock rounding; a reboot differs by far more. */
const BOOT_SLACK_MS = 5_000;

/** A group's leader as it was when started: a reused id never matches both fields. */
export interface GroupEntry { pgid: number; identity: string }

type Send = (pgid: number, signal: NodeJS.Signals | 0) => void;

export function machineBootMs(): number { return Math.round(Date.now() - os.uptime() * 1000); }

const realSend: Send = (pgid, signal) => { process.kill(pgid, signal); };

/** Replace the ledger with these groups (an empty list removes it). Best effort: never throws. */
export function recordToolboxGroups(dir: string, groups: GroupEntry[], bootMs: number = machineBootMs()): void {
  const file = path.join(dir, FILE);
  try {
    if (groups.length === 0) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ boot: bootMs, groups }));
  } catch { /* the ledger is a safety net; losing it must not break a tool call */ }
}

/** At boot: end every still-living group the ledger names, then clear it. */
export function reapLeftoverToolboxGroups(
  opts: { dir: string; bootMs?: number; send?: Send; graceMs?: number; identityOf?: (pid: number) => string | null },
): { ended: number[] } {
  const file = path.join(opts.dir, FILE);
  const send = opts.send ?? realSend;
  const ended: number[] = [];
  let groups: GroupEntry[] = [];
  const identityOf = opts.identityOf ?? identityOfPid;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { boot?: unknown; groups?: unknown };
    const bootNow = opts.bootMs ?? machineBootMs();
    if (typeof raw.boot === 'number' && Math.abs(raw.boot - bootNow) <= BOOT_SLACK_MS && Array.isArray(raw.groups)) {
      groups = (raw.groups as Array<Partial<GroupEntry>>).filter((g): g is GroupEntry =>
        !!g && Number.isInteger(g.pgid) && (g.pgid as number) > 1 && typeof g.identity === 'string' && g.identity !== '');
    }
  } catch { /* no ledger, or an unreadable one: nothing to end */ }
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  for (const { pgid: g, identity } of groups) {
    // Signal only the very process that was recorded: same start time AND command. A reused id, or a
    // leader that has since exited, is dropped, never signalled.
    if (identityOf(g) !== identity) continue;
    try { send(-g, 0); } catch { continue; }   // already gone
    try { send(-g, 'SIGTERM'); ended.push(g); } catch { continue; }
    setTimeout(() => { try { send(-g, 'SIGKILL'); } catch { /* gone */ } }, opts.graceMs ?? 3_000).unref();
  }
  return { ended };
}

/** The boot call: the ledger lives under the data folder. Never throws. */
export function reapToolboxGroupsAtBoot(): void {
  try {
    const { ended } = reapLeftoverToolboxGroups({ dir: path.join(homeDir(), 'data') });
    if (ended.length > 0) logger.warn(`Boot: ended ${ended.length} process group(s) the toolbox started before the last hard kill`);
  } catch { /* best effort */ }
}
