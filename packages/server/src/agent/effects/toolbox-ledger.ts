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
import { identityOfPid, membersOfGroup } from '../../process-identity.js';
import { dojoDir } from '../../home.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('toolbox-ledger');

const FILE = 'toolbox-groups.json';
/** Boot times read at two moments differ by clock rounding; a reboot differs by far more. */
const BOOT_SLACK_MS = 5_000;

/** A group's leader as it was when started (`ps` start time, then command): a reused id never matches both. */
export interface GroupEntry {
  pgid: number; identity: string;
  /** Members ("pid lstart") seen in the group when its leader exited: how a leaderless group is recognised. */
  members?: string[];
}

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

/** True when a member the toolbox noted in this group is still alive in it. */
function noteSurvives(pgid: number, noted: string[] | undefined, membersOf: (pgid: number) => string[]): boolean {
  if (!noted || noted.length === 0) return false;
  const now = new Set(membersOf(pgid));
  return noted.some((m) => now.has(m));
}

/** At boot: end every still-living group the ledger names, then clear it. */
export function reapLeftoverToolboxGroups(
  opts: { dir: string; bootMs?: number; send?: Send; graceMs?: number; identityOf?: (pid: number) => string | null;
    membersOf?: (pgid: number) => string[] },
): { ended: number[] } {
  const file = path.join(opts.dir, FILE);
  const send = opts.send ?? realSend;
  const ended: number[] = [];
  let groups: GroupEntry[] = [];
  const identityOf = opts.identityOf ?? identityOfPid;
  const membersOf = opts.membersOf ?? membersOfGroup;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { boot?: unknown; groups?: unknown };
    const bootNow = opts.bootMs ?? machineBootMs();
    if (typeof raw.boot === 'number' && Math.abs(raw.boot - bootNow) <= BOOT_SLACK_MS && Array.isArray(raw.groups)) {
      groups = (raw.groups as Array<Partial<GroupEntry>>).filter((g): g is GroupEntry =>
        !!g && Number.isInteger(g.pgid) && (g.pgid as number) > 1 && typeof g.identity === 'string' && g.identity !== ''
        && (g.members === undefined || (Array.isArray(g.members) && g.members.every((m) => typeof m === 'string'))));
    }
  } catch { /* no ledger, or an unreadable one: nothing to end */ }
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  for (const { pgid: g, identity, members } of groups) {
    // Signal only a group that is provably the recorded one. Leader alive: it must be the very process
    // recorded (same start time AND command), else the id was reused and is dropped. Leader gone: a
    // one-shot script exits at once and leaves what it backgrounded running in the group, so the toolbox
    // noted the members it saw (pid + start time) when the leader exited; the group is ours only while
    // one of THOSE is still in it. A reused id, even one whose own leader has since exited, never matches.
    const now = identityOf(g);
    if (now !== null ? now !== identity : !noteSurvives(g, members, membersOf)) continue;
    try { send(-g, 0); } catch { continue; }   // already gone
    try { send(-g, 'SIGTERM'); ended.push(g); } catch { continue; }
    setTimeout(() => { try { send(-g, 'SIGKILL'); } catch { /* gone */ } }, opts.graceMs ?? 3_000).unref();
  }
  return { ended };
}

/** The boot call: the ledger lives under the data folder. Never throws. */
export function reapToolboxGroupsAtBoot(): void {
  try {
    const { ended } = reapLeftoverToolboxGroups({ dir: dojoDir('data') });
    if (ended.length > 0) logger.warn(`Boot: ended ${ended.length} process group(s) the toolbox started before the last hard kill`);
  } catch { /* best effort */ }
}
