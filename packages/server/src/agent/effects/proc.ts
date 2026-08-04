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

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { requireAuthorized } from './capability.js';

const execFileAsync = promisify(execFile);

export interface AuthorizedExecOptions {
  timeout: number;
  maxBuffer: number;
  encoding: 'utf-8';
  cwd?: string;
}

/**
 * `execFile(file, argv, options)` behind the capability.
 *
 * `execFile` never consults a shell, which is what makes the exec door
 * argv-no-shell rather than argv-shaped; the shell door reaches the same
 * primitive with an explicit `/bin/zsh -c`. Nothing about that changed — what
 * changed is that the program has to be one this call was authorized for.
 */
export async function execFileAuthorized(
  file: string,
  argv: readonly string[],
  options: AuthorizedExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  requireAuthorized({ op: 'proc', program: file });
  return execFileAsync(file, [...argv], options);
}

/**
 * `spawn(file, argv)` behind the same capability — the STREAMING form.
 *
 * `execFileAuthorized` buffers both streams and resolves once; a converted
 * mechanism that reads `stderr` as it arrives, or that waits on `exit` itself,
 * needs the process object rather than its output. Both forms ask the SAME
 * question of the SAME capability, so the streaming door is not a second door:
 * the program still has to be one the gate loop resolved from this call's own
 * declaration.
 *
 * No shell, exactly as `execFile` uses none — `spawn` without `shell: true`
 * hands argv straight to `execve`.
 */
export function spawnAuthorized(
  file: string,
  argv: readonly string[],
): ChildProcessWithoutNullStreams {
  requireAuthorized({ op: 'proc', program: file });
  return spawn(file, [...argv]);
}
