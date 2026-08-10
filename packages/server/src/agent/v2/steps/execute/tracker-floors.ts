// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — THE TWO TRACKER TIERS, moved byte-faithfully out of
// `loop.ts`'s `execute` span: the >3 NUDGE (a one-shot, non-blocking model-choice
// assist) and the >=6 ENGINE FLOOR (the engine opens ONE work row itself, so the
// work is tracked on the weakest model regardless of what the model chooses).
//
// BOTH THRESHOLDS ARE COPIED VERBATIM (Global Constraints), and so is the reason
// they ask two DIFFERENT questions: DECIDED D4 root-caused a contradiction where
// the nudge's own success disarmed the floor in the same turn. No threshold was
// touched then and none is touched here.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { isDreamerAgent, isHealerAgent, isPMAgent } from '../../../../config/platform.js';
import { insertEngineEventIfAbsent } from '../../../../memory/message-store.js';
import { clearUntrackedWorkAcrossTurns, getUntrackedWorkAcrossTurns } from '../../../turn-state.js';
import { ENGINE_SCAFFOLD_ROOT_KIND } from '../../../../work/tracker-view.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { advance, type AgentTurnState } from '../../state.js';
import { TRACKER_STEER_FLOORS, enqueueSteer, steerFiredAny } from '../../steer-queue.js';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');
import { deriveScaffoldTitle, dispatchPMRenameHandoff } from './scaffold-title.js';
import type { ExecuteContext } from './index.js';

