// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — THIS ITERATION'S TRACKER ACCOUNTING, moved byte-faithfully
// out of `loop.ts`'s `execute` span: what the model just did, counted the five
// different ways the floors below it ask about.
//
// The five questions are deliberately different and each carries its own incident
// at its own site — tracker engagement, REAL work calls (trivial lookups excluded,
// FA-T3), a status mutation, a DISARMING write (FN-9 / FA-T2), and the narrow "did
// a work ROW come into existence" (T8c item 3 / D4). Widening any one of them into
// another is how both counters moved silently the last time.
//
// The agent-created start-ack rides here because it keys on the same iteration's
// calls: a diligent agent that opens its own project must not DEPRIVE the person of
// the "on it" the engine's own scaffold would have given them.
// ════════════════════════════════════════

import { CLOSING_WORK_OPS, DISARMING_WORK_OPS, OPENING_WORK_OPS, isTrackerFamilyCall, toolOpKey } from '../../../../tools/work-verbs.js';
import { accumulateUntrackedWorkAcrossTurns, clearUntrackedWorkAcrossTurns } from '../../../turn-state.js';
import { advance, type AgentTurnState } from '../../state.js';
import { isAdvancingStatusArg } from './work-status.js';
import { TRIVIAL_TOOLS } from './tool-sets.js';
import type { ExecuteContext } from './index.js';
import { getDb } from '../../../../db/connection.js';
import { taskScope } from '../../../../work/tracker-view.js';
import { chargeEffort } from '../../../../tracker/effort-governor.js';

/**
 * T79c: resolve "the agent's CURRENT claimed task" for the durable effort meter.
 *
 * Same scope, same predicate, same filter as `tracker-floors.ts`'s own nag — it
 * resolves "the only open tracker task assigned to you" (the "hasn't been updated in
 * a while" message, ~line 283 there) via `taskScope`, `state = 'claimed'` (status
 * "in_progress"), `agent_id = ?`. Copied in SHAPE rather than by calling that code,
 * because the nag's question is "is there a stale one to name in a message" (it reads
 * every claimed task and picks the STALEST to warn about) and this one is "which row
 * pays for THIS call" — a different question that additionally needs a deterministic
 * pick when more than one task is claimed at once: charge the MOST RECENTLY UPDATED
 * one (`ORDER BY updated_at DESC, rowid DESC LIMIT 1`). That is also the task most
 * likely to be the one this iteration's calls were actually for, since a tracker
 * write on it is what would have bumped `updated_at` in the first place.
 *
 * T79 FIX WAVE, FINDING 3 (minor): `, rowid DESC` is the tiebreak. `noteEngineCheckpoint`
 * (`work/engine-checkpoint-note.ts`) touches every one of an agent's claimed tasks with ONE
 * shared `now` at a checkpoint, so two tasks can share the exact same `updated_at` — without a
 * secondary sort the pick between them is whatever order SQLite happens to return, unspecified
 * and untested. `rowid` is monotonic insertion order, always present on this table (a normal
 * rowid table, not `WITHOUT ROWID`), and free of ties by construction.
 *
 * Returns `null` when nothing is claimed — charge nothing in that case. Untracked
 * work already has its own governor (the tracker floors: the >3 nudge / >=6
 * auto-scaffold above/below in this same iteration), a SEPARATE mechanism from this
 * durable per-task meter.
 *
 * Exported so the "most-recently-updated wins" choice is directly testable in
 * isolation from the rest of this iteration's accounting.
 */
