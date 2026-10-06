// ════════════════════════════════════════════════════════════════════════════
// BOUNDING A CHILD PROCESS BY ITS SILENCE (t114, census U2 / U14 / U21 / U22).
//
// A total-duration `timeout` on `exec`/`execFile` cannot tell a wedged command from a slow one:
// it SIGTERMs at a wall-clock mark whatever the child is doing. Several of the census's flat
// kills are that one option — the exec door at 120s, the updater's `curl` and `npm install` at
// 120s each, the installers at 120–300s, AppleScript at 30s. All of them kill processes that are
// demonstrably alive, because output is arriving the whole time.
//
// This module is the measured answer, and it holds NOTHING ELSE: given a child that someone else
// decided to spawn, bound the GAP BETWEEN ITS WRITES rather than its total life. Every chunk on
// either stream re-arms the idle timer, which is `makeStreamWatchdog`'s contract (the model
// transports' per-chunk `bump`) applied to a process instead of a token stream. A ceiling that
// does NOT re-arm sits behind it, because an idle bound alone can be held open for ever by a
// process dribbling a byte a minute — the unbounded-renewal trap the stream watchdog's own
// header refuses.
//
// ── WHY IT TAKES A CHILD RATHER THAN SPAWNING ONE ──
//
// Two very different callers need this mechanism and they must NOT share a spawn:
//
//   * the agent toolbox spawns through `agent/effects/proc.ts`'s capability facade, which
//     refuses a program the gate loop did not resolve for the running call;
//   * platform code (the updater, the dependency installers) is not an agent tool call at all
//     and has no capability to present — `requireAuthorized` would refuse it outright.
//
// So the DECISION about what may run stays at each caller's own spawn site, where its own rules
// live, and only the clock is shared. A `spawn`-injecting parameter would have put a hole in the
// toolbox's facade guarantee; handing in the child cannot, because a caller who has a child has
// already passed whatever gate governs it.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The child, STRUCTURALLY — deliberately NOT `import type { ChildProcess } from
 * 'node:child_process'`.
 *
 * The effects gate refuses that import from any module an agent can reach, and this one IS
 * reachable: `agent/tools/process-idle-bound.ts` calls it on every `exec`/`shell`. Putting this
 * file on the exclusion list would have been the wrong answer — that list is for platform
 * machinery no agent can influence, and claiming it here would be false. The import is not needed
 * either way: this module never CREATES a child, it only watches one, so the members it actually
 * touches are the whole type it requires. Spelling them out keeps the gate honest and documents
 * the entire surface this mechanism depends on.
 */
export interface WatchableChild {
  stdout?: {
    setEncoding(enc: string): unknown;
    on(ev: 'data', cb: (chunk: Buffer | string) => void): unknown;
  } | null;
  stderr?: {
    setEncoding(enc: string): unknown;
    on(ev: 'data', cb: (chunk: Buffer | string) => void): unknown;
  } | null;
  on(ev: 'error', cb: (err: NodeJS.ErrnoException) => void): unknown;
  on(ev: 'close', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

/** Both streams together. Carried from `execFile`'s `maxBuffer` on the buffered primitive. */
export const CHILD_MAX_BUFFER_BYTES = 1024 * 1024;

/** The shape `execFile` rejects with, rebuilt from a streaming run so that callers which used to
 *  read `err.killed` / `err.signal` / `err.code` keep working unchanged. */
export interface ChildRunFailure {
  stdout: string;
  stderr: string;
  code?: number | string;
  signal?: NodeJS.Signals;
  killed?: boolean;
  message?: string;
}

export interface IdleBoundOptions {
  /** Milliseconds of SILENCE tolerated. Re-arms on every chunk from either stream. */
  idleMs: number;
  /** The one bound on TOTAL life. Does not re-arm. */
  ceilingMs: number;
  /** Combined stdout+stderr cap; defaults to `CHILD_MAX_BUFFER_BYTES`. */
  maxBufferBytes?: number;
}

/**
 * Collect a child's output under an idle bound. Resolves on a clean exit; rejects with a
 * `ChildRunFailure` otherwise, naming WHICH bound fired so a caller can tell the agent (or the
 * log) that the process went silent rather than that it "timed out" — which implied a work budget
 * it never had.
 */
export async function attachIdleBound(
  child: WatchableChild,
  opts: IdleBoundOptions,
): Promise<{ stdout: string; stderr: string }> {
  const maxBytes = opts.maxBufferBytes ?? CHILD_MAX_BUFFER_BYTES;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    /** Which bound fired, so the reason can name it. */
    let killedBy: 'idle' | 'ceiling' | 'buffer' | null = null;

    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(ceilingTimer);
      fn();
    };

    const kill = (why: 'idle' | 'ceiling' | 'buffer'): void => {
      if (settled) return;
      killedBy = why;
      // SIGTERM first, exactly as `execFile`'s own timeout does; the `close` handler reports it.
      // No SIGKILL escalation is added — that would be new behaviour the buffered primitive
      // never had, and a process mid-write deserves the chance to finish its syscall.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    };

    /** THE RE-ARM. This is the whole mechanism — output is the measured fact of liveness. */
    const bumpIdle = (): void => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => kill('idle'), opts.idleMs);
      idleTimer.unref?.();
    };

    const ceilingTimer = setTimeout(() => kill('ceiling'), opts.ceilingMs);
    ceilingTimer.unref?.();

    const take = (which: 'out' | 'err') => (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      bytes += Buffer.byteLength(text, 'utf-8');
      if (which === 'out') stdout += text; else stderr += text;
      if (bytes > maxBytes) { kill('buffer'); return; }
      bumpIdle();
    };

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));

    child.on('error', (err: NodeJS.ErrnoException) => {
      done(() => reject({
        stdout, stderr, code: err.code, message: err.message,
      } satisfies ChildRunFailure));
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      done(() => {
        if (killedBy !== null) {
          reject({
            stdout, stderr, killed: true, signal: signal ?? 'SIGTERM',
            code: code ?? undefined,
            message: killedBy === 'idle'
              ? `no output for ${Math.round(opts.idleMs / 1000)}s`
              : killedBy === 'ceiling'
                ? `ran past the ${Math.round(opts.ceilingMs / 60000)}-minute ceiling`
                : `output exceeded the ${Math.round(maxBytes / (1024 * 1024))}MB buffer`,
          } satisfies ChildRunFailure);
          return;
        }
        if (signal) {
          reject({ stdout, stderr, signal } satisfies ChildRunFailure);
          return;
        }
        if (code !== 0) {
          reject({ stdout, stderr, code: code ?? undefined } satisfies ChildRunFailure);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

    // Armed only once the caller's child exists, so a spawn error is never reported as silence.
    bumpIdle();
  });
}
