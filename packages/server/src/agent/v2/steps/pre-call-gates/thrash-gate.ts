// ════════════════════════════════════════
// PHASE-6 T3 — preCallGates, part 1 of 3: THE THRASH LADDER.
//
// The drift ladder, the terminal auto-block, and the per-signature thrash gate.
// Relocated verbatim from `agent/v2/loop.ts` (`:2583`–`:2910` at `c1ad4d5`).
//
// ⚠ THE LADDER'S SHAPE IS THE GUARD AND ITS NUMBERS ARE COPIED, NOT RE-DERIVED.
// Soft drift (8) NUDGES ONCE and never blocks — legitimate progress varies its
// call signatures too, so blocking there is the "engine stops genuine work"
// failure the owner forbids — and the drift window is deliberately NOT reset by
// the nudge, because an earlier version that reset it let a signature-varying
// spiral loop forever. Hard drift (24) and the refusal breaker (6) are the two
// terminal arms, and the gap between 8 and 24 is the room a genuinely-working
// task gets after the nudge. The PM agent is exempt from all of it.
//
// The engine does NOT speak as the agent here (OR2): the terminal block tells the
// AGENT on the events lane and lets it decide what the person hears, and tells the
// PERSON as the PLATFORM in a `role='system'` owner-alert row beside the toast.
// The first-person paragraph that used to sit here is gone, and the note at the
// site records why this one site cannot steer-and-re-enter like the other four.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { getDb } from '../../../../db/connection.js';
import { isPMAgent } from '../../../../config/platform.js';
import { insertMessageIfAbsent, insertEngineEventIfAbsent } from '../../../../memory/message-store.js';
import { taskScope, ENGINE_SCAFFOLD_ROOT_KIND } from '../../../../work/tracker-view.js';
import { setTrackerStatus, upholdClaim } from '../../../../work/tracker-store.js';
import { advance, type AgentTurnState } from '../../state.js';
import { enqueueSteer, steerFired } from '../../steer-queue.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PreCallGatesContext, PreCallGatesExitReason } from './index.js';

const logger = createLogger('v2-loop');

// ── The ladder's numbers, moved with the code they bound ──
// Every one of these had its only reader inside this span; they are the same
// values, with the same reasoning, in the file that now owns them.

/** Refusals the per-signature gate will absorb before the engine blocks the task. */
const THRASH_GATE_BREAKER_LIMIT = 6;
// Soft drift threshold: the engine NUDGES the agent once (no block), legitimate
// progress also varies signatures, so a block here would false-positive.
const THRASH_GATE_DRIFT_LIMIT = 8;
// Hard drift threshold: well above the soft one. If the agent keeps varying call
// signatures to dodge the gate for THIS many iterations DESPITE the nudge, it is a
// genuine signature-varying spiral (which never increments the refusal count, so the
// refusal-breaker never catches it), terminally block so it can't loop unbounded
// across auto-continued turns (comms-audit REG-1). The gap between 8 and 24 gives a
// genuinely-working task ample room past the nudge before any block.
const THRASH_GATE_DRIFT_HARD_LIMIT = 24;

/**
 * The thrash ladder. Returns `proceed` unless the terminal block fired, in which
 * case the turn is over and the driver is told why.
 */
