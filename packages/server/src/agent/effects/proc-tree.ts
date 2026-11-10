// THE PROCESS TREE A TOOL STARTED, AND THE OWNER'S STOP: proc.ts spawns (as group leader), this binds
// those spawns to the agent's stop and signals whole trees. No child_process import: it only signals.

import { untilUserStop } from '../stop-waiters.js';
import { dojoDir } from '../../home.js';
import { recordToolboxGroups, groupIsOurs, type GroupEntry } from './toolbox-ledger.js';
import { identityOfPid, membersOfGroupAsync } from '../../process-identity.js';

// THE OWNER'S STOP REACHES EVERY PROCESS THE TOOLBOX STARTED: every spawned child waits on the stop while
// it lives, and a thrown turn's teardown ends what it left running; SIGTERM to the group first (a process
// mid-write deserves its syscall), then SIGKILL to whatever ignored it. The wait is stop-waiters, not the
// abort registry: a barge-in cuts model calls, never a running command.

// A registry slot would read as live movement, so a wedged command would never count as silent.
export const KILL_GRACE_MS = 3_000;

/** Every process group this door has started and that may still have members. */
const toolboxGroups = new Set<number>();
const groupIdentity = new Map<number, string>();
/** The members seen in a group when its leader exited: what proves a leaderless group is still ours. */
const groupMembers = new Map<number, string[]>();
let exitHooked = false;

/** The members of a spawned child this module touches: structural, so it holds no `child_process`. */
export interface ProcessTreeRoot {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): unknown;
  once(ev: 'close' | 'error' | 'exit', cb: () => void): unknown;
}

/** Signal a child AND everything it started. Falls back to the child alone if it has no group. */
export function signalProcessTree(child: Pick<ProcessTreeRoot, 'pid' | 'kill'>, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, signal); return; } catch { /* the group is gone, or never formed */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/** Each agent's commands that have not ended yet, as the cut that ends one. A thrown turn ends these. */
const running = new Map<string, Set<() => void>>();
/** The cut that ends each running child, by pid, so a backgrounded command can be found again. */
const cutByPid = new Map<number, { agentId: string; cut: () => void }>();
// The agent's BACKGROUND jobs, not a turn's: a later turn spares them; the Stop and exit still end them.
const background = new Map<string, Map<number, { what: string; startedAt: number }>>();

export function endsWithTheStop(agentId: string, child: ProcessTreeRoot): () => void {
  if (child.pid !== undefined) {
    const pgid = child.pid;
    rememberGroup(pgid);
    child.once('exit', () => noteSurvivors(pgid));
  }
  let over = false;
  let kill: ReturnType<typeof setTimeout> | null = null;
  const cut = (): void => {
    if (over) return;
    signalProcessTree(child, 'SIGTERM');
    // One escalation per child: every caller reuses this cut; a second call must not arm a second timer.
    kill ??= setTimeout(() => signalProcessTree(child, 'SIGKILL'), KILL_GRACE_MS).unref();
  };
  const wait = untilUserStop(agentId);
  if (wait.already) { cut(); return cut; }
  let cuts = running.get(agentId);
  if (!cuts) { cuts = new Set(); running.set(agentId, cuts); }
  cuts.add(cut);
  if (child.pid !== undefined) cutByPid.set(child.pid, { agentId, cut });
  void wait.stopped.then(cut);
  const settle = (): void => {
    over = true;
    if (kill) clearTimeout(kill);   // the child is gone: no kill timer may outlive it
    wait.dispose();
    cuts.delete(cut);
    if (cuts.size === 0 && running.get(agentId) === cuts) running.delete(agentId);
    if (child.pid !== undefined) {
      cutByPid.delete(child.pid);
      const jobs = background.get(agentId);
      jobs?.delete(child.pid);
      if (jobs && jobs.size === 0) background.delete(agentId);
    }
  };
  child.once('close', settle);
  child.once('error', settle);
  return cut;
}

// pid's command is now a background job, out of the turn's cut set; false if no running command matches it.
export function handToBackground(agentId: string, pid: number, what: string): boolean {
  const entry = cutByPid.get(pid);
  if (!entry || entry.agentId !== agentId) return false;
  const cuts = running.get(agentId);
  cuts?.delete(entry.cut);
  if (cuts && cuts.size === 0) running.delete(agentId);
  let jobs = background.get(agentId);
  if (!jobs) { jobs = new Map(); background.set(agentId, jobs); }
  jobs.set(pid, { what, startedAt: Date.now() });
  return true;
}

export function backgroundCommandsOf(agentId: string): Array<{ pid: number; what: string; startedAt: number }> {
  return [...(background.get(agentId) ?? new Map())].map(([pid, j]) => ({ pid, ...j }));
}

/** A turn that threw is over: end whatever it left running for this agent. Returns how many. */
export function endAgentCommands(agentId: string): number {
  const cuts = running.get(agentId);
  if (!cuts) return 0;
  for (const cut of [...cuts]) cut();
  return cuts.size;
}

function rememberGroup(pgid: number): void {
  for (const g of toolboxGroups) {
    try { process.kill(-g, 0); } catch { toolboxGroups.delete(g); groupIdentity.delete(g); groupMembers.delete(g); }
  }
  if (!exitHooked) { exitHooked = true; process.once('exit', endToolboxGroups); }
  toolboxGroups.add(pgid);
  const identity = identityOfPid(pgid);
  if (identity !== null) groupIdentity.set(pgid, identity);
  writeLedger();
}

/** A hard kill runs no exit hook: this file's ledger is what the next boot ends. */
function writeLedger(): void {
  const entries: GroupEntry[] = [...groupIdentity].map(([g, identity]) => ({ pgid: g, identity, members: groupMembers.get(g) }));
  recordToolboxGroups(dojoDir('data'), entries);
}

/** Leader exited: note who remains (pid + start time) so the next boot can tell a reused id apart. */
function noteSurvivors(pgid: number): void {
  if (!groupIdentity.has(pgid)) return;
  try { process.kill(-pgid, 0); } catch { return; }
  void membersOfGroupAsync(pgid).then((members) => {
    if (members.length === 0 || !groupIdentity.has(pgid)) return;
    groupMembers.set(pgid, members);
    writeLedger();
  });
}

export function endToolboxGroups(): void {
  for (const g of toolboxGroups) {
    // A quiet stretch can outlast the id: signal only a group still provably the one this door started.
    const identity = groupIdentity.get(g);
    if (identity === undefined || !groupIsOurs(g, identity, groupMembers.get(g))) continue;
    try { process.kill(-g, 'SIGTERM'); } catch { /* already gone */ }
  }
  toolboxGroups.clear();
  groupIdentity.clear();
  groupMembers.clear();
  recordToolboxGroups(dojoDir('data'), []);
}
