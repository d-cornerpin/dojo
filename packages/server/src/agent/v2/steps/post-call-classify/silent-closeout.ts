// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE SILENT-CLOSEOUT STEER (owner ruling 2026-07-22), moved
// byte-faithfully out of `loop.ts`'s `postCallClassify` span.
//
// OR2 IN ITS PUREST FORM, AND THE REASON THIS TRANCHE'S NOTE SAYS THE FLOOR FAMILY IS
// ALREADY AGENT-VOICED: the user speaks with the AGENT, so the always-acked completion
// guarantee is enforced as a CHECK PLUS A HANDED-BACK MIC — the engine detects that a
// turn is ending without the person hearing anything, and STEERS the model to say it.
// The engine never composes the line itself.
// ════════════════════════════════════════

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer, steerFired } from '../../steer-queue.js';
import { closedWithoutDelivery, owesAnswer } from '../../answered-edge.js';
import { msToText, taskScope, tsToMs } from '../../../../work/tracker-view.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

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
  // ── Silent-closeout steer (owner ruling 2026-07-22) ── The user speaks
  // with the AGENT; the engine never speaks for it. So the always-acked
  // completion guarantee (v3.1.14 hard rule) is enforced as a CHECK plus
  // a handed-back mic, not as engine-composed text: when this ending turn
  // completed task(s) and nothing user-facing surfaced, steer once and
  // let the model say it in its own words. The engine-record facts ride
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
      // PHASE-2 T6 (C2, requirement 1b): "did work close WITHOUT a delivery" is a JOIN
      // now. The SPINE half asks it directly (`closedWithoutDelivery()`; the DDL's own
      // CHECK makes that set exact, since a row cannot be `done` without pointing at a
      // delivery); the TRACKER half — task rows on the same spine, kept as a separate
      // read because it carries the closed row's own prose — filters through the same
      // ONE reader, `owesAnswer()`.
      const turnStartedAtMs = Date.parse(`${turnStartedAt.replace(' ', 'T')}Z`);
      const closedWorkThisTurn = closedWithoutDelivery(agentId, Number.isFinite(turnStartedAtMs) ? turnStartedAtMs : Date.now() - 60_000);
      const closedThisTurn = db.prepare(`
        SELECT w.title AS title, w.result AS result, ${msToText('w.opened_at')} AS created_at,
               w.source_message_id AS source_message_id FROM work w
         WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'done'
           AND w.repeat_interval IS NULL AND w.closed_at >= ?
         ORDER BY w.closed_at ASC LIMIT 3
      `).all(agentId, tsToMs(turnStartedAt) ?? 0) as Array<{ title: string; result: string | null; created_at: string; source_message_id: string | null }>;
      if (closedWorkThisTurn.length > 0) {
        logger.info('v2 silent-closeout: work settled this turn with NO delivery to point at', {
          agentId, turnNumber,
          work: closedWorkThisTurn.map((w) => ({ id: w.workId, kind: w.kind, state: w.state })),
        }, agentId);
      }
      if (closedThisTurn.length > 0) {
        // Receipt-keyed owe, PER TASK (2026-07-23, owner production
        // transcript: duplicate status reply after the real answer). The
        // old time-window dedup ("any substantive reply since the
        // earliest task was created") failed exactly when a bookkeeping
        // task was born AFTER the real answer went out: the window was
        // empty, the steer fired on a settled conversation, and the
        // model re-announced work the user already had, on a WAKE turn
        // nobody was waiting on. The receipts say who is owed what:
        //   - a task WITH an origin ask owes a closeout only while that
        //     ask records no answer (mig 113 answer_message_id);
        //   - a task WITHOUT an origin ask (self/bookkeeping) owes one
        //     only when this turn is serving a live human ask; on a
        //     wake/bookkeeping turn its close is incidental, exactly
        //     what the tracker engine-note tells the model to [no-reply].
        const owedTasks = closedThisTurn.filter((t) => (
          t.source_message_id ? owesAnswer(t.source_message_id) : hasUnansweredUser
        ));
        if (owedTasks.length > 0) {
          const first = owedTasks[0];
          const whichTask = owedTasks.length === 1
            ? `the task "${first.title.slice(0, 80)}"`
            : `${owedTasks.length} tasks (first: "${first.title.slice(0, 80)}")`;
          // Receipts, never the model's own result prose (owner .19
          // transcript: a task closed with a FALSE "opened in the canvas"
          // claim and this steer quoted it back as "result on file",
          // lending engine framing to a lie; prose-never-authority
          // applies to the engine's own steers too). The engine states
          // only what it RECORDED; with no recorded delivery it demands
          // honesty instead of a victory lap.
          let receipts = '';
          try {
            const { composeTurnDeliverySummary, isTangibleDeliverySummary } =
              await import('../../../../tracker/task-stamps.js');
            // T19 (D7): this steer's own two branches say "no file artifact, no channel send"
            // — it means TANGIBLE, and it keeps meaning tangible. The summary now also names a
            // dashboard-only bubble, which is exactly the case this floor is firing ABOUT, so
            // quoting it back as a recorded delivery would be the engine contradicting itself.
            const summary = composeTurnDeliverySummary(agentId, turnNumber);
            receipts = isTangibleDeliverySummary(summary) ? summary : '';
          } catch { /* fall through to the no-receipts wording */ }
          const steerText =
            `[Engine record: this turn marked ${whichTask} complete. ` +
            (receipts.length > 0
              ? `The engine recorded this delivery: ${receipts.slice(0, 220)}. The user has not heard anything about it. `
              : 'The engine has NO recorded delivery for it (no file artifact, no channel send). ') +
            'WRITE one short reply in this conversation now, in your own words: ' +
            (receipts.length > 0
              ? 'tell the user it is done and include the deliverable or link. '
              : 'if the work truly reached the user, say where; if it did NOT, say honestly what remains instead of claiming it is done. ') +
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
  // ── v2.7.17: "added a note then stopped" detector ──
  return proceed(state);
}
