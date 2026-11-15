// This iteration's tracker accounting: what the model just did, counted the distinct ways the floors ask.
// The questions differ on purpose; widening one into another silently moves the counters.

import { CLOSING_WORK_OPS, DISARMING_WORK_OPS, OPENING_WORK_OPS, isTrackerFamilyCall, toolOpKey } from '../../../../tools/work-verbs.js';
import { accumulateUntrackedWorkAcrossTurns, clearUntrackedWorkAcrossTurns } from '../../../turn-state.js';
import { advance, type AgentTurnState } from '../../state.js';
import { isAdvancingStatusArg } from './work-status.js';
import { TRIVIAL_TOOLS } from './tool-sets.js';
import type { ExecuteContext } from './index.js';
import { getDb } from '../../../../db/connection.js';
import { taskScope, workingTaskOrder } from '../../../../work/tracker-view.js';
import { recordCallsTouched, type RoundResult } from '../../../../work/ledger-store.js';
import type { ToolEffect } from '../../../tools/types.js';
import { jobTaskOf } from '../post-call-classify/job-turn-end.js';
import { heldExpr, workingExpr } from '../../../../work/done/hold.js';

/** The agent's current claimed task, or null; ordered by `workingTaskOrder`, shared with the job pick. */
export function resolveCurrentClaimedTaskId(agentId: string): string | null {
  const row = getDb().prepare(
    `SELECT w.id AS id FROM work w
     WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w')} AND NOT ${heldExpr('w')}
     ORDER BY ${workingTaskOrder('w')} LIMIT 1`,
  ).get(agentId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** The task this iteration is charged to: the job's task the turn end reads (`jobTaskOf`), else the claim. */
export function taskToCharge(agentId: string): string | null {
  return jobTaskOf(agentId, getDb())?.id ?? resolveCurrentClaimedTaskId(agentId);
}

export function countTrackerWorkThisIteration(
  state: AgentTurnState, ctx: ExecuteContext, roundResults: ReadonlyArray<RoundResult> = [],
  /** Each tool's declared effects (`effectsFor`), handed in by the executor: importing the tool layer
   *  here would add a module edge. */
  effectsOf: (toolName: string) => readonly ToolEffect[] | undefined = () => undefined,
): AgentTurnState {
  const { agentId, turnCtx, result, counterparty, counterpartyIsAgentSender, engineStartAckDeliveredThisTurn } = ctx;

  // `isTrackerFamilyCall` excludes reminders and obligation ops; widening it would move both counters below.
  const trackerInThisIter = result.toolCalls.filter(
    (tc) => isTrackerFamilyCall(tc.name, tc.arguments),
  ).length;
  // Real work calls only: tracker ops and trivial lookups never count toward the multi-step floor.
  const nonTrackerInThisIter = result.toolCalls.filter(
    (tc) => !isTrackerFamilyCall(tc.name, tc.arguments) && !TRIVIAL_TOOLS.has(tc.name),
  ).length;
  const chargeableCallsInThisIter = result.toolCalls.filter(
    (tc) => !isTrackerFamilyCall(tc.name, tc.arguments),
  );
  const trackerStatusInThisIter = result.toolCalls.some(
    (tc) => CLOSING_WORK_OPS.has(toolOpKey(tc.name, tc.arguments)),
  );
  // Disarm the floor only when the agent opens or advances its own work; closing, handing off or reading
  // never disarms, so later multi-step work in the turn cannot ride in behind a close.
  const trackerWriteInThisIter = result.toolCalls.some(
    (tc) => {
      const op = toolOpKey(tc.name, tc.arguments);
      return DISARMING_WORK_OPS.has(op) ||
        (op === 'work_update:status' && isAdvancingStatusArg(tc.arguments?.status));
    },
  );
  // The engine floor's narrow question: did a work row come into existence this iteration.
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
    // Mirror untracked work into the human conversation's cross-turn counter; a2a/engine turns are skipped.
    if (trackerWriteInThisIter) {
      clearUntrackedWorkAcrossTurns(agentId);
    } else if (nonTrackerInThisIter > 0) {
      const turnConv = turnCtx.convKey;
      if (typeof turnConv === 'string' && turnConv.length > 0) {
        accumulateUntrackedWorkAcrossTurns(agentId, turnConv, nonTrackerInThisIter);
      }
    }
  }
  // This iteration's work calls, on the agent's current claimed task: what they touched.
  if (chargeableCallsInThisIter.length > 0) {
    const claimedTaskId = taskToCharge(agentId);
    if (claimedTaskId) {
      recordCallsTouched(claimedTaskId, chargeableCallsInThisIter, roundResults, effectsOf, agentId); // what this round's successes touched
    }
  }
  // Start ack when the agent opens its own project on a user turn, deduped by the one-per-turn flags.
  if (
    counterparty.kind === 'user' &&
    !counterpartyIsAgentSender && // no start-ack to an agent-flagged sender
    !engineStartAckDeliveredThisTurn &&
    !turnCtx.startAckSteerArmedThisTurn && !turnCtx.startAckSteerRequested &&
    result.toolCalls.some((tc) => toolOpKey(tc.name, tc.arguments) === 'work_open:project')
  ) {
    // The engine detects, the agent speaks: request the steer; the next iteration boundary injects it.
    turnCtx.startAckSteerRequested = true;
  }
  return state;
}
