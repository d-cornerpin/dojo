// ════════════════════════════════════════
// Shared module-level state for v1 + v2 runtimes
//
// Per Part XIX preservation contract — these state objects must
// continue to exist with the same semantics in v2. Extracting them
// here (instead of leaving them in runtime.ts and duplicating in v2)
// means stop/preempt/abort signals work correctly regardless of which
// runtime version is active. v1 and v2 share the SAME sets/maps.
// ════════════════════════════════════════

// Track active agent runs to prevent concurrent processing.
export const activeRuns = new Set<string>();

// Queue for messages that arrive while an agent is busy.
export const pendingWakeups = new Set<string>();

// Agents that should halt on the next loop iteration.
export const stoppedAgents = new Set<string>();

// AbortControllers for in-flight API calls — aborting kills request immediately.
export const activeAbortControllers = new Map<string, AbortController>();

// Agents that should treat the next aborted model call as a soft-end so a
// queued urgent wakeup can fire promptly.
export const preemptedAgents = new Set<string>();

// Track agent start times for uptime calculation.
export const agentStartTimes = new Map<string, number>();

// Per-agent count of consecutive auto-continuations across turns.
// Bounded by MAX_TURN_AUTO_CONTINUATIONS; reset on a clean turn end.
export const turnContinuationCounts = new Map<string, number>();

// Heartbeat timers — re-broadcast agent:status='working' every 30s while
// the agent loop is active, so dashboard reconnects mid-turn pick up state.
export const statusHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

// Per-agent streak of consecutive same-kind in-loop recoveries. Capped at
// MAX_CONSECUTIVE_INLOOP_RECOVERIES (=3) so a recovery that can't actually
// fix the underlying problem doesn't loop forever (we saw 132 retries-in-
// seconds before the cap existed).
//
// Shared across v1 and v2 so an agent's streak persists across the runtime
// boundary. Phase 6 (2026-05-04) moved this from runtime.ts to here so v2's
// recovery cascade can read/write it directly without import cycles.
export const recoveryRunStreak = new Map<string, { kind: string; count: number }>();

// Maximum consecutive same-kind in-loop recoveries before escalating to
// injury (status='error', healer notification). Lives here because both
// runtime.ts and v2/recovery.ts need it.
export const MAX_CONSECUTIVE_INLOOP_RECOVERIES = 3;
