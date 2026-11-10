// THE LEDGER OF PROCESS GROUPS THE TOOLBOX STARTED: a graceful exit signals every group; a hard
// kill runs no exit hook, so groups are written as they start and the next boot ends what it names.
// A group id can be reused after a reboot, so the file carries the boot time and ignores itself when
// that differs. No child_process import here: it signals only groups somebody else authorized.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identityOfPid, membersOfGroup } from '../../process-identity.js';
import { dojoDir } from '../../home.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('toolbox-ledger');

export const TOOLBOX_LEDGER_FILE = 'toolbox-groups.json';
const FILE = TOOLBOX_LEDGER_FILE;
/** Boot times read at two moments differ by clock rounding; a reboot differs by far more. */
const BOOT_SLACK_MS = 5_000;

export interface GroupEntry {
  pgid: number; identity: string;
  /** Members ("pid lstart") seen when its leader exited: how a leaderless group is recognised. */
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

/** THE ONE TEST that a group is provably one the toolbox started (boot reap and the exit hook). */
/** Leader alive: it must be the very process recorded (start time AND command), else the id was reused. */
/** Leader gone: ours only while a member noted at exit (pid + start time) remains; reuse never matches. */
export function groupIsOurs(
  pgid: number, identity: string, noted: string[] | undefined,
  identityOf: (pid: number) => string | null = identityOfPid,
  membersOf: (pgid: number) => string[] = membersOfGroup,
): boolean {
  const now = identityOf(pgid);
  if (now !== null) return now === identity;
  if (!noted || noted.length === 0) return false;
  const present = new Set(membersOf(pgid));
  return noted.some((m) => present.has(m));
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
    if (!groupIsOurs(g, identity, members, identityOf, membersOf)) continue;
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
