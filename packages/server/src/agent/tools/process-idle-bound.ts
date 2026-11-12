// The toolbox's process door under an output-idle bound; the clock itself lives in `child-idle-bound.ts`.

import { spawnAuthorized } from '../effects/proc.js';
import { signalProcessTree } from '../effects/proc-tree.js';
import { attachIdleBound, type ChildRunFailure, type WatchableChild } from '../../child-idle-bound.js';

export type { ChildRunFailure };

/** Capability-gated spawn; rejects with an `execFile`-shaped error, one failure shape for callers. */
export async function runWithIdleBound(
  file: string, argv: readonly string[],
  opts: { idleMs: number; ceilingMs?: number; cwd?: string; onSpawn?: (pid: number) => void },
): Promise<{ stdout: string; stderr: string }> {
  const child = spawnAuthorized(file, argv, opts.cwd ? { cwd: opts.cwd } : undefined);
  if (child.pid !== undefined) opts.onSpawn?.(child.pid);   // the handle the hand-off needs
  // Kill the WHOLE tree: a background job left alive would hold the pipe and the run would never return.
  const tree: WatchableChild = {
    stdout: child.stdout,
    stderr: child.stderr,
    on: ((ev: string, cb: (...a: unknown[]) => void) => child.on(ev, cb)) as WatchableChild['on'],
    kill: (signal) => signalProcessTree(child, signal ?? 'SIGTERM'),
  };
  return attachIdleBound(tree, { idleMs: opts.idleMs, ...(opts.ceilingMs !== undefined ? { ceilingMs: opts.ceilingMs } : {}) });
}
