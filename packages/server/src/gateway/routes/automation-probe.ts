// ════════════════════════════════════════════════════════════════════════════
// THE AUTOMATION PERMISSION, ASKED FOR REAL (t115 — owner ruling 2026-10-06).
//
// ── WHAT WAS WRONG, TWICE ──
//
// t96 found the original probe to be a FALSE GREEN: `osascript -e "return 1"` drives no
// application, so it needs no Automation grant to succeed. It passed on every box, including
// boxes where sending an iMessage was blocked, and a green light on a permission the user does
// not have is worse than no light — it sends them hunting for the fault anywhere but the place
// it is.
//
// t113 replaced that with an honest `unknown`: it refused to claim what it had not established,
// and its reasoning was that the only probe which would answer for Messages raises a macOS
// consent dialog, which a polled status endpoint must not do.
//
// THE OWNER RULED OTHERWISE (2026-10-06): the check becomes the real probe — drive Messages
// harmlessly so the answer is a true yes/no — and the TCC pop-up appearing during setup is
// ACCEPTED. That ruling is the authority for this file. `unknown` survives, but only as the
// answer to a question that genuinely has no answer here (no Messages, no osascript, a failure
// nothing in this file recognises), never as a way of not asking.
//
// ── WHY THE EXPRESSION CANNOT MUTATE ANYTHING ──
//
// The whole script is `tell application "Messages" to get name`:
//
//   * `get` is the Standard Suite's `core/getd` AppleEvent. It is a READ verb — its event has
//     a direct object (what to read) and no parameter capable of carrying a value to store.
//     There is no `set`, no `make`, no `send`, no `delete`, no `close`.
//   * `name` is the read-only `name` property of the `application` class, inherited from the
//     Standard Suite. It answers the literal string "Messages". It is the app's own identity,
//     not a window, a chat, a buddy, an account, a file or a message — so the script never
//     NAMES user data, let alone writes it.
//   * Nothing is interpolated into it. It is a module constant passed as a single `-e`
//     argument to `/usr/bin/osascript` by absolute path with NO shell, so there is no string
//     a caller or a user could extend it with.
//
// A send would have to say `send` to a `buddy` or a `chat`; a draft would have to `make` one.
// Neither verb nor noun is present. The strongest side effect available to this script is that
// macOS LAUNCHES Messages to answer it — which it does at most once, because from then on
// Messages is running and the same event is answered by a live process.
//
// ── THE BOUND, AND WHY IT IS NOT AN IDLE BOUND ──
//
// t114's doctrine is to bound SILENCE rather than total life, because a flat kill cannot tell a
// wedged child from a working one. THIS CHILD IS THE DOCUMENTED EXCEPTION, and the reason is
// that it is silent BY DESIGN: `osascript` writes exactly once, at the end. There is no stream
// to re-arm on, so an `idleMs` here would degenerate into precisely the flat total cap t114
// removed — and it would fire at the one moment we must not kill, with the consent dialog up
// and the user reaching for the mouse.
//
// So two separate clocks, each bounding the thing it actually owns:
//
//   1. PROBE_SETTLE_MS — how long the HTTP RESPONSE waits. Generous enough for every DECIDED
//      round trip: once TCC has a recorded answer, osascript returns in milliseconds, and the
//      only slow decided case is a cold Messages launch. Past this mark the child is NOT killed
//      — it is left running and the poll answers `unknown` for now.
//   2. PROBE_CEILING_MS — the ONE non-re-arming bound, and it bounds the CHILD, not the
//      request. A consent dialog nobody ever answers would otherwise keep an osascript alive
//      for the life of the server.
//
// IF THE USER NEVER ANSWERS THE DIALOG: the request returns `unknown` after PROBE_SETTLE_MS and
// the row keeps rendering its manual instruction; the dialog stays up; no further probe is
// started (see the single-flight guard) so the dialogs cannot stack; at PROBE_CEILING_MS the
// child is SIGTERMed and macOS takes the dialog down with the process that raised it, after
// which a later poll is free to ask again. The endpoint never hangs, and nothing is ever killed
// for the sin of waiting on a human.
//
// WHEN THEY DO ANSWER — possibly minutes after the request that asked — the child exits and
// records its classification in `lastCompleted`, which the next poll reads. That is the whole
// reason the slow child is kept rather than killed: its answer is the answer.
// ════════════════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process';

export type AutomationStatus = 'granted' | 'denied' | 'unknown';

/**
 * THE SCRIPT. Read-only by construction — see the header's argument. Exported so a clause can
 * assert the shape rather than trusting the prose above it.
 */
export const MESSAGES_READ_ONLY_PROBE = 'tell application "Messages" to get name';

/** Absolute, and run with no shell: the script is a constant and stays one. */
export const OSASCRIPT_PATH = '/usr/bin/osascript';

/** How long the HTTP response waits. Covers every decided round trip, cold launch included. */
export const PROBE_SETTLE_MS = 5_000;

/** The one bound on the CHILD. Does not re-arm. A dialog nobody answers ends here. */
export const PROBE_CEILING_MS = 10 * 60_000;

