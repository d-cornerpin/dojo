import { constants as bufferConstants } from 'node:buffer';

// Bounds a child process by the gap between its writes, not its total life: every chunk on either
// stream re-arms the idle timer, and an optional non-re-arming ceiling stops a byte-a-minute dribbler.
// It takes an already-spawned child so each caller keeps its own spawn gate (the toolbox's capability
// facade in `agent/effects/proc.ts`, the updater's own spawn); only the clock is shared.

/** The child's touched members, structural: the effects gate refuses a `node:child_process` import
 *  here because `agent/tools/process-idle-bound.ts` makes this module agent-reachable. */
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

/** The only output bound, a memory-safety one: past it the pipe is still drained, the command runs to
 *  its end and the result names how much was not kept. Output volume never kills a command. */
export const CHILD_KEEP_CEILING_CHARS = Math.floor(bufferConstants.MAX_STRING_LENGTH / 4);

/** The `execFile` rejection shape, so callers reading `killed` / `signal` / `code` work unchanged. */
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
  /** The one bound on TOTAL life. Does not re-arm. Absent: no total bound. */
  ceilingMs?: number;
  /** Combined stdout+stderr characters HELD; defaults to `CHILD_KEEP_CEILING_CHARS`. Never a kill. */
  keepCeilingChars?: number;
}

/** Collect a child's output under an idle bound. Rejects with a `ChildRunFailure` naming which
 *  bound fired, so the caller can say the process went silent rather than that it timed out. */
export async function attachIdleBound(
  child: WatchableChild,
  opts: IdleBoundOptions,
): Promise<{ stdout: string; stderr: string }> {
  const keepCeiling = opts.keepCeilingChars ?? CHILD_KEEP_CEILING_CHARS;
  return new Promise((resolve, reject) => {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    let kept = 0;
    let notKept = 0;
    // Joined once, at the end: no repeated string growth while a long output streams in.
    const collected = (): { stdout: string; stderr: string } => {
      const note = notKept > 0
        ? `\n[${notKept} characters of output were not kept: the command printed more than can be held in memory (${keepCeiling}). It ran to its end.]`
        : '';
      return { stdout: outChunks.join('') + note, stderr: errChunks.join('') };
    };
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let killedBy: 'idle' | 'ceiling' | null = null;

    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (ceilingTimer) clearTimeout(ceilingTimer);
      fn();
    };

    const kill = (why: 'idle' | 'ceiling'): void => {
      if (settled) return;
      killedBy = why;
      // SIGTERM only, as `execFile`'s timeout does; the `close` handler reports it.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    };

    /** Output is the measured fact of liveness, so each chunk re-arms the idle timer. */
    const bumpIdle = (): void => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => kill('idle'), opts.idleMs);
      idleTimer.unref?.();
    };

    const ceilingTimer = opts.ceilingMs !== undefined ? setTimeout(() => kill('ceiling'), opts.ceilingMs) : null;
    ceilingTimer?.unref?.();

    const take = (which: 'out' | 'err') => (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const room = Math.max(0, keepCeiling - kept);
      const keep = text.length <= room ? text : text.slice(0, room);
      kept += keep.length;
      notKept += text.length - keep.length;
      if (keep) (which === 'out' ? outChunks : errChunks).push(keep);
      bumpIdle();
    };

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));

    child.on('error', (err: NodeJS.ErrnoException) => {
      done(() => reject({
        ...collected(), code: err.code, message: err.message,
      } satisfies ChildRunFailure));
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      done(() => {
        const { stdout, stderr } = collected();
        if (killedBy !== null) {
          reject({
            stdout, stderr, killed: true, signal: signal ?? 'SIGTERM',
            code: code ?? undefined,
            message: killedBy === 'idle'
              ? `no output for ${Math.round(opts.idleMs / 1000)}s`
              : `ran past the ${Math.round((opts.ceilingMs ?? 0) / 60000)}-minute ceiling`,
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
