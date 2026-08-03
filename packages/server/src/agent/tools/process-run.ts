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
import { coerceNumberArg } from './pagination.js';
import { execFileAuthorized } from '../effects/proc.js';

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

export const EXEC_TIMEOUT_MS = 30000;
export const EXEC_TIMEOUT_MAX_MS = 120000;

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
    reason = `timed out after ${Math.round(timeout / 1000)}s (killed by SIGTERM)`;
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
  try {
    const { stdout, stderr } = await execFileAuthorized(file, argv, {
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
      encoding: 'utf-8',
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
