// ════════════════════════════════════════════════════════════════════════════
// RUNNING A PROCESS (PHASE-5 T3 Step 1) — the shared body of both exec doors.
//
// WHY THIS IS A MODULE AND NOT 120 MORE LINES OF `agent/tools.ts`. T3 turns one
// exec entry point into two, and two doors that format their output differently
// is how a scenario asserting on `stdout_truncated: true` starts passing on one
// and failing on the other. Everything below is the SAME code the deleted
// string-exec handler ran — the per-stream 16K caps, the `stdout_truncated`
// flags, the `command_failed: <reason>` header, the ENOENT/SIGTERM
// translations — lifted verbatim so both doors share it by construction rather
// than by anybody remembering to keep them in step.
//
// It is also the shape T4 wants: a leaf that imports nothing from the toolbox,
// so when handler bodies move into `agent/tools/cat/*.ts` this one does not have
// to move again. `auditLog` is INJECTED rather than imported, which is the only
// reason this file can be a leaf at all.
// ════════════════════════════════════════════════════════════════════════════

import { resolveHomePath, isExistingDirectory } from '../path-resolve.js';
import { sudoWouldHang } from '../brokers/sudo-probe.js';
import { coerceNumberArg } from './pagination.js';
import { spawnAuthorized } from '../effects/proc.js';

// `execFile` never consults a shell, which is what makes `exec({argv})`
// argv-no-shell rather than argv-shaped. The `shell` door reaches /bin/zsh
// through this SAME primitive with an explicit `-c`, so there is exactly one
// process-spawning call in the toolbox.
//
// PHASE-5 T8 Step 3 (CATEGORY: the process door). That one call now goes through
// `agent/effects/proc.ts`, which requires the capability the gate loop minted
// for THIS call and refuses a program it does not name. Nothing else moved: the
// same primitive, the same arguments, the same options object, the same caps and
// the same failure translation below. The brokers still DECIDE (`gates.ts` rows
// 3 and 3s → `authorizeExecShapedCall`); what changed is that the carrying is no
// longer done by a raw `child_process` import a handler could aim anywhere.

// ── t114 (census U2) — THE EXEC CLOCK BOUNDS SILENCE, NOT WORK ──
//
// THE DEFECT: `EXEC_TIMEOUT_MAX_MS` was a hard TOTAL-duration cap the agent could not exceed
// (`Math.min(coerced ?? 30s, 120s)`), handed to `execFile`'s own `timeout` option, which SIGTERMs
// the child at that wall-clock mark whatever it is doing. `shell({script:"npm install"})`, a
// `pytest` suite, a `docker build`, a large `git clone` all routinely exceed two minutes while
// healthily producing output, and all were killed mid-stride. The census called it the
// highest-frequency flat kill in the tree by raw call count, and noted the deeper problem: the
// door used the BUFFERED `execFileAuthorized`, so there was structurally no per-chunk signal that
// could have extended the clock even if someone had wanted to.
//
// THE FIX: the same bound, re-pointed at the thing it can actually prove. These numbers now bound
// OUTPUT SILENCE — the gap between two writes to stdout/stderr — rather than total runtime, which
// makes them the `makeStreamWatchdog` shape the model transports use (bound a GAP, re-arm on
// every chunk) applied to a child process. A command that is talking is a command that is alive,
// so it runs; a command that has gone quiet for the whole window is as dead as we can prove and
// is still killed, loudly, with a reason that says silence is what ended it.
//
// The door moves to the STREAMING primitive (`spawnAuthorized`) to get that per-chunk signal.
// Same capability, same program check, same no-shell argv — `proc.ts` makes that explicit.
export const EXEC_TIMEOUT_MS = 30000;
export const EXEC_TIMEOUT_MAX_MS = 120000;

