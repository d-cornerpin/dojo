// Two tracker tiers: a one-shot >3 nudge (a model-choice assist) and a >=6 engine floor that opens
// one work row itself, so work is tracked on the weakest model whatever the model chooses.

import { isDreamerAgent, isHealerAgent, isPMAgent } from '../../../../config/platform.js';
import { clearUntrackedWorkAcrossTurns, getUntrackedWorkAcrossTurns } from '../../../turn-state.js';
import { ENGINE_SCAFFOLD_ROOT_KIND } from '../../../../work/tracker-view.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { advance, type AgentTurnState } from '../../state.js';
import { TRACKER_STEER_FLOORS, steerFiredAny } from '../../steer-queue.js';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { getDb } from '../../../../db/connection.js';
import { recordedInstant } from '../../../../memory/message-stamp.js';
import { jobOfTurn } from '../../../../work/job-continuation.js';
import { askIdForMessage, joinState } from '../../../../work/store.js';
import { openTrackerTask } from '../../../../work/tracker-store.js';

const logger = createLogger('v2-loop');
import type { ExecuteContext } from './index.js';

/** The floor's title: engine facts only, never the turn's message (the row links to it instead). */
export const SCAFFOLD_TITLE = 'Multi-step task';

/** THE ONE OPENER of an engine task: one working task, linked to the request it serves (and its thread, for
 *  another agent's request). The floor and a park call it; the title is theirs. */
export function openEngineScaffoldTask(agentId: string, title: string, turn: number, request: { messageId: string; convKey: string | null; threadId?: string | null }): string {
  return openTrackerTask({
    title, assignedTo: agentId, createdBy: agentId, status: 'in_progress', rootKind: ENGINE_SCAFFOLD_ROOT_KIND,
    a2aThreadId: request.threadId ?? null,
    origin: { kind: 'engine_scaffold', sourceMessageId: request.messageId, turn, convKey: request.convKey },
  });
}

/** The most-used tool this turn, from the turn's own persisted `tool_use` rows. */
function mostUsedToolThisTurn(agentId: string, turnNumber: number): string | null {
  try {
    const rows = getDb().prepare(
      `SELECT content FROM messages
        WHERE agent_id = ? AND turn_number = ? AND role = 'assistant' AND content LIKE '[{%'`,
    ).all(agentId, turnNumber) as Array<{ content: string }>;
    const tally = new Map<string, number>();
    for (const r of rows) {
      try {
        for (const b of JSON.parse(r.content) as Array<{ type?: string; name?: string }>) {
          if (b.type === 'tool_use' && b.name) tally.set(b.name, (tally.get(b.name) ?? 0) + 1);
        }
      } catch { /* not a block array */ }
    }
    let best: string | null = null;
    for (const [name, n] of tally) if (best === null || n > (tally.get(best) ?? 0)) best = name;
    return best;
  } catch { return null; }
}

/** The floor's title, from engine facts only. */
export function scaffoldTitle(calls: number, tool: string | null, turnStartMs: number): string {
  return `${SCAFFOLD_TITLE} — ${calls} calls${tool ? `: ${tool}` : ''} ${recordedInstant(turnStartMs)}`;
}