export function resolveCurrentClaimedTaskId(agentId: string): string | null {
  const row = getDb().prepare(
    `SELECT w.id AS id FROM work w
     WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed'
     ORDER BY w.updated_at DESC, w.rowid DESC LIMIT 1`,
  ).get(agentId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function countTrackerWorkThisIteration(state: AgentTurnState, ctx: ExecuteContext): AgentTurnState {
  const { agentId, turnCtx, result, counterparty, counterpartyIsAgentSender, engineStartAckDeliveredThisTurn } = ctx;

  // ── Runtime tracker nudge (v2.5.40) ──
  // Detect "agent is doing real multi-step work but never opened a
  // tracker entry" mid-turn and inject a one-shot system reminder.
  // Multi-step work without a tracker task drifts and stalls, the PM
  // agent can't intervene because there's nothing to monitor, and on
  // the user's most recent test, an agent ran for tens of minutes,
  // hit compaction, and started re-reading sources it had already
  // lost from context. The reflex in the tool index header tells
  // agents to do this; this nudge is the runtime safety net for
  // agents that ignored it.
  // PHASE-2 T8V: `startsWith('tracker_')` became `isTrackerFamilyCall`, which
  // is the SAME membership — reminders and the two obligation ops are excluded
  // there for exactly the reason they were excluded here: `work_open(kind="reminder")`,
  // `work_open(kind="commitment")` and `work_close_request(action="commitment")` never carried the prefix, so
  // widening to "any work verb" would silently move both counters below.
  const trackerInThisIter = result.toolCalls.filter(
    (tc) => isTrackerFamilyCall(tc.name, tc.arguments),
  ).length;
  // FA-T3: the multi-step floor counts REAL WORK calls only, calls that are
  // neither tracker ops nor TRIVIAL_TOOLS (read-only reconnaissance / utility
  // / bookkeeping). Before this, a pure recon turn (check email + calendar +
  // texts + vault, ~6 read-only lookups) tripped the >=6 floor, auto-scaffolded
  // a junk project, then failed the close-out gate, auto-paused, and fired
  // CLOSEOUT_MISS at the PM. Trivial lookups are not multi-step work. Reads
  // still never DISARM the floor (FN-9); they simply no longer COUNT toward it.
  const nonTrackerInThisIter = result.toolCalls.filter(
    (tc) => !isTrackerFamilyCall(tc.name, tc.arguments) && !TRIVIAL_TOOLS.has(tc.name),
  ).length;
  // T79 FIX WAVE, FINDING 1 (CRITICAL) — the durable effort meter's OWN count, computed here
  // but consumed ONLY at the charge site below. `nonTrackerInThisIter` above exists for the
  // SCAFFOLDING FLOORS (FA-T3's deliberate anti-false-positive carve-out for TRIVIAL_TOOLS —
  // reconnaissance lookups should not trip the >=6 auto-scaffold), and every floor/nudge that
  // reads it keeps reading exactly that number, untouched.
  //
  // The effort meter has no such reason to look away: a wide loop built entirely of
  // TRIVIAL_TOOLS calls (varied gmail_search / gmail_inbox / calendar-lookup shapes — the
  // plan's own motivating scenario, a mailbox sweep re-enumerating forever) is real, ongoing
  // model spend on a claimed task, and before this fix it charged the meter NOTHING, so on an
  // uncapped provider row nothing ever stopped it. This count reuses `isTrackerFamilyCall` —
  // the SAME authoritative tracker-family predicate `trackerInThisIter` above already applies
  // — and excludes nothing else: every call this iteration that is not a tracker-family call,
  // TRIVIAL_TOOLS included, is chargeable effort.
  const chargeableCallsInThisIter = result.toolCalls.filter(
    (tc) => !isTrackerFamilyCall(tc.name, tc.arguments),
  ).length;
  // The status-mutation OPERATIONS are the signal "agent advanced or closed a
  // task this turn", distinct from broad tracker engagement (which includes
  // work_open:project and the two read ops).
  const trackerStatusInThisIter = result.toolCalls.some(
    (tc) => CLOSING_WORK_OPS.has(toolOpKey(tc.name, tc.arguments)),
  );
  // v3.1.11 (FN-9) + FA-T2: disarm the multi-step floor only when the agent
  // OPENS or ADVANCES its own work. Creating / editing / adding-notes /
  // advancing-a-step is tending; a status change disarms only when its status
  // arg advances the task to an active state. CLOSING / abandoning / handing
  // off (close_project, reassign, resolve_missed, status -> complete/fallen/
  // paused/blocked) does NOT disarm: it removes what the PM watches, so new
  // multi-step work later in the SAME turn must not ride in behind an earlier
  // close. For those the floor falls through to the hasRecentlyTendedTask DB
  // check. READS never disarm (they are absent from the disarming set).
  const trackerWriteInThisIter = result.toolCalls.some(
    (tc) => {
      const op = toolOpKey(tc.name, tc.arguments);
      return DISARMING_WORK_OPS.has(op) ||
        (op === 'work_update:status' && isAdvancingStatusArg(tc.arguments?.status));
    },
  );
  // T8c item 3 (D4): the narrow question the ENGINE FLOOR asks — did a work ROW come
  // into existence — as opposed to the wide "did the agent tend its work" above.
  const workOpenedInThisIter = result.toolCalls.some(
    (tc) => OPENING_WORK_OPS.has(toolOpKey(tc.name, tc.arguments)),
  );
  if (nonTrackerInThisIter > 0 || trackerInThisIter > 0) {
    state = advance(state, {
      nonTrackerToolCalls: state.nonTrackerToolCalls + nonTrackerInThisIter,
      trackerToolCalledThisTurn: state.trackerToolCalledThisTurn || trackerInThisIter > 0,
      trackerWriteThisTurn: state.trackerWriteThisTurn || trackerWriteInThisIter,
      workRowOpenedThisTurn: state.workRowOpenedThisTurn || workOpenedInThisIter,
      trackerStatusUpdatedThisTurn: state.trackerStatusUpdatedThisTurn || trackerStatusInThisIter,
    });
    // RC-19 item 3: mirror this iteration's untracked-work delta into the
    // cross-turn counter for the agent's current human conversation, so an A2A
    // send that breaks the turn can't reset the >=6 auto-scaffold floor. A tracker
    // write clears it (work is now tracked); a conversation change resets it (via
    // the conv_key tag inside accumulate). a2a/engine turns (conv_key null) are
    // transparent, so an interleaved A2A detour never clobbers the human total.
    if (trackerWriteInThisIter) {
      clearUntrackedWorkAcrossTurns(agentId);
    } else if (nonTrackerInThisIter > 0) {
      const turnConv = turnCtx.convKey;
      if (typeof turnConv === 'string' && turnConv.length > 0) {
        accumulateUntrackedWorkAcrossTurns(agentId, turnConv, nonTrackerInThisIter);
      }
    }
  }
  // T79c (T79 FIX WAVE, FINDING 1): charge this iteration's chargeable work calls to the
  // agent's CURRENT claimed task — durably, in the row, where a compaction cannot erase it
  // (unlike the in-memory cross-turn counter mirrored just above). This is the complementary
  // half of T79a's engine checkpoint note: that task keeps a claimed row's `updated_at` honest
  // across a checkpoint-and-continue so it is never mistaken for abandoned; this counter is
  // what stops that same aliveness from being spent forever on a task nobody is really
  // advancing. See `resolveCurrentClaimedTaskId` above for how "current claimed task" is
  // resolved and why nothing is charged when there isn't one.
  //
  // Deliberately OUTSIDE the `if (nonTrackerInThisIter > 0 || trackerInThisIter > 0)` gate
  // above: a trivial-only iteration (FINDING 1's mailbox-sweep scenario) trips neither of
  // those two, so nesting the charge inside that gate — as it stood before this fix — silently
  // skipped it even after `chargeableCallsInThisIter` was widened to see it.
  if (chargeableCallsInThisIter > 0) {
    const claimedTaskId = resolveCurrentClaimedTaskId(agentId);
    if (claimedTaskId) {
      chargeEffort(claimedTaskId, chargeableCallsInThisIter);
    }
  }
  // START ACK (NEXT-WAVE item 1, agent-created path): the owner rule is that
  // the user hears "on it" whenever their request is judged project-worthy.
  // That judgment can come from the engine classifier (the two auto-scaffold
  // sites below) OR from the AGENT proactively opening its own project. A
  // diligent agent that self-organizes must not DEPRIVE the user of the ack,
  // so fire it here too, deduped by the same one-per-turn flag and gated to
  // user turns. If the engine auto-scaffold already fired this turn the flag
  // is set, so there is never a double ack.
  if (
    counterparty.kind === 'user' &&
    !counterpartyIsAgentSender && // RC-4.2: no start-ack to an agent-flagged sender
    !engineStartAckDeliveredThisTurn &&
    !turnCtx.startAckSteerArmedThisTurn && !turnCtx.startAckSteerRequested &&
    result.toolCalls.some((tc) => toolOpKey(tc.name, tc.arguments) === 'work_open:project')
  ) {
    // Owner ruling 2026-07-22 (engine detects, agent speaks): request the
    // steer; the next iteration boundary injects it and the model speaks.
    turnCtx.startAckSteerRequested = true;
  }
  return state;
}
