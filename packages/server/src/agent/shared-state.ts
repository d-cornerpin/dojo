// ════════════════════════════════════════
// Shared module-level state for v1 + v2 runtimes
//
// Per Part XIX preservation contract — these state objects must
// continue to exist with the same semantics in v2. Extracting them
// here (instead of leaving them in runtime.ts and duplicating in v2)
// means stop/preempt/abort signals work correctly regardless of which
// runtime version is active. v1 and v2 share the SAME sets/maps.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';

const sharedStateLogger = createLogger('shared-state');

// Track active agent runs to prevent concurrent processing.
export const activeRuns = new Set<string>();

// Queue for messages that arrive while an agent is busy.
export const pendingWakeups = new Set<string>();

// Agents that should halt on the next loop iteration.
//
// UX-REPAIR T37 — THE FLAG'S LIFETIME IS THE RUN'S LIFETIME. It used to be
// deleted by whichever checkpoint noticed it first (the pre-call gate, the
// model-call catch, the executor's mid-batch check). That made the stop
// invisible to everything that runs AFTER the loop breaks — and the loop
// breaking is not the end of the run. `handleMessage`'s `finally` then asked
// its drains "is a human still waiting?", the answer was yes precisely BECAUSE
// the stop left the ask unanswered, and it started a fresh turn 500 ms later on
// the same request (measured on the dev box, 2026-08-11: stop at 07:24:30.475,
// "Processing queued wakeup" at 07:24:31.571, `work_open` at 07:24:38.718).
// The checkpoints now READ the flag; `runtime.ts`'s run-exit `finally` is the
// ONE owner of the clear, and `the-stop-button-stops-the-agent.test.ts` runs
// the census that keeps it at one.
export const stoppedAgents = new Set<string>();

/**
 * THE ONE DOOR FOR A TURN'S OWN WAKEUP (UX-REPAIR T37).
 *
 * Every "wake myself again when this run ends" site — the A2A re-trigger, the
 * compile drive, the unserved-wake drain, the human-conversation drain, the
 * wake-budget resume, the in-loop recovery re-drives, the completion report —
 * queues through here, and here is where a live user stop is honoured. Four of
 * those sites were added after the stop button was written and not one of them
 * knew about it; a single door is what makes the fifth one safe by default.
 *
 * NOT a self-wake, and deliberately NOT routed through here: the direct
 * `pendingWakeups.add` in `handleMessage`'s busy path. That one parks a message
 * that ARRIVED — somebody asking for something — for the end of the current
 * run. Stopping the work the agent was already doing is not a reason to drop
 * somebody's new message on the floor.
 *
 * @returns true if the wakeup was queued, false if a live stop refused it.
 */
export function queueSelfWake(agentId: string, reason: string): boolean {
  if (stoppedAgents.has(agentId)) {
    sharedStateLogger.info('self-wake refused: the user stopped this agent', { reason }, agentId);
    return false;
  }
  pendingWakeups.add(agentId);
  return true;
}

// AbortControllers for in-flight API calls — aborting kills request immediately.
export const activeAbortControllers = new Map<string, AbortController>();

// Agents that should treat the next aborted model call as a soft-end so a
// queued urgent wakeup can fire promptly.
export const preemptedAgents = new Set<string>();

// v2.5.14 — Per-agent flag set while a routine background gap-drain
// (compaction) is in flight. The v2 loop checks this before kicking off
// another drain so a slow/hung drain can't pile up. Released only when
// the drain promise actually settles (success, error, or abort).
export const backgroundDrains = new Set<string>();

// Per-agent timestamp of the most recent "Memory Compacted" divider broadcast.
// Used to throttle the divider so a backlog drain that runs across many turns
// doesn't spam the chat with a divider every turn — at most one per 10 min.
// Pre-fix, the routine drain path suppressed the divider entirely; that meant
// users got zero visibility into compaction even on long single-task flows.
export const lastCompactionDividerAt = new Map<string, number>();

// v2.5.38 — per-agent timestamp of the most recent inbound A2A preempt.
// Used to throttle preempts so a chatty sender can't interrupt a busy
// receiver more than once every A2A_PREEMPT_MIN_INTERVAL_MS. Subsequent
// inbound A2As within the window queue normally (existing handleMessage
// behavior — added to pendingWakeups, fires after current turn ends).
export const lastA2APreemptAt = new Map<string, number>();
export const A2A_PREEMPT_MIN_INTERVAL_MS = 30_000;

// Track agent start times for uptime calculation.
export const agentStartTimes = new Map<string, number>();

// Per-agent count of consecutive auto-continuations across turns.
// Bounded by MAX_TURN_AUTO_CONTINUATIONS; reset on a clean turn end.
export const turnContinuationCounts = new Map<string, number>();

// Heartbeat timers — re-broadcast agent:status='working' every 30s while
// the agent loop is active, so dashboard reconnects mid-turn pick up state.
export const statusHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

// Per-agent streak of consecutive same-kind in-loop recoveries.
//
// v2.3.19 (error-handling-spec Phase 1): the streak is now keyed by
// `(kind, inputsFingerprint)`. The agent gets unlimited adaptation
// attempts as long as it actually CHANGES its inputs each turn (different
// tool args, different message body, etc.). The cap fires only when the
// agent keeps re-running the SAME failing inputs — that's when system
// notes aren't helping and we should escalate to Healer (Tier C), not
// inject a 4th identical note.
//
// Pre-v2.3.19: count-based cap of 3 per kind. Worked for short loops but
// punished agents that hit the same KIND with different inputs across a
// long session (e.g. three different malformed tool calls in one turn,
// none of them identical).
//
// Shared across v1 and v2 so an agent's streak persists across the
// runtime boundary.
export const recoveryRunStreak = new Map<
  string,
  { kind: string; inputsFingerprint: string; count: number }
>();

// Hard ceiling on retries when the inputs DON'T change — that means the
// system note isn't helping and the cycle is wasteful. Lowered from 3 to
// 2: one retry with the note, one to confirm it's not just transient,
// then escalate.
export const MAX_INLOOP_RECOVERIES_SAME_INPUTS = 2;

// Legacy export — kept so old callers still compile. v2.3.19 code paths
// use MAX_INLOOP_RECOVERIES_SAME_INPUTS instead. Will be removed once
// all callers migrate.
export const MAX_CONSECUTIVE_INLOOP_RECOVERIES = 3;
