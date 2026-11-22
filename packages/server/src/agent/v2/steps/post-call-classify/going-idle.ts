// The fall-asleep detectors: add-notes-stop (a `work_note`, then silence, on a task still in progress),
// its broader sibling going-idle-with-in-progress, and the reconciliation after the latter already ran.
// `turnCtx.goingIdleDetectorRanThisTurn` must outlive the iteration, or a nudged turn would be nudged again.

import { v4 as uuidv4 } from 'uuid';
import { classifyTool } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { CLOSING_WORK_OPS, toolOpKey } from '../../../../tools/work-verbs.js';
import { taskScope } from '../../../../work/tracker-view.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer, steerFired } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { userWords } from '../../turn-address.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import { continueTheJob } from './job-continues.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';
import { heldExpr, workingExpr } from '../../../../work/done/hold.js';
import { occurrenceOwesDeliverable } from '../../../../work/deliverable-declaration.js';

const logger = createLogger('v2-loop');

/** The two fall-asleep detectors and the reconciliation branch. */
export async function runGoingIdle(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agentId, db, isA2ATurn, lastUserMessageContent, mostRecentInbound, turnCtx, turnNumber,
  } = ctx;
  // The engine never re-prompts after a spoken reply: the agent would answer again.
  const replied = !!sc.persistedContent?.trim();
  // Add-notes-stop: the turn's last tool call was a `work_note` on a task still in progress, then
  // silence. One steer per turn, so it cannot loop.
  if (!replied && !steerFired(state.steerQueue, 'add-notes-stop') && state.toolResults.length > 0) {
    const lastTool = state.toolResults[state.toolResults.length - 1];
    if (lastTool && lastTool.name === 'work_note') {
      const tid = lastTool.arguments?.task_id;
      const nudgedTaskId = typeof tid === 'string' ? tid : null;
      if (nudgedTaskId) {
        const row = db.prepare(`SELECT ${workingExpr('w')} AS working, w.title FROM work w WHERE w.id = ?`).get(nudgedTaskId) as { working?: number; title?: string } | undefined;
        if (row?.working) {
          const titleShort = (row.title ?? '').slice(0, 60);
          const nudgeText = (
            `[System: you just added a note to "${titleShort}" (${nudgedTaskId.slice(0, 8)}) but did not say what comes next. ` +
            `That task is STILL in_progress. If you have more work to do on it, KEEP GOING - call your next tool now, do not end the turn. ` +
            `If you are genuinely waiting on something (user input, an external response, a scheduled time), say so explicitly: ` +
            `update the task status to "blocked" or "paused" with a clear reason, OR write one sentence in your reply telling ${userWords(turnCtx.address)} what you are waiting for. ` +
            `Silently going idle after a work_note leaves ${userWords(turnCtx.address)} with no idea what is happening.]`
          );
          // Through the steer queue so the model sees it; a bare system row is stripped by the assembler.
          state = persistEngineSteer(
            state,
            { agentId, content: nudgeText, turnNumber, floor: 'add-notes-stop', atLoop: state.loopCount },
            { broadcast },
          );
          logger.info('v2 add-notes-stop nudge fired', { agentId, taskId: nudgedTaskId }, agentId);
          return continueLoop(state); // re-enter the loop so the model sees the nudge
        }
      }
    }
  }

  // A turn ending mid-job is parked and continued while it makes progress (`job-continues.ts`).
  const job = await continueTheJob(state, ctx, sc);
  if (job) return requestExit(state, `job-${job}`);

  // Going idle with a task in progress and untransitioned this turn: list the end-of-turn choices once.
  // Skipped when add-notes-stop already steered this turn.
  if (
    !turnCtx.goingIdleDetectorRanThisTurn &&
    !steerFired(state.steerQueue, 'add-notes-stop')
  ) {
    // Any in-progress task qualifies, even one touched this turn: the issue is idling unresolved, not staleness.
    const openTasks = db.prepare(`
      SELECT w.id AS id, w.title AS title FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ?
        AND ${workingExpr('w')}
        AND w.is_paused = 0 AND NOT ${heldExpr('w')}
      ORDER BY w.updated_at DESC
      LIMIT 5
    `).all(agentId) as Array<{ id: string; title: string }>;

    // A turn that already transitioned a task made a deliberate state choice; another left open is fine.
    const transitionedThisTurn = state.toolResults.some(tr => CLOSING_WORK_OPS.has(toolOpKey(tr.name, tr.arguments)));

    // Bookkeeping is enforced only on a turn that worked a task (task-triggered, or a real side effect),
    // never on a conversation turn. Membership comes from `classifyTool`, so new tools cannot fall out;
    // `work_note` and `work_open:task` count too, since tending the tracker is task work.
    const countsAsTaskWork = (name: string, args?: Record<string, unknown>): boolean => {
      const key = toolOpKey(name, args);
      return classifyTool(name, args) === 'effectful-action' ||
        key === 'work_note' || key === 'work_open:task';
    };
    const schedulerTurn = mostRecentInbound?.origin_intent === 'scheduler' || (lastUserMessageContent ?? '').includes('[SOURCE: SCHEDULER');
    const workedATaskThisTurn = schedulerTurn || isA2ATurn ||
      state.toolResults.some(tr => !tr.isError && !!tr.name && countsAsTaskWork(tr.name, tr.arguments));

    if (openTasks.length > 0 && !transitionedThisTurn && workedATaskThisTurn) {
      // Successful side effects this turn are listed as a fact so they are not repeated (read from
      // `state.toolResults`: most tools write no per-task log). No text pre-fills a close.
      const recentSideEffects: Array<{ name: string; preview: string }> = [];
      for (let i = state.toolResults.length - 1; i >= 0 && recentSideEffects.length < 4; i--) {
        const tr = state.toolResults[i];
        if (!tr.name || classifyTool(tr.name, tr.arguments) !== 'effectful-action') continue;
        if (tr.isError) continue;
        const preview = (tr.content ?? '').replace(/\s+/g, ' ').slice(0, 160);
        recentSideEffects.push({ name: tr.name, preview });
      }
      const taskList = openTasks
        .map(t => `  - "${t.title.slice(0, 60)}" (${t.id.slice(0, 8)})`)
        .join('\n');
      const auditHint = recentSideEffects.length > 0
        ? `\nSide-effecting calls that already ran this turn (do not repeat them):\n` + recentSideEffects.map(s => `  - \`${s.name}\`: ${s.preview}`).join('\n') + '\n'
        : '';
      const nudgeText = (
        `[System: this turn is ending with ${openTasks.length} task${openTasks.length === 1 ? '' : 's'} still in progress and assigned to you:\n` +
        `${taskList}\n` + auditHint +
        `\nIf there is more to do, do it: call your next tool now and continue from exactly where you stopped (next item, next line, next step; do not restart or re-read what you already processed).\n` +
        `If you are waiting on the person (you already asked them): work_update(action="status", task_id, status="paused", notes="waiting for X").\n` +
        `If something the person does not know about stops you: work_update(action="status", task_id, status="blocked", notes="why").\n` +
        `If the task is genuinely finished: work_update(action="hand_in", task_id, outcome="finished", proof=[...], note); a measured task is finished when its measure reads 0, and items that genuinely cannot or should not be done are handed in as can't be done with a remainder item naming them and why.\n` +
        `A task left in progress is not a problem: a one-off task stays open and you are brought back to it; a scheduled run left in progress is recorded as not done, and its schedule goes on.]`
      );
      // Re-prompt only on a silent stop; with a reply the flag is set and only the reconciliation below runs.
      turnCtx.goingIdleDetectorRanThisTurn = true;
      if (replied) {
        logger.info('v2 going-idle-with-in_progress: agent already replied this turn, skipping re-prompt, engine reconciles the dangling task', {
          agentId, openTaskCount: openTasks.length, taskIds: openTasks.map(t => t.id),
        }, agentId);
        // No nudge: fall through so the one reply already shown stands.
      } else {
        const nudgeId = uuidv4();
        insertMessageIfAbsent({ id: nudgeId, agentId, role: 'system', content: nudgeText, turnNumber });
        broadcast({
          type: 'chat:message',
          agentId,
          message: {
            id: nudgeId, agentId, role: 'system' as const,
            content: nudgeText,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        // Also queued as a steer: the system row above is for the dashboard, and the assembler strips it.
        state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'going-idle-in-progress', content: nudgeText, atLoop: state.loopCount }) });
        logger.info('v2 going-idle-with-in_progress nudge fired', {
          agentId, openTaskCount: openTasks.length, taskIds: openTasks.map(t => t.id),
        }, agentId);
        return continueLoop(state); // re-enter the loop so the model sees the nudge
      }
    }
  }

  // Reconciliation once the detector ran and the turn ended with a reply (nudged or not): this turn's own run of a
  // repeating task is failed through the one run close and its schedule goes on. A run that owes a message is closed
  // on its delivery once the turn ends; a one-shot task stays visibly in progress for the check-in ladder.
  const run = turnCtx.root?.kind === 'occurrence' ? occurrenceOwesDeliverable(turnCtx.root.id) : null;
  if (turnCtx.goingIdleDetectorRanThisTurn && replied && run?.taskId && !run.owes) {
    const repeating = db.prepare(`SELECT 1 FROM work w WHERE w.id = ? AND w.repeat_interval IS NOT NULL AND NOT ${heldExpr('w')}`).get(run.taskId);
    const { onTaskRunComplete } = await import('../../../../scheduler/runner.js');
    if (repeating) await onTaskRunComplete(run.taskId, 'failed', 'its turn ended with a reply and the run was not handed in').catch(() => false);
  }

  return proceed(state);
}
