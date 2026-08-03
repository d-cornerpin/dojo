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

import { execFile } from 'node:child_process';
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
