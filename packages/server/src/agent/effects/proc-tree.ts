// ════════════════════════════════════════════════════════════════════════════
// THE PROCESS TREE A TOOL STARTED, AND THE OWNER'S STOP (t203, B6).
//
// A leaf beside the process facade: `proc.ts` decides nothing new and spawns as before (now as
// the leader of its own process group); this module binds what it spawned to the agent's stop
// and knows how to signal the whole tree. It holds no `child_process` import — it only signals
// processes somebody else was authorized to start.
// ════════════════════════════════════════════════════════════════════════════

import { openAgentCall } from '../abortable-call.js';

// ════════════════════════════════════════
// t203 (B6) — THE OWNER'S STOP REACHES EVERY PROCESS THE TOOLBOX STARTED.
//
// Before this, nothing a tool spawned was known to the stop: `stopAgent` aborts the abort
// registry, and no child was in it. Every child that comes through this door now holds a slot
// there (via `spawnAuthorized`, the toolbox's one spawn door) for as long as it lives, so the stop (and the turn's own teardown, for a call the
// executor abandoned) ends it. SIGTERM to the whole group first — a process mid-write deserves
// its syscall — then SIGKILL to whatever ignored it. The grace is the kill's own escalation,
// not a bound on the work: nothing is killed here that the owner (or the turn ending) did not
// already cut.
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

export function endsWithTheStop(agentId: string, child: ProcessTreeRoot): void {
  const slot = openAgentCall(agentId, 'turn');
  if (child.pid !== undefined) rememberGroup(child.pid);
  const cut = (): void => {
    signalProcessTree(child, 'SIGTERM');
    setTimeout(() => signalProcessTree(child, 'SIGKILL'), KILL_GRACE_MS).unref();
  };
  if (slot.signal.aborted) cut();
  else slot.signal.addEventListener('abort', cut, { once: true });
  child.once('close', () => slot.release());
  child.once('error', () => slot.release());
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
