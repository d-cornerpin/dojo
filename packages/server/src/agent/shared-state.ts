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

// T83 — THE RUN'S OWN STOP FENCE, because `stoppedAgents` is clearable FROM OUTSIDE. Two
// legitimate doors lift it — a fresh user message (`routes/chat.ts`) and reset-session
// (`routes/agents.ts`) — both meaning "the NEXT run may proceed", neither able to say "…but
// the run you stopped is still unwinding". Measured (MrMeSeeks `a504e5c9`, 2026-09-21): stop
// 04:22:42.167; reset-session lifted the flag 04:25:23.307; the stopped turn's budget
// checkpoint then queued `turn-budget-continuation` at 04:27:10.624 unrefused and the chain
// resumed on turn 73. SELF-CLEANING BY CONSTRUCTION: raised only when `activeRuns` says a run
// is in flight, lowered by that run's own `finally` in `runtime.ts` — the same ONE owner that
// retires `stoppedAgents` — so no fence can outlive its run and starve the agent (which would
// be the P3 silent hang, produced by the guard against one). RESIDUAL, not hidden: that
// `finally` deletes `activeRuns` at its top and then runs a long awaited tail; a stop landing
// inside the tail raises no fence and is covered by `stoppedAgents` exactly as before.
//
// T83 FIX ROUND (review IMPORTANT A-4): the value is WHEN the stop was requested (epoch ms),
// not a bare membership. A fence is raised against a run that is supposed to be tearing down;
// if it is still standing an hour later, that run is wedged, and `recoverStuckAgents` needs the
// age to say so. `.has()` / `.delete()` read exactly as they did when this was a `Set`.
export const stopFencedRuns = new Map<string, number>();

/** Is a user stop standing — by the flag, or by the fence the stopped run carries? OR-ed
 *  everywhere: a checkpoint reading only the flag is one reset-session can talk out of a stop. */
export function isStopFenced(agentId: string): boolean {
  return stoppedAgents.has(agentId) || stopFencedRuns.has(agentId);
}

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
  // T83: `isStopFenced`, not `stoppedAgents.has` — see the fence's header for the measured shape.
  if (isStopFenced(agentId)) {
    sharedStateLogger.info('self-wake refused: the user stopped this agent', { reason }, agentId);
    return false;
  }
  pendingWakeups.add(agentId);
  return true;
}

// ════════════════════════════════════════
// T83 — THE ABORT REGISTRY: A SET PER AGENT, BEHIND ONE DOOR.
//
// It was `Map<string, AbortController>` — ONE controller per agent, written and deleted by key
// from three files. Two measured facts (dev log, MrMeSeeks `a504e5c9`, 2026-09-21) say that
// shape cannot carry a stop:
//
//   1. ONLY ONE CALL SITE EVER REGISTERED — `v2/steps/call-llm/model-call.ts`, for the TURN's
//      own dial. Every other dial a turn makes registered nothing and carried no signal: the
//      budget checkpoint's forced compaction (`memory/summarize.ts`), the continuity brief,
//      the classifiers, ask-title, the vision-caption fallback. 04:22:16.150 the turn's own
//      call completed and de-registered; 04:22:25.273 the checkpoint's summariser dialled;
//      04:22:42.167 the stop found an EMPTY map and aborted nothing; 04:27:10.615 that call
//      completed after 285,328 ms and the turn parked for a continuation.
//   2. ONE SLOT IS WRONG EVEN IF EVERYONE REGISTERS. Two calls can be in flight on one agentId
//      at once — proven at 04:25:27.711, ask-title dialling while the summariser ran. One slot
//      means the second registration evicts the first and the first's completion deletes the
//      second, so a stop reaches neither. Hence a Set and a release BY IDENTITY.
//
// The three doors below are the ONLY writers; `a-stop-stops-and-the-status-tells-the-truth.
// test.ts` runs the census that keeps it that way.
// ════════════════════════════════════════

/** In-flight, abortable provider calls per agent. Written only by the doors below. */
export const activeAbortControllers = new Map<string, Set<AbortController>>();

/**
 * Register one in-flight call as abortable by this agent's stop.
 *
 * THE RACE THIS CLOSES: `stopAgent` can only abort what is registered at the instant it runs,
 * so a call registering a moment LATER used to dial straight through a stop that had already
 * landed. Registration and the stop check are one act here: either the stop was already
 * recorded and this controller is aborted before it reaches the wire, or it is in the registry
 * and the next abort reaches it. There is no third state.
 *
 * @returns true if registered; false if a live stop refused it — and on that path the
 *          controller is ALREADY aborted, so no caller has to remember to do it.
 */
export function registerAbortable(agentId: string, controller: AbortController): boolean {
  if (isStopFenced(agentId)) {
    controller.abort();
    sharedStateLogger.info('call refused before dialling: the user stopped this agent', {}, agentId);
    return false;
  }
  let set = activeAbortControllers.get(agentId);
  if (!set) { set = new Set(); activeAbortControllers.set(agentId, set); }
  set.add(controller);
  return true;
}

