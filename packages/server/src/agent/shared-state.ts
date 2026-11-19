// Shared module-level state the two runtimes SHARE, so stop/preempt/abort see one set of facts.

import { createLogger } from '../logger.js';

const sharedStateLogger = createLogger('shared-state');

export const activeRuns = new Set<string>();

export const pendingWakeups = new Set<string>();

// THE FLAG'S LIFETIME IS THE RUN'S LIFETIME: checkpoints read it; the run-exit finally clears it, and a run's start clears one with no fence.
export const stoppedAgents = new Set<string>();

// The stopped run's own fence: stoppedAgents can be lifted from outside (new message, reset) while the run
// still unwinds. Raised only while activeRuns has it; the value is the stop instant: stale means wedged.
export const stopFencedRuns = new Map<string, number>();

/** A user stop stands if either the flag or the run's own fence is up; no door talks out of a stop. */
export function isStopFenced(agentId: string): boolean {
  return stoppedAgents.has(agentId) || stopFencedRuns.has(agentId);
}


// Written only by the run-exit finally.
export const lastRunEndedAt = new Map<string, number>();

/** How long the run's tail is believed to be unwinding after activeRuns: a bound, not a retry delay. */
export const RUN_UNWIND_GRACE_MS = 2_000;

// True in flight or in the exit tail: status and live work go false earlier; a quiet press stays refused.
export function isRunUnwinding(agentId: string): boolean {
  if (activeRuns.has(agentId)) return true;
  const ended = lastRunEndedAt.get(agentId);
  return ended !== undefined && Date.now() - ended < RUN_UNWIND_GRACE_MS;
}

/** THE ONE DOOR for a run's own wakeups; an ARRIVED message parks elsewhere, so a stop never drops it. */
export function queueSelfWake(agentId: string, reason: string): boolean {
  if (isStopFenced(agentId)) {
    sharedStateLogger.info('self-wake refused: the user stopped this agent', { reason }, agentId);
    return false;
  }
  pendingWakeups.add(agentId);
  return true;
}

// THE ABORT REGISTRY, a Set per agent: two dials share an agentId, and one slot reaches neither.
export const activeAbortControllers = new Map<string, Set<AbortController>>();

/** 'turn': every abort reaches it. 'background' can outlive its turn; only the user's stop reaches it. */
export type AbortScope = 'turn' | 'background';

/** Bookkeeping as a sidecar so the registry keeps the Set shape its stop clauses read; weak by design. */
const abortableMeta = new WeakMap<AbortController, { scope: AbortScope; cutBy: string | null }>();

/** The reasons that mean the user stopped; the reap counts, it fires only on an already-stopped run.
 *  Teardown and urgent preempt are left out on purpose: they must never blame the owner. */
const USER_STOP_REASONS = new Set(['user-stop', 'stuck-stopped-run-reap']);

/** Registration and the stop check are one act: a late call aborts at the door or meets the next abort.
 *  `scope` defaults to `turn` on purpose: a forgetful caller is killed visibly, never hidden from Stop. */
export function registerAbortable(
  agentId: string, controller: AbortController, scope: AbortScope = 'turn',
): boolean {
  if (isStopFenced(agentId)) {
    controller.abort();
    // A refusal IS the user's stop: stamp the identity here too, or a door-refused call cannot name it.
    abortableMeta.set(controller, { scope, cutBy: 'user-stop' });
    sharedStateLogger.info('call refused before dialling: the user stopped this agent', { scope }, agentId);
    return false;
  }
  let set = activeAbortControllers.get(agentId);
  if (!set) { set = new Set(); activeAbortControllers.set(agentId, set); }
  set.add(controller);
  abortableMeta.set(controller, { scope, cutBy: null });
  return true;
}

/** This call has settled. Removes BY IDENTITY, so one call's end never de-registers another's. */
export function releaseAbortable(agentId: string, controller: AbortController): void {
  const set = activeAbortControllers.get(agentId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) activeAbortControllers.delete(agentId);
}

