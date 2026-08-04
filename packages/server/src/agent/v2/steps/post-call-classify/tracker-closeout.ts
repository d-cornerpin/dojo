// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE END-OF-TURN TRACKER CLOSE-OUT CHECK (v2.5.40), moved
// byte-faithfully out of `loop.ts`'s `postCallClassify` span. The common failure it
// exists for: the agent opens a project, marks task 1 in_progress, does the work and
// then ends the turn with the tracker still saying the work is running.
//
// TWO OF THE SPAN'S SEVEN EXITS ARE HERE, and they are opposite ends of one ladder —
// the close-out one-shot's escalation to the PM, and the HARDCAP that ends the turn
// when the nudge fired once and was ignored. The third conversion is the nudge's own
// one-more-round `continue`.
//
// The PRE-TURN close-out gate's reconciliation rides with it, including the branch that
// KEEPS the agent's reply visible and reconciles the tracker silently — an OR2 property,
// not a convenience: the person sees what the agent said, and the bookkeeping is the
// engine's own business.
// ════════════════════════════════════════

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { advance, type AgentTurnState } from '../../state.js';
import { steerFired } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { splitDanglers } from '../../stale-work-ids.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** The end-of-turn tracker close-out check, its escalation and its hardcap. */
export async function runTrackerCloseout(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const { agentId, counterparty, db, turnNumber } = ctx;
  const { persistedContent } = sc;
  // ── End-of-turn tracker close-out check (v2.5.40) ──
  // Common failure: agent opens a project, marks task 1 in_progress,
  // does the work, never marks it complete (or any subsequent task).
  // The PM agent's poke chain eventually catches it but costs a 30-min
  // wait. Detect at the moment of failure: agent is ending the turn
  // with text, has at least one in_progress task assigned, AND made
  // no work_update(action="status") / work_update(action="complete_step") call this turn.
  //
  // Hardcap mirrors the A2A enforcer: if the agent already saw the
  // nudge once this turn and STILL produces text without updating
  // tracker status, end the turn cleanly. Don't loop forever.
  const agentProducedText = !!(persistedContent && persistedContent.trim().length > 0);
  if (agentProducedText) {
    // ── v2.5.46 / demolition Phase 1.4: pre-turn close-out gate ──
    // The pre-turn system message already gave the agent a chance to
    // engage with the tracker BEFORE generating any response. If they
    // produced text instead of calling a tracker tool, they forfeited the
    // chance. The gate USED TO auto-pause the danglers here and pre-bless
    // the pause (pause_validated=1) so the PM could never re-flag it, a
    // forgery of the PM's key. De-fanged: the danglers keep their TRUE
    // status (one-shots stay in_progress), the recurring janitorial reset
    // stays, and the miss is escalated to the PM (visible A2A) to decide
    // per task. The turn then ends.
    //
    // No "second chance" hard nudge: the prior implementation streamed a
    // second response to the user before the duplicate detector could
    // suppress it, the user saw two responses. One shot, then the turn ends.
    if (
      state.danglingTaskIds.length > 0 &&
      !state.closeOutGateSatisfied
    ) {
      // ── KEEP the agent's reply visible; reconcile the tracker silently ──
      // BUG-2 (comms-audit convergence pass): this gate used to DELETE the
      // just-streamed assistant reply and erase the bubble whenever an
      // UNRELATED idle/stranded tracker task existed, with no human-waiting
      // guard. On the weak-model floor the agent routinely answers a fresh,
      // unrelated human question in plain text (without first calling a
      // work verb); the gate then ate that answer and the user got
      // silence (inv 2). That is the same silent-drop class as the whole P0,
      // and it contradicts the sibling going-idle hardcap which was already
      // fixed (2026-06-25, ~line 3333) to KEEP the closeout visible. Apply the
      // identical trade here: protecting an internal tracker-consistency
      // invariant the user never sees (they read the chat, not the task table)
      // is NOT worth suppressing a real reply. The reply was already persisted
      // AND streamed earlier this turn, so we simply let it stand and STILL
      // reconcile the danglers below (one-shots stay in_progress + escalate to
      // PM / recurring reset / on_deck left in place). No duplicate risk: there
      // is no second-chance re-prompt here (only one reply was ever generated).
      logger.info('v2: pre-turn close-out gate, keeping the agent reply visible, reconciling danglers in the background', {
        agentId, danglingCount: state.danglingTaskIds.length,
      }, agentId);

      try {
        // Distinguish the KINDS of dangler. One-shot in_progress rows keep
        // their TRUE status (no pause, no stamp); on_deck stragglers stay
        // on_deck, the user can decide whether to reassign or close the
        // project. PHASE-6 T0D: there are THREE kinds and this asked for
        // two — see `stale-work-ids.ts`.
        const danglers = splitDanglers(state.danglingTaskIds);
        const inProgressIds = danglers.claimed;
        const onDeckIds = danglers.onDeck;
        if (danglers.gone.length > 0) {
          state = advance(state, { danglingTaskIds: [...danglers.claimed, ...danglers.onDeck] });
          logger.info('v2: dropped dangling task ids whose rows are gone', {
            agentId, goneCount: danglers.gone.length, remaining: state.danglingTaskIds.length,
          }, agentId);
        }

        // Demolition Phase 1.4: the gate no longer PAUSES one-shot danglers
        // or pre-blesses a pause (pause_validated=1). That flag was an
        // engine-authored "PM-blessed" verdict the PM sweep could never
        // re-flag, a forgery of the PM's key. One-shot danglers now stay
        // in_progress and are escalated to the PM (which decides per task).
        // Recurring danglers keep the janitorial reset (a single missed
        // close-out fails THIS run via forceResetStuckRecurringTask, never
        // pausing/closing the whole schedule).
        const { forceResetStuckRecurringTask } = await import('../../../../scheduler/runner.js');
        const recurringResetIds: string[] = [];
        const oneShotDanglerIds: string[] = [];
        for (const tid of inProgressIds) {
          const isRecurring = db.prepare(`SELECT repeat_interval FROM work WHERE id = ?`).get(tid) as { repeat_interval: number | null } | undefined;
          if (isRecurring?.repeat_interval) {
            try { forceResetStuckRecurringTask(tid); recurringResetIds.push(tid); } catch { /* best effort */ }
            continue;
          }
          oneShotDanglerIds.push(tid);
        }

        if (oneShotDanglerIds.length > 0 || recurringResetIds.length > 0 || onDeckIds.length > 0) {
          // Repaint the board (recurring rows changed; one-shots are
          // unchanged but harmless to re-broadcast). No INVISIBLE
          // retrospective note: the old engine-steer-exempt "[System: ...
          // the engine reconciled the danglers ...]" row is deleted. The
          // going-idle menu steer already gave the model its (visible)
          // instruction this turn, and the PM escalation below is a visible
          // A2A; nothing model-facing is owed on this (ending) turn.
          try {
            const { getTask } = await import('../../../../tracker/schema.js');
            for (const tid of state.danglingTaskIds) {
              const updatedTask = getTask(tid);
              if (updatedTask) {
                broadcast({ type: 'tracker:task_updated', data: updatedTask });
              }
            }
          } catch { /* best effort */ }
          logger.warn('v2: pre-turn close-out gate unsatisfied, reply kept visible, one-shot danglers left in_progress (no pause, no stamp), recurring reset on schedule', {
            agentId, oneShotDanglerCount: oneShotDanglerIds.length, recurringResetCount: recurringResetIds.length, onDeckCount: onDeckIds.length, totalDangling: state.danglingTaskIds.length,
          }, agentId);
          // Escalate the one-shot danglers to the PM (visible A2A). They
          // keep their true in_progress status until the PM decides.
          if (oneShotDanglerIds.length > 0) {
            try {
              const { escalateCloseoutMissToPM } = await import('../../../../tracker/pm-agent.js');
              await escalateCloseoutMissToPM({
                agentId,
                danglingTaskIds: oneShotDanglerIds,
                agentText: persistedContent ?? '',
                source: 'pre-turn-gate',
              });
            } catch (escErr) {
              logger.warn('v2: pre-turn gate closeout-miss escalation failed (non-fatal)', {
                agentId, error: escErr instanceof Error ? escErr.message : String(escErr),
              }, agentId);
            }
          }
        }
      } catch (escErr) {
        logger.error('v2: close-out one-shot escalation failed', {
          agentId, error: escErr instanceof Error ? escErr.message : String(escErr),
        }, agentId);
      }
      return requestExit(state, 'closeout-one-shot-escalated');
    }

    if (
      steerFired(state.steerQueue, 'tracker-closeout') &&
      !state.trackerStatusUpdatedThisTurn
    ) {
      // Hardcap: nudge fired once and was ignored. End the turn.
      // The PM agent will catch the dangling tasks on its next poke pass.
      logger.warn('v2: tracker close-out nudge ignored, ending turn anyway', {
        agentId,
      }, agentId);
      return requestExit(state, 'tracker-closeout-nudge-ignored');
    }

    // Lane separation (attribution redesign §4.5): this nudge re-prompts the
    // model ("close out your open tasks; write NO user-facing text"). On a live
    // conversation turn the model ignores the no-text instruction and re-answers
    // the present user, producing the near-duplicate reply (field-documented
    // below). The deeper problem is the bleed itself: task-closeout is machinery
    // (Lane 2/3), and it has no business re-running the model in the middle of a
    // Lane-1 conversation about something unrelated (the open tasks are usually
    // pre-existing background danglers, not this turn's work). So on a user turn
    // we do NOT re-prompt, the agent answered the user, the turn ends here, and
    // the danglers are caught off the conversation path by the deterministic
    // pre-turn close-out gate next turn and by the PM poke chain (which is where
    // closeout enforcement belongs). The re-prompt remains for non-conversation
    // turns (autonomous / A2A), where any resulting text is already routed to the
    // agent-internal lane and never surfaces to the user.
    if (
      counterparty.kind !== 'user' &&
      !steerFired(state.steerQueue, 'tracker-closeout') &&
      !state.trackerStatusUpdatedThisTurn &&
      state.nonTrackerToolCalls > 0
    ) {
      let openTasks: Array<{ id: string; title: string }> = [];
      try {
        const { listTasks } = await import('../../../../tracker/schema.js');
        const inProgress = listTasks({ status: 'in_progress', assignedTo: agentId });
        openTasks = inProgress.map((t) => ({ id: t.id, title: t.title }));
      } catch (err) {
        logger.warn('Tracker close-out nudge: listTasks failed', {
          agentId, err: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
      if (openTasks.length > 0) {
        const taskList = openTasks
          .map((t) => `  - "${t.title}" (${t.id.slice(0, 8)})`)
          .join('\n');
        // v2.5.42, rewritten to a direct, action-only command.
        // Prior wording was a paragraph with an "or end your turn
        // silently" escape hatch. Field test showed DeepSeek V4 Pro
        // ignoring the escape and re-running the whole response,
        // producing a duplicate reply to the user. The user noticed
        // immediately ("notice that something triggered him to do
        // it twice now"). New wording: tool call ONLY, no text,
        // explicit "do not repeat your prior message" guardrail.
        const nudgeText = (
          `[System: ${openTasks.length} in_progress task${openTasks.length === 1 ? '' : 's'} assigned to you was not closed out this turn:\n` +
          `${taskList}\n` +
          `REQUIRED ACTION: call work_update(action="complete_step") (for multi-step projects) or work_update(action="status") (complete | blocked | paused) on each task above. Make ONLY the tool call(s). Do NOT write any user-facing text, the user already received your previous response and a duplicate reply is worse than a stale tracker. ` +
          `If a task is genuinely still in progress, end your turn now with NO text output (no tool call, no message); the engine will continue you on the next user turn.]`
        );
        // RC-19: via persistEngineSteer so the close-out directive reaches the
        // model (the steer queue) AND keeps its dashboard row. This branch is
        // non-user turns only (any resulting text is routed to the agent-internal
        // lane, see the lane note above), so the bare role='system' row the
        // assembler strips meant the re-prompt never actually reached the model.
        state = persistEngineSteer(
          state,
          { agentId, content: nudgeText, turnNumber, floor: 'tracker-closeout', atLoop: state.loopCount },
          { broadcast },
        );
        logger.info('v2: tracker close-out nudge fired', {
          agentId, openTaskCount: openTasks.length,
        }, agentId);
        return continueLoop(state);
      }
    }
  }
  return proceed(state);
}