/** This call has settled. Removes BY IDENTITY, so one call's end never de-registers another's. */
export function releaseAbortable(agentId: string, controller: AbortController): void {
  const set = activeAbortControllers.get(agentId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) activeAbortControllers.delete(agentId);
}

/** Abort every call this agent has in flight. Returns how many were cut. */
export function abortInFlight(agentId: string, reason: string): number {
  const set = activeAbortControllers.get(agentId);
  if (!set || set.size === 0) return 0;
  const cut = set.size;
  for (const c of set) {
    try { c.abort(); } catch { /* an already-settled controller is not an error */ }
  }
  activeAbortControllers.delete(agentId);
  sharedStateLogger.info('in-flight provider calls aborted', { reason, cut }, agentId);
  return cut;
}

// ════════════════════════════════════════
// A-5 — THE MEDIA DIALS COME THROUGH THE SAME DOOR.
//
// T83 made "every provider call an agent makes is abortable by that agent's stop" true of
// everything dialled through `callModel`. The media generators are not: `image-generation.ts`,
// `audio-generation.ts`, `video-generation.ts` and `transcription.ts` each call `fetch`
// directly, so a stop pressed while an image / narration / video / transcript was on the wire
// found an empty registry for that work and cut nothing. The owner's instruction is that the
// button stops ALL of an agent's activity, so those dials register here too.
//
// ONE DOOR, NOT FIVE COPIES OF `callModel`'s PREAMBLE. Each of those sites already carries its
// own flat clock as the `signal:` argument, and the three things that have to be true of every
// one of them are the same three `callModel` spells out in its own header: register through the
// stop-aware door (which REFUSES, pre-aborted, while a stop is live), dial with that controller
// COMPOSED with whatever the caller brought rather than replacing it, and release BY IDENTITY
// on every exit path. Handing back a slot instead of wrapping the call is what lets a body with
// a dozen early returns adopt it without being rewritten around a callback.
//
// AND THE THIRD THING A MEDIA CALLER NEEDS THAT `callModel` DOES NOT: `cutByStop()`. A model
// call that dies throws and the loop's stop checkpoints read the fence; a generator RETURNS a
// result object with a `code`, and every one of those unions had only provider-failure codes in
// it. `image-generation.ts`'s `isTimeoutError` even classifies a bare `AbortError` as the
// 10-minute deadline, so before this a stop was reported to the user as *"Image generation
// timed out after 10 minutes. The provider or model is slow or overloaded right now."* — the
// user's own button wearing a provider's failure. The predicate asks THIS CALL'S OWN
// controller, never the composed signal, so the caller's clock can never be read as a stop and
// a stop can never be read as the clock: the same discrimination T81d's patience timer carries.
// ════════════════════════════════════════

/** One in-flight media call's registration. Opened per call; released on every exit path. */
export interface AgentCallSlot {
  /** Hand this to `fetch`. This call's stop controller, composed with the caller's own signals. */
  readonly signal: AbortSignal;
  /** A stop was ALREADY standing when this opened: do not dial. `signal` is aborted already. */
  readonly refused: boolean;
  /** Was this call cut by THIS agent's stop — as opposed to the caller's clock, or a transport
   *  error? Reads the call's own controller, so a composed timeout can never answer yes. */
  cutByStop(): boolean;
  /** This call has settled. Idempotent, and by identity — never another call's registration. */
  release(): void;
}

/**
 * Open one abortable media call under this agent's stop.
 *
 * @param externals any signals the caller already had (its flat clock, a parent loop's signal).
 *                  `undefined` entries are dropped so a caller need not branch.
 */
export function openAgentCall(agentId: string, ...externals: Array<AbortSignal | undefined>): AgentCallSlot {
  const ctl = new AbortController();
  const registered = registerAbortable(agentId, ctl);
  const present = externals.filter((s): s is AbortSignal => s != null);
  const signal = present.length === 0 ? ctl.signal : AbortSignal.any([ctl.signal, ...present]);
  let released = false;
  return {
    signal,
    refused: !registered,
    cutByStop: () => ctl.signal.aborted,
    release: () => {
      if (released) return;
      released = true;
      releaseAbortable(agentId, ctl);
    },
  };
}

/** The one sentence a stopped media call tells the user. Never a provider's failure wording. */
export const STOPPED_BY_USER = 'Stopped: you pressed stop while this was still generating.';

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

// T81b (NO-DOOMED-DIALS), WIDENED BY T82b (ANSWER-ANYWAY) — which agents have already spent
// their ONE forced-compaction attempt on a declared-patience exhaustion (`v2/recovery.ts`'s
// `tryDeclaredPatienceCompactOnceRecovery`, widened by T82b from a pre-dial-refusal-only
// `tryPreDialDoomedRefusalRecovery` to also cover a real dial dying at patience, sharing this
// exact Map rather than adding a second one), keyed to WHICH turn spent it — not a bare boolean.
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
// `v2/recovery.ts` — `tryContextOverflowRecovery`, `tryDeclaredPatienceCompactOnceRecovery`,
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
