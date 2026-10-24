// The screen-control tools' process runner (v3.5 E19), beside `system-control.ts` so that file stays the
// tools. It holds the program to the owner's Stop through the toolbox's existing door (`effects/proc-tree.ts`).

import { execFileSync, spawn } from 'node:child_process';
import { endsWithTheStop, signalProcessTree } from './effects/proc-tree.js';

/**
 * v3.5 E19 — THE ONE WAY `system-control.ts` RUNS A PROGRAM THAT DRIVES THE SCREEN: asynchronously, and bound
 * to the owner's Stop (`effects/proc-tree.ts`, the door every toolbox child already waits on). It was
 * `execFileSync`, which held the event loop: the stop race could not even see the Stop until the
 * child returned or hit its bound, and nothing ended the child. Same argv, same bound as before.
 */
export function runBoundToTheStop(agentId: string, program: string, argv: string[], opts: { timeout: number; input?: string; maxBuffer?: number }): Promise<string> {
  // `spawn`, not `execFile`: execFile cannot make the child a group leader, and without `detached` the
  // Stop's group kill fails and anything the program started (an AppleScript's `do shell script` job)
  // survives it — and holds the pipes open. The bound and the output cap are execFile's own semantics:
  // SIGTERM to the tree at `timeout`, and `maxBuffer` (Node's documented 1 MiB default) per stream.
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(program, argv, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    endsWithTheStop(agentId, child);
    let stdout = '';
    let stderr = '';
    let fault: string | null = null;
    const end = (why: string): void => { fault ??= why; signalProcessTree(child, 'SIGTERM'); };
    const bound = setTimeout(() => end(`timed out after ${opts.timeout} ms`), opts.timeout);
    child.stdout.setEncoding('utf-8').on('data', (d: string) => { stdout += d; if (stdout.length > maxBuffer) end('stdout maxBuffer exceeded'); });
    child.stderr.setEncoding('utf-8').on('data', (d: string) => { stderr += d; if (stderr.length > maxBuffer) end('stderr maxBuffer exceeded'); });
    child.once('error', (err) => { clearTimeout(bound); reject(Object.assign(err, { stderr })); });
    child.once('close', (code, signal) => {
      clearTimeout(bound);
      if (code === 0 && fault === null) { resolve(stdout); return; }
      const why = fault ?? (signal ? `ended by ${signal}` : `exited with code ${code}`);
      reject(Object.assign(new Error(`Command failed: ${program} ${argv.join(' ')} (${why})${stderr ? `\n${stderr}` : ''}`), { stderr, status: code }));
    });
    child.stdin.on('error', () => undefined);   // a child cut by the Stop closes its stdin: EPIPE is that, not a fault
    child.stdin.end(opts.input ?? '');
  });
}

/** Whether `program` is on PATH (`which`, argv form: no shell). Asked once per process by the caller. */
export function programOnPath(program: string): boolean {
  try {
    execFileSync('which', [program], { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