/**
 * The absolute ceiling, and the reason it has to exist: an output-idle bound alone can be held
 * open for ever by a process that dribbles a byte a minute, which is the unbounded-renewal trap
 * the stream watchdog's own header refuses. ONE HOUR — far above any legitimate interactive tool
 * call, far below "for ever", and reached only by a process that has been producing output
 * continuously for an hour, which is a runaway rather than a slow build.
 */
export const EXEC_ABSOLUTE_CEILING_MS = 60 * 60 * 1000;

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
async function runWithIdleBound(
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

/** Phase 3.5 (2026-05-04), per-stream caps. Each of stdout/stderr gets its own
 *  ~4K-token cap (16K chars), tagged with `stdout_truncated:true` /
 *  `stderr_truncated:true` flags so the agent sees structurally that output was
 *  cut. Combined output also hits the engine-level applyMaxResultTokensCap. */
const STREAM_CHAR_CAP = 16_000;

function capStream(raw: string): { text: string; truncated: boolean } {
  const truncated = raw.length > STREAM_CHAR_CAP;
  return { text: truncated ? raw.slice(0, STREAM_CHAR_CAP) : raw, truncated };
}

/** Phase 3.5 fix, defensive coerce. DeepSeek emits numeric args as strings
 *  despite the schema; without coerce a string timeout silently falls back to
 *  the default instead of being honored. */
export function processTimeout(raw: unknown): number {
  const coerced = coerceNumberArg(raw);
  return Math.min(coerced !== null ? coerced : EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MAX_MS);
}

/**
 * The working directory for a process door.
 *
 * `undefined` means "inherit the server's cwd", which is exactly what the
 * deleted entry point did — it passed no `cwd` at all. A `cwd` that does not
 * name an existing directory is NOT a refusal: it falls back with a note, so a
 * model guessing at a path gets its command run and a sentence telling it why
 * the directory was ignored, rather than an error it will retry blind.
 */
export function resolveProcessCwd(raw: unknown): { cwd: string | undefined; note: string | null } {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { cwd: undefined, note: null };
  if (isExistingDirectory(raw)) return { cwd: resolveHomePath(raw), note: null };
  return {
    cwd: undefined,
    note: `[note: cwd "${raw}" is not an existing directory; ran in the default working directory instead]`,
  };
}

/** The ENOENT / signal / exit-code translation, verbatim from the deleted
 *  string-exec handler: an agent must not read "Error (exit unknown)" when the
 *  real cause was a timeout or a missing binary. */
function processFailureReason(err: unknown, timeout: number): { reason: string; messageFallback: string } {
  const error = err as {
    stderr?: string; stdout?: string; message?: string;
    code?: number | string; signal?: NodeJS.Signals; killed?: boolean;
  };
  let reason: string;
  if (error.killed && error.signal === 'SIGTERM') {
    // t114 (U2): the reason NAMES WHICH BOUND FIRED. "timed out after 120s" was the only story
    // this door could tell while the clock was a total, and it was the wrong one — it implied the
    // command had been given 120 seconds of work when what it had actually been given was 120
    // seconds of SILENCE. `message` is set by the runner for exactly this.
    reason = error.message
      ? `stopped: ${error.message} (killed by SIGTERM)`
      : `timed out after ${Math.round(timeout / 1000)}s (killed by SIGTERM)`;
  } else if (error.signal) {
    reason = `killed by ${error.signal}`;
  } else if (error.code === 'ENOENT') {
    reason = 'command not found (ENOENT), check spelling, PATH, or quote your command properly';
  } else if (typeof error.code === 'number') {
    reason = `exit ${error.code}`;
  } else if (typeof error.code === 'string') {
    reason = `failed (${error.code})`;
  } else {
    reason = 'failed (exit unknown)';
  }
  let messageFallback = '';
  if (!error.stdout && !error.stderr && error.message) {
    messageFallback = error.message.replace(/^Command failed:[^\n]*\n?/, '').trim();
  }
  return { reason, messageFallback };
}

function formatProcessResult(
  outcome: { stdout: string; stderr: string; reason: string | null; messageFallback: string },
  note: string | null,
): string {
  const out = capStream(outcome.stdout ?? '');
  const err = capStream(outcome.stderr ?? '');
  const parts: string[] = [];
  if (outcome.reason) parts.push(`command_failed: ${outcome.reason}`);
  if (out.text.trim() || out.truncated) {
    parts.push(`stdout${out.truncated ? ' (truncated, stdout_truncated: true)' : ''}:\n${out.text.trim() || '(empty)'}`);
  }
  if (err.text.trim() || err.truncated) {
    parts.push(`stderr${err.truncated ? ' (truncated, stderr_truncated: true)' : ''}:\n${err.text.trim() || '(empty)'}`);
  }
  if (outcome.reason && outcome.messageFallback) parts.push(`node_error:\n${outcome.messageFallback}`);
  if (note) parts.push(note);
  if (parts.length === 0) return '(command completed with no output)';
  return parts.join('\n\n');
}

/** How a door records what it ran. Injected so this module stays a leaf. */
export type ProcessAudit = (target: string, result: 'success' | 'error', detail: string) => void;

/** ONE runner for both doors: same caps, same audit shape, same failure
 *  translation. Only the program and the arguments differ. */
export async function runProcess(input: {
  /** What the audit row records as the target — the argv line, or the whole script. */
  auditTarget: string;
  file: string;
  argv: string[];
  timeout: number;
  cwd: string | undefined;
  note: string | null;
  audit: ProcessAudit;
}): Promise<string> {
  const { auditTarget, file, argv, timeout, cwd, note, audit } = input;
  // ── HONEST FAILURE FOR SUDO (owner ruling 2026-09-26, v3.2.2) ──
  // A sudo line on a box with no NOPASSWD rule does not fail — it BLOCKS on a password prompt nobody
  // can type into, and the turn dies on the timeout with nothing to read. `sudoWouldHang` probes it
  // in ~1.5s and the answer names the ONE command a human runs once. Checked HERE, at the single
  // execution seam, so both the shell door and the argv door are covered by one check.
  const hang = await sudoWouldHang(auditTarget);
  if (hang) {
    audit(auditTarget, 'error', 'sudo requires a password on this box; nothing was run');
    return hang;
  }
  try {
    // t114 (U2): `timeout` is now the OUTPUT-IDLE bound rather than a total-duration cap, and
    // the run streams so each chunk can re-arm it. A healthy long build talks the whole way
    // through and survives; a wedged command says nothing and is still killed.
    const { stdout, stderr } = await runWithIdleBound(file, argv, {
      idleMs: timeout,
      ceilingMs: EXEC_ABSOLUTE_CEILING_MS,
      ...(cwd ? { cwd } : {}),
    });
    const out = capStream(stdout ?? '');
    const err = capStream(stderr ?? '');
    audit(auditTarget, 'success',
      err.text.trim()
        ? `stdout: ${out.text.trim().slice(0, 250)} | stderr: ${err.text.trim().slice(0, 250)}`
        : out.text.trim().slice(0, 500));
    return formatProcessResult({ stdout: stdout ?? '', stderr: stderr ?? '', reason: null, messageFallback: '' }, note);
  } catch (err: unknown) {
    const error = err as { stderr?: string; stdout?: string };
    const { reason, messageFallback } = processFailureReason(err, timeout);
    const out = capStream(error.stdout ?? '');
    const errStream = capStream(error.stderr ?? '');
    audit(auditTarget, 'error',
      `${reason} | stderr: ${errStream.text.trim().slice(0, 250) || '(empty)'} | stdout: ${out.text.trim().slice(0, 250) || '(empty)'}`);
    return formatProcessResult(
      { stdout: error.stdout ?? '', stderr: error.stderr ?? '', reason, messageFallback },
      note,
    );
  }
}