/**
 * A probe in progress. Deliberately NOT `ChildProcess`: all this mechanism needs is "tell me
 * when it finished and with what" plus "end it", and spelling that out is what lets a clause
 * drive the three outcomes without the real Messages app — the dev box's TCC state is not a
 * fixture.
 */
export interface AutomationProbeChild {
  /** Resolves when the child exits. Never rejects; a spawn error arrives as a `code`/`stderr`. */
  readonly settled: Promise<{ code: number | null; stderr: string }>;
  /** End it. Called only when the ceiling fires. */
  kill(): void;
}

export type AutomationProbeSpawn = () => AutomationProbeChild;

/** THE REAL SEAM: one AppleEvent to Messages, no shell, nothing interpolated. */
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
    // An `osascript` that will not even start is not a denial — it is a box we cannot ask.
    child.on('error', (err: NodeJS.ErrnoException) => finish(null, `${err.code ?? ''} ${err.message}`));
    child.on('close', (code) => finish(code));
  });
  return { settled, kill: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } } };
};

/**
 * THE REFUSAL macOS RETURNS WHEN AUTOMATION IS NOT GRANTED. `errAEEventNotPermitted` (-1743) is
 * what a "Don't Allow" is recorded as, and it is also what every subsequent call gets — the
 * dialog does not come back. Matched on the number AND on the sentence, because osascript's
 * wording and its numeric tail have both moved across macOS releases and either alone is one
 * release away from silently re-classifying a denial as `unknown`.
 */
const DENIED_SIGNS = [/-1743\b/, /not authori[sz]ed to send Apple events/i];

/**
 * A BOX WE CANNOT ASK, which is not the same as a box that said no. -1728 (no such object),
 * -10814 / -600 (no such application / not running) and osascript's own "Can't get application"
 * all mean Messages is not there to drive. These stay `unknown` so the row keeps its manual
 * instruction instead of accusing the user of having denied something they were never asked.
 */
const ABSENT_SIGNS = [
  /-1728\b/, /-10814\b/, /-600\b/,
  /can[’']?t get application/i,
  /application isn[’']?t running/i,
  /ENOENT/,
];

/**
 * Turn one finished run into one of the three honest answers. Exported because this is the
 * judgement, and a clause should be able to drive it directly rather than through a timer.
 */
export function classifyAutomationProbe(result: { code: number | null; stderr: string }): AutomationStatus {
  if (result.code === 0) return 'granted';
  const text = result.stderr ?? '';
  if (DENIED_SIGNS.some((re) => re.test(text))) return 'denied';
  if (ABSENT_SIGNS.some((re) => re.test(text))) return 'unknown';
  // An unrecognised failure is NOT a denial. t96's lesson runs in both directions: asserting a
  // state we have not established is the defect, whichever state it is.
  return 'unknown';
}

// ── THE TWO PIECES OF STATE, AND WHY EACH EXISTS ──

/**
 * SINGLE FLIGHT. The dashboard polls this endpoint on mount and again after every "Open
 * Settings". Without this guard each poll would raise its own consent dialog and the owner
 * would be digging out from a stack of them — which is the one way an accepted pop-up becomes
 * an unacceptable one.
 */
let inFlight: Promise<AutomationStatus> | null = null;

/**
 * The classification of the most recently FINISHED probe, including one that finished long
 * after the request that started it (the user answered the dialog). This is where a slow
 * child's answer lands so the next poll can read it.
 */
let lastCompleted: AutomationStatus | null = null;

let spawnProbe: AutomationProbeSpawn = spawnRealMessagesProbe;

/** Test seam. Nothing in the product calls this. */
export function setAutomationProbeSpawn(fn: AutomationProbeSpawn): void { spawnProbe = fn; }

/** Test seam: forget the seam and both pieces of state. */
export function resetAutomationProbeForTests(): void {
  spawnProbe = spawnRealMessagesProbe;
  inFlight = null;
  lastCompleted = null;
}

/** What a finished probe has most recently decided. For clauses; the route reads the function. */
export function lastCompletedAutomationStatus(): AutomationStatus | null { return lastCompleted; }

/**
 * Run (or join) the probe and answer within `PROBE_SETTLE_MS`.
 *
 * NOTE THAT NOTHING IS CACHED ACROSS COMPLETED PROBES. Once TCC has decided, the real probe is
 * a dialog-free millisecond round trip against an already-running Messages, so re-asking every
 * poll costs nothing and is the only way a `denied` row turns green the moment the owner
 * toggles the switch. `lastCompleted` is a LANDING PLACE for a late answer, not a cache that
 * suppresses asking.
 */
export async function automationPermissionStatus(): Promise<AutomationStatus> {
  if (inFlight) {
    // A dialog is plausibly up from the previous poll. Do not raise a second one; report what
    // the last finished probe decided, or `unknown` if none has.
    return lastCompleted ?? 'unknown';
  }

  const child = spawnProbe();

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

  // `pending` = the dialog is up and the user has not answered. The child KEEPS RUNNING (the
  // ceiling is its only bound) and this poll tells the truth about this moment.
  return outcome === 'pending' ? (lastCompleted ?? 'unknown') : outcome;
}
