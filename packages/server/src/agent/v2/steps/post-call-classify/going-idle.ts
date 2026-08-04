// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE TWO FALL-ASLEEP DETECTORS AND THEIR RECONCILIATION, moved
// byte-faithfully out of `loop.ts`'s `postCallClassify` span:
//   • ADD-NOTES-STOP (v2.7.17) — the agent wrote a `work_note` on an in_progress task
//     and then went quiet without saying what comes next;
//   • GOING-IDLE-WITH-IN-PROGRESS — its broader sibling, which catches every case of a
//     turn ending while the tracker still says work is in flight;
//   • the GOING-IDLE RECONCILIATION (demolition Phase 1.3) — the branch that fires when
//     the nudge already went out this turn and the model still ended user-facing.
//
// `turnCtx.goingIdleDetectorRanThisTurn` IS CUT 8's THIRD CARRIER AND IT IS READ HERE.
// PHASE-4 T3 split it out of a local that carried two jobs; the branch that reads it is
// the one that deliberately does NOT steer, so a latch reset each iteration would
// produce an EXTRA engine nudge on a turn that had already been nudged.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { classifyTool } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { CLOSING_WORK_OPS, toolOpKey } from '../../../../tools/work-verbs.js';
import { STATE_TO_STATUS_SQL, taskScope } from '../../../../work/tracker-view.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer, steerFired } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { argsForResult } from './args-for-result.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

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
  const { persistedContent } = sc;
  // Common failure: agent is mid-project, calls work_note as
  // a status checkpoint, then ends the turn silently because the
  // model treats the note as a stopping point. The user is left
  // wondering why the agent went idle. Detect that pattern and
  // fire a one-shot nudge before the turn ends.
  //
  // Conditions:
  //   - had any tool calls this turn
  //   - LAST tool call was work_note
  //   - the target task is still in_progress
  //   - not already nudged this turn (one-shot, no loop)
  if (
    !steerFired(state.steerQueue, 'add-notes-stop') &&
    state.toolResults.length > 0
  ) {
    const lastTool = state.toolResults[state.toolResults.length - 1];
    if (lastTool && lastTool.name === 'work_note') {
      // Pull the task_id from the original tool call args. The args
      // live on the matching toolCall record by id; search both lists.
      let nudgedTaskId: string | null = null;
      for (let i = state.toolCalls.length - 1; i >= 0; i--) {
        const tc = state.toolCalls[i];
        if (tc.id === lastTool.toolCallId && tc.name === 'work_note') {
          const tid = (tc.arguments as { task_id?: unknown })?.task_id;
          if (typeof tid === 'string') nudgedTaskId = tid;
          break;
        }
      }
      if (nudgedTaskId) {
        const row = db.prepare(`SELECT ${STATE_TO_STATUS_SQL('state')} AS status, title FROM work WHERE id = ?`).get(nudgedTaskId) as { status?: string; title?: string } | undefined;
        if (row?.status === 'in_progress') {
          const titleShort = (row.title ?? '').slice(0, 60);
          const nudgeText = (
            `[System: you just added a note to "${titleShort}" (${nudgedTaskId.slice(0, 8)}) but did not say what comes next. ` +
            `That task is STILL in_progress. If you have more work to do on it, KEEP GOING - call your next tool now, do not end the turn. ` +
            `If you are genuinely waiting on something (user input, an external response, a scheduled time), say so explicitly: ` +
            `update the task status to "blocked" or "paused" with a clear reason, OR write one sentence in your reply telling the user what you are waiting for. ` +
            `Silently going idle after a work_note leaves the user with no idea what is happening.]`
          );
          // RC-19: via persistEngineSteer so the nudge reaches the model
          // (the steer queue) AND keeps its dashboard row. The prior bare
          // role='system' row was stripped by the assembler, so the re-entered
          // model never saw "keep going / say what you are waiting for".
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

  // ── v2.7.17: "going idle with in_progress task" detector ──
  // Broader sibling of the add-notes-stop nudge. Catches every case
  // where the agent ends a turn while a task assigned to them is
  // still in_progress AND they did not transition it this turn.
  // Walks them through the decision matrix - keep going, mark
  // complete, mark paused (waiting on user), or mark blocked
  // (needs escalation). One-shot so a model that insists on
  // stopping doesn't trigger a loop.
  //
  // Skip if the close-out gate is already armed for this turn
  // (the gate's own message + dispatcher already covers the case)
  // or the add-notes-stop nudge just fired (we just told them).
  if (
    !turnCtx.goingIdleDetectorRanThisTurn &&
    !steerFired(state.steerQueue, 'add-notes-stop') &&
    !state.nudgedForCloseOutThisTurn
  ) {
    // Find in_progress tasks assigned to this agent. Use the same
    // criterion the close-out gate uses but at end-of-turn instead
    // of start: any in_progress task at all (even one touched this
    // turn) qualifies, because the issue isn't staleness - it's
    // that the agent went idle without resolving its state.
    const openTasks = db.prepare(`
      SELECT w.id AS id, w.title AS title FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ?
        AND w.state = 'claimed'
        AND w.is_paused = 0
      ORDER BY w.updated_at DESC
      LIMIT 5
    `).all(agentId) as Array<{ id: string; title: string }>;

    // Skip if no in_progress tasks - then the agent is fine to idle.
    // Also skip if the agent ALREADY transitioned a task this turn (any
    // status flip / step completion / project close), since that signals
    // they DID make a deliberate state choice and just happened to leave
    // another task in_progress for legitimate reasons.
    const transitionedThisTurn = state.toolResults.some(
      tr => CLOSING_WORK_OPS.has(toolOpKey(tr.name, argsForResult(state.toolCalls, tr))),
    );

    // ── Channel-awareness: enforce task bookkeeping only on a TASK-EXECUTION
    // turn, never on a CONVERSATION turn (attribution redesign §4.5). ──
    // The closeout/auto-pause/PM-escalation machinery exists to catch "the
    // agent WORKED a task and forgot to record it." A pure conversational
    // reply, answering "what's on my plate?", searching the vault and telling
    // the user "I couldn't find the key", greeting a contact, is NOT task
    // execution; the standing backlog is not this turn's responsibility.
    // Firing on it is exactly what turned a simple question into a closeout-miss
    // + PM sweep storm. A turn "worked a task" only if it was task-triggered
    // (scheduler / A2A task coordination) OR it produced a real side effect
    // (sent a message, ran exec, created a doc/file). Reading the tracker or
    // just talking does not count. Decide by what the turn actually did.
    //
    // MEMBERSHIP IS DERIVED, NOT HAND-LISTED. The original hand list here
    // froze a snapshot of google-flavored canonical names, so every _ms
    // variant, every user_ twin, and every office/onedrive tool read as
    // "just conversation": a 31-event calendar_create_ms turn skipped this
    // whole machinery, its task sat open for 100 minutes, and an unrelated
    // email wake re-announced the finished work to the owner (observed on
    // the production box 2026-07-08). classifyTool is the canonical,
    // test-covered classifier (every tool in categories.ts must classify,
    // per the shared V5 test), so new tools can never silently fall out.
    // work_note / work_open:task classify as bookkeeping but counted in the
    // old list on purpose (tending the tracker IS task work); keep them
    // explicitly.
    const countsAsTaskWork = (name: string, args?: Record<string, unknown>): boolean => {
      const key = toolOpKey(name, args);
      return classifyTool(name, args) === 'effectful-action' ||
        key === 'work_note' || key === 'work_open:task';
    };
    const schedulerTurn = mostRecentInbound?.origin_intent === 'scheduler' || (lastUserMessageContent ?? '').includes('[SOURCE: SCHEDULER');
    const workedATaskThisTurn = schedulerTurn || isA2ATurn ||
      state.toolResults.some(tr => !tr.isError && !!tr.name && countsAsTaskWork(tr.name, argsForResult(state.toolCalls, tr)));

    if (openTasks.length > 0 && !transitionedThisTurn && workedATaskThisTurn) {
      // v2.10.2, detect scheduler-triggered turns AND scan this
      // turn's tool_results for side-effecting calls that
      // returned success. Pre-fix, the agent had to read a
      // 4-option menu and construct result+evidence themselves,
      // and frequently just emitted "08 done" as text. When
      // we can see "you just ran gmail_send and got [SENT]",
      // surfacing that inline makes the close-out mechanical.
      //
      // Signal source is `state.toolResults` (in-memory, this
      // turn) rather than task_log, most tools don't write
      // per-task log entries when called, so a task_log scan
      // would almost always come up empty.
      // v3.1.10 (attribution redesign §5, Phase 5): decide by structured
      // origin first. The scheduler stamps origin_intent='scheduler'; reading
      // it fixes the case where lastUserMessageContent (now sourced from the
      // authorized-human waiting set) is null on a pure scheduler turn and the
      // prose marker could never match. Prose kept only as the legacy fallback.
      const isSchedulerTriggered =
        mostRecentInbound?.origin_intent === 'scheduler' ||
        (lastUserMessageContent ?? '').includes('[SOURCE: SCHEDULER');
      // Same derived membership as countsAsTaskWork above (minus the
      // tracker tools: this hint warns about re-running EXTERNAL side
      // effects, and re-adding a tracker note is harmless). The old hand
      // list had the same google-only drift as SIDE_EFFECTING did.
      const recentSideEffects: Array<{ name: string; preview: string }> = [];
      for (let i = state.toolResults.length - 1; i >= 0 && recentSideEffects.length < 4; i--) {
        const tr = state.toolResults[i];
        if (!tr.name || classifyTool(tr.name) !== 'effectful-action') continue;
        if (tr.isError) continue;
        const preview = (tr.content ?? '').replace(/\s+/g, ' ').slice(0, 160);
        recentSideEffects.push({ name: tr.name, preview });
      }
      const taskList = openTasks
        .map(t => `  - "${t.title.slice(0, 60)}" (${t.id.slice(0, 8)})`)
        .join('\n');
      const schedulerHint = isSchedulerTriggered
        ? `\n**This turn was scheduler-triggered.** Scheduler-fired tasks rarely need option (1) KEEP GOING, the scheduler does the repetition, not you. The right answer here is almost always option (2) DONE.\n`
        : '';
      const auditHint = recentSideEffects.length > 0
        ? `\nYou successfully called ${recentSideEffects.length === 1 ? 'a side-effecting tool' : 'side-effecting tools'} this turn:\n` +
          recentSideEffects.map(s => `  - \`${s.name}\` returned: ${s.preview}`).join('\n') + `\n\n` +
          `These are NON-IDEMPOTENT actions that already executed. Re-running them would duplicate the side effect (double email, double text, double charge). The work is done. Close the task NOW:\n` +
          `\`work_update(action="status", task_id="${openTasks[0].id}", status="complete", result="<one-line summary of what landed>", evidence=[{kind: "tool_call_ref", claim: "${recentSideEffects[0].name} succeeded"}])\`\n`
        : '';
      const nudgeText = (
        `[System: you are about to end this turn with ${openTasks.length} task${openTasks.length === 1 ? '' : 's'} still in_progress and assigned to you:\n` +
        `${taskList}\n` +
        schedulerHint +
        auditHint +
        `\nPick exactly one of these before ending the turn:\n\n` +
        `  1. KEEP GOING - call your next tool NOW to continue from EXACTLY where you stopped. Long file reads, batch operations, multi-step processes, don't restart, don't re-read content you already processed, just advance to the next line / next item / next step.\n` +
        `  2. DONE - work_update(action="status", task_id, status="complete", result="...", evidence=[...]) (or work_update(action="complete_step") for multi-step projects).\n` +
        `  3. WAITING ON USER (already asked them) - work_update(action="status", task_id, status="paused", notes="waiting for X"). PM will ignore this task entirely; no pokes.\n` +
        `  4. BLOCKED (needs escalation - user does not know yet) - work_update(action="status", task_id, status="blocked", notes="why"). PM will surface this to the primary user.\n\n` +
        `If you go idle with a task still in_progress, the engine will auto-pause it and escalate to PM. Pre-fix for non-idempotent tasks (gmail_send, sms_send, voice_call, exec hitting live APIs), PM was then forced into a re-run remediation that duplicated the side effect. Save everyone the work: close the task now.]`
      );
      // v3.1.10: if the agent ALREADY produced a user-facing reply this
      // turn, do NOT re-prompt it. The weaker model treats the re-prompt
      // as "answer again" and emits a second, slightly-reworded reply, 
      // the double-response the user reported (e.g. the Anthropic-OAuth
      // recall question answered twice), and on a setup turn the same
      // re-prompt makes it redo the work (the duplicate project). Set the
      // flag and fall through to the close-out hardcap below, which
      // reconciles the dangling task deterministically (pause one-shot /
      // reset recurring) while the one reply already shown stands. Only
      // re-prompt when there is NO reply yet (a silent stop), where it can
      // safely get the agent to continue or formally close the task. Build
      // to the weak-model floor: never rely on a re-prompt doing the right
      // thing.
      turnCtx.goingIdleDetectorRanThisTurn = true;
      const alreadyRepliedThisTurn = !!(persistedContent && persistedContent.trim().length > 0);
      if (alreadyRepliedThisTurn) {
        logger.info('v2 going-idle-with-in_progress: agent already replied this turn, skipping re-prompt, engine reconciles the dangling task', {
          agentId, openTaskCount: openTasks.length, taskIds: openTasks.map(t => t.id),
        }, agentId);
        // No nudge message, no continue: fall through to the hardcap below,
        // which pauses/resets the dangling task and keeps the single reply.
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
        // F2.6: the persisted row above is a role='system' message, which the
        // assembler strips, so the re-entered round would carry NO new info and
        // burn a model call for nothing. Deliver the menu via the steer queue (a
        // synthetic user message injected next iteration) so the extra round
        // actually shows the model the 4-option decision. Row kept for the
        // dashboard. Gating is unchanged.
        state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'going-idle-in-progress', content: nudgeText, atLoop: state.loopCount }) });
        logger.info('v2 going-idle-with-in_progress nudge fired', {
          agentId, openTaskCount: openTasks.length, taskIds: openTasks.map(t => t.id),
        }, agentId);
        return continueLoop(state); // re-enter the loop so the model sees the nudge
      }
    }
  }

  // Going-idle reconciliation (demolition Phase 1.3): the going-idle nudge
  // already fired this turn and the model STILL ended with a user-facing
  // closeout ("Done" / "All set") without calling a tracker close verb.
  // P2 drive boundary (owner status-truth invariant, 2026-07-21): the
  // going-idle deliverable_shown stamp that lived here was DELETED. It
  // guessed "the reply the user saw IS the delivery" from the mere fact
  // that a non-empty reply and open tasks coexisted, then marked EVERY
  // in_progress task delivered, and that hidden flag stood the poke
  // ladder down (the yacht-research silent hour). Statuses are promises:
  // an in_progress task stays visibly in_progress and the ladder DRIVES
  // it (check-in poke: continue, or close with evidence, or self-mark
  // paused/blocked). Real delivery evidence files Key-1 through the
  // sanctioned paths; prose never silences the drive.
  //
  // RECURRING CARVE-OUT (kept, janitorial not forgery): a recurring
  // schedule is never terminally completed by a missed close-out; fail
  // THIS run and keep the schedule alive.
  if (
    turnCtx.goingIdleDetectorRanThisTurn &&
    persistedContent && persistedContent.trim().length > 0
  ) {
    const recurringDanglers = db.prepare(`
      SELECT w.id AS id FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ?
        AND w.state = 'claimed'
        AND w.is_paused = 0
        AND w.repeat_interval IS NOT NULL
      ORDER BY w.updated_at DESC
      LIMIT 10
    `).all(agentId) as Array<{ id: string }>;
    if (recurringDanglers.length > 0) {
      const { forceResetStuckRecurringTask } = await import('../../../../scheduler/runner.js');
      for (const r of recurringDanglers) {
        try { forceResetStuckRecurringTask(r.id); } catch { /* best effort */ }
      }
      logger.info('v2 idle-with-in_progress: recurring dangler(s) failed THIS run and rejoined their schedule; one-shot danglers stay visibly in_progress for the drive boundary', {
        agentId, recurringResetCount: recurringDanglers.length,
      }, agentId);
    }
  }

  return proceed(state);
}