export function runThrashGate(state: AgentTurnState, ctx: PreCallGatesContext): StepOutcome {
  const { agentId, turnNumber, counterparty, broadcast, setAgentStatus, detectTaskThrashing } = ctx;
  const ENGINE_BLOCK_ESCAPE_HATCH = ctx.engineBlockEscapeHatch;

  // Last-resort auto-block. Two conditions trip it:
  //   (1) Refusal count exceeded, agent kept calling gated sigs and
  //       ignored the refusals.
  //   (2) Drift exceeded, gate has been on for THRASH_GATE_DRIFT_LIMIT
  //       iterations and the agent kept dodging the gate by varying
  //       its calls (different ids, get_current_time, work_update(action="get"))
  //       without ever calling work_update(action="status") to wrap up. This
  //       is the "look around to avoid finishing" failure mode.
  // We block (not pause) so the task hits a real terminal state.
  const drift =
    state.thrashGateActivatedAtLoopCount !== null
      ? state.loopCount - state.thrashGateActivatedAtLoopCount
      : 0;
  const refusalTrip = state.thrashGateRefusalCount >= THRASH_GATE_BREAKER_LIMIT;
  const driftSoftTrip = drift >= THRASH_GATE_DRIFT_LIMIT;
  const driftHardTrip = drift >= THRASH_GATE_DRIFT_HARD_LIMIT;
  // ── DRIFT-SOFT path (comms-audit G-BLK-1 + REG-1): NUDGE once, never block ──
  // Drift (gate on while the agent varies its call signatures) is a
  // false-positive-prone signal: legitimate progress varies signatures too, so a
  // block at the soft threshold is exactly the "engine stops genuine work" failure
  // the owner forbids. Inject ONE visible nudge (with the escape-hatch) and let the
  // agent continue. CRITICAL: do NOT reset the drift window here, the earlier
  // version did, which let a signature-varying spiral loop forever (it never
  // increments the refusal count, so the refusal-breaker never caught it, and on
  // MAX_TOOL_LOOPS the turn just auto-continued with drift reset to 0). Letting
  // drift keep accumulating means a genuine spiral eventually hits the HARD limit
  // below and terminates deterministically.
  if (!isPMAgent(agentId) && driftSoftTrip && !driftHardTrip && !refusalTrip) {
    if (!steerFired(state.steerQueue, 'thrash-drift')) {
      const driftNudge =
        `[Engine hint] The engine thrash gate has been active for ${drift} iterations and you keep ` +
        `varying your tool calls without recording progress. If you ARE making progress, record it with ` +
        `work_update(action="status") (or work_note), then continue. If you are stuck, wrap up and tell ` +
        `the user where things stand. ${ENGINE_BLOCK_ESCAPE_HATCH}`;
      const driftNudgeId = uuidv4();
      try {
        // Model-visible steer channel. A role='system' row would be stripped
        // by the assembler (dashboard-only theater), so this ladder rung would
        // never reach the model. Persist on the EVENTS lane (it surfaces next
        // turn) AND enqueue the steer so
        // the model receives it on the very next iteration. conv_key sentinel
        // 'engine-steer' keeps it un-selectable as a pending event (see the
        // thrash-steer C6 note below).
        insertEngineEventIfAbsent({
          work: null,
          id: driftNudgeId,
          agentId,
          content: driftNudge,
          sourceAgentId: null,
          originIntent: 'thrash_drift',
          turnNumber,
        });
      } catch { /* best effort */ }
      // One-shot nudge only, the drift window is deliberately NOT reset (a
      // signature-varying spiral must keep accruing drift to the hard limit).
      state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'thrash-drift', content: driftNudge, atLoop: state.loopCount }) });
      logger.info('v2: thrash drift nudge (one-shot; drift keeps accruing to the hard limit)', {
        agentId, drift, loopCount: state.loopCount,
      }, agentId);
    }
    // fall through, soft drift never blocks; the hard limit below is the stop
  } else if (!isPMAgent(agentId) && (refusalTrip || driftHardTrip)) {
    // ── TERMINAL BLOCK: the agent either IGNORED explicit gate refusals
    // (refusalTrip), OR kept varying call signatures to DODGE the gate past the
    // HARD drift limit despite the nudge (driftHardTrip), a genuine spiral that
    // the refusal counter can't see. The task hits a real terminal state. The
    // AGENT is told on the model-visible steer channel (below), the USER is told
    // in plain language if the work is theirs (F1), and a dashboard toast fires,
    // so the block is VISIBLE and recoverable, not a mute dead-end.
    // Third-person reason for the task-log line and the dashboard toast.
    const breakerReason = refusalTrip
      ? `agent ignored the thrash gate ${state.thrashGateRefusalCount}× without wrapping up`
      : `agent kept varying call signatures for ${drift} iterations to dodge the thrash gate, never wrapping up`;
    // Second-person reason for the agent-facing note. Fixes the old
    // "because you agent ..." double-subject bug: the note prepends "because",
    // and BOTH branches of breakerReason start with "agent ...", so it read
    // "because you agent ...". This string starts with "you ...".
    const breakerReasonSecondPerson = refusalTrip
      ? `you ignored the thrash gate ${state.thrashGateRefusalCount}× without wrapping up`
      : `you kept varying call signatures for ${drift} iterations to dodge the thrash gate, never wrapping up`;
    // F1: does this blocked work trace to a user request? A user ask can be
    // continuing on a background (non-user) turn, so the engine-auto marker on
    // the project also counts as user-origin. If so, the engine tells the person
    // directly (below) rather than leaving the whole escalation ladder mute.
    let blockedWorkIsUserOrigin = counterparty.kind === 'user';
    try {
      const db2 = getDb();
      const task = db2.prepare(`
        SELECT w.id AS id, w.title AS title, w.parent_id AS project_id,
               w.root_kind AS root_kind FROM work w
        WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed'
        ORDER BY w.updated_at DESC LIMIT 1
      `).get(agentId) as { id: string; title: string; project_id: string | null; root_kind: string } | undefined;
      if (task) {
        // T8c item 3: the marker is the row's own `root_kind`, so this no longer needs a
        // second query against the parent project's description text.
        if (!blockedWorkIsUserOrigin && task.root_kind === ENGINE_SCAFFOLD_ROOT_KIND) {
          blockedWorkIsUserOrigin = true;
        }
        const noteLine = `Engine auto-blocked: ${breakerReason}. Likely needs human review or a re-stated goal.`;
        // PHASE-2 T8b: through `transition()`, and `blocked_validated = 1` is now the
        // upheld adjudication it always was in substance — the comment below already
        // called it "the engine's validation"; it is a ROW saying so.
        const blockRes = setTrackerStatus(task.id, 'blocked', {
          by: 'agent', actorId: agentId,
          reason: `engine auto-block: ${breakerReason}`,
          note: noteLine,
        });
        if (blockRes.kind === 'applied') {
          upholdClaim(task.id, 'blocked', 'engine', 'engine',
            `deterministic engine block: ${breakerReason}`);
        }
        // F1.4: no noteTransitionForReview call here. runPMReview surfaces any
        // blocked task after 30 minutes regardless of blocked_validated (the
        // pm-agent blocked-issue check), so the PM has its backstop. A fresh
        // block (<30 min) would be dropped by that 30-min gate anyway, and
        // re-validating a deterministic engine block would be theater:
        // blocked_validated=1 IS the engine's validation.
        void import('../../../../tracker/task-log.js').then(({ writeTaskLog }) => {
          writeTaskLog({
            taskId: task.id,
            fromEntity: 'engine',
            entryKind: 'observation',
            fromStatus: 'in_progress',
            toStatus: 'blocked',
            actionTaken: 'engine auto-block (thrash gate ignored)',
            reason: 'thrash:gate-ignored',
            note: noteLine,
          });
        }).catch(() => { /* best effort */ });
        void import('../../../../tracker/schema.js').then(({ getTask: schemaGetTask }) => {
          const fresh = schemaGetTask(task.id);
          if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
        }).catch(() => { /* best effort */ });
        logger.warn('v2: thrash gate breaker tripped, task auto-blocked', {
          taskId: task.id, refusalCount: state.thrashGateRefusalCount, loopCount: state.loopCount,
        }, agentId);
      }
      // F1.3: agent-facing block note on the model-visible steer channel. A
      // role='system' row is stripped by the assembler (dashboard-only theater),
      // so the block would never reach the model. No steer: the turn is
      // ending here (break below), so the next turn's EVENTS lane surfaces it.
      // conv_key sentinel keeps it un-selectable as a pending event.
      //
      // PHASE-4 T4 (OR2): this note is now the WHOLE of what is said to the person,
      // through the agent — the engine's own first-person paragraph below it is deleted —
      // so it carries the 2026-07-30 owner ruling's nudge explicitly: the agent is TOLD,
      // and the agent decides whether the user should hear it and says it in its own
      // words. The wording below already asked for that; it now says so as an
      // instruction rather than as an aside.
      const agentNoteId = uuidv4();
      insertEngineEventIfAbsent({
        work: null,
        id: agentNoteId,
        agentId,
        content:
          `[System] The engine auto-blocked your current task because ${breakerReasonSecondPerson}. Next turn, either ` +
          `re-state the goal and resume (work_update(action="status")), or tell the user it is blocked and why. ` +
          `If the user should know this — and if they were waiting on this work, they should — WRITE it to them ` +
          `in your own words, directly in the conversation (the engine routes your reply; do not call a send tool). ` +
          `If this block looks wrong and is stopping something the user needs, tell them what you were attempting so they can decide.`,
        sourceAgentId: null,
        originIntent: 'thrash_block',
        turnNumber,
      });
    } catch (err) {
      logger.warn('v2: thrash auto-block failed', { error: err instanceof Error ? err.message : String(err) }, agentId);
    }
    // ── F1.1, CONVERTED — PHASE-4 T4 (§T0-PINS E3, the line the plan had never listed) ──
    //
    // WHAT WAS HERE. A hard-coded first-person paragraph — *"I hit a wall on this: I kept
    // retrying without making progress, so I've stopped…"* — delivered through
    // `deliverEngineUserAck` with `originIntent: null`, i.e. an assistant message on the
    // owner's lane carrying NO stamp of any kind. T4S1 measured that and named it the
    // blind spot: it is byte-indistinguishable from agent speech on every structural
    // column the kit's judge can read. The engine wrote "I", and nothing anywhere could
    // tell it was not the agent.
    //
    // WHY THE LADDER IS SHAPED DIFFERENTLY HERE, stated rather than quietly skipped. The
    // other four conversions steer, re-enter, and give the model a real chance to speak.
    // THIS site cannot: the loop `break`s three statements below, so there is no further
    // model call this turn, and a steer enqueued here would be exactly the shape T3
    // deleted — written, never seen. Two honest halves replace one dishonest sentence:
    //   * THE AGENT IS TOLD, and decides. The `thrash_block` events-lane note above is
    //     delivered on its next turn and now carries the 2026-07-30 ruling's own nudge.
    //   * THE PLATFORM TELLS THE USER, AS THE PLATFORM. A `role='system'` owner-alert
    //     note (durable, allowlisted into the owner's chat) beside the toast, which was
    //     always here and was never enough on its own: a toast is a frame, and a frame a
    //     person did not have the window open for is not a record.
    //
    // NO `floor_ghosted` ROW, DELIBERATELY. Its declared meaning is "a floor's steer was
    // refused twice and the agent truly ghosted". No steer was written here, so a row
    // would be a receipt for something that did not happen — the forged-completion class
    // this whole phase exists to remove.
    if (blockedWorkIsUserOrigin) {
      try {
        insertMessageIfAbsent({
          id: uuidv4(), agentId, role: 'system',
          content:
            `${OWNER_ALERT_HEADS_UP_PREFIX} your agent kept retrying the same step without getting anywhere, `
            + `so the platform stopped it rather than let it spin. The work is left open and flagged. `
            + `Ask your agent about it and it can pick the work back up or explain what it was attempting.`,
          turnNumber,
        });
      } catch { /* the toast below still fires; a note is not worth the turn */ }
    }
    try {
      broadcast({
        type: 'chat:error',
        agentId,
        error: `Engine auto-blocked task, ${breakerReason}.`,
        code: 'TASK_THRASH_PAUSED',
        severity: 'warning',
        retryable: true,
      });
    } catch { /* best effort */ }
    setAgentStatus(agentId, 'idle');
    return requestExit(state, 'thrash-auto-block' satisfies PreCallGatesExitReason);
  }

  // Task-thrash detector, steer + per-signature gate (not pause).
  //
  // When the model re-runs the SAME canonical signature 4+ times in 2
  // minutes without calling work_update(action="status"), inject a specific
  // steer message that names the exact tool + args + count + window
  // and gate further calls to that one signature. The agent can keep
  // calling the same tool with DIFFERENT args (legitimate iteration
  // over a list of N items stays unblocked). Last resort: if the gate
  // has refused THRASH_GATE_BREAKER_LIMIT+ calls without a
  // work_update(action="status") transition, the engine auto-blocks the task
  // so it reaches a clean terminal state instead of looping forever.
  if (!isPMAgent(agentId) && state.loopCount >= 4) {
    const thrash = detectTaskThrashing(agentId);
    if (thrash.thrashing && thrash.signature && !state.thrashGatedSignatures.includes(thrash.signature)) {
      // Pull the recent canonical sig back into a human-readable form
      // for the steer message. The signature itself is `name:{...json}`
      //, we extract the JSON tail to show args verbatim.
      const argsPart = thrash.signature.includes(':')
        ? thrash.signature.slice(thrash.signature.indexOf(':') + 1)
        : '{}';
      // The steer MUST reach the model. assembler.ts strips role='system'
      // messages from history, so writing one as `system` would be
      // invisible to the model (dashboard-only theater). The queue entry
      // gets injected at the top of the next model call as a synthetic
      // `role: 'user'` message, that's the engine's waking-style
      // delivery channel. We also persist as `role: 'user'` so the
      // dashboard renders it AND any next assemble cycle keeps seeing
      // it (the floor's queue latch is one-shot per turn).
      const steerMsg =
        `[Engine thrash gate] You've called \`${thrash.toolName}(${argsPart})\` ${thrash.count}× on this turn (and its continuation). ` +
        `You already have the result from the first call; further calls with these exact args are refused.\n\n` +
        `Your next action MUST be one of:\n` +
        `  (a) Call \`${thrash.toolName}\` with DIFFERENT args (e.g., a different id / target) if you genuinely have more to read.\n` +
        `  (b) Reply to the user with the answer you can give using the data you already have.\n` +
        `  (c) Call work_update(action="status", status='complete') with a result + evidence if this is a tracker task.\n` +
        `  (d) Call work_update(action="status", status='blocked') if you genuinely cannot proceed.\n` +
        `  (e) Send the user a specific question if you need clarification.\n\n` +
        `If you keep hitting refused signatures the engine will auto-block this task to stop the loop.`;
      const steerMsgId = uuidv4();
      try {
        // Persist as role='user' so the assembler picks it up next time
        // and the dashboard shows it inline as the engine's voice. Stamp the
        // structured engine origin (mig 075) so it's attributed as an EVENT,
        // not parsed from the [Engine thrash gate] prose.
        // An engine steer is platform coordination, so it lands on lane='events'.
        // conv_key 'engine-steer' (below) keeps it un-selectable as a pending
        // event; the EVENTS lane still surfaces it to the model.
        insertEngineEventIfAbsent({
          work: null,
          id: steerMsgId,
          agentId,
          content: steerMsg,
          sourceAgentId: null,
          originIntent: 'thrash_gate',
          turnNumber,
        });
        // C6 (as it was): stamp a non-NULL conv_key sentinel ('engine-steer'), because
        // getPendingEngineEvent selected conv_key-NULL engine rows and would otherwise
        // return this steer → the drain fires an engine turn → which can mint ANOTHER
        // steer → unbounded thrash-steer loop.
        //
        // ⚠ PHASE-2 T10H — C6'S REQUIREMENT NOW LIVES SOMEWHERE THAT SURVIVES THE COLUMN.
        // T9 moved the pending-event claim onto `served_by_turn`, which left this sentinel
        // excluding nothing at NINE steer sites plus every awareness notice — silently,
        // because the drain's engine arm logs nothing and only the wake-budget breaker at
        // 30 ever spoke. The exclusion is `ENGINE_RIDER_INTENTS` now (see
        // `memory/message-store.ts`), read off THIS row's `origin_intent`, complete by
        // measurement and enforced against these very writers by
        // `agent/v2/__tests__/engine-rider-never-drives-a-turn.test.ts`.
        //
        // The `convKey: 'engine-steer'` writes at all nine sites are RESIDUE for this job
        // and were kept ONLY because `re-answer-guard.ts` and the dashboard's
        // `isBackgroundTurnRow` still read the sentinels for a DIFFERENT job (engine
        // chatter vs a human conversation). Both readers are now settled: T10I re-pointed
        // them onto `conversation_id` / `lane`, and PHASE-3 T7 Step 2 DELETED
        // `re-answer-guard.ts` outright, so one of the two named readers no longer exists.
        // The steer still reaches the model (the EVENTS/awareness lane filters on `lane`,
        // not `conv_key`) and still renders in the dashboard.
      } catch { /* best effort */ }
      logger.warn('v2: thrash gate activated for signature', {
        toolName: thrash.toolName, signature: thrash.signature,
        count: thrash.count, loopCount: state.loopCount,
      }, agentId);
      state = advance(state, {
        thrashGatedSignatures: [...state.thrashGatedSignatures, thrash.signature],
        thrashGateActivatedAtLoopCount: state.thrashGateActivatedAtLoopCount ?? state.loopCount,
        // Also enqueue the steer so it reaches the model on the very NEXT iteration
        // even if the assembler hasn't seen the persisted user message yet. KEYED on
        // the signature: a second gated signature is a second fact, not a repeat.
        steerQueue: enqueueSteer(state.steerQueue, {
          floor: 'thrash-gate', content: steerMsg, key: thrash.signature, atLoop: state.loopCount,
        }),
      });
      try {
        broadcast({
          type: 'chat:error',
          agentId,
          error: `Engine refusing further ${thrash.toolName} calls with these args, try different input, mark complete, or block.`,
          code: 'TASK_THRASH_PAUSED',
          severity: 'warning',
          retryable: true,
        });
      } catch { /* best effort */ }
      // Don't break, let the loop continue. The next model turn will
      // see the system message and pick a wrap-up path. The runOne
      // path enforces the gate on tool execution.
    }
  }
  return proceed(state);
}
