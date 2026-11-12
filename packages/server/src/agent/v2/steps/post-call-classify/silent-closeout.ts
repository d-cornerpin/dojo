// When a turn completes tracked work and the person heard nothing, steer the model to say it.
// The engine detects; the model phrases. The engine never composes the line itself.

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer, steerFired } from '../../steer-queue.js';
import { closedWithoutDelivery, owesAnswer } from '../../answered-edge.js';
import { msToText, taskScope, tsToMs } from '../../../../work/tracker-view.js';
import { handedInSinceExpr, handInNoteExpr } from '../../../../work/done/record.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';
import { userWords } from '../../turn-address.js';

const logger = createLogger('v2-loop');

/** The silent-closeout check and its handed-back mic. */
export async function runSilentCloseout(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agentId, counterparty, counterpartyIsAgentSender, db, hasUnansweredUser, isA2ATurn,
    messageId, persistAndBroadcastSystemRow, turnCtx, turnNumber, turnStartedAt,
  } = ctx;
  const { persistedContent } = sc;
  // Fires once, on user-facing turns where nothing user-facing surfaced. Engine-record facts ride
  // in the steer so the weakest model only has to phrase, not remember.
  if (
    !steerFired(state.steerQueue, 'silent-closeout') &&
    !isA2ATurn &&
    counterparty.kind === 'user' &&
    !counterpartyIsAgentSender &&
    (!persistedContent || persistedContent.trim().length === 0) &&
    !state.surfacedReplyThisTurn &&
    !state.lastAssistantTextForIM &&
    !turnCtx.deferredUserReplyWithTools &&
    !Object.values(state.explicitSendThisTurn).some(Boolean)
  ) {
    try {
      // Spine work closed without a delivery is only logged; tracker tasks carry the closed row's
      // own prose and are filtered through the one owesAnswer() reader.
      const turnStartedAtMs = Date.parse(`${turnStartedAt.replace(' ', 'T')}Z`);
      const closedWorkThisTurn = closedWithoutDelivery(agentId, Number.isFinite(turnStartedAtMs) ? turnStartedAtMs : Date.now() - 60_000);
      const closedThisTurn = db.prepare(`
        SELECT w.title AS title, ${handInNoteExpr('w')} AS result, ${msToText('w.opened_at')} AS created_at,
               w.source_message_id AS source_message_id FROM work w
         WHERE ${taskScope('w')} AND w.agent_id = ? AND w.repeat_interval IS NULL AND ${handedInSinceExpr('w')}
         ORDER BY w.updated_at ASC LIMIT 3
      `).all(agentId, tsToMs(turnStartedAt) ?? 0) as Array<{ title: string; result: string | null; created_at: string; source_message_id: string | null }>;
      if (closedWorkThisTurn.length > 0) {
        logger.info('v2 silent-closeout: work settled this turn with NO delivery to point at', {
          agentId, turnNumber,
          work: closedWorkThisTurn.map((w) => ({ id: w.workId, kind: w.kind, state: w.state })),
        }, agentId);
      }
      if (closedThisTurn.length > 0) {
        // Owed per task by receipt: a task with an origin ask owes a closeout only while that ask is
        // unanswered; a task without one owes it only when this turn serves a live human ask.
        const owedTasks = closedThisTurn.filter((t) => (
          t.source_message_id ? owesAnswer(t.source_message_id) : hasUnansweredUser
        ));
        if (owedTasks.length > 0) {
          const first = owedTasks[0];
          const whichTask = owedTasks.length === 1
            ? `the task "${first.title.slice(0, 80)}"`
            : `${owedTasks.length} tasks (first: "${first.title.slice(0, 80)}")`;
          // Quote engine receipts only, never the model's result prose (it can be false); with no
          // recorded delivery, demand honesty instead of a claim of done.
          let receipts = '';
          try {
            const { composeTurnDeliverySummary, isTangibleDeliverySummary } =
              await import('../../../../tracker/task-stamps.js');
            // Only a tangible delivery counts; a dashboard-only bubble is what this floor fires about.
            const summary = composeTurnDeliverySummary(agentId, turnNumber);
            receipts = isTangibleDeliverySummary(summary) ? summary : '';
          } catch { /* fall through to the no-receipts wording */ }
          const steerText =
            `[Engine record: this turn handed in ${whichTask}. ` +
            (receipts.length > 0
              ? `The engine recorded this delivery: ${receipts.slice(0, 220)}. ${userWords(turnCtx.address, true)} has not heard anything about it. `
              : 'The engine has NO recorded delivery for it (no file artifact, no channel send). ') +
            'WRITE one short reply in this conversation now, in your own words: ' +
            (receipts.length > 0
              ? `tell ${userWords(turnCtx.address)} it is done and include the deliverable or link. `
              : `if the work truly reached ${userWords(turnCtx.address)}, say where; if it did NOT, say honestly what remains instead of claiming it is done. `) +
            'Do NOT call imessage_send or any other send tool; the engine routes your written reply automatically. Do not re-open or re-do the task.]';
          try {
            persistAndBroadcastSystemRow(steerText);
          } catch { /* dashboard row is best effort */ }
          broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
          state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'silent-closeout', content: steerText, atLoop: state.loopCount }) });
          logger.info('v2 silent-closeout steer: turn completed task(s) whose origin ask is unanswered; handing the mic to the model for the completion message', {
            agentId, turnNumber, taskCount: owedTasks.length, firstTask: first.title.slice(0, 60),
          }, agentId);
          return continueLoop(state);
        }
      }
    } catch { /* best effort; the teardown detector still logs the miss */ }
  }
  return proceed(state);
}
