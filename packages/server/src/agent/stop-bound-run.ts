// ════════════════════════════════════════════════════════════════════════════
// THE ONE RUNNER FOR A PLATFORM PROGRAM THE OWNER'S STOP CAN CUT (v3.5 E19 + E19b).
//
// The screen-control tools (`agent/system-control.ts`: cliclick, screencapture, osascript) and the
// iMessage sends (`services/imessage-run.ts`: imsg, osascript) used to run their programs
// synchronously, which held the server's event loop for the whole call: the stop race could not
// see the owner's Stop until the child returned, and nothing ended the child. Each lane moved its
// calls onto an async runner; the two runners were near copies and had drifted. This is the one.
//
//   • `spawn`, detached: execFile cannot make the child a group leader, and without it the Stop's
//     group kill misses whatever the program started (an AppleScript's `do shell script` job).
//   • Bound to the Stop through the toolbox's existing door (`effects/proc-tree.ts`) when an agent id is
//     given; a platform run (an owner notice, the auto-route) passes none and no Stop cuts it.
//   • A Stop already standing: the program NEVER STARTS (rejects `neverStarted`) — nothing was
//     clicked, typed or sent, and the caller can say so.
//   • The bound keeps execFile's semantics (SIGTERM to the tree at `timeout`), then escalates like
//     the Stop does: SIGKILL after the same grace, so a program that ignores SIGTERM cannot leave
//     the call pending. Output is capped per stream at Node's documented 1 MiB `maxBuffer` default.
//   • A run the Stop cut rejects `cutByTheStop`, so a caller does not mistake it for a broken
//     program (the bridge would otherwise retry the send another way).
//   • The error names the program, never its argv: an argv carries what an agent typed or sent.
// ════════════════════════════════════════════════════════════════════════════

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { endsWithTheStop, signalProcessTree, KILL_GRACE_MS } from './effects/proc-tree.js';
import { untilUserStop } from './stop-waiters.js';

/** The rejection of a run the owner's Stop ended. */
export type CutByTheStop = Error & { readonly cutByTheStop: true };

export function wasCutByTheStop(err: unknown): err is CutByTheStop {
  return err instanceof Error && (err as Partial<CutByTheStop>).cutByTheStop === true;
}

/** The rejection of a run that never started, because the owner's Stop was already standing. */
export function wasNeverStarted(err: unknown): boolean {
  return err instanceof Error && (err as { neverStarted?: boolean }).neverStarted === true;
}

export interface BoundRunOptions {
  readonly timeout: number;
  /** The agent whose Stop ends the run; none for a platform run. */
  readonly agentId?: string;
  /** Written to the program's stdin (then closed); without it stdin is not opened. */
  readonly input?: string;
  readonly maxBuffer?: number;
}

export function runBoundToTheStop(program: string, argv: readonly string[], opts: BoundRunOptions): Promise<string> {
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const stop = opts.agentId === undefined ? null : untilUserStop(opts.agentId);
    if (stop?.already === true) { stop.dispose(); reject(Object.assign(new Error(`${program}: not started, the agent was stopped`), { neverStarted: true })); return; }
    let child: ChildProcess;
    try {
      child = spawn(program, [...argv], { detached: true, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (err) { stop?.dispose(); reject(err); return; }   // the waiter is not left behind
    const cutByStop = opts.agentId === undefined ? null : endsWithTheStop(opts.agentId, child);
    let cut = false;
    void stop?.stopped.then(() => { cut = true; });
    let stdout = '';
    let stderr = '';
    let fault: string | null = null;
    let closed = false;
    let kill: ReturnType<typeof setTimeout> | null = null;
    const armKill = (): void => {
      kill ??= setTimeout(() => { if (!closed) signalProcessTree(child, 'SIGKILL'); }, KILL_GRACE_MS).unref();
    };
    const end = (why: string): void => {
      fault ??= why;
      if (cutByStop) { cutByStop(); return; }   // the stop's own cut signals and arms the one timer
      signalProcessTree(child, 'SIGTERM');
      armKill();
    };
    const bound = setTimeout(() => end(`timed out after ${opts.timeout} ms`), opts.timeout);
    const done = (): void => { closed = true; clearTimeout(bound); if (kill) clearTimeout(kill); stop?.dispose(); };
    child.stdout?.setEncoding('utf-8').on('data', (d: string) => { stdout += d; if (stdout.length > maxBuffer) end('stdout maxBuffer exceeded'); });
    child.stderr?.setEncoding('utf-8').on('data', (d: string) => { stderr += d; if (stderr.length > maxBuffer) end('stderr maxBuffer exceeded'); });
    child.once('error', (err) => { done(); reject(Object.assign(err, { stderr })); });
    child.once('close', (code, signal) => {
      done();
      // An exit 0 succeeded, even if the Stop landed at that instant: the caller then says it happened.
      if (code === 0 && fault === null) { resolve(stdout); return; }
      const why = cut ? 'ended by the owner\'s Stop' : fault ?? (signal ? `ended by ${signal}` : `exited with code ${code}`);
      reject(Object.assign(new Error(`${program} failed (${why})${stderr ? `\n${stderr}` : ''}`), { stderr, status: code, ...(cut ? { cutByTheStop: true as const } : {}) }));
    });
    if (child.stdin) {
      child.stdin.on('error', () => undefined);   // a child cut by the Stop closes its stdin: EPIPE is that, not a fault
      child.stdin.end(opts.input);
    }
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
