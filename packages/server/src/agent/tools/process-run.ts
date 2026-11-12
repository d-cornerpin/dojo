// THE SHARED BODY OF BOTH EXEC DOORS: one runner, so two doors cannot drift into two output formats.
// `auditLog` is injected rather than imported, which is what keeps this module a toolbox-free leaf.

import { resolveHomePath, isExistingDirectory } from '../path-resolve.js';
import { sudoWouldHang } from '../brokers/sudo-probe.js';
import { coerceNumberArg } from './pagination.js';
import { silentWindowMs } from '../../tracker/silent-window.js';
import { runWithIdleBound } from './process-idle-bound.js';

// `execFile` never consults a shell, which is what makes `exec({argv})` argv-no-shell; the shell
// door reaches /bin/zsh by `-c` through this same single spawning call, carrying the call's capability.

// THE EXEC CLOCK BOUNDS SILENCE, NOT WORK: these numbers bound the gap between two output writes,
// not a command's total life: one that is talking runs, one quiet for the whole window is killed.
/** setTimeout's own largest delay (a larger one fires at once); a technical edge, not a policy. */
const LARGEST_TIMER_MS = 2 ** 31 - 1;

// The output is returned WHOLE: the executor keeps it and the agent reads any part of it.

/** How long a command may stay quiet: the agent's own `timeout` when it asks, else its silent window. */
export function processTimeout(raw: unknown, agentId: string): number {
  const coerced = coerceNumberArg(raw);
  const asked = coerced !== null && coerced > 0 ? coerced : silentWindowMs(agentId);
  return Math.min(asked, LARGEST_TIMER_MS);
}

/** `undefined` means "inherit the server's cwd". A `cwd` that does not exist is NOT a refusal: it
 *  falls back with a note, so a model that guessed a path gets its run plus the reason, not an error. */
export function resolveProcessCwd(raw: unknown): { cwd: string | undefined; note: string | null } {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { cwd: undefined, note: null };
  if (isExistingDirectory(raw)) return { cwd: resolveHomePath(raw), note: null };
  return {
    cwd: undefined,
    note: `[note: cwd "${raw}" is not an existing directory; ran in the default working directory instead]`,
  };
}

/** The failure translation both doors share: never "failed (exit unknown)" for a timeout or ENOENT. */
function processFailureReason(err: unknown, timeout: number): { reason: string; messageFallback: string } {
  const error = err as {
    stderr?: string; stdout?: string; message?: string;
    code?: number | string; signal?: NodeJS.Signals; killed?: boolean;
  };
  let reason: string;
  if (error.killed && error.signal === 'SIGTERM') {
    // The reason NAMES WHICH BOUND FIRED: the runner's `message` says silence ended it, not the clock.
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
  const out = (outcome.stdout ?? '').trim();
  const err = (outcome.stderr ?? '').trim();
  const parts: string[] = [];
  if (outcome.reason) parts.push(`command_failed: ${outcome.reason}`);
  if (out) parts.push(`stdout:\n${out}`);
  if (err) parts.push(`stderr:\n${err}`);
  if (outcome.reason && outcome.messageFallback) parts.push(`node_error:\n${outcome.messageFallback}`);
  if (note) parts.push(note);
  if (parts.length === 0) return '(command completed with no output)';
  return parts.join('\n\n');
}

export type ProcessAudit = (target: string, result: 'success' | 'error', detail: string) => void;

/** ONE runner for both doors: same caps, same audit shape, same failure translation. */
export async function runProcess(input: {
  /** What the audit row records as the target: the argv line, or the whole script. */
  auditTarget: string;
  file: string;
  argv: string[];
  timeout: number;
  cwd: string | undefined;
  note: string | null;
  audit: ProcessAudit;
  /** A person's message can hand the call back while the command runs; absent, the call waits for it. */
  personFirst?: PersonFirst;
}): Promise<string> {
  const { auditTarget, file, argv, timeout, cwd, audit, personFirst } = input;
  // Sudo with no NOPASSWD rule BLOCKS on a prompt nobody can type into; the probe checks HERE, both doors.
  const hang = await sudoWouldHang(auditTarget);
  if (hang) {
    audit(auditTarget, 'error', 'sudo requires a password on this box; nothing was run');
    return hang;
  }
  // `timeout` bounds OUTPUT SILENCE here, not total duration; the run streams so each chunk re-arms it.
  let pid: number | undefined;
  const startedAt = Date.now();
  // The watch starts BEFORE the child: only a message arriving after this instant hands the call back.
  const watch = personFirst?.watchFrom(startedAt);
  const running = runWithIdleBound(file, argv, {
    idleMs: timeout,   // no total-life cap on the agent's own command
    ...(cwd ? { cwd } : {}),
    onSpawn: (p) => { pid = p; },
  });
  const settle = (p: Promise<{ stdout: string; stderr: string }>): Promise<string> => settleProcess(p, input);
  if (!personFirst || !watch) return settle(running);
  const outcome = settle(running);
  const first = await Promise.race([outcome, watch.arrived.then(() => 'person' as const)]);
  watch.cancel();
  if (first !== 'person') return first;
  personFirst.handedBack(pid, outcome);
  return handBackText(pid);
}

/** One background hand-off, as the exec door wires it (`tools/person-first.ts`). */
export interface PersonFirst {
  /** Resolves when a person's message ARRIVES after this instant, never for one already open. */
  watchFrom(startedAt: number): { arrived: Promise<void>; cancel(): void };
  /** The call was handed back: own the still-running command, and hand its result over when it ends. */
  handedBack(pid: number | undefined, outcome: Promise<string>): void;
}

export function handBackText(pid: number | undefined): string {
  return '[A message from a person arrived while this command was running, and it comes first, so the command was moved to the background'
    + `${pid !== undefined ? ` (pid ${pid})` : ''}. Its result is NOT available yet. Nothing that depends on this command's result can run now: `
    + 'wait for the Dojo to hand you the result, which it does when the command ends, and wake you. '
    + `${pid !== undefined ? `It is still running as process group ${pid}; \`kill -- -${pid}\` through the shell ends it and everything it started, and so does the Stop button.` : 'The Stop button ends it.'}]`;
}

async function settleProcess(
  running: Promise<{ stdout: string; stderr: string }>,
  input: { auditTarget: string; timeout: number; note: string | null; audit: ProcessAudit },
): Promise<string> {
  const { auditTarget, timeout, note, audit } = input;
  try {
    const { stdout, stderr } = await running;
    const out = (stdout ?? '').trim();
    const err = (stderr ?? '').trim();
    audit(auditTarget, 'success',
      err ? `stdout: ${out.slice(0, 250)} | stderr: ${err.slice(0, 250)}` : out.slice(0, 500));
    return formatProcessResult({ stdout: stdout ?? '', stderr: stderr ?? '', reason: null, messageFallback: '' }, note);
  } catch (err: unknown) {
    const error = err as { stderr?: string; stdout?: string };
    const { reason, messageFallback } = processFailureReason(err, timeout);
    const out = (error.stdout ?? '').trim();
    const errStream = (error.stderr ?? '').trim();
    audit(auditTarget, 'error',
      `${reason} | stderr: ${errStream.slice(0, 250) || '(empty)'} | stdout: ${out.slice(0, 250) || '(empty)'}`);
    return formatProcessResult(
      { stdout: error.stdout ?? '', stderr: error.stderr ?? '', reason, messageFallback },
      note,
    );
  }
}