export async function runTrackerFloors(state: AgentTurnState, ctx: ExecuteContext): Promise<AgentTurnState> {
  const {
    agentId, turnCtx, turnNumber, chosenConvKey, staleTaskWindowMinutes,
    counterparty, counterpartyIsAgentSender, engineStartAckDeliveredThisTurn,
  } = ctx;
  const STALE_TASK_WINDOW_MINUTES = staleTaskWindowMinutes;

  const TRACKER_NUDGE_THRESHOLD = 3;
  const TRACKER_AUTO_SCAFFOLD_AT = 6;
  // The floor counts the conversation's cross-turn untracked total so an A2A send cannot reset it.
  const turnConvForFloor = turnCtx.convKey;
  const effectiveUntracked =
    typeof turnConvForFloor === 'string' && turnConvForFloor.length > 0
      ? Math.max(state.nonTrackerToolCalls, getUntrackedWorkAcrossTurns(agentId, turnConvForFloor))
      : state.nonTrackerToolCalls;
  if (
    // The Healer is tracker-exempt: a task it cannot tend would go stale and trip the PM poke ladder.
    !isHealerAgent(agentId) &&
    // The tiers ask different questions. Nudge: has the agent tended its work this turn (any write)?
    // Floor: does a work row exist for this turn's work (an opening op)? A nudge-opened row satisfies it.
    ((!state.trackerWriteThisTurn && !steerFiredAny(state.steerQueue, TRACKER_STEER_FLOORS) && state.nonTrackerToolCalls > TRACKER_NUDGE_THRESHOLD) ||
      (!state.workRowOpenedThisTurn && effectiveUntracked >= TRACKER_AUTO_SCAFFOLD_AT))
  ) {
    // A recently moved in_progress task suppresses the nudge; the task carrying this turn is named by it when stale.
    const job = jobOfTurn(agentId, state.lastUserMessageId);
    let hasRecentlyTendedTask = false;
    let staleOpenTask: { id: string; title: string } | null = null;
    try {
      const { listTasks } = await import('../../../../tracker/schema.js');
      const { normalizeDbTimestamp } = await import('../../../../scheduler/engine.js');
      const { taskLastMovedAt } = await import('../../../../tracker/liveness.js');
      const cutoffMs = Date.now() - STALE_TASK_WINDOW_MINUTES * 60_000;
      // in_progress only: queued or scheduled on_deck tasks are not neglected work and are never named.
      const candidates = listTasks({ status: 'in_progress', assignedTo: agentId });   // Working: claimed or sent back
      for (const t of candidates) {
        const tendedMs = taskLastMovedAt(t.id, new Date(normalizeDbTimestamp(t.updatedAt)).getTime());   // real movement (ledger included); a park touches nothing
        if (tendedMs >= cutoffMs) {
          hasRecentlyTendedTask = true;
        } else if (t.id === job) {
          staleOpenTask = { id: t.id, title: t.title };
        }
      }
    } catch (err) {
      logger.warn('Tracker nudge: listTasks failed (treating as no recently-tended task)', {
        agentId, err: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    if (
      // Open a task only when no task carries this turn's work, whatever other tasks the agent holds.
      !job && !(state.lastUserMessageId && (joinState(askIdForMessage(state.lastUserMessageId))?.landed ?? 0) > 0) &&
      effectiveUntracked >= TRACKER_AUTO_SCAFFOLD_AT &&
      // The floor opens a row only for a turn serving a request it can link to; it never invents one.
      state.lastUserMessageId &&
      !isPMAgent(agentId) &&
      // The Dreamer's batch work is engine-orchestrated maintenance, not a user ask.
      !isDreamerAgent(agentId)
    ) {
      try {
        // No message text is captured here, so no handed credential can reach the work row from this floor.
        const scaffoldName = scaffoldTitle(effectiveUntracked, mostUsedToolThisTurn(agentId, turnNumber), state.turnStartMs);
        const scaffoldTaskId = openEngineScaffoldTask(agentId, scaffoldName, turnNumber, { messageId: state.lastUserMessageId, convKey: chosenConvKey });
        // The steer queue reaches the model (the assembler strips system rows); the row serves the dashboard.
        // The note prints both counts so the one that fired the floor (effectiveUntracked) is visible.
        const autoNoteText = (
          `[System] The engine opened tracker task "${scaffoldName}" (task_id: ${scaffoldTaskId}) for this work ` +
          `(work calls with no tracker entry — this turn: ${state.nonTrackerToolCalls}; ` +
          `total untracked in this conversation: ${effectiveUntracked}; floor: ${TRACKER_AUTO_SCAFFOLD_AT}; ` +
          `untracked multi-step work drifts and the PM cannot monitor it). ` +
          // Facts and how to keep the row honest; no close-coaching.
          `Keep working; rename it with work_update(action="edit", title=…) to what you are doing, and update it with work_note as you go.`
        );
        state = persistEngineSteer(
          state,
          { agentId, content: autoNoteText, turnNumber, floor: 'tracker-scaffold', atLoop: state.loopCount },
          { broadcast },
        );
        // The floor opened a work row: set the flags so neither tier re-enters this turn.
        state = advance(state, {
          trackerToolCalledThisTurn: true,
          trackerWriteThisTurn: true,
          workRowOpenedThisTurn: true,
        });
        // This engine-side write bypasses the per-iteration accumulate/clear, so reset the cross-turn
        // total explicitly or it would re-trip the floor next turn.
        clearUntrackedWorkAcrossTurns(agentId);
        logger.info('v2: tracker auto-scaffold fired (engine floor)', {
          agentId,
          nonTrackerToolCalls: state.nonTrackerToolCalls,
          effectiveUntracked,
          floor: TRACKER_AUTO_SCAFFOLD_AT,
          taskId: scaffoldTaskId,
        }, agentId);
        // The only engine site that opens work requests a start-ack steer once per turn (the model words it);
        // never for an agent counterparty (ack ping-pong).
        if (counterparty.kind === 'user' && !counterpartyIsAgentSender && !engineStartAckDeliveredThisTurn && !turnCtx.startAckSteerArmedThisTurn && !turnCtx.startAckSteerRequested) {
          turnCtx.startAckSteerRequested = true;
        }
      } catch (err) {
        logger.warn('Tracker auto-scaffold failed (non-fatal, falling back to nudge)', {
          agentId, err: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    } else if (!hasRecentlyTendedTask && !steerFiredAny(state.steerQueue, TRACKER_STEER_FLOORS)) {
      // A stale open task is named with a choice to update it or start new work; otherwise ask for a project.
      const nudgeText = staleOpenTask
        ? (
          `[System: you've made ${state.nonTrackerToolCalls} work tool calls this turn, but the only open tracker task assigned to you ("${staleOpenTask.title}", task_id ${staleOpenTask.id.slice(0, 8)}) hasn't been updated in a while. ` +
          `Multi-step work that isn't reflected in a live tracker task drifts and stalls (the PM agent can't intervene because there's nothing current to monitor) and your context is filling up which means compaction is coming and you'll lose source detail you've already read. ` +
          `Decide now: if what you've been doing IS that task, bring it current via work_update(action="status") / work_note; otherwise this is NEW work, so open a project for it with work_open(kind="project", title="<short name>", level=2, plan={approach, steps:[{title, how, done}…one step per discrete batch…]}). ` +
          `Then keep each task current via work_update(action="status"), and use scratchpad_set to keep a running outline that survives compaction. ` +
          `Resume the work once the tracker reflects it.]`
        )
        : (
          `[System: you've made ${state.nonTrackerToolCalls} work tool calls this turn without an active tracker task assigned to you. ` +
          `Multi-step work without a tracker entry drifts and stalls (the PM agent can't intervene because there's nothing to monitor) and your context is filling up which means compaction is coming and you'll lose source detail you've already read. ` +
          `STOP what you're doing right now and call work_open(kind="project", title="<short name>", level=2, plan={approach, steps:[{title, how, done}…]}) describing the steps for what you've been doing and what's left. ` +
          `Then update each task as you complete it via work_update(action="status"), and use scratchpad_set to keep a running outline that survives compaction. ` +
          `Resume the work after the project is opened.]`
        );
      // Through persistEngineSteer so the STOP directive reaches the model, not only the dashboard row.
      state = persistEngineSteer(
        state,
        { agentId, content: nudgeText, turnNumber, floor: 'tracker-stop-directive', atLoop: state.loopCount },
        { broadcast },
      );
      logger.info('v2: tracker nudge fired', {
        agentId, nonTrackerToolCalls: state.nonTrackerToolCalls,
      }, agentId);
    }
  }
  return state;
}
