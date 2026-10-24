// ════════════════════════════════════════════════════════════════════════════
// THE PROCESS FACADE (PHASE-5 T8 Step 2) — the entry that SPAWNS the program.
//
// `agent/brokers/proc.ts` answers *may this agent run this?* — the allow list,
// the global denies, the shell-interpreter refusal, the tokenized sensitive-read
// scan. This module runs it. **The broker DECIDES, the facade CARRIES.**
//
// The authorization it requires is the PROGRAM the gate loop resolved out of the
// call's own declaration: `exec` declares `proc from args.argv` (the program is
// `argv[0]`) and `shell` declares `shell from args.script` (the program is the
// one interpreter, `/bin/zsh`). A handler that reached for a different binary —
// the residual this task closes — is refused here, because the capability does
// not name it.
//
// This is the ONE `child_process` call in the toolbox and it stays one: both
// exec doors already shared `runProcess`, and now `runProcess` is the only thing
// that spawns.
// ════════════════════════════════════════════════════════════════════════════

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { requireAuthorized } from './capability.js';
import { endsWithTheStop } from './proc-tree.js';

/**
 * `spawn(file, argv)` behind the capability — the toolbox's ONE process door.
 *
 * v3.5 E19: the buffered sibling (`execFileAuthorized`) is deleted. It had no production caller
 * after t114 moved the exec door to this streaming form, and a door nothing uses is a second door
 * waiting to be reached for. The program still has to be one the gate loop resolved from this
 * call's own declaration.
 *
 * No shell, exactly as `execFile` uses none — `spawn` without `shell: true`
 * hands argv straight to `execve`.
 */
export function spawnAuthorized(
  file: string,
  argv: readonly string[],
  options?: { cwd?: string },
): ChildProcessWithoutNullStreams {
  const { agentId } = requireAuthorized({ op: 'proc', program: file });
  // t114: `cwd` is forwarded so the exec door can reach this streaming form without losing the
  // working directory it has always honoured. Still no `shell` — `spawn` without `shell: true`
  // hands argv straight to `execve`, which is the whole argv-no-shell property of both doors.
  // t203: `detached` makes the child the leader of its OWN process group, so the owner's Stop and
  // the idle clock can end the whole tree it starts, not just the first process (`proc-tree.ts`).
  const child = spawn(file, [...argv], { ...(options?.cwd ? { cwd: options.cwd } : {}), detached: true });
  endsWithTheStop(agentId, child);
  return child;
}
