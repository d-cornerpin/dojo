// ════════════════════════════════════════════════════════════════════════════
// RUNNING A PROCESS UNDER AN OUTPUT-IDLE BOUND (t114, census U2).
//
// WHY THIS IS ITS OWN MODULE. The exec door's clock used to be one option on a buffered
// `execFile` call — `timeout`, a flat TOTAL duration that SIGTERMs the child at that wall-clock
// mark whatever it is doing. Replacing it with a bound on SILENCE needs a streaming run and a
// re-arming timer, which is ~90 lines of mechanism that has nothing to do with the two exec
// doors' argument shapes, their per-stream caps or their failure wording. Left inline it took
// `process-run.ts` from 178 lines to 329 and the growth detector called it correctly: a file on
// its way to being a god file.
//
// It is a LEAF, exactly as `process-run.ts` is: it imports the process facade and nothing else,
// so it holds no judgement about which programs may run. The capability check still happens
// inside `spawnAuthorized` — this module cannot reach a process the gate loop did not resolve
// for the call that is running.
// ════════════════════════════════════════════════════════════════════════════

import { spawnAuthorized } from '../effects/proc.js';

/** Both streams together, as `maxBuffer` bounded them on the buffered primitive. */
const PROCESS_MAX_BUFFER_BYTES = 1024 * 1024;

/** The shape `execFile` rejects with, rebuilt from the streaming run so that
 *  `processFailureReason` below is unchanged and both doors keep their exact wording. */
interface ProcessRunFailure {
  stdout: string;
  stderr: string;
  code?: number | string;
  signal?: NodeJS.Signals;
  killed?: boolean;
  message?: string;
}

/**
 * Run a child process under an OUTPUT-IDLE bound. Resolves on a clean exit; rejects with an
 * `execFile`-shaped error otherwise, so every caller and every failure string below is untouched.
 *
 * `idleMs` re-arms on each chunk from either stream. `ceilingMs` does not re-arm — it is the one
 * bound on total life, and the two are distinguished in the rejection so the agent is told which
 * one ended its command rather than a single ambiguous "timed out".
 */
export async function runWithIdleBound(
  file: string, argv: readonly string[],
  opts: { idleMs: number; ceilingMs: number; cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnAuthorized(file, argv, opts.cwd ? { cwd: opts.cwd } : undefined);
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
      // SIGTERM first, exactly as `execFile`'s own timeout does; the `close` handler below
      // reports it. No SIGKILL escalation is added here — that would be a new behaviour, and
      // the buffered primitive never had one either.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    };

    /** t114: THE RE-ARM. This is the whole fix — output is the measured fact of liveness. */
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
      if (bytes > PROCESS_MAX_BUFFER_BYTES) { kill('buffer'); return; }
      bumpIdle();
    };

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));

    child.on('error', (err: NodeJS.ErrnoException) => {
      done(() => reject({
        stdout, stderr, code: err.code, message: err.message,
      } satisfies ProcessRunFailure));
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
                : 'output exceeded the 1MB buffer',
          } satisfies ProcessRunFailure);
          return;
        }
        if (signal) {
          reject({ stdout, stderr, signal } satisfies ProcessRunFailure);
          return;
        }
        if (code !== 0) {
          reject({ stdout, stderr, code: code ?? undefined } satisfies ProcessRunFailure);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

    // Armed only once the process exists, so a spawn error is not reported as a silence.
    bumpIdle();
  });
}