export function abortReasonOf(controller: AbortController): string | null {
  return controller.signal.aborted ? abortableMeta.get(controller)?.cutBy ?? null : null;
}

export function wasCutByUserStop(controller: AbortController): boolean {
  return controller.signal.aborted && USER_STOP_REASONS.has(abortableMeta.get(controller)?.cutBy ?? '');
}

export function countAbortable(agentId: string, scope: 'all' | AbortScope = 'all'): number {
  const set = activeAbortControllers.get(agentId);
  if (!set) return 0;
  if (scope === 'all') return set.size;
  let n = 0;
  for (const c of set) if ((abortableMeta.get(c)?.scope ?? 'turn') === scope) n += 1;
  return n;
}

// 'all' belongs to the user's stop and its reap alone: a preempt that cut a render blamed the user for it.
export function abortInFlight(
  agentId: string, reason: string, opts: { scope?: 'all' | AbortScope } = {},
): number {
  const want = opts.scope ?? 'turn';
  const set = activeAbortControllers.get(agentId);
  if (!set || set.size === 0) return 0;
  const targets = want === 'all'
    ? [...set]
    : [...set].filter((c) => (abortableMeta.get(c)?.scope ?? 'turn') === want);
  if (targets.length === 0) return 0;
  for (const c of targets) {
    const meta = abortableMeta.get(c);
    if (meta) meta.cutBy = reason;
    try { c.abort(); } catch { /* an already-settled controller is not an error */ }
    set.delete(c);
  }
  if (set.size === 0) activeAbortControllers.delete(agentId);
  sharedStateLogger.info('in-flight provider calls aborted', {
    reason, cut: targets.length, scope: want, leftStanding: set.size,
  }, agentId);
  return targets.length;
}


// Soft-end the next aborted model call so a queued urgent wakeup can fire promptly.
export const preemptedAgents = new Set<string>();

// Set while a background compaction drain runs; released only when its promise settles, so drains never pile up.
export const backgroundDrains = new Set<string>();

// At most one compaction divider per 10 min: a backlog drain must not spam one every turn.
export const lastCompactionDividerAt = new Map<string, number>();

// Last forced preempt per agent: every preempt shares this one cool-down, never a private one.
export const lastA2APreemptAt = new Map<string, number>();
export const A2A_PREEMPT_MIN_INTERVAL_MS = 30_000;

export const agentStartTimes = new Map<string, number>();

export const statusHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

// Keyed by (kind, inputsFingerprint): the cap fires only on REPEATED identical inputs, else adapt freely.
export const recoveryRunStreak = new Map<
  string,
  { kind: string; inputsFingerprint: string; count: number }
>();

export const MAX_INLOOP_RECOVERIES_SAME_INPUTS = 2;

// One forced compaction per patience exhaustion; the value is the turn that spent it. Spent only when the
// current turn is that + 1 (turn numbers are gapless per agent), so a stale entry never denies a later turn.
export const doomedPrefillCompactionSpent = new Map<string, number>();

// Set only by recordInjury; the queued-wakeup restart declines only if it names the latest turn, then consumes
// it; preflight clears it at each new turn. It replaced a prose read of `last_error` that declined real retries.
export const declaredPatienceHonestFailTurn = new Map<string, number>();

const arrivalListeners = new Map<string, Set<() => void>>();
export function onArrivalWhileBusy(agentId: string, listener: () => void): () => void {
  let set = arrivalListeners.get(agentId);
  if (!set) { set = new Set(); arrivalListeners.set(agentId, set); }
  set.add(listener);
  return () => {
    const cur = arrivalListeners.get(agentId);
    cur?.delete(listener);
    if (cur && cur.size === 0) arrivalListeners.delete(agentId);
  };
}

export function noteArrivalWhileBusy(agentId: string): void {
  for (const l of [...(arrivalListeners.get(agentId) ?? [])]) {
    try { l(); } catch { /* a listener's failure never touches the park */ }
  }
}