export async function runTrackerFloors(state: AgentTurnState, ctx: ExecuteContext): Promise<AgentTurnState> {
  const {
    agentId, turnCtx, turnNumber, chosenConvKey, staleTaskWindowMinutes,
    counterparty, counterpartyIsAgentSender, engineStartAckDeliveredThisTurn,
  } = ctx;
  const STALE_TASK_WINDOW_MINUTES = staleTaskWindowMinutes;

  // F2 (post-D3): the deleted anti-hoarding gate was ALSO the thing that forced
  // task scaffolding at the 6th load; deleting it removed all engine pressure to
  // scaffold multi-step work (observed: a 7-call research job created no tracker
  // task, drifted, and the PM had nothing to monitor). Re-homed as two tiers:
  //   nudge at >3 real work calls (model-choice assist, one-shot, non-blocking),
  //   ENGINE FLOOR at >=6: the engine auto-creates the task itself via the same
  //   ENGINE FLOOR at >=6: the engine opens ONE work(kind='task') itself, so on the
  //   weakest model the work is tracked regardless of what the model chooses.
  const TRACKER_NUDGE_THRESHOLD = 3;
  const TRACKER_AUTO_SCAFFOLD_AT = 6;
  // RC-19 item 3: the >=6 auto-scaffold FLOOR keys on the CROSS-TURN untracked-work
  // total for this human conversation (accumulated above), so an A2A send that
  // breaks the turn can no longer drop the count below the floor. Falls back to the
  // per-turn count on a2a/engine turns (conv_key null). The per-turn count is a
  // subset of the cross-turn total on a human turn, so Math.max is just defensive.
  // The >3 NUDGE tier stays per-turn (it is a within-turn model-choice assist).
  const turnConvForFloor = turnCtx.convKey;
  const effectiveUntracked =
    typeof turnConvForFloor === 'string' && turnConvForFloor.length > 0
      ? Math.max(state.nonTrackerToolCalls, getUntrackedWorkAcrossTurns(agentId, turnConvForFloor))
      : state.nonTrackerToolCalls;
  if (
    // D-B v2: the Healer is tracker-exempt (no tracker tools; SOUL forbids
    // touching it). Neither nudge it nor auto-open a task it cannot tend,
    // which would go stale and trip the PM poke ladder, the exact trap a held
    // destructive consent must not spring against the waiting Healer.
    !isHealerAgent(agentId) &&
    // ── DECIDED D4, EXECUTED (PHASE-2 T8c item 3) ──
    // This condition used to be a single `!state.trackerWriteThisTurn` gating BOTH
    // tiers, and that is the contradiction D4 root-caused: the >3 nudge's own SUCCESS
    // (the agent opens a row) set `trackerWriteThisTurn`, which disarmed the >=6 floor
    // in the same turn. The scenario asked for both tiers; the code forbade both. No
    // threshold was touched to resolve it (#14 — no invented thresholds); the two tiers
    // now ask the two DIFFERENT questions they were always meant to ask:
    //   NUDGE  — "has the agent tended its work this turn?"  (any disarming write)
    //   FLOOR  — "does a work row exist for this turn's work?" (an OPENING op)
    // The floor's requirement is the weakest-model guarantee, which is about existence,
    // so keyed on existence it is satisfied by whichever tier produced the row — and
    // "a work row exists at turn end" is true either way, which is what the scenario
    // now asserts.
    ((!state.trackerWriteThisTurn && !steerFiredAny(state.steerQueue, TRACKER_STEER_FLOORS) && state.nonTrackerToolCalls > TRACKER_NUDGE_THRESHOLD) ||
      (!state.workRowOpenedThisTurn && effectiveUntracked >= TRACKER_AUTO_SCAFFOLD_AT))
  ) {
    // Secondary check: the agent may have a RECENTLY-TENDED task from a
    // previous turn that they're just continuing. Don't nudge them either.
    // The v2.5.40 concern (a nudge firing right after the agent cleanly
    // completed a 3-task project, when every task was already `complete`) is
    // covered by the trackerWriteThisTurn gate above: completing tasks is a
    // tracker write, which disarms this whole block. on_deck was previously
    // counted here as belt-and-suspenders, but is now EXCLUDED (NEXT-WAVE
    // item 2, see the candidate filter below): a queued/scheduled task is not
    // active work, so it must neither suppress this nudge nor be named by it.
    //
    // v3.1.11 (FN-9): "recently tended", not "has any active task". A STALE
    // open task (assigned but untouched for longer than
    // STALE_TASK_WINDOW_MINUTES) no longer suppresses the tiers. That was
    // the second disarm hole: an agent sitting on a long-dead in_progress
    // task could do unlimited untracked multi-step work and never be
    // nudged. Any tracker mutation bumps updated_at, so genuinely-active
    // work stays inside the window. A stale open task (if any) is captured
    // so the nudge can name it and offer "update it, or open a new one".
    let hasRecentlyTendedTask = false;
    let hasAnyInProgressTask = false;
    let staleOpenTask: { id: string; title: string } | null = null;
    try {
      const { listTasks } = await import('../../../../tracker/schema.js');
      const { normalizeDbTimestamp } = await import('../../../../scheduler/engine.js');
      const cutoffMs = Date.now() - STALE_TASK_WINDOW_MINUTES * 60_000;
      // NEXT-WAVE item 2 (verified misfire): candidates are in_progress ONLY.
      // on_deck (queued / scheduled) tasks are NOT work the agent is
      // neglecting, they are waiting their turn, and their naturally-old
      // updatedAt made a queued task (e.g. a recurring scheduled brief) get
      // named as "the only open tracker task... hasn't been updated in a
      // while" while the agent was actively working a DIFFERENT in_progress
      // task. A queued scheduled task coming due is a SCHEDULER concern and
      // must never be cited by this nudge, so it can no longer be picked as
      // staleOpenTask nor count toward the floor.
      const candidates = listTasks({ assignedTo: agentId }).filter(
        (t) => t.status === 'in_progress',
      );
      for (const t of candidates) {
        hasAnyInProgressTask = true;
        const tendedMs = new Date(normalizeDbTimestamp(t.updatedAt)).getTime();
        if (tendedMs >= cutoffMs) {
          hasRecentlyTendedTask = true;
        } else if (!staleOpenTask) {
          staleOpenTask = { id: t.id, title: t.title };
        }
      }
    } catch (err) {
      logger.warn('Tracker nudge: listTasks failed (treating as no recently-tended task)', {
        agentId, err: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    if (
      // NEXT-WAVE item 2: never auto-scaffold a NEW project when an
      // in_progress task already exists (worked or not). If it exists but is
      // stale, the nudge branch below names it and asks the agent to bring it
      // current, rather than opening a duplicate. Only genuinely-untracked
      // work (zero in_progress tasks) reaches the engine floor here.
      !hasAnyInProgressTask &&
      effectiveUntracked >= TRACKER_AUTO_SCAFFOLD_AT &&
      state.lastUserMessageContent &&
      !isPMAgent(agentId) &&
      // P2b: the Dreamer's batch turns make dozens of vault_remember work
      // calls, so this >=6 floor fired EVERY batch and auto-created a tracker
      // project on it, which same-turn-closed and posted a notifyPrimaryAgent
      // completion pair to the primary's chat. Its cycle work is engine-
      // orchestrated maintenance, not a user ask, so the floor skips it (same
      // reasoning as the turn-start classifier skip above).
      !isDreamerAgent(agentId)
    ) {
      // ENGINE FLOOR: the model has done 6+ real work calls with no tracker
      // engagement (the exact point where the old anti-hoarding gate used to
      // force scaffolding). Stop asking; create the task ourselves via the
      // engine's own row, stamped `root_kind='engine_scaffold'`, so the
      // work is tracked on the weakest model regardless of what it chooses.
      try {
        const { openTrackerTask } = await import('../../../../work/tracker-store.js');
        // F12.5: cleaned interim name (strip filler, word-boundary truncate,
        // capitalize) instead of a mangled raw slice. Capture the prompt now (narrowed to
        // string by the enclosing guard) so the rename dispatch below still has it after
        // the state reassignments that follow.
        const scaffoldPrompt: string = state.lastUserMessageContent;
        const scaffoldName = deriveScaffoldTitle(scaffoldPrompt) || 'Multi-step task';
        // ── ONE TASK, NOT A PROJECT-AND-A-TASK (PHASE-2 T8c item 3, DECIDED D4) ──
        // The floor used to call `createProject`, which opened a project row, a first
        // task under it, and — because the project's description carried a prose
        // ENGINE_AUTO_MARKER — a string the dup guard and three other readers matched on.
        // D4's requirement names exactly one row: "the >=6 floor opens ONE
        // `work(kind='task')`". The project was never the requirement; it was how the
        // marker and the same-turn close were plumbed.
        // THE MARKER IS A COLUMN NOW: `root_kind='engine_scaffold'` on the row itself,
        // which is a fact stamped at creation instead of a prefix on prose that any edit
        // could truncate away.
        const scaffoldTaskId = openTrackerTask({
          title: scaffoldName,
          description: scaffoldPrompt.slice(0, 2000),
          assignedTo: agentId,
          createdBy: agentId,
          status: 'in_progress',
          rootKind: ENGINE_SCAFFOLD_ROOT_KIND,
          origin: { kind: 'engine_scaffold', sourceMessageId: state.lastUserMessageId, turn: turnNumber, convKey: chosenConvKey },
        });
        // F2.2: scaffold note on the model-visible steer channel. The old
        // role='system' row was stripped by the assembler, so a continuing
        // agent never learned the engine had opened the task (it then drifted
        // and the PM later re-delivered the old answer). Persist as an
        // origin_kind='engine' row (EVENTS lane surfaces it) AND a queue entry
        // so the continuing agent sees the task id + how to close it THIS turn.
        // Label form ([System] body) so the events-lane leading-bracket strip
        // keeps the body. conv_key sentinel keeps it un-selectable as an event.
        // UX-REPAIR T1 (observability): the note used to print ONLY `nonTrackerToolCalls`,
        // the PER-TURN counter — the one that did not decide anything. The gate reads
        // `effectiveUntracked`. Printing one while gating on the other is how a firing could
        // read "you made 2 work calls" against a floor of 6 and look like a string bug
        // instead of the accumulator defect it was. BOTH numbers, always, so the next reader
        // sees which one fired the floor.
        const autoNoteText = (
          `[System] The engine opened tracker task "${scaffoldName}" (task_id: ${scaffoldTaskId}) for this work ` +
          `(work calls with no tracker entry — this turn: ${state.nonTrackerToolCalls}; ` +
          `total untracked in this conversation: ${effectiveUntracked}; floor: ${TRACKER_AUTO_SCAFFOLD_AT}; ` +
          `untracked multi-step work drifts and the PM cannot monitor it). ` +
          `Keep working; update it with work_note as you go and close it with work_update(action="status", complete) plus result/evidence when done.`
        );
        const autoNoteId = uuidv4();
        try {
          insertEngineEventIfAbsent({
            work: null,
            id: autoNoteId,
            agentId,
            content: autoNoteText,
            sourceAgentId: null,
            originIntent: 'auto_scaffold',
            turnNumber,
          });
        } catch { /* best effort */ }
        // The floor just OPENED a work row, so set both flags to disarm the gate
        // above and stop it re-entering on later iterations —
        // `workRowOpenedThisTurn` is the one the floor tier itself reads now (D4).
        // trackerToolCalledThisTurn is kept for parity with the agent-engaged-tracker
        // signal. The queue entry
        // delivers the scaffold note to a continuing agent this turn (F2.2).
        //
        // UX-REPAIR T1: `autoScaffoldedTaskIdThisTurn` USED TO BE SET HERE, and the comment
        // that stood in these lines promised "natural turn-end can close JUST this task
        // (F2.1)". That close path died with `d00f270` — `closeEngineScaffoldSameTurn` was
        // the ONLY engine path allowed to write `status='complete'` on a task, and the
        // two-key contract removed it deliberately. The field had ZERO readers from that
        // commit onward, so the write and both comments were live misinformation about a
        // mechanism the tree does not have. The row is closed by the going-idle close-out
        // gate, the PM ladder's delivery-evidence consult, or the reaper — as `d00f270` says.
        state = advance(state, {
          trackerToolCalledThisTurn: true,
          trackerWriteThisTurn: true,
          workRowOpenedThisTurn: true,
          steerQueue: enqueueSteer(state.steerQueue, { floor: 'tracker-scaffold', content: autoNoteText, atLoop: state.loopCount }),
        });
        // RC-19 item 3: the floor just tracked the work, so reset
        // the cross-turn untracked-work total. This is an engine-side tracker
        // write that never flows through the per-iteration accumulate/clear above,
        // so clear it explicitly or the count would re-trip the floor next turn.
        clearUntrackedWorkAcrossTurns(agentId);
        // UX-REPAIR T1: the log line carried only `nonTrackerToolCalls` too, so the misfire
        // was invisible in the logs as well as in the note. `effectiveUntracked` is the
        // number the gate compared against the floor; record it beside its input.
        logger.info('v2: tracker auto-scaffold fired (engine floor)', {
          agentId,
          nonTrackerToolCalls: state.nonTrackerToolCalls,
          effectiveUntracked,
          floor: TRACKER_AUTO_SCAFFOLD_AT,
          taskId: scaffoldTaskId,
        }, agentId);
        // START ACK (NEXT-WAVE item 1): the engine floor is now the ONLY
        // engine-side work-opening site, so this is where the requirement lives.
        // The engine just decided this in-flight work is trackable, so
        // the person who asked hears it is being tracked, once per turn.
        // RC-4.2: never start-ack an agent-flagged counterparty (ack ping-pong).
        if (counterparty.kind === 'user' && !counterpartyIsAgentSender && !engineStartAckDeliveredThisTurn && !turnCtx.startAckSteerArmedThisTurn && !turnCtx.startAckSteerRequested) {
          // Owner ruling 2026-07-22 (engine detects, agent speaks): request
          // the steer; the next iteration boundary injects it and the model
          // says it is on it mid-work, in its own words.
          turnCtx.startAckSteerRequested = true;
        }
        // F12.5: the interim name is a cleaned slice of the prompt, so the PM gives it
        // a proper one. ONE row to rename now, not a project and a task, so the handoff
        // asks for one title instead of two distinct ones.
        void dispatchPMRenameHandoff({
          callingAgentId: agentId,
          taskId: scaffoldTaskId,
          taskTitle: scaffoldName,
          originalPrompt: scaffoldPrompt,
          // UX-REPAIR T1: the same two numbers the note carries, so the handoff and the
          // note can never state different reasons for the same firing again.
          untrackedInConversation: effectiveUntracked,
          untrackedThisTurn: state.nonTrackerToolCalls,
          floor: TRACKER_AUTO_SCAFFOLD_AT,
        });
      } catch (err) {
        logger.warn('Tracker auto-scaffold failed (non-fatal, falling back to nudge)', {
          agentId, err: err instanceof Error ? err.message : String(err),
        }, agentId);
      }
    } else if (!hasRecentlyTendedTask && !steerFiredAny(state.steerQueue, TRACKER_STEER_FLOORS)) {
      // v3.1.11 (FN-9): two wordings. When the agent has a STALE open task
      // (assigned but not recently tended), name it and give a fork: update
      // that task if this is the same work, otherwise open a project for
      // the new work. When there's no open task at all, keep the original
      // create-a-project wording.
      const nudgeText = staleOpenTask
        ? (
          `[System: you've made ${state.nonTrackerToolCalls} work tool calls this turn, but the only open tracker task assigned to you ("${staleOpenTask.title}", task_id ${staleOpenTask.id.slice(0, 8)}) hasn't been updated in a while. ` +
          `Multi-step work that isn't reflected in a live tracker task drifts and stalls (the PM agent can't intervene because there's nothing current to monitor) and your context is filling up which means compaction is coming and you'll lose source detail you've already read. ` +
          `Decide now: if what you've been doing IS that task, bring it current via work_update(action="status") / work_note; otherwise this is NEW work, so open a project for it with work_open(kind="project", title="<short name>", level=2, tasks=[…one task per discrete batch…]). ` +
          `Then keep each task current via work_update(action="status"), and use scratchpad_set to keep a running outline that survives compaction. ` +
          `Resume the work once the tracker reflects it.]`
        )
        : (
          `[System: you've made ${state.nonTrackerToolCalls} work tool calls this turn without an active tracker task assigned to you. ` +
          `Multi-step work without a tracker entry drifts and stalls (the PM agent can't intervene because there's nothing to monitor) and your context is filling up which means compaction is coming and you'll lose source detail you've already read. ` +
          `STOP what you're doing right now and call work_open(kind="project", title="<short name>", level=2, tasks=[…one task per discrete batch…]) describing the steps for what you've been doing and what's left. ` +
          `Then update each task as you complete it via work_update(action="status"), and use scratchpad_set to keep a running outline that survives compaction. ` +
          `Resume the work after the project is opened.]`
        );
      // RC-19 (F-18): via persistEngineSteer so the STOP/open-a-project directive
      // reaches the model (the steer queue) AND keeps its dashboard row. This is the
      // site the owner remembered "ignoring the STOP": the bare role='system' row was
      // stripped by the assembler, so the model was never actually told to stop.
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
