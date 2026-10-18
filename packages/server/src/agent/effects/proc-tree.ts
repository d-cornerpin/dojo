// ════════════════════════════════════════════════════════════════════════════
// THE PROCESS TREE A TOOL STARTED, AND THE OWNER'S STOP (t203, B6).
//
// A leaf beside the process facade: `proc.ts` decides nothing new and spawns as before (now as
// the leader of its own process group); this module binds what it spawned to the agent's stop
// and knows how to signal the whole tree. It holds no `child_process` import — it only signals
// processes somebody else was authorized to start.
// ════════════════════════════════════════════════════════════════════════════

import { untilUserStop } from '../stop-waiters.js';

// ════════════════════════════════════════
// t203 (B6) — THE OWNER'S STOP REACHES EVERY PROCESS THE TOOLBOX STARTED.
//
// Before this, nothing a tool spawned was known to the stop. Every child that comes through this
// door (via `spawnAuthorized`, the toolbox's one spawn door) now waits on the owner's stop for as
// long as it lives, so the stop (and the turn's own teardown, for a command a thrown turn left
// running) ends it. SIGTERM to the whole group first — a process mid-write deserves its syscall —
// then SIGKILL to whatever ignored it. The grace is the kill's own escalation, not a bound on the
// work: nothing is killed here that the owner (or the turn ending) did not already cut.
//
// t224 — THE WAIT IS A STOP WAITER, NOT AN ABORT-REGISTRY SLOT. t203 first held each child as a
// `turn`-scoped slot in the abort registry. That registry means "a model or media request is
// open", and two readers act on exactly that: liveness (an open request is movement RIGHT NOW,
// so a sub-agent wedged on a command that never exits was never SILENT and the owner was never
// told) and the urgent preempt (a running command made a barge-in arm `preemptedAgents` and cut
// the command along with the model call). `stop-waiters.ts` exists for what WAITS on the stop as
// opposed to what the stop ABORTS, so the child waits there, and the registry is again only the
// requests. The three doors that used to end a child through the registry, and what ends it now:
//   • the owner's stop (`stopAgent`, scope all)      -> `untilUserStop` (also born-stopped);
//   • the stuck-stopped-run reaper (scope all)       -> nothing new: it only follows a stop,
//                                                       which already ended the child;
//   • a thrown turn's teardown (scope turn)          -> `endAgentCommands` below, called there;
//   • the urgent preempt (scope turn)                -> deliberately NOT: a barge-in cuts the
//                                                       model call, never a running command.
//
// THE PROCESS GROUP IS WHAT MAKES "NO ORPHANS" TRUE. A shell script's pipeline, or a job it put
// in the background, is a child of the shell, not of the server; signalling only the shell
// left them running with nobody to hold them. And because a detached group no longer dies with
// the server's own group when the server exits, the groups this door started are signalled on
// the way out too (`toolboxGroups`), which keeps the old "a restart ends what the agents ran".
// ════════════════════════════════════════

const KILL_GRACE_MS = 3_000;

/** Every process group this door has started and that may still have members. */
const toolboxGroups = new Set<number>();
let exitHooked = false;

/** The members of a spawned child this module touches — structural, so it holds no `child_process`. */
export interface ProcessTreeRoot {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): unknown;
  once(ev: 'close' | 'error', cb: () => void): unknown;
}

/** Signal a child AND everything it started. Falls back to the child alone if it has no group. */
export function signalProcessTree(child: Pick<ProcessTreeRoot, 'pid' | 'kill'>, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, signal); return; } catch { /* the group is gone, or never formed */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/** Each agent's commands that have not ended yet, as the cut that ends one. */
const running = new Map<string, Set<() => void>>();

export function endsWithTheStop(agentId: string, child: ProcessTreeRoot): void {
  if (child.pid !== undefined) rememberGroup(child.pid);
  let over = false;
  const cut = (): void => {
    if (over) return;
    signalProcessTree(child, 'SIGTERM');
    setTimeout(() => signalProcessTree(child, 'SIGKILL'), KILL_GRACE_MS).unref();
  };
  const wait = untilUserStop(agentId);
  if (wait.already) { cut(); return; }
  let cuts = running.get(agentId);
  if (!cuts) { cuts = new Set(); running.set(agentId, cuts); }
  cuts.add(cut);
  void wait.stopped.then(cut);
  const settle = (): void => {
    over = true;
    wait.dispose();
    cuts.delete(cut);
    if (cuts.size === 0 && running.get(agentId) === cuts) running.delete(agentId);
  };
  child.once('close', settle);
  child.once('error', settle);
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
    try { process.kill(-g, 0); } catch { toolboxGroups.delete(g); }
  }
  if (!exitHooked) { exitHooked = true; process.once('exit', endToolboxGroups); }
  toolboxGroups.add(pgid);
}

function endToolboxGroups(): void {
  for (const g of toolboxGroups) {
    try { process.kill(-g, 'SIGTERM'); } catch { /* already gone */ }
  }
  toolboxGroups.clear();
}
