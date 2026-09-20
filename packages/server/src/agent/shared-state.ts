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

// v2.5.38 — per-agent timestamp of the most recent forced preempt. Originally added so a
// chatty inbound A2A sender couldn't interrupt a busy receiver more than once every
// A2A_PREEMPT_MIN_INTERVAL_MS — but `chat.ts` and `a2a-transport.ts` both stopped calling
// `preemptAgentForUrgentMessage` shortly after (the "duplicate-work root fix": preempting a
// mid-flight turn and letting the queued wakeup cold-redial it caused duplicate side effects),
// leaving this Map with zero callers.
//
// T81c (NO-DOOMED-DIALS, census row 21) — GPU livelock incident, Leg B: revived for the
// function itself. `preemptAgentForUrgentMessage`'s one live caller (voice barge-in) had never
// had ANY governor, and combined with the 500ms queued-wakeup restart in `runtime.ts`, a
// repeated preempt signal could abort a fresh in-flight call every ~1s with no counter and no
// backoff — the fastest concretely-provable cold-redial loop the census found. The name and
// the value are unchanged from the A2A-era original on purpose: the SHAPE this task was told
// to reuse (`shared-state.ts:90`) is this exact pair, not a re-derivation of it, and every
// future caller of `preemptAgentForUrgentMessage` shares this ONE per-agent cool-down rather
// than inventing its own.
export const lastA2APreemptAt = new Map<string, number>();
export const A2A_PREEMPT_MIN_INTERVAL_MS = 30_000;

// Track agent start times for uptime calculation.
export const agentStartTimes = new Map<string, number>();

// Per-agent count of consecutive auto-continuations across turns.
// SLOW-INFERENCE T79b: no longer bounded by a flat MAX_TURN_AUTO_CONTINUATIONS (that constant
// is gone) — the ladder is bounded by the serving provider's own declared unattended budget,
// via `agent/unattended-budget.ts`'s `continuationCapFor`, read fresh at each checkpoint in
// `agent/v2/steps/pre-call-gates/turn-budget.ts`. Reset on a clean turn end, unchanged.
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

// T81b (NO-DOOMED-DIALS) — which agents have already spent their ONE forced-compaction
// attempt on a pre-dial doomed-request refusal (`v2/recovery.ts`'s `tryPreDialDoomedRefusalRecovery`),
// keyed to WHICH turn spent it — not a bare boolean.
//
// REVIEW ROUND FINDING: a bare `Set<agentId>` (the first cut) is cleared only when the cap is
// spent (a second doomed refusal arrives) or on a CLEAN turn finalize
// (`v2/steps/finalize/index.ts`, matching `recoveryRunStreak`'s own asymmetry — a turn that
// ends via the error/recovery arm never clears it, on purpose, the same reason
// `recoveryRunStreak` doesn't either). But an error-path turn end for a DIFFERENT reason (an
// unrelated network failure, say) is also NEITHER of those two — so the bare boolean stayed set
// forever, and a much-later, wholly unrelated doomed request on the same agent found it already
// "spent" and skipped the one compaction it was entitled to.
//
// THE FIX: discriminate the marker the way `recoveryRunStreak` discriminates by
// `{kind, inputsFingerprint}` — store WHICH turn earned the spend (`agentId -> turnNumber`),
// not just THAT one was spent. `turn-record.ts`'s `startTurn` allocates `turn_number` as
// `MAX(turn_number) + 1` per agent, so it is a strict, gapless, per-agent monotonic sequence —
// which makes "is the CURRENT turn the one immediately after the one that compacted"
// (`current === spentAtTurn + 1`) a reliable identity check, not a guess. A turn number that
// does NOT match is proof a DIFFERENT turn happened in between (successful or not), so the
// marker is treated as unspent and a fresh compaction is granted — self-cleaning, because no
// stale entry can ever coincidentally satisfy the adjacency check again (turn numbers never
// repeat and never go backward).
//
// TRADEOFF, STATED RATHER THAN HIDDEN: if the queued self-wake races an unrelated trigger (a
// user message, say) and loses, so the doomed request's actual retry lands two-or-more turns
// later instead of immediately next, this grants it one EXTRA compaction it was not strictly
// owed. That is the deliberately safe direction to be wrong in: an extra compaction attempt is
// bounded and costs no dial, where the alternative (denying a rightful compaction) is the exact
// defect this fix exists to close.
export const doomedPrefillCompactionSpent = new Map<string, number>();

// T81c FIX ROUND 1 (NO-DOOMED-DIALS) — REPLACES a `last_error` STRING READ THE REVIEW ROUND
// PROVED UNSAFE, keyed `agentId -> turnNumber`, same idiom as `doomedPrefillCompactionSpent`
// directly above.
//
// THE DEFECT THE FIRST CUT SHIPPED: `runtime.ts`'s 500ms queued-wakeup restart declined to fire
// whenever `agents.last_error` CONTAINED a declared-patience phrase, with no scoping to WHICH
// turn produced it. `agents.last_error` survives a `working` transition by design (FA-A2 — the
// Healer's diagnostic must not vanish on the free retry that follows an injury), so an OLD
// declared-patience injury's message could still be sitting in `last_error` turns later, after
// the agent recovered onto a completely different failure. Four recovery arms in
// `v2/recovery.ts` — `tryContextOverflowRecovery`, `tryPreDialDoomedRefusalRecovery`,
// `tryOutputTruncationRecovery`, and Tier-B's `tryProviderRecovery` — all call `queueSelfWake`
// for a LEGITIMATE, intended retry WITHOUT touching `last_error` at all (none of them are
// injuries; `recordInjury` is the only writer). Reviewer's reproduction: an agent injured by a
// declared-patience turn, resumed by a fresh human message (status flips to `working`,
// `last_error` untouched), then hits an UNRELATED context-overflow on the very next turn — the
// stale phrase from the FIRST injury was still sitting in `last_error`, so the SECOND turn's
// entirely legitimate forced-compaction retry was silently declined. Status stayed `working`
// forever with nothing left to wake it except the 75-minute stuck-agent reaper — exactly the
// silent-hang class P3 forbids, produced by the very mechanism meant to prevent one.
//
// THE FIX: stop reading prose. `v2/recovery.ts`'s `recordInjury` is the ONE place that KNOWS,
// authoritatively, that a turn just ended on `DECLARED_PATIENCE_EXCEEDED_CODE` with NO
// self-scheduled retry — reaching `recordInjury` at all means every earlier cascade step
// (including the four listed above) declined to handle it. It sets this marker to the turn
// that just failed, and ONLY there. `runtime.ts`'s queued-wakeup gate declines ONLY when the
// marker names the EXACT turn number `v2/turn-record.ts`'s `currentTurnNumber` reports as the
// agent's latest — i.e., the turn that marker was set for is still the most recent one, nothing
// has run since — and consumes (deletes) it as part of declining. Cleared unconditionally at
// the start of every new turn (`v2/steps/preflight/counterparty-and-record.ts`, right where the
// turn's own number is allocated) as a second, independent guarantee: even if some future edit
// let a stale marker survive an intervening turn, `currentTurnNumber` having moved on already
// makes an old entry's turn number mismatch — the clear-on-start is belt-and-suspenders on top
// of an identity check, not the whole safety net by itself.
export const declaredPatienceHonestFailTurn = new Map<string, number>();
