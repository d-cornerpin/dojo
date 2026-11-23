// This iteration's tracker accounting: whether the model wrote or closed its own work, and what its work calls touched.

import { CLOSING_WORK_OPS, DISARMING_WORK_OPS, isTrackerFamilyCall, toolOpKey } from '../../../../tools/work-verbs.js';
import { advance, type AgentTurnState } from '../../state.js';
import { isAdvancingStatusArg } from './work-status.js';
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

  const chargeableCallsInThisIter = result.toolCalls.filter(
    (tc) => !isTrackerFamilyCall(tc.name, tc.arguments),
  );
  const trackerStatusInThisIter = result.toolCalls.some(
    (tc) => CLOSING_WORK_OPS.has(toolOpKey(tc.name, tc.arguments)),
  );
  // The agent opened or advanced its own work; closing, handing off or reading is not a write.
  const trackerWriteInThisIter = result.toolCalls.some(
    (tc) => {
      const op = toolOpKey(tc.name, tc.arguments);
      return DISARMING_WORK_OPS.has(op) ||
        (op === 'work_update:status' && isAdvancingStatusArg(tc.arguments?.status));
    },
  );
  if (trackerWriteInThisIter || trackerStatusInThisIter) {
    state = advance(state, {
      trackerWriteThisTurn: state.trackerWriteThisTurn || trackerWriteInThisIter,
      trackerStatusUpdatedThisTurn: state.trackerStatusUpdatedThisTurn || trackerStatusInThisIter,
    });
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
