// ════════════════════════════════════════════════════════════════════════════
// THE TOOLBOX'S PROCESS DOOR, UNDER AN OUTPUT-IDLE BOUND (t114, census U2).
//
// WHY THIS IS ITS OWN MODULE. The exec door's clock used to be one option on a buffered
// `execFile` call — `timeout`, a flat TOTAL duration that SIGTERMs the child at that wall-clock
// mark whatever it is doing. Replacing it with a bound on SILENCE needs a streaming run, which
// has nothing to do with the two exec doors' argument shapes, their per-stream caps or their
// failure wording. Left inline it took `process-run.ts` from 178 lines to 329 and the growth
// detector called it correctly: a file on its way to being a god file.
//
// WHAT IS LEFT HERE after the U14 round: only the two things that are specific to the TOOLBOX.
// The clock itself moved to `child-idle-bound.ts` once the updater and the installers needed the
// same mechanism, and that module deliberately takes an ALREADY-SPAWNED child — see its header.
// The split matters: the capability DECISION stays here, at a spawn site that goes through
// `agent/effects/proc.ts`, so this door still cannot reach a program the gate loop did not
// resolve for the running call. Sharing a spawn with platform code would have put a hole in
// exactly that guarantee.
//
// It is a LEAF, exactly as `process-run.ts` is: the process facade and the clock, nothing else,
// so it holds no judgement about which programs may run.
// ════════════════════════════════════════════════════════════════════════════

import { spawnAuthorized } from '../effects/proc.js';
import { attachIdleBound, type ChildRunFailure } from '../../child-idle-bound.js';

/** Re-exported so the exec door's failure translation keeps one name for the shape it reads. */
export type { ChildRunFailure };

/**
 * Run a child process under an OUTPUT-IDLE bound, through the capability facade. Resolves on a
 * clean exit; rejects with an `execFile`-shaped error otherwise, so every caller and every
 * failure string in `process-run.ts` is untouched.
 *
 * `idleMs` re-arms on each chunk from either stream. `ceilingMs` does not re-arm — it is the one
 * bound on total life, and the two are distinguished in the rejection so the agent is told which
 * one ended its command rather than a single ambiguous "timed out".
 */
export async function runWithIdleBound(
  file: string, argv: readonly string[],
  opts: { idleMs: number; ceilingMs: number; cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  // The capability check lives INSIDE `spawnAuthorized`: a program this call was not authorized
  // for never becomes a child, so the clock below is only ever handed a process the gate allowed.
  const child = spawnAuthorized(file, argv, opts.cwd ? { cwd: opts.cwd } : undefined);
  return attachIdleBound(child, { idleMs: opts.idleMs, ceilingMs: opts.ceilingMs });
}
