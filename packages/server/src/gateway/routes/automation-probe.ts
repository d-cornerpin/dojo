// Automation permission probe for Messages: runs `tell application "Messages" to get name`, a read-only
// AppleEvent (a `get` of the app's own `name`, nothing interpolated, no shell), so the answer is a true yes/no.
// `unknown` means no answer is available (no Messages, no osascript, unrecognised failure), never "not asked".
// The child is silent by design (osascript writes once, at the end), so there is no idle bound: only
// PROBE_SETTLE_MS (how long the HTTP response waits; the child keeps running) and PROBE_CEILING_MS (SIGTERM,
// which also takes down an unanswered consent dialog). A late answer lands in `lastCompleted` for the next poll.

import { spawn } from 'node:child_process';

export type AutomationStatus = 'granted' | 'denied' | 'unknown';

/** Read-only by construction; exported so a test can assert its shape. */
export const MESSAGES_READ_ONLY_PROBE = 'tell application "Messages" to get name';

export const OSASCRIPT_PATH = '/usr/bin/osascript';

export const PROBE_SETTLE_MS = 5_000;

export const PROBE_CEILING_MS = 10 * 60_000;

export interface AutomationProbeChild {
  readonly settled: Promise<{ code: number | null; stderr: string }>;
  kill(): void;
}

export type AutomationProbeSpawn = () => AutomationProbeChild;

export const spawnRealMessagesProbe: AutomationProbeSpawn = () => {
  const child = spawn(OSASCRIPT_PATH, ['-e', MESSAGES_READ_ONLY_PROBE], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const settled = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let done = false;
    const finish = (code: number | null, extra = ''): void => {
      if (done) return;
      done = true;
      resolve({ code, stderr: stderr + extra });
    };
    child.on('error', (err: NodeJS.ErrnoException) => finish(null, `${err.code ?? ''} ${err.message}`));
    child.on('close', (code) => finish(code));
  });
  return { settled, kill: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } } };
};

/** errAEEventNotPermitted (-1743): matched on number AND sentence, since either alone could misclassify. */
const DENIED_SIGNS = [/-1743\b/, /not authori[sz]ed to send Apple events/i];

/** Messages absent or not running: stays `unknown` so the row keeps its manual instruction. */
const ABSENT_SIGNS = [
  /-1728\b/, /-10814\b/, /-600\b/,
  /can[’']?t get application/i,
  /application isn[’']?t running/i,
  /ENOENT/,
];

export function classifyAutomationProbe(result: { code: number | null; stderr: string }): AutomationStatus {
  if (result.code === 0) return 'granted';
  const text = result.stderr ?? '';
  if (DENIED_SIGNS.some((re) => re.test(text))) return 'denied';
  if (ABSENT_SIGNS.some((re) => re.test(text))) return 'unknown';
  return 'unknown';
}


/** Single flight: each poll would otherwise raise its own consent dialog, and dialogs must not stack. */
let inFlight: Promise<AutomationStatus> | null = null;

// Landing place for a late answer, not a cache: every poll re-asks, so a denied row turns green once allowed.
let lastCompleted: AutomationStatus | null = null;

export async function automationPermissionStatus(): Promise<AutomationStatus> {
  if (inFlight) {
    // A dialog is plausibly up from the previous poll: report the last finished answer instead.
    return lastCompleted ?? 'unknown';
  }

  const child = spawnRealMessagesProbe();

  const ceiling = setTimeout(() => { child.kill(); }, PROBE_CEILING_MS);
  ceiling.unref?.();

  const run = child.settled.then((result) => {
    clearTimeout(ceiling);
    const status = classifyAutomationProbe(result);
    lastCompleted = status;
    inFlight = null;
    return status;
  });
  inFlight = run;
  // The late answer must not become an unhandled rejection if no awaiter is left holding it.
  run.catch(() => { clearTimeout(ceiling); inFlight = null; });

  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const settleWindow = new Promise<'pending'>((resolve) => {
    settleTimer = setTimeout(() => resolve('pending'), PROBE_SETTLE_MS);
    settleTimer.unref?.();
  });

  const outcome = await Promise.race([run, settleWindow]);
  clearTimeout(settleTimer);

  return outcome === 'pending' ? (lastCompleted ?? 'unknown') : outcome;
}
